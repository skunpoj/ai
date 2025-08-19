import os
from dotenv import load_dotenv
from fasthtml.common import *
from starlette.websockets import WebSocket, WebSocketDisconnect # Explicitly import WebSocket classes from starlette

import base64
import json
import tempfile
import queue
import time
import asyncio
from google.cloud import speech
try:
    import google.generativeai as gm  # Consumer Gemini (API key)
except Exception:
    gm = None
try:
    from google import genai as genai_sdk  # Google Gen AI SDK (Vertex backend)
    from google.genai import types as genai_types
except Exception:
    genai_sdk = None
    genai_types = None

# Transcription is now controlled at runtime via Start/Stop Transcribe
ENABLE_GOOGLE_SPEECH = True

# Load .env before reading any credential env vars
load_dotenv()

# --- Credentials Handling (START) ---
credentials_json = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")
if credentials_json:
    try:
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, 'w') as tmp:
            tmp.write(credentials_json)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = path
        print(f"Google Cloud credentials written to temporary file: {path}")
    except Exception as e:
        print(f"Error writing Google Cloud credentials to temporary file: {e}")
else:
    print("GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable not found.")
# --- Credentials Handling (END) ---

# Audio recording parameters
STREAMING_LIMIT = 240000  # 4 minutes
# For browser MediaRecorder with Opus, actual sample rate is typically 48000 and
# embedded in the container. We avoid forcing a mismatched sample_rate here.
SAMPLE_RATE = 16000
CHUNK_SIZE = int(SAMPLE_RATE / 10)  # 100ms worth of audio frames for backend processing
CHUNK_MS = 250  # MediaRecorder timeslice in ms for frontend
SEGMENT_MS = 10000  # Default duration of a playable client-side segment (10 seconds)

app, rt = fast_app(exts='ws') # Ensure 'exts='ws'' is present
app.static_route_exts(prefix="/static", static_path="static") # Configure static files serving

print(f"Current working directory: {os.getcwd()}")
print(f"Absolute path to static directory: {os.path.abspath('static')}")

def get_current_time() -> int:
    """Return Current Time in MS."""
    return int(round(time.time() * 1000))

# Configure Google Cloud Speech-to-Text client globally
global_speech_client = None
global_recognition_config = None
global_streaming_config = None
global_auth_info = None
global_gemini_model = None
global_vertex_client = None
VERTEX_GEMINI_MODEL = os.environ.get("VERTEX_GEMINI_MODEL", "gemini-2.5-flash")

# Initialize Google client if credentials are present; otherwise stay None and we will notify on demand
if True:
    # Global Credentials Check and Client Initialization
    credentials_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if credentials_path and os.path.exists(credentials_path):
        try:
            with open(credentials_path, 'r') as f:
                creds_content = f.read()
                json.loads(creds_content) # Validate JSON content
            
            global_speech_client = speech.SpeechClient()
            # Use LINEAR16 PCM at 16kHz for streaming (matches working sample)
            global_recognition_config = speech.RecognitionConfig(
                encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=16000,
                language_code="en-US",
            )
            global_streaming_config = speech.StreamingRecognitionConfig(
                config=global_recognition_config, interim_results=True
            )
            # Build redacted auth info for debugging
            try:
                creds_json = json.loads(creds_content)
                client_email = creds_json.get("client_email")
                private_key_id = creds_json.get("private_key_id")
                project_id = creds_json.get("project_id")
                def mask(val):
                    if not val or len(val) < 8: return "***"
                    return f"{val[:4]}...{val[-4:]}"
                global_auth_info = {
                    "project_id": project_id or "",
                    "client_email_masked": (client_email[:3] + "...@" + client_email.split("@")[-1]) if client_email and "@" in client_email else "***",
                    "private_key_id_masked": mask(private_key_id)
                }
            except Exception:
                global_auth_info = None
            print(f"Google Cloud Speech client initialized successfully using credentials from: {credentials_path}")
        except Exception as e:
            print(f"Error initializing Google Cloud Speech client: {e}")
    else:
        print(f"Google Cloud credentials file not found or path not set: {credentials_path}")

# Initialize Gemini model if API key is present and library available
gemini_api_key = os.environ.get("GEMINI_API_KEY")
if gemini_api_key and gm is not None:
    try:
        gm.configure(api_key=gemini_api_key)
        # Use latest model for transcription prompts
        global_gemini_model = gm.GenerativeModel("gemini-2.5-flash")
        print("Gemini model initialized for parallel transcription.")
    except Exception as e:
        print(f"Error initializing Gemini: {e}")
        global_gemini_model = None
