import os
from fasthtml.common import *
from google.cloud import speech
import queue
import time

# Audio recording parameters (from main.py - adjust as needed for web input)
STREAMING_LIMIT = 240000  # 4 minutes
SAMPLE_RATE = 16000
CHUNK_SIZE = int(SAMPLE_RATE / 10)  # 100ms


def get_current_time() -> int:
    """Return Current Time in MS."""
    return int(round(time.time() * 1000))


class ResumableMicrophoneStream:
    """Placeholder for web audio input. Will need to be adapted."""

    def __init__(
        self: object,
        rate: int,
        chunk_size: int,
    ) -> None:
        self._rate = rate
        self.chunk_size = chunk_size
        self._buff = queue.Queue()
        self.closed = True
        self.start_time = get_current_time()
        self.restart_counter = 0
        self.audio_input = []
        self.last_audio_input = []
        self.result_end_time = 0
        self.is_final_end_time = 0
        self.final_request_end_time = 0
        self.bridging_offset = 0
        self.last_transcript_was_final = False
        self.new_stream = True

    def __enter__(self: object) -> object:
        self.closed = False
        return self

    def __exit__(
        self: object,
        type: object,
        value: object,
        traceback: object,
    ) -> object:
        self.closed = True
        self._buff.put(None)

    def _fill_buffer(self: object, in_data: object, *args: object, **kwargs: object) -> object:
        self._buff.put(in_data)
        return None, None # Modified for web, pyaudio.paContinue not applicable

    def generator(self: object) -> object:
        while not self.closed:
            data = []
            if self.new_stream and self.last_audio_input:
                chunk_time = STREAMING_LIMIT / len(self.last_audio_input)
                if chunk_time != 0:
                    if self.bridging_offset < 0:
                        self.bridging_offset = 0
                    if self.bridging_offset > self.final_request_end_time:
                        self.bridging_offset = self.final_request_end_time

                    chunks_from_ms = round(
                        (self.final_request_end_time - self.bridging_offset) / chunk_time
                    )
                    self.bridging_offset = round(
                        (len(self.last_audio_input) - chunks_from_ms) * chunk_time
                    )
                    for i in range(chunks_from_ms, len(self.last_audio_input)):
                        data.append(self.last_audio_input[i])
                self.new_stream = False
            chunk = self._buff.get()
            self.audio_input.append(chunk)
            if chunk is None:
                return
            data.append(chunk)
            while True:
                try:
                    chunk = self._buff.get(block=False)
                    if chunk is None:
                        return
                    data.append(chunk)
                    self.audio_input.append(chunk)
                except queue.Empty:
                    break
            yield b"".join(data)


def transcribe_audio(audio_content_generator):
    client = speech.SpeechClient()
    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
        sample_rate_hertz=SAMPLE_RATE,
        language_code="en-US",
        max_alternatives=1,
    )
    streaming_config = speech.StreamingRecognitionConfig(
        config=config, interim_results=True
    )
    requests = (
        speech.StreamingRecognizeRequest(audio_content=content)
        for content in audio_content_generator
    )
    responses = client.streaming_recognize(streaming_config, requests)

    transcript_result = []
    for response in responses:
        if not response.results:
            continue
        result = response.results[0]
        if not result.alternatives:
            continue
        transcript = result.alternatives[0].transcript
        if result.is_final:
            transcript_result.append(transcript)

    return " ".join(transcript_result)


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
                mediaRecorder = new MediaRecorder(stream);
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

                mediaRecorder.ondataavailable = event => {
                    audioChunks.push(event.data);
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(event.data);
                    }
                };

                mediaRecorder.onstop = async () => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.close();
                    }

                    const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
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

    audio_requests = (
        speech.StreamingRecognizeRequest(audio_content=chunk)
        async for chunk in websocket.iter_bytes()
    )

    try:
        responses = client.streaming_recognize(streaming_config, audio_requests)
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
