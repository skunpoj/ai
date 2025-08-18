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
