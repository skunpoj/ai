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
SEGMENT_MS = 3000  # Duration of a playable client-side segment

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
            # For WEBM_OPUS, do not force sample_rate_hertz; the container carries it (usually 48000).
            global_recognition_config = speech.RecognitionConfig(
                encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
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
            ),
            # Status + outputs
            P("Transcription: ", id="transcription"),
            Div(
                Label("Segment length (ms): ", _for="segmentMsInput"),
                Input(type="range", id="segmentMsInput", min="1000", max="10000", value=str(SEGMENT_MS), step="250"),
                Span(str(SEGMENT_MS), id="segmentMsValue"),
            ),
            Div(id="recordingsContainer"),
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
                    # Also send auth status when enabling
                    if transcribe_enabled:
                        status = {
                            "type": "auth",
                            "ready": bool(global_speech_client and global_streaming_config),
                            "info": global_auth_info or {}
                        }
                        try:
                            await websocket.send_json(status)
                        except Exception:
                            pass
                        # Inform UI we're listening
                        try:
                            await websocket.send_json({"type": "status", "message": "Transcribing... awaiting results"})
                        except Exception:
                            pass
                        stream_started = True
                        # Start streaming task if not already running and client ready
                        if stream_task is None and global_speech_client and global_streaming_config:
                            stream_task = asyncio.create_task(stream_to_google_and_send_to_frontend())
                    else:
                        # Stop streaming by sending sentinel
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
                audio_data_b64 = message.get("audio")

                # Persist audio chunks to server file; forward to Google if enabled, also save per-chunk file
                if audio_data_b64:
                    try:
                        print(f"Backend: Audio chunk received (base64 length={len(audio_data_b64)})")
                        decoded_chunk = base64.b64decode(audio_data_b64)
                        print(f"Backend: Decoded audio chunk bytes={len(decoded_chunk)}")
                        server_file.write(decoded_chunk)
                        server_file.flush()
                        # Save per-chunk file
                        chunk_path = os.path.join(session_chunks_dir, f"chunk_{chunk_index}.webm")
                        with open(chunk_path, "ab") as cf:
                            cf.write(decoded_chunk)
                        chunk_url = f"/static/recordings/session_{session_ts}/chunk_{chunk_index}.webm"
                        try:
                            await websocket.send_json({"type": "chunk_saved", "idx": chunk_index, "url": chunk_url})
                            print(f"Backend: Notified client chunk_saved idx={chunk_index}")
                        except Exception as e:
                            print(f"Backend: Failed to notify chunk_saved: {e}")
                        # Launch per-chunk transcription if enabled and client ready
                        this_idx = chunk_index
                        if enable_google_speech and (global_speech_client and global_streaming_config):
                            try:
                                # Run short recognize on this chunk in background to get per-chunk transcript
                                loop = asyncio.get_running_loop()
                                async def transcribe_chunk(chunk_bytes: bytes, idx: int):
                                    try:
                                        def do_recognize():
                                            cfg = speech.RecognitionConfig(
                                                encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
                                                language_code="en-US",
                                            )
                                            audio = speech.RecognitionAudio(content=chunk_bytes)
                                            return global_speech_client.recognize(config=cfg, audio=audio)
                                        resp = await loop.run_in_executor(None, do_recognize)
                                        transcript_text = ""
                                        if resp.results and resp.results[0].alternatives:
                                            transcript_text = resp.results[0].alternatives[0].transcript or ""
                                        try:
                                            await websocket.send_json({"type": "chunk_transcript", "idx": idx, "transcript": transcript_text})
                                        except Exception:
                                            pass
                                    except Exception as e:
                                        print(f"Backend: per-chunk recognize error: {e}")
                                asyncio.create_task(transcribe_chunk(decoded_chunk, this_idx))
                            except Exception as e:
                                print(f"Backend: Failed to schedule per-chunk transcription: {e}")
                        # Also forward bytes to streaming recognizer if active
                        if enable_google_speech and stream_started:
                            try:
                                requests_q.put(decoded_chunk)
                            except Exception:
                                pass
                        chunk_index += 1
                    except Exception as e:
                        print(f"Backend: Error decoding/writing audio chunk: {e}")
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

