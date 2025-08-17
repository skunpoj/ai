import os
from fasthtml.common import *
from google.cloud import speech
import queue
import time
import base64

# Audio recording parameters (from main.py - adjust as needed for web input)
STREAMING_LIMIT = 240000  # 4 minutes
SAMPLE_RATE = 16000
CHUNK_SIZE = int(SAMPLE_RATE / 10)  # 100ms


def get_current_time() -> int:
    """Return Current Time in MS."""
    return int(round(time.time() * 1000))


app, rt = fast_app()

# Print the GOOGLE_APPLICATION_CREDENTIALS environment variable for verification
print(f"GOOGLE_APPLICATION_CREDENTIALS: {os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')}")

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
                    mediaRecorder.start(CHUNK_SIZE); // Start recording and emit data every CHUNK_SIZE ms
                };

                socket.onmessage = event => {
                    const data = JSON.parse(event.data);
                    if (data.transcript) {
                        document.getElementById('transcription').innerText = `Transcription: ${data.transcript}`;
                        if (data.is_final) {
                            // Only add final transcriptions to recordings
                            recordings.push({ audioUrl: null, transcription: data.transcript }); // audioUrl will be set on stop
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
                        const arrayBuffer = await event.data.arrayBuffer();
                        const base64String = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
                        socket.send(JSON.stringify({ audio: base64String }));
                    }
                };

                mediaRecorder.onstop = async () => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ end_stream: true })); // Send end signal as JSON
                        socket.close();
                    }

                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    const audioUrl = URL.createObjectURL(audioBlob);

                    // Update the last recording with the audio URL
                    if (recordings.length > 0) {
                        const lastRecording = recordings[recordings.length - 1];
                        if (lastRecording.audioUrl === null) { // Only update if not already set
                            lastRecording.audioUrl = audioUrl;
                            displayRecordings(); // Re-render to show audio player
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
                container.innerHTML = ''; // Clear previous recordings
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
    await websocket.accept()
    print("WebSocket accepted")

    # Configure Google Cloud Speech-to-Text client
    client = speech.SpeechClient()
    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,  # Assuming webm/opus from MediaRecorder
        sample_rate_hertz=SAMPLE_RATE,
        language_code="en-US",
    )
    streaming_config = speech.StreamingRecognitionConfig(
        config=config, interim_results=True
    )

    # Create a generator for streaming audio requests
    async def request_generator():
        while True:
            try:
                message = await websocket.receive_json()
                if "end_stream" in message and message["end_stream"]:
                    break
                
                if "audio" in message:
                    decoded_chunk = base64.b64decode(message["audio"])
                    print(f"Received and decoded chunk of size: {len(decoded_chunk)}")
                    yield speech.StreamingRecognizeRequest(audio_content=decoded_chunk)
                else:
                    print("Received non-audio JSON message:", message)
            except Exception as e:
                print(f"Error receiving or decoding chunk: {e}")
                break

    try:
        responses = client.streaming_recognize(streaming_config, request_generator())
        print("Receiving responses...")
        async for response in responses:
            if not response.results:
                continue
            
            result = response.results[0]
            if not result.alternatives:
                continue
            
            transcript = result.alternatives[0].transcript
            is_final = result.is_final
            
            # Send transcription back to client via WebSocket
            await websocket.send_json({"transcript": transcript, "is_final": is_final})
            
    except Exception as e:
        print(f"WebSocket Error: {e}")
    finally:
        print("WebSocket closed (backend)")
        await websocket.close()

serve()