else:
    if not gemini_api_key:
        print("GEMINI_API_KEY not set; skipping Gemini parallel transcription.")
    if gm is None:
        print("google-generativeai not installed; skipping Gemini parallel transcription.")

# Initialize Vertex AI Gemini using Google Gen AI SDK (Vertex backend) if available
vertex_project = os.environ.get("GOOGLE_CLOUD_PROJECT")
if not vertex_project and global_auth_info and global_auth_info.get("project_id"):
    vertex_project = global_auth_info.get("project_id")
vertex_location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
# vertex_location = os.environ.get("GOOGLE_CLOUD_LOCATION", "bot.or.th")

if genai_sdk is not None and vertex_project:
    try:
        global_vertex_client = genai_sdk.Client(vertexai=True, project=vertex_project, location=vertex_location)
        print(f"Google Gen AI SDK (Vertex backend) initialized for project={vertex_project} location={vertex_location}.")
    except Exception as e:
        print(f"Error initializing Google Gen AI SDK (Vertex backend): {e}")
        global_vertex_client = None
else:
    if genai_sdk is None:
        print("google-genai SDK not installed; skipping Vertex AI Gemini.")
    elif not vertex_project:
        print("GOOGLE_CLOUD_PROJECT not set and could not infer; skipping Vertex AI Gemini.")

@rt("/") # Main application route
def index():
    return Title("Speech-to-Text with FastHTML"),\
        Link(rel="icon", href="/static/favicon.ico"),\
        H1("Speech-to-Text"),\
        Div( # Start Div arguments
            # Row 1: recording + connection health
            Div(
                Button("Start Recording", id="startRecording"),
                Button("Stop Recording", id="stopRecording", disabled=True),
                Button("Check Connection", id="testConnection"),
                P("WebSocket: not connected", id="connStatus"),
            ),
            # Row 2: transcribe controls on a new line
            Div(
                Button("Start Transcribe", id="startTranscribe", disabled=True),
                Button("Stop Transcribe", id="stopTranscribe", disabled=True),
                Button("Segment length", id="openSegmentModal"),
            ),
            # Status + outputs
            P("Transcription: ", id="transcription"),
            Div(id="liveTranscriptContainer"),
            # Segment length modal (hidden by default)
            Div(
                Div(
                    H3("Segment length"),
                    Div(
                        Input(type="radio", name="segmentLen", id="seg5", value="5000"), Label("5s", _for="seg5"),
                        Input(type="radio", name="segmentLen", id="seg10", value="10000", checked=True), Label("10s", _for="seg10"),
                        Input(type="radio", name="segmentLen", id="seg30", value="30000"), Label("30s", _for="seg30"),
                        Input(type="radio", name="segmentLen", id="seg45", value="45000"), Label("45s", _for="seg45"),
                        Input(type="radio", name="segmentLen", id="seg60", value="60000"), Label("60s", _for="seg60"),
                        Input(type="radio", name="segmentLen", id="seg90", value="90000"), Label("90s", _for="seg90"),
                        Input(type="radio", name="segmentLen", id="seg120", value="120000"), Label("120s", _for="seg120"),
                        Input(type="radio", name="segmentLen", id="seg150", value="150000"), Label("150s", _for="seg150"),
                        Input(type="radio", name="segmentLen", id="seg180", value="180000"), Label("180s", _for="seg180"),
                        id="segmentLenGroup"
                    ),
                    Button("Close", id="closeSegmentModal"),
                    id="segmentModalContent", style="background:#222;padding:16px;border:1px solid #444;max-width:480px;margin:10% auto"
                ),
                id="segmentModal", style="display:none;position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999"
            ),
            Div(
                H2("Full Recording"),
                Div(id="fullContainer")
            ),
            Div(
                H2("Segments"),
                Div(id="segmentContainer")
            ),
            Script(f"let CHUNK_MS = {CHUNK_MS};"),
            Script(f"let SEGMENT_MS = {SEGMENT_MS};"),
            Script("window.SEGMENT_MS = SEGMENT_MS;"),
            # Log redacted Google auth info on page load
            Script(
                f"window.GOOGLE_AUTH_INFO = {json.dumps(global_auth_info or {})};\n"
                f"window.GOOGLE_AUTH_READY = {( 'true' if (global_speech_client and global_streaming_config) else 'false' )};\n"
                "console.log('Frontend: Google auth on load:', { ready: window.GOOGLE_AUTH_READY, info: window.GOOGLE_AUTH_INFO });"
            ),
            Script(src="/static/main.js")
        ) # End Div arguments


