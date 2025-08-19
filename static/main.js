document.addEventListener('DOMContentLoaded', () => {
    let mediaRecorder;
    let audioChunks = [];
    let socket;
    let recordings = []; // Array to store recorded audios and their transcriptions
    let currentRecording = null; // Single recording per Start/Stop session
    let savedCloseTimer = null; // Delay socket close until server confirms save
    // Ensure this flag is in the outer scope so UI buttons can toggle it reliably
    let enableGoogleSpeech = false;
    // Buffer client-side chunks into longer segments for playback
    let segmentBuffer = [];
    let segmentStartTs = null;

    const startRecordingButton = document.getElementById('startRecording');
    const stopRecordingButton = document.getElementById('stopRecording');
    const startTranscribeButton = document.getElementById('startTranscribe');
    const stopTranscribeButton = document.getElementById('stopTranscribe');
    const transcriptionElement = document.getElementById('transcription');
    const recordingsContainer = document.getElementById('recordingsContainer');
    const toggleGoogleSpeechCheckbox = document.getElementById('toggleGoogleSpeech');
    const segmentMsInput = document.getElementById('segmentMsInput');
    const segmentMsValue = document.getElementById('segmentMsValue');
    
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
    // Removed authStatus UI; we'll only log masked info to console

    // Log redacted Google auth info on load (from server-injected globals)
    const initialAuthReady = typeof window.GOOGLE_AUTH_READY !== 'undefined' ? window.GOOGLE_AUTH_READY : false;
    const initialAuthInfo = (typeof window.GOOGLE_AUTH_INFO !== 'undefined' && window.GOOGLE_AUTH_INFO) ? window.GOOGLE_AUTH_INFO : {};
    console.log('Frontend: Google auth on load:', { ready: initialAuthReady, info: initialAuthInfo });
    // Only log auth status; do not display in UI

    // This ensures CHUNK_SIZE is available from the backend-rendered script tag
    // Example: <script>let CHUNK_SIZE = 1600;</script>
    // No explicit declaration here as it's provided by app.py

    // Segment length control state
    let segmentMs = (typeof window !== 'undefined' && typeof window.SEGMENT_MS !== 'undefined') ? window.SEGMENT_MS : 3000;
    if (segmentMsInput && segmentMsValue) {
        try { segmentMsInput.value = String(segmentMs); segmentMsValue.textContent = String(segmentMs); } catch(_) {}
        segmentMsInput.addEventListener('input', () => {
            const v = Number(segmentMsInput.value);
            if (!Number.isNaN(v) && v >= 250 && v <= 20000) {
                segmentMs = v;
                segmentMsValue.textContent = String(segmentMs);
                console.log('Frontend: segmentMs updated:', segmentMs);
                // Reset current aggregation so the next segment starts fresh
                segmentBuffer = [];
                segmentStartTs = null;
            }
        });
    }

    startRecordingButton.addEventListener('click', async () => {
        startRecordingButton.disabled = true;
        stopRecordingButton.disabled = false;
        startTranscribeButton.disabled = false; // allow transcribe only during recording
        stopTranscribeButton.disabled = true;
        transcriptionElement.innerText = "Transcription: ";
        recordingsContainer.innerHTML = ''; // Clear previous recordings on new start

        console.log("Frontend: Start Recording button clicked.");

        // Transcription control is via buttons; default off at start
        enableGoogleSpeech = false;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const preferredType = 'audio/webm; codecs=opus';
            const options = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(preferredType)) ? { mimeType: preferredType } : {};
            mediaRecorder = new MediaRecorder(stream, options);
            audioChunks = [];

            // Connect WebSocket for streaming chunks BEFORE starting recorder to avoid sending to closed socket
            const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
            socket = new WebSocket(`${wsScheme}://${window.location.host}/ws_stream`);

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
                // Start the recorder now that socket is open
                try { mediaRecorder.start(CHUNK_MS); console.log('Frontend: MediaRecorder started with CHUNK_MS after socket open:', CHUNK_MS); } catch (e) { console.warn('Frontend: start on open failed:', e); }
            };

            socket.onmessage = event => {
                console.log('Frontend: Received WebSocket message:', event.data);
                let data = null;
                try {
                    data = JSON.parse(event.data);
                } catch (e) {
                    // Ignore plain-text messages to avoid double starts
                    console.warn('Frontend: Non-JSON message received and ignored.');
                    return;
                }
                console.log('Frontend: Parsed WebSocket data:', data);

                if (data.type === "ready") {
                    console.log('Frontend: Backend ready signal received. Recorder status:', mediaRecorder.state);
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
                    // If there is a per-chunk entry, append transcript to it
                    const chunkList = document.getElementById('chunkList');
                    if (chunkList) {
                        const lastChunk = chunkList.querySelector('div:last-child span[id^="chunk-tx-"]');
                        if (lastChunk) lastChunk.textContent = ` — ${data.transcript}`;
                    }
                } else if (data.type === 'chunk_saved') {
                    // Render chunk list below segment list
                    console.log('Frontend: Server saved chunk:', data);
                    const idx = data.idx;
                    let segList = document.getElementById('segmentList');
                    let chunkList = document.getElementById('chunkList');
                    if (!chunkList) {
                        chunkList = document.createElement('div');
                        chunkList.id = 'chunkList';
                        if (segList && segList.parentNode) segList.parentNode.insertBefore(chunkList, segList.nextSibling);
                        else recordingsContainer.parentNode.insertBefore(chunkList, recordingsContainer);
                        chunkList.style.display = 'flex';
                        chunkList.style.flexWrap = 'wrap';
                        chunkList.style.gap = '8px';
                    }
                    const entry = document.createElement('div');
                    entry.id = `chunk-${idx}`;
                    entry.innerHTML = `Chunk ${idx + 1} <span id="chunk-tx-${idx}"></span>`;
                    entry.style.display = 'inline-block';
                    chunkList.appendChild(entry);
                } else if (data.type === 'chunk_transcript') {
                    const el = document.getElementById(`chunk-tx-${data.idx}`);
                    if (el) el.textContent = data.transcript ? ` — ${data.transcript}` : '';
                } else if (data.type === 'segment_saved') {
                    // Render single server-hosted playable audio per segment
                    let segList = document.getElementById('segmentList');
                    if (!segList) {
                        segList = document.createElement('div');
                        segList.id = 'segmentList';
                        recordingsContainer.parentNode.insertBefore(segList, recordingsContainer);
                    }
                    const idx = data.idx;
                    const existing = document.getElementById(`segment-${idx}`);
                    const html = `Segment ${idx + 1}: <audio controls src="${data.url}"></audio> <a href="${data.url}" download>Download</a> <span id="segment-tx-${idx}"></span>`;
                    if (existing) existing.innerHTML = html; else {
                        const segDiv = document.createElement('div');
                        segDiv.id = `segment-${idx}`;
                        segDiv.innerHTML = html;
                        segList.appendChild(segDiv);
                    }
                } else if (data.type === 'segment_transcript') {
                    const el = document.getElementById(`segment-tx-${data.idx}`);
                    if (el) el.textContent = data.transcript ? ` — ${data.transcript}` : '';
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
                } else if (data.type === 'status') {
                    // Show server-side status messages (e.g., "Transcribing...")
                    transcriptionElement.innerText = `Transcription: ${data.message}`;
                } else if (data.type === 'auth') {
                    const ready = !!data.ready;
                    const info = data.info || {};
                    const project = info.project_id || '';
                    const email = info.client_email_masked || '';
                    const key = info.private_key_id_masked || '';
                    console.log('Frontend: Google auth status:', { ready, project, email, key });
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

            function arrayBufferToBase64(buffer) {
                const bytes = new Uint8Array(buffer);
                const chunkSize = 0x8000; // 32KB
                const chunks = [];
                for (let i = 0; i < bytes.length; i += chunkSize) {
                    const sub = bytes.subarray(i, i + chunkSize);
                    chunks.push(String.fromCharCode.apply(null, sub));
                }
                return btoa(chunks.join(''));
            }

            mediaRecorder.ondataavailable = async event => {
                console.log('Frontend: Data available:', event.data.size, 'bytes');
                console.log('Frontend: MediaRecorder mimeType:', mediaRecorder.mimeType);
                audioChunks.push(event.data);
                console.log('Frontend: Current audioChunks length:', audioChunks.length);
                // Client-side segmenting for better playback experience
                const now = Date.now();
                if (segmentStartTs === null) segmentStartTs = now;
                segmentBuffer.push(event.data);
                if (now - segmentStartTs >= segmentMs) {
                    try {
                        const segBlob = new Blob(segmentBuffer, { type: (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : 'audio/webm;codecs=opus' });
                        let segList = document.getElementById('segmentList');
                        if (!segList) {
                            segList = document.createElement('div');
                            segList.id = 'segmentList';
                            recordingsContainer.parentNode.insertBefore(segList, recordingsContainer);
                        }
                        const idx = segList.childElementCount;
                        const entry = document.createElement('div');
                        entry.id = `segment-${idx}`;
                        entry.textContent = `Segment ${idx + 1} (uploading...)`;
                        segList.appendChild(entry);
                        // Also upload the segment to server so it is playable from server
                        if (socket.readyState === WebSocket.OPEN) {
                            const arrayBuffer = await segBlob.arrayBuffer();
                            const b64seg = arrayBufferToBase64(arrayBuffer);
                            socket.send(JSON.stringify({ type: 'segment', audio: b64seg, id: idx }));
                        }
                    } catch (e) { console.warn('Frontend: failed to create/send segment blob', e); }
                    segmentBuffer = [];
                    segmentStartTs = now;
                }
                if (socket.readyState === WebSocket.OPEN) {
                    console.log('Frontend: Sending audio data. WebSocket readyState:', socket.readyState, 'Chunk size:', event.data.size);
                    try {
                        const arrayBuffer = await event.data.arrayBuffer();
                        const b64 = arrayBufferToBase64(arrayBuffer);
                        socket.send(JSON.stringify({ audio: b64, enable_google_speech: enableGoogleSpeech }));
                    } catch (e) {
                        console.error('Frontend: Failed to convert/send chunk:', e);
                    }
                } else {
                    console.warn('Frontend: WebSocket not open. readyState:', socket.readyState, 'Not sending data.');
                }
            };

            mediaRecorder.onstop = async () => {
                console.log('Frontend: MediaRecorder stopped. Finalizing audio.');
                // Flush remaining segment buffer as a playable segment
                if (segmentBuffer.length) {
                    try {
                        const segBlob = new Blob(segmentBuffer, { type: (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : 'audio/webm;codecs=opus' });
                        let segList = document.getElementById('segmentList');
                        if (!segList) {
                            segList = document.createElement('div');
                            segList.id = 'segmentList';
                            recordingsContainer.parentNode.insertBefore(segList, recordingsContainer);
                        }
                        const idx = segList.childElementCount;
                        const entry = document.createElement('div');
                        entry.id = `segment-${idx}`;
                        entry.textContent = `Segment ${idx + 1} (uploading...)`;
                        segList.appendChild(entry);
                        // Upload final segment to server
                        if (socket.readyState === WebSocket.OPEN) {
                            const arrayBuffer = await segBlob.arrayBuffer();
                            const b64seg = arrayBufferToBase64(arrayBuffer);
                            socket.send(JSON.stringify({ type: 'segment', audio: b64seg, id: idx }));
                        }
                    } catch (e) { console.warn('Frontend: failed to flush segment', e); }
                    segmentBuffer = [];
                    segmentStartTs = null;
                }
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
        startTranscribeButton.disabled = true; // disable transcribe controls when not recording
        stopTranscribeButton.disabled = true;
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

