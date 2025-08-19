document.addEventListener('DOMContentLoaded', () => {
    let mediaRecorder;
    let audioChunks = [];
    let socket;
    let recordings = []; // Array to store recorded audios and their transcriptions
    let currentRecording = null; // Single recording per Start/Stop session
    let savedCloseTimer = null; // Delay socket close until server confirms save

    const startRecordingButton = document.getElementById('startRecording');
    const stopRecordingButton = document.getElementById('stopRecording');
    const startTranscribeButton = document.getElementById('startTranscribe');
    const stopTranscribeButton = document.getElementById('stopTranscribe');
    const transcriptionElement = document.getElementById('transcription');
    const recordingsContainer = document.getElementById('recordingsContainer');
    const toggleGoogleSpeechCheckbox = document.getElementById('toggleGoogleSpeech');
    
    // Add a connection status and test button UI elements if not present
    let connStatus = document.getElementById('connStatus');
    if (!connStatus) {
        connStatus = document.createElement('p');
        connStatus.id = 'connStatus';
        connStatus.innerText = 'WebSocket: not connected';
        const parentNode = recordingsContainer && recordingsContainer.parentNode ? recordingsContainer.parentNode : document.body;
        const beforeNode = recordingsContainer && recordingsContainer.parentNode ? recordingsContainer : parentNode.firstChild;
        parentNode.insertBefore(connStatus, beforeNode);
    }
    let testConnBtn = document.getElementById('testConnection');
    if (!testConnBtn) {
        testConnBtn = document.createElement('button');
        testConnBtn.id = 'testConnection';
        testConnBtn.innerText = 'Check Connection';
        const parentNode = recordingsContainer && recordingsContainer.parentNode ? recordingsContainer.parentNode : document.body;
        const beforeNode = recordingsContainer && recordingsContainer.parentNode ? recordingsContainer : parentNode.firstChild;
        parentNode.insertBefore(testConnBtn, beforeNode);
    }
    let authStatus = document.getElementById('authStatus');
    if (!authStatus) {
        authStatus = document.createElement('p');
        authStatus.id = 'authStatus';
        authStatus.innerText = '';
        const parentNode = recordingsContainer && recordingsContainer.parentNode ? recordingsContainer.parentNode : document.body;
        const beforeNode = recordingsContainer && recordingsContainer.parentNode ? recordingsContainer : parentNode.firstChild;
        parentNode.insertBefore(authStatus, recordingsContainer || beforeNode);
    }

    // This ensures CHUNK_SIZE is available from the backend-rendered script tag
    // Example: <script>let CHUNK_SIZE = 1600;</script>
    // No explicit declaration here as it's provided by app.py

    startRecordingButton.addEventListener('click', async () => {
        startRecordingButton.disabled = true;
        stopRecordingButton.disabled = false;
        transcriptionElement.innerText = "Transcription: ";
        recordingsContainer.innerHTML = ''; // Clear previous recordings on new start

        console.log("Frontend: Start Recording button clicked.");

        // Transcription control is now via buttons; default off at start
        let enableGoogleSpeech = false;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm; codecs=opus' });
            audioChunks = [];
            
            // WebSocket connection is managed by HTMX on the hx-ext="ws" element.
            // To send data from JavaScript, we can either get the raw WebSocket object
            // from HTMX, or trigger an HTMX element to send.
            // The easiest way for raw audio is to get the socket directly if HTMX exposes it,
            // or send a JSON message via fetch to a different endpoint if needed.

            // For this example, let's connect manually for MediaRecorder data,
            // and use HTMX for initial UI and server responses.
            // This is a hybrid approach. Let's send audio chunks via a new direct socket.
            
            // Re-establish direct WebSocket for MediaRecorder streaming for now
            // Use secure WSS when the page is served over HTTPS
            const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
            socket = new WebSocket(`${wsScheme}://${window.location.host}/ws_test`);

            socket.onopen = () => {
                console.log('Frontend: Direct WebSocket opened to /ws_test for audio streaming.');
                // MediaRecorder.start() will be called only after 'ready' signal from backend
                try {
                    socket.send(JSON.stringify({ type: 'hello' }));
                    console.log('Frontend: Sent hello handshake.');
                } catch (e) {
                    console.warn('Frontend: Failed to send hello handshake:', e);
                }
                connStatus.innerText = 'WebSocket: open';
                startTranscribeButton.disabled = false;
                stopTranscribeButton.disabled = false;
            };

            socket.onmessage = event => {
                console.log('Frontend: Received WebSocket message:', event.data);
                let data = null;
                try {
                    data = JSON.parse(event.data);
                } catch (e) {
                    // Some servers may send plain strings; treat 'ready' explicitly
                    if (typeof event.data === 'string' && event.data.toLowerCase().includes('ready')) {
                        console.log('Frontend: Plain ready message received. Starting MediaRecorder.');
                        mediaRecorder.start(CHUNK_MS);
                        console.log('Frontend: MediaRecorder started with CHUNK_MS:', CHUNK_MS);
                        return;
                    }
                    console.warn('Frontend: Non-JSON message received and ignored.');
                    return;
                }
                console.log('Frontend: Parsed WebSocket data:', data);

                if (data.type === "ready") {
                    console.log('Frontend: Backend ready signal received. Starting MediaRecorder.');
                    mediaRecorder.start(CHUNK_MS); // Start recording only after ready signal
                    console.log('Frontend: MediaRecorder started with CHUNK_MS:', CHUNK_MS);
                    try {
                        socket.send(JSON.stringify({ type: 'ping_start' }));
                        console.log('Frontend: Sent ping_start.');
                    } catch (e) {
                        console.warn('Frontend: Failed to send ping_start:', e);
                    }
                    // Initialize current recording object for this session
                    currentRecording = { audioUrl: null, transcription: '' };
                } else if (data.transcript) {
                    console.log('Frontend: Received transcription:', data.transcript);
                    transcriptionElement.innerText = `Transcription: ${data.transcript}`;
                    if (currentRecording) currentRecording.transcription = data.transcript;
                } else if (data.type === 'saved') {
                    // Server finalized and saved the recording file
                    const savedUrl = data.url;
                    console.log('Frontend: Server saved recording at:', savedUrl);
                    if (recordings.length > 0) {
                        const last = recordings[recordings.length - 1];
                        last.serverUrl = savedUrl;
                        displayRecordings();
                    }
                    if (savedCloseTimer) {
                        clearTimeout(savedCloseTimer);
                        savedCloseTimer = null;
                    }
                    // Now safely close socket
                    try {
                        if (socket.readyState === WebSocket.OPEN) socket.close();
                    } catch (_) {}
                } else if (data.type === 'pong') {
                    connStatus.innerText = `WebSocket: pong (${data.ts})`;
                } else if (data.type === 'auth') {
                    const ready = !!data.ready;
                    const info = data.info || {};
                    const project = info.project_id || '';
                    const email = info.client_email_masked || '';
                    const key = info.private_key_id_masked || '';
                    console.log('Frontend: Google auth status:', { ready, project, email, key });
                    authStatus.innerText = ready ? `Google auth OK (project=${project}, email=${email}, key=${key})` : 'Google auth NOT READY';
                } else if (data.type === 'ack') {
                    if (data.what === 'start') {
                        connStatus.innerText = 'WebSocket: start acknowledged';
                    } else if (data.what === 'stop') {
                        connStatus.innerText = 'WebSocket: stop acknowledged';
                    } else {
                        connStatus.innerText = 'WebSocket: ack received';
                    }
                }
            };

            socket.onclose = () => {
                console.log('Frontend: Direct WebSocket closed.');
                connStatus.innerText = 'WebSocket: closed';
            };

            socket.onerror = error => {
                console.error('Frontend: Direct WebSocket error:', error);
                alert('WebSocket connection error. See console for details.');
            };

            mediaRecorder.ondataavailable = async event => {
                console.log('Frontend: Data available:', event.data.size, 'bytes');
                console.log('Frontend: MediaRecorder mimeType:', mediaRecorder.mimeType);
                audioChunks.push(event.data);
                console.log('Frontend: Current audioChunks length:', audioChunks.length);
                if (socket.readyState === WebSocket.OPEN) {
                    console.log('Frontend: Sending audio data. WebSocket readyState:', socket.readyState, 'Chunk size:', event.data.size);
                    const arrayBuffer = await event.data.arrayBuffer();
                    socket.send(JSON.stringify({ audio: btoa(String.fromCharCode(...new Uint8Array(arrayBuffer))), enable_google_speech: enableGoogleSpeech }));
                } else {
                    console.warn('Frontend: WebSocket not open. readyState:', socket.readyState, 'Not sending data.');
                }
            };

            mediaRecorder.onstop = async () => {
                console.log('Frontend: MediaRecorder stopped. Finalizing audio.');
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'ping_stop' }));
                    socket.send(JSON.stringify({ end_stream: true })); // Send end signal as JSON
                    // Give server time to respond with 'saved' before closing
                    savedCloseTimer = setTimeout(() => {
                        try {
                            if (socket && socket.readyState === WebSocket.OPEN) socket.close();
                        } catch (_) {}
                    }, 1500);
                }

                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const audioUrl = URL.createObjectURL(audioBlob);
                console.log('Frontend: Generated audio URL:', audioUrl);

                // Finalize single-session recording
                if (!currentRecording) {
                    currentRecording = { audioUrl: null, transcription: transcriptionElement.innerText.replace('Transcription: ', '') };
                }
                currentRecording.audioUrl = audioUrl;
                recordings.push(currentRecording);
                console.log('Frontend: Updated last recording with audioUrl:', currentRecording);
                displayRecordings(); // Display recordings with the new audio player
                currentRecording = null; // Reset for next session
            };
        } catch (err) {
            console.error('Frontend: Error accessing microphone or setting up MediaRecorder:', err);
            alert('Error accessing microphone. Please ensure permissions are granted.');
            startRecordingButton.disabled = false;
            stopRecordingButton.disabled = true;
        }
    });

    stopRecordingButton.addEventListener('click', () => {
        console.log("Frontend: Stop Recording button clicked.");
        startRecordingButton.disabled = false;
        stopRecordingButton.disabled = true;
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
    });

    // Transcription control
    startTranscribeButton.addEventListener('click', () => {
        enableGoogleSpeech = true;
        startTranscribeButton.disabled = true;
        stopTranscribeButton.disabled = false;
        startTranscribeButton.innerText = 'Transcribing...';
        stopTranscribeButton.innerText = 'Stop Transcribe';
        try {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'transcribe', enabled: true }));
            }
        } catch (e) { console.warn('Frontend: failed to send transcribe=true', e); }
    });
    stopTranscribeButton.addEventListener('click', () => {
        enableGoogleSpeech = false;
        startTranscribeButton.disabled = false;
        stopTranscribeButton.disabled = true;
        startTranscribeButton.innerText = 'Start Transcribe';
        stopTranscribeButton.innerText = 'Transcribe stopped';
        try {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'transcribe', enabled: false }));
            }
        } catch (e) { console.warn('Frontend: failed to send transcribe=false', e); }
    });

    // Manual connection check button
    testConnBtn.addEventListener('click', () => {
        if (!socket) {
            alert('Socket not created yet. Click Start Recording first.');
            return;
        }
        try {
            socket.send(JSON.stringify({ type: 'ping' }));
            connStatus.innerText = 'WebSocket: ping sent';
        } catch (e) {
            console.warn('Frontend: ping send failed:', e);
            connStatus.innerText = 'WebSocket: ping failed';
        }
    });

    function displayRecordings() {
        console.log('Frontend: Displaying recordings. Current recordings array:', recordings);
        recordingsContainer.innerHTML = ''; // Clear existing displayed recordings

        recordings.forEach((record, index) => {
            const recordDiv = document.createElement('div');
            recordDiv.className = 'recording-item';
            recordDiv.innerHTML = `
                <h3>Recording ${index + 1}</h3>
                ${record.audioUrl ? `<audio controls src="${record.audioUrl}"></audio>` : ''}
                ${record.serverUrl ? `<div><a href="${record.serverUrl}" download>Download server audio</a></div>` : ''}
                <p>Transcription: ${record.transcription}</p>
                <hr/>
            `;
            recordingsContainer.appendChild(recordDiv);
        });
    }

    console.log('Frontend: DOMContentLoaded - Ready for interaction.');
});

