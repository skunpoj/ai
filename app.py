import os
from fasthtml.common import *
from starlette.websockets import WebSocket, WebSocketDisconnect # Explicitly import WebSocket classes from starlette

import base64
import json
import tempfile
import queue
import time
import asyncio
from google.cloud import speech

ENABLE_GOOGLE_SPEECH = os.environ.get("ENABLE_GOOGLE_SPEECH", "false").lower() == "true"

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
SAMPLE_RATE = 16000
CHUNK_SIZE = int(SAMPLE_RATE / 10)  # 100ms worth of audio frames for backend processing
CHUNK_MS = 250  # MediaRecorder timeslice in ms for frontend

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

if ENABLE_GOOGLE_SPEECH:
    # Global Credentials Check and Client Initialization
    credentials_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if credentials_path and os.path.exists(credentials_path):
        try:
            with open(credentials_path, 'r') as f:
                creds_content = f.read()
                json.loads(creds_content) # Validate JSON content
            
            global_speech_client = speech.SpeechClient()
            global_recognition_config = speech.RecognitionConfig(
                encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
                sample_rate_hertz=SAMPLE_RATE,
                language_code="en-US",
            )
            global_streaming_config = speech.StreamingRecognitionConfig(
                config=global_recognition_config, interim_results=True
            )
            print(f"Google Cloud Speech client initialized successfully using credentials from: {credentials_path}")
        except Exception as e:
            print(f"Error initializing Google Cloud Speech client: {e}")
    else:
        print(f"Google Cloud credentials file not found or path not set: {credentials_path}")
else:
    print("Google Speech-to-Text functionality is disabled via ENABLE_GOOGLE_SPEECH environment variable.")

@rt("/") # Main application route
def index():
    return Title("Speech-to-Text with FastHTML"),\
        Link(rel="icon", href="/static/favicon.ico"),\
        H1("Speech-to-Text"),\
        Div( # Start Div arguments
            Button("Start Recording", id="startRecording"),
            Button("Stop Recording", id="stopRecording", disabled=True),
            Button("Start Transcribe", id="startTranscribe", disabled=True),
            Button("Stop Transcribe", id="stopTranscribe", disabled=True),
            P("Transcription: ", id="transcription"),
            Div(id="recordingsContainer"),
            Script(f"let CHUNK_MS = {CHUNK_MS};"),
            Script(src="/static/main.js"),
            hx_ext="ws" # Apply HTMX WebSocket extension to the Div
        ) # End Div arguments


@app.ws("/ws_test") # WebSocket endpoint for HTMX-driven audio streaming
async def ws_test(websocket: WebSocket):
    print("Backend: ENTERED /ws_test function (audio streaming HTMX).") # CRITICAL TEST LOG

    # Send ready signal to frontend - Frontend will start MediaRecorder on this
    try:
        await websocket.send_json({"type": "ready"})
        print("Backend: Sent 'ready' signal.")
    except Exception as e:
        # Client may have disconnected before we could send
        print(f"Backend: Failed to send 'ready' (client likely disconnected): {e}")
        return

    # Use a queue to buffer audio chunks for Google Speech API
    audio_queue = asyncio.Queue()

    # Prepare server-side recording file under static so it can be fetched later
    recordings_dir = os.path.join("static", "recordings")
    os.makedirs(recordings_dir, exist_ok=True)
    server_filename = f"recording_{get_current_time()}.webm"
    server_filepath = os.path.join(recordings_dir, server_filename)
    server_file = open(server_filepath, "ab")

    # Task to continuously receive messages from frontend
    async def receive_from_frontend():
        try:
            sent_disabled_notice = False
            transcribe_enabled = False
            while True:
                try:
                    message = await websocket.receive_json() # Frontend sends JSON
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
                    print("Backend: Received hello from client. Re-sending 'ready'.")
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
                    continue

                if "end_stream" in message and message["end_stream"]:
                    print("Backend: Received end_stream signal from client.")
                    # Signal end of stream to consumer (Google API)
                    await audio_queue.put(None) # Sentinel to stop consuming
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

                # Persist audio chunks to server file; forward to Google if enabled
                if audio_data_b64:
                    try:
                        decoded_chunk = base64.b64decode(audio_data_b64)
                        server_file.write(decoded_chunk)
                        server_file.flush()
                        if enable_google_speech:
                            await audio_queue.put(decoded_chunk)
                    except Exception as e:
                        print(f"Backend: Error decoding/writing audio chunk: {e}")

                    # When Google is disabled, send placeholder only once per session
                    if not enable_google_speech and not sent_disabled_notice:
                        try:
                            await websocket.send_json({
                                "type": "transcript",
                                "transcript": "Google Speech-to-Text is disabled.",
                                "is_final": True
                            })
                        except Exception as e:
                            print(f"Backend: Failed to send disabled transcript: {e}")
                        print("Backend: Sent placeholder transcription (once per session).")
                        sent_disabled_notice = True
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
            await websocket.send_json({
                "type": "transcript",
                "transcript": "Google Speech-to-Text client not ready. Check server logs.",
                "is_final": True
            })
            return
        
        try:
            # Generator for Google Speech API requests
            async def request_generator():
                while True:
                    chunk = await audio_queue.get()
                    if chunk is None: # Sentinel for end of stream
                        print("Backend: Audio queue sentinel received, ending request_generator.")
                        break
                    yield speech.StreamingRecognizeRequest(audio_content=chunk)

            print("Backend: Starting Google Speech streaming recognition.")
            responses = global_speech_client.streaming_recognize(global_streaming_config, request_generator())

            async for response in responses:
                if not response.results:
                    # print("Backend: No transcription results in response.") # Too verbose
                    continue
                
                result = response.results[0]
                if not result.alternatives:
                    # print("Backend: No alternatives in transcription result.") # Too verbose
                    continue
                
                transcript = result.alternatives[0].transcript
                is_final = result.is_final
                
                # Send transcription to frontend as JSON for direct WebSocket handling
                try:
                    await websocket.send_json({
                        "type": "transcript",
                        "transcript": transcript,
                        "is_final": is_final
                    })
                except Exception as e:
                    print(f"Backend: Failed to send transcript (client likely disconnected): {e}")
                    return
                # print(f"Backend: Sent transcription to frontend: {transcript} (Final: {is_final})") # Too verbose

        except Exception as e:
            print(f"Backend: Error in stream_to_google_and_send_to_frontend: {e}")
        finally:
            print("Backend: stream_to_google_and_send_to_frontend task ended.")

    # Run both tasks concurrently
    receive_task = asyncio.create_task(receive_from_frontend())
    stream_task = asyncio.create_task(stream_to_google_and_send_to_frontend())

    # Wait for both tasks to complete or for an error
    try:
        await asyncio.gather(receive_task, stream_task)
    except Exception as e:
        print(f"Backend: Error gathering tasks: {e}")
    finally:
        print("Backend: ws_test handler finished.")

serve()

