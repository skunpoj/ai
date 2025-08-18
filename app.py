import os
from fasthtml.common import *
from google.cloud import speech
import queue
import time
import base64
import tempfile
import json

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
CHUNK_SIZE = int(SAMPLE_RATE / 10)  # 100ms

def get_current_time() -> int:
    """Return Current Time in MS."""
    return int(round(time.time() * 1000))

app, rt = fast_app(exts='ws') # Added exts='ws'

# Configure Google Cloud Speech-to-Text client globally
global_speech_client = None
global_recognition_config = None
global_streaming_config = None

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

@rt("/")
def index():
    return Title("Speech-to-Text with FastHTML"),\
        H1("Speech-to-Text"),\
        Button("Start Recording", id="startRecording"),\
        Button("Stop Recording", id="stopRecording", disabled=True),\
        P("Transcription: ", id="transcription"),\
        Div(id="recordingsContainer"),\
        Script(f"let CHUNK_SIZE = {CHUNK_SIZE};"),\
        Script("""
            let mediaRecorder;
            let audioChunks = [];
            let socket;
            let recordings = []; // Array to store recorded audios and their transcriptions

            document.getElementById('startRecording').addEventListener('click', async () => {
                document.getElementById('startRecording').disabled = true;
                document.getElementById('stopRecording').disabled = false;
                document.getElementById('transcription').innerText = "Transcription: ";

                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm; codecs=opus' });
                audioChunks = [];

                // Establish WebSocket connection
                socket = new WebSocket(`wss://${window.location.host}/transcribe`);

                socket.onopen = () => {
                    console.log('WebSocket opened');
                    // MediaRecorder.start() will be called only after 'ready' signal from backend
                };

                socket.onmessage = event => {
                    console.log('Frontend: Received WebSocket message:', event.data); # Added logging
                    const data = JSON.parse(event.data);
                    if (data.type === "ready") {
                        console.log('Backend ready signal received. Starting MediaRecorder.');
                        mediaRecorder.start(CHUNK_SIZE); // Start recording only after ready signal
                    } else if (data.status) {
                        console.log(`Credential Status: ${data.status}`);
                        if (data.path) console.log(`Credential Path: ${data.path}`);
                        if (data.error) console.error(`Credential Error: ${data.error}`);
                        if (data.content) console.log(`Credential Content:\n${data.content}`);
                    } else if (data.ack) {
                        console.log('Backend Acknowledgement received.');
                    } else if (data.transcript) {
                        document.getElementById('transcription').innerText = `Transcription: ${data.transcript}`;
                        if (data.is_final) {
                            recordings.push({ audioUrl: null, transcription: data.transcript });
                            displayRecordings();
                        }
                    }
                };

                socket.onclose = () => {
                    console.log('WebSocket closed');
                };

                socket.onerror = error => {
                    console.error('WebSocket error:', error);
                };

                mediaRecorder.ondataavailable = async event => {
                    console.log('Data available:', event.data.size, 'bytes');
                    console.log('MediaRecorder mimeType:', mediaRecorder.mimeType);
                    audioChunks.push(event.data);
                    if (socket.readyState === WebSocket.OPEN) {
                        console.log('Sending data. WebSocket readyState:', socket.readyState);
                        const arrayBuffer = await event.data.arrayBuffer();
                        const base64String = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
                        socket.send(JSON.stringify({ audio: base64String }));
                    } else {
                        console.warn('WebSocket not open. readyState:', socket.readyState, 'Not sending data.');
                    }
                };

                mediaRecorder.onstop = async () => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ end_stream: true })); // Send end signal as JSON
                        socket.close();
                    }

                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    const audioUrl = URL.createObjectURL(audioBlob);

                    if (recordings.length > 0) {
                        const lastRecording = recordings[recordings.length - 1];
                        if (lastRecording.audioUrl === null) {
                            lastRecording.audioUrl = audioUrl;
                            displayRecordings();
                        }
                    }
                };
            });

            document.getElementById('stopRecording').addEventListener('click', () => {
                document.getElementById('startRecording').disabled = false;
                document.getElementById('stopRecording').disabled = true;
                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    mediaRecorder.stop();
                }
            });

            function displayRecordings() {
                const container = document.getElementById('recordingsContainer');
                container.innerHTML = '';
                recordings.forEach((record, index) => {
                    const recordDiv = document.createElement('div');
                    recordDiv.innerHTML = `
                        <h3>Recording ${index + 1}</h3>
                        ${record.audioUrl ? `<audio controls src="${record.audioUrl}"></audio>` : ''}
                        <p>Transcription: ${record.transcription}</p>
                    `;
                    container.appendChild(recordDiv);
                });
            }
        """)


@app.ws("/transcribe")
async def transcribe(websocket: WebSocket):
    print("WebSocket accepted")
    await websocket.send_json({"type": "ready"}) # Send ready signal
    print("Backend: Sent 'ready' signal.") # Added logging

    if not global_speech_client:
        print("Error: Google Cloud Speech client not initialized.")
        await websocket.close(code=1011, reason="Google Speech client not ready.")
        return

    async def request_generator():
        while True:
            try:
                print("Backend: Waiting for WebSocket message...")
                message = await websocket.receive_json()
                print(f"Backend: Received WebSocket message: {message}")
                
                await websocket.send_json({"ack": True})
                
                if "end_stream" in message and message["end_stream"]:
                    print("Backend received end_stream signal.")
                    break
                
                if "audio" in message:
                    decoded_chunk = base64.b64decode(message["audio"])
                    print(f"Received and decoded chunk of size: {len(decoded_chunk)}")
                    yield speech.StreamingRecognizeRequest(audio_content=decoded_chunk)
                else:
                    print("Received non-audio JSON message:", message)

            except WebSocketDisconnect:
                print("WebSocket disconnected cleanly from client.")
                break
            except Exception as e:
                print(f"Error receiving or decoding chunk in request_generator: {e}")
                break

    try:
        responses = global_speech_client.streaming_recognize(global_streaming_config, request_generator())
        print("Receiving responses from Google Speech API...")
        async for response in responses:
            if not response.results:
                print("No transcription results in response.")
                continue
            
            result = response.results[0]
            if not result.alternatives:
                print("No alternatives in transcription result.")
                continue
            
            transcript = result.alternatives[0].transcript
            is_final = result.is_final
            
            print(f"Sending transcription to frontend: {transcript} (Final: {is_final})")
            await websocket.send_json({"transcript": transcript, "is_final": is_final})
            
    except Exception as e:
        print(f"WebSocket Error during streaming: {e}")
    finally:
        print("WebSocket closed (backend)")
        await websocket.close()

serve()