@app.ws("/ws_stream") # Dedicated WebSocket endpoint for audio streaming
async def ws_test(websocket: WebSocket):
    print("Backend: ENTERED /ws_stream function (audio streaming).") # CRITICAL TEST LOG

    # Do not send 'ready' yet; wait for client 'hello' to avoid race

    # Queues to buffer audio chunks for Google Speech API
    # Use a standard Queue for the Google streaming call (which is synchronous)
    requests_q = queue.Queue()
    # Optional PCM queue for LINEAR16 streaming if client sends raw pcm
    pcm_requests_q = queue.Queue()

    # Prepare server-side recording file under static so it can be fetched later
    recordings_dir = os.path.join("static", "recordings")
    os.makedirs(recordings_dir, exist_ok=True)
    session_ts = get_current_time()
    server_filename = f"recording_{session_ts}.webm"
    server_filepath = os.path.join(recordings_dir, server_filename)
    server_file = open(server_filepath, "ab")

    # Directory for per-chunk files
    session_chunks_dir = os.path.join(recordings_dir, f"session_{session_ts}")
    os.makedirs(session_chunks_dir, exist_ok=True)
    chunk_index = 0
    # Directory for full segments (standalone playable)
    session_segments_dir = os.path.join(recordings_dir, f"session_{session_ts}")
    os.makedirs(session_segments_dir, exist_ok=True)
    segment_index = 0

    # Task to continuously receive messages from frontend
    async def receive_from_frontend():
        nonlocal chunk_index
        try:
            transcribe_enabled = False
            stream_started = False
            stream_task = None
            while True:
                try:
                    message = await websocket.receive_json() # Frontend sends JSON
                    try:
                        mtype = message.get("type")
                    except Exception:
                        mtype = None
                    print(f"Backend: Received JSON message type={mtype} keys={list(message.keys())}")
                    print(f"Backend: Received JSON message keys={list(message.keys())}")
                except WebSocketDisconnect as e:
                    print(f"Backend: Client disconnected during receive: {e}")
                    break
                except RuntimeError as e:
                    # e.g., Cannot call "receive" once a disconnect message has been received
                    print(f"Backend: RuntimeError during receive_json (disconnect): {e}")
                    break
                except Exception as e:
                    print(f"Backend: Error receiving JSON: {e}")
                    break
                # print(f"Backend: Received raw message from client: {message}") # Too verbose, uncomment if needed
                
                # Respond with 'ready' on explicit hello to ensure recorder starts
                if message.get("type") == "hello":
                    print("Backend: Received hello from client. Sending 'ready'.")
                    await websocket.send_json({"type": "ready"})
                    continue

                # Simple ping/pong for connection checks
                if message.get("type") == "ping":
                    await websocket.send_json({"type": "pong", "ts": get_current_time()})
                    continue
                if message.get("type") == "ping_start":
                    await websocket.send_json({"type": "ack", "what": "start"})
                    continue
                if message.get("type") == "ping_stop":
                    await websocket.send_json({"type": "ack", "what": "stop"})
                    continue
                if message.get("type") == "transcribe":
                    transcribe_enabled = bool(message.get("enabled", False))
                    try:
                        await websocket.send_json({"type": "ack", "what": "transcribe", "enabled": transcribe_enabled})
                    except Exception:
                        pass
                    if transcribe_enabled:
                        # Send auth status and UI hint; per-segment recognition will run for each segment
                        status = {
                            "type": "auth",
                            "ready": bool(global_speech_client and global_streaming_config),
                            "info": global_auth_info or {}
                        }
                        try:
                            await websocket.send_json(status)
                            await websocket.send_json({"type": "status", "message": "Transcribing... awaiting results"})
                        except Exception:
                            pass
                        # Explicitly keep streaming disabled (we rely on per-segment recognize with WEBM_OPUS)
                        stream_started = False
                        stream_task = None
                    else:
                        # Ensure any prior streaming attempts are stopped (safety)
                        try:
                            requests_q.put(None)
                        except Exception:
                            pass
                        stream_started = False
                        stream_task = None
                    continue

                if "end_stream" in message and message["end_stream"]:
                    print("Backend: Received end_stream signal from client.")
                    # Signal end of stream to consumer (Google API)
                    try:
                        requests_q.put(None) # Sentinel to stop consuming
                    except Exception:
                        pass
                    try:
                        if not server_file.closed:
                            server_file.flush()
                            server_file.close()
                        saved_url = f"/static/recordings/{server_filename}"
                        try:
                            await websocket.send_json({"type": "saved", "url": saved_url})
                        except Exception as e2:
                            print(f"Backend: Failed to notify client of saved file: {e2}")
                        print(f"Backend: Saved recording at {server_filepath}")
                    except Exception as e:
                        print(f"Backend: Error finalizing and notifying saved file: {e}")
                    break
                
                # prefer live toggle if provided; fallback to per-message flag
                enable_google_speech = transcribe_enabled or message.get("enable_google_speech", False)
                if mtype is None and "audio" in message:
                    print(f"Backend: enable_google_speech flag on chunk: {enable_google_speech}")
                audio_data_b64 = message.get("audio")
                pcm_b64 = message.get("pcm16")

                # Handle full segment uploads (each is a complete, playable audio container)
                if message.get("type") == "segment" and audio_data_b64:
                    try:
                        nonlocal segment_index
                        decoded_seg = base64.b64decode(audio_data_b64)
                        client_mime = (message.get("mime") or "").lower()
                        seg_ext = "ogg" if ("ogg" in client_mime) else "webm"
                        seg_path = os.path.join(session_segments_dir, f"segment_{segment_index}.{seg_ext}")
                        with open(seg_path, "wb") as sf:
                            sf.write(decoded_seg)
                        seg_url = f"/static/recordings/session_{session_ts}/segment_{segment_index}.{seg_ext}"
                        client_id = message.get("id")
                        client_ts = message.get("ts") or get_current_time()
                        try:
                            await websocket.send_json({
                                "type": "segment_saved",
                                "idx": segment_index,
                                "url": seg_url,
                                "id": client_id,
                                "ts": client_ts,
                                "status": "ws_ok",
                                "ext": seg_ext,
                                "mime": client_mime
                            })
                        except Exception:
                            pass
                        # Google STT per-segment (only when transcribe is enabled)
                        if transcribe_enabled and (global_speech_client and global_streaming_config):
                            loop = asyncio.get_running_loop()
                            async def recognize_segment(segment_bytes: bytes, idx: int):
                                try:
                                    def do_recognize_webm():
                                        cfg = speech.RecognitionConfig(
                                            encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
                                            language_code="en-US",
                                            sample_rate_hertz=48000,
                                        )
                                        audio = speech.RecognitionAudio(content=segment_bytes)
                                        return global_speech_client.recognize(config=cfg, audio=audio)
                                    def do_recognize_ogg():
                                        cfg = speech.RecognitionConfig(
                                            encoding=speech.RecognitionConfig.AudioEncoding.OGG_OPUS,
                                            language_code="en-US",
                                            sample_rate_hertz=48000,
                                        )
                                        audio = speech.RecognitionAudio(content=segment_bytes)
                                        return global_speech_client.recognize(config=cfg, audio=audio)
                                    # Prefer matching the saved container first
                                    if seg_ext == "ogg":
                                        resp = await loop.run_in_executor(None, do_recognize_ogg)
                                    else:
                                        resp = await loop.run_in_executor(None, do_recognize_webm)
                                    transcript_text = ""
                                    if resp.results and resp.results[0].alternatives:
                                        transcript_text = resp.results[0].alternatives[0].transcript or ""
                                    # Fallback: try OGG_OPUS if WEBM_OPUS produced no text
                                    if not transcript_text:
                                        try:
                                            resp2 = await loop.run_in_executor(None, do_recognize_ogg)
                                            if resp2.results and resp2.results[0].alternatives:
                                                transcript_text = resp2.results[0].alternatives[0].transcript or ""
                                        except Exception as _:
                                            pass
                                    try:
                                        # Send both a specific Google type and legacy generic type for compatibility
                                        await websocket.send_json({
                                            "type": "segment_transcript_google",
                                            "idx": idx,
                                            "transcript": transcript_text,
                                            "id": client_id,
                                            "ts": client_ts
                                        })
                                        await websocket.send_json({
                                            "type": "segment_transcript",
                                            "idx": idx,
                                            "transcript": transcript_text,
                                            "id": client_id,
                                            "ts": client_ts
                                        })
                                    except Exception:
                                        pass
                                except Exception as e:
                                    print(f"Backend: segment recognize error: {e}")
                            asyncio.create_task(recognize_segment(decoded_seg, segment_index))

                        # Parallel: Vertex (service account) per-segment via Google Gen AI SDK
                        if transcribe_enabled and global_vertex_client is not None and genai_types is not None:
                            async def recognize_segment_vertex(segment_bytes: bytes, idx: int):
                                try:
                                    loop = asyncio.get_running_loop()
                                    def do_vertex():
                                        try:
                                            # Prefer the declared mime; then fallback to the other container
                                            order = [client_mime] if client_mime else []
                                            if seg_ext == "ogg":
                                                order += ["audio/ogg", "audio/webm"]
                                            else:
                                                order += ["audio/webm", "audio/ogg"]
                                            last_exc = None
                                            for mt in order:
                                                if not mt:
                                                    continue
                                                try:
                                                    # Build contents with camelCase inlineData as per google-genai expectations
                                                    b64 = base64.b64encode(segment_bytes).decode("ascii")
                                                    contents = [{
                                                        "role": "user",
                                                        "parts": [
                                                            {"inlineData": {"mimeType": mt, "data": b64}},
                                                            {"text": "Transcribe the spoken audio to plain text. Return only the transcript."}
                                                        ]
                                                    }]
                                                    return global_vertex_client.models.generate_content(
                                                        model=VERTEX_GEMINI_MODEL,
                                                        contents=contents
                                                    )
                                                except Exception as ie:
                                                    last_exc = ie
                                                    continue
                                            if last_exc:
                                                raise last_exc
                                        except Exception as e:
                                            raise e
                                    resp = await loop.run_in_executor(None, do_vertex)
                                    text = ""
                                    try:
                                        text = (resp.text or "").strip()
                                    except Exception:
                                        text = ""
                                    try:
                                        await websocket.send_json({
                                            "type": "segment_transcript_vertex",
                                            "idx": idx,
                                            "transcript": text,
                                            "id": client_id,
                                            "ts": client_ts
                                        })
                                    except Exception:
                                        pass
                                except Exception as e:
                                    print(f"Backend: Vertex (google-genai) segment recognize error: {e}")
                            asyncio.create_task(recognize_segment_vertex(decoded_seg, segment_index))
                        # Parallel: Gemini API-key per-segment
                        if transcribe_enabled and global_gemini_model is not None:
                            async def recognize_segment_gemini(segment_bytes: bytes, idx: int):
                                try:
                                    loop = asyncio.get_running_loop()
                                    def do_gemini():
                                        try:
                                            # Prefer declared mime first
                                            order = [client_mime] if client_mime else []
                                            if seg_ext == "ogg":
                                                order += ["audio/ogg", "audio/webm"]
                                            else:
                                                order += ["audio/webm", "audio/ogg"]
                                            last_exc = None
                                            for mt in order:
                                                if not mt:
                                                    continue
                                                try:
                                                    return global_gemini_model.generate_content([
                                                        {"text": "Transcribe the spoken audio to plain text. Return only the transcript."},
                                                        {"mime_type": mt, "data": segment_bytes}
                                                    ])
                                                except Exception as ie:
                                                    last_exc = ie
                                                    continue
                                            if last_exc:
                                                raise last_exc
                                        except Exception as e:
                                            raise e
                                    resp = await loop.run_in_executor(None, do_gemini)
                                    text = ""
                                    try:
                                        text = (resp.text or "").strip()
                                    except Exception:
                                        text = ""
                                    try:
                                        await websocket.send_json({
                                            "type": "segment_transcript_gemini",
                                            "idx": idx,
                                            "transcript": text,
                                            "id": client_id,
                                            "ts": client_ts
                                        })
                                    except Exception:
                                        pass
                                except Exception as e:
                                    print(f"Backend: Gemini segment recognize error: {e}")
                            asyncio.create_task(recognize_segment_gemini(decoded_seg, segment_index))
                        segment_index += 1
                    except Exception as e:
                        print(f"Backend: Error saving segment: {e}")
                    continue

                # Persist audio chunks to server file; forward to Google if enabled, also save per-chunk file
                if audio_data_b64:
                    try:
                        print(f"Backend: Audio chunk received (base64 length={len(audio_data_b64)})")
                        decoded_chunk = base64.b64decode(audio_data_b64)
                        print(f"Backend: Decoded audio chunk bytes={len(decoded_chunk)}")
                        server_file.write(decoded_chunk)
                        server_file.flush()
                        # Save per-chunk file as standalone playable WebM
                        chunk_path = os.path.join(session_chunks_dir, f"chunk_{chunk_index}.webm")
                        with open(chunk_path, "wb") as cf:
                            cf.write(decoded_chunk)
                        chunk_url = f"/static/recordings/session_{session_ts}/chunk_{chunk_index}.webm"
                        try:
                            await websocket.send_json({
                                "type": "chunk_saved",
                                "idx": chunk_index,
                                "url": chunk_url,
                                "ts": message.get("client_ts")
                            })
                            print(f"Backend: Notified client chunk_saved idx={chunk_index}")
                        except Exception as e:
                            print(f"Backend: Failed to notify chunk_saved: {e}")
                        # Per-chunk recognition disabled to avoid noise; we rely on per-segment recognition.
                        # If PCM streaming is enabled, prefer that; else rely on per-segment recognition
                        chunk_index += 1
                    except Exception as e:
                        print(f"Backend: Error decoding/writing audio chunk: {e}")
                elif pcm_b64 and transcribe_enabled and global_speech_client and global_streaming_config:
                    # Receive raw PCM16LE bytes from client for LINEAR16 streaming
                    try:
                        raw = base64.b64decode(pcm_b64)
                        pcm_requests_q.put(raw)
                    except Exception as e:
                        print(f"Backend: Error decoding pcm16: {e}")
                else:
                    print(f"Backend: Received non-audio/non-end_stream message from client (Google Enabled): {message}")
                    # Acknowledge if it's not an audio chunk or end_stream
                    await websocket.send_json({"type": "ack"})

        except Exception as e:
            print(f"Backend: Error in receive_from_frontend: {e}")
        finally:
            # Ensure file handle is closed
            try:
                if not server_file.closed:
                    server_file.close()
            except Exception as e:
                print(f"Backend: Error closing server recording file in finally: {e}")
            print("Backend: receive_from_frontend task ended.")

    # Task to send audio to Google Speech API and stream back results
    async def stream_to_google_and_send_to_frontend():
        if not global_speech_client or not global_streaming_config:
            print("Backend: Google Speech client not initialized for streaming.")
            return

        loop = asyncio.get_running_loop()

        def request_generator_sync():
            while True:
                # Prefer pcm if available
                if not pcm_requests_q.empty():
                    item = pcm_requests_q.get()
                else:
                    item = requests_q.get()
                if item is None:
                    print("Backend: requests_q sentinel received, ending request_generator_sync.")
                    break
                yield speech.StreamingRecognizeRequest(audio_content=item)

        def run_streaming_blocking():
            try:
                print("Backend: Starting Google Speech streaming recognition (thread).")
                responses = global_speech_client.streaming_recognize(global_streaming_config, request_generator_sync())
                for response in responses:
                    if not response.results:
                        continue
                    result = response.results[0]
                    if not result.alternatives:
                        continue
                    transcript = result.alternatives[0].transcript
                    is_final = result.is_final
                    try:
                        print(f"Backend: transcript received (final={is_final}): {transcript}")
                    except Exception:
                        pass
                    try:
                        asyncio.run_coroutine_threadsafe(
                            websocket.send_json({
                                "type": "transcript",
                                "transcript": transcript,
                                "is_final": is_final
                            }),
                            loop
                        )
                    except Exception as e:
                        print(f"Backend: Failed to schedule transcript send: {e}")
                        break
            except Exception as e:
                print(f"Backend: Error in run_streaming_blocking: {e}")
            finally:
                print("Backend: streaming recognition thread ended.")

        try:
            await loop.run_in_executor(None, run_streaming_blocking)
        except Exception as e:
            print(f"Backend: Error awaiting streaming executor: {e}")
        finally:
            print("Backend: stream_to_google_and_send_to_frontend task ended.")

    # Run receiver only; streaming happens only when transcribe is enabled (via queue)
    receive_task = asyncio.create_task(receive_from_frontend())

    # Wait for both tasks to complete or for an error
    try:
        await asyncio.gather(receive_task)
    except Exception as e:
        print(f"Backend: Error gathering tasks: {e}")
    finally:
        print("Backend: ws_test handler finished.")

serve()

