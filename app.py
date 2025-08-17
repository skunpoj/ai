from fast_html.common import *
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


@fast_app
def app():
    @get("/")
    def index():
        return Title("Speech-to-Text with FastHTML"),\
            H1("Speech-to-Text"),\
            Button("Start Recording", id="startRecording"),\
            Button("Stop Recording", id="stopRecording", disabled=True),\
            P("Transcription: ", id="transcription"),\
            Script(\'\'\'
                let mediaRecorder;
                let audioChunks = [];
                let recognitionStream;

                document.getElementById(\'startRecording\').addEventListener(\'click\', async () => {
                    document.getElementById(\'startRecording\').disabled = true;
                    document.getElementById(\'stopRecording\').disabled = false;
                    document.getElementById(\'transcription\').innerText = "Transcription: ";

                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    mediaRecorder = new MediaRecorder(stream);
                    audioChunks = [];

                    mediaRecorder.ondataavailable = event => {
                        audioChunks.push(event.data);
                    };

                    mediaRecorder.onstop = async () => {
                        const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
                        const arrayBuffer = await audioBlob.arrayBuffer();
                        const audioContent = new Uint8Array(arrayBuffer);

                        // Send audio to backend for transcription
                        const response = await fetch('/transcribe', {
                            method: 'POST',
                            body: audioContent,
                            headers: {
                                'Content-Type': 'application/octet-stream'
                            }
                        });
                        const data = await response.text();
                        document.getElementById('transcription').innerText = "Transcription: " + data;
                    };

                    mediaRecorder.start();
                });

                document.getElementById('stopRecording').addEventListener('click', () => {
                    document.getElementById('startRecording').disabled = false;
                    document.getElementById('stopRecording').disabled = true;
                    if (mediaRecorder && mediaRecorder.state === 'recording') {
                        mediaRecorder.stop();
                    }
                });
            \'\'\')

    # Placeholder for a new route to handle speech-to-text
    # This will be refined in the next step to accept audio from the web
    @post("/transcribe")
    async def transcribe(request: Request):
        audio_data = await request.body()

        # Create a simple generator for the audio data
        async def audio_chunk_generator():
            # For now, we'll treat the entire audio_data as a single chunk
            # In a real-time streaming scenario, you'd process chunks as they arrive
            yield audio_data

        transcript = transcribe_audio(audio_chunk_generator())
        return transcript
