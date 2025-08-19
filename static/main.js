document.addEventListener('DOMContentLoaded', () => {
    let mediaRecorder;
    let audioChunks = [];
    let socket;
    let recordings = []; // Array of {audioUrl, serverUrl, startTs, stopTs, durationMs, transcripts}
    let currentRecording = null; // Active recording object
    let recordStartTs = null;
    const seenTxKeys = new Set(); // dedupe transcript lines across duplicate events
    let savedCloseTimer = null; // Delay socket close until server confirms save
    // Ensure this flag is in the outer scope so UI buttons can toggle it reliably
    let enableGoogleSpeech = false;
    // Segment timing
    let segmentBuffer = [];
    let lastChunkBlob = null; // unused in timeslice mode
    let segmentStartTs = null; // unused in timeslice mode
    let segmentRotate = false; // when true, onstop restarts recorder with new timeslice

    const startRecordingButton = document.getElementById('startRecording');
    const stopRecordingButton = document.getElementById('stopRecording');
    const startTranscribeButton = document.getElementById('startTranscribe');
    const stopTranscribeButton = document.getElementById('stopTranscribe');
    const transcriptionElement = document.getElementById('transcription');
    const liveTranscriptContainer = document.getElementById('liveTranscriptContainer');
    const recordingsContainer = document.getElementById('recordingsContainer');
    const fullContainer = document.getElementById('fullContainer') || recordingsContainer;
    const segmentContainer = document.getElementById('segmentContainer') || recordingsContainer;
    const chunkContainer = null; // Removed redundant chunk UI
    const toggleGoogleSpeechCheckbox = document.getElementById('toggleGoogleSpeech');
    const segmentLenGroup = document.getElementById('segmentLenGroup');
    const openSegmentModalBtn = document.getElementById('openSegmentModal');
    const segmentModal = document.getElementById('segmentModal');
    const closeSegmentModalBtn = document.getElementById('closeSegmentModal');
    const fullTranscriptContainer = document.getElementById('fullTranscriptContainer');
    // Recorder helpers
    let currentStream = null;
    let recOptions = {};
    let recMimeType = '';
    let segmentTimerId = null;
    
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

    // Segment length control state (radio group)
    let segmentMs = (typeof window !== 'undefined' && typeof window.SEGMENT_MS !== 'undefined') ? window.SEGMENT_MS : 10000;
    if (segmentLenGroup) {
        const radios = segmentLenGroup.querySelectorAll('input[type="radio"][name="segmentLen"]');
        radios.forEach(r => {
            if (Number(r.value) === Number(segmentMs)) r.checked = true;
            r.addEventListener('change', () => {
                const v = Number(r.value);
                if (!Number.isNaN(v) && v >= 5000 && v <= 150000) {
                    segmentMs = v;
                    console.log('Frontend: segmentMs updated via radio:', segmentMs);
                    // If currently recording, rotate MediaRecorder to apply new timeslice
                    try {
                        if (mediaRecorder && mediaRecorder.state === 'recording') {
                            segmentRotate = true;
                            mediaRecorder.stop();
                        }
                    } catch(_) {}
                }
            });
        });
    }
    if (openSegmentModalBtn && segmentModal) openSegmentModalBtn.addEventListener('click', () => { segmentModal.style.display = 'block'; });
    if (closeSegmentModalBtn && segmentModal) closeSegmentModalBtn.addEventListener('click', () => { segmentModal.style.display = 'none'; });

    startRecordingButton.addEventListener('click', async () => {
        startRecordingButton.disabled = true;
        stopRecordingButton.disabled = false;
        startTranscribeButton.disabled = false; // allow transcribe only during recording
        stopTranscribeButton.disabled = true;
        transcriptionElement.innerText = "Transcription: ";
        // Do NOT clear previous full recordings; keep history visible
        // Keep existing full recordings visible; only clear segments UI for the new session
        if (segmentContainer) segmentContainer.innerHTML = '';
        if (chunkContainer) chunkContainer.innerHTML = '';
        if (liveTranscriptContainer) liveTranscriptContainer.innerHTML = '';

        console.log("Frontend: Start Recording button clicked.");

        // Transcription control is via buttons; default off at start
        enableGoogleSpeech = false;
        recordStartTs = Date.now();
        // Pre-create current recording to avoid losing it if 'ready' arrives late
        currentRecording = {
            audioUrl: null,
            serverUrl: null,
            startTs: recordStartTs,
            stopTs: null,
            durationMs: null,
            transcripts: { google: [], googleLive: [], vertex: [], gemini: [] }
        };
        recordings.push(currentRecording);
        try { displayRecordings(); } catch(_) {}

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, sampleRate: 48000 } });
            // Prefer WebM Opus for widest browser support; fallback to OGG Opus
            const preferredTypes = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/ogg;codecs=opus'
            ];
            recOptions = {};
            recMimeType = '';
            if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
                for (const t of preferredTypes) {
                    if (MediaRecorder.isTypeSupported(t)) { recOptions = { mimeType: t }; recMimeType = t; break; }
                }
            }
            currentStream = stream;
            mediaRecorder = new MediaRecorder(currentStream, recOptions);
            audioChunks = [];

            // Build a WebAudio graph to gather 16kHz mono PCM for LINEAR16 streaming
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const source = audioCtx.createMediaStreamSource(stream);
            const processor = audioCtx.createScriptProcessor(4096, 1, 1);
            source.connect(processor);
            processor.connect(audioCtx.destination);
            processor.onaudioprocess = e => {
                if (!enableGoogleSpeech || !socket || socket.readyState !== WebSocket.OPEN) return;
                const input = e.inputBuffer.getChannelData(0);
                // Convert float [-1,1] to 16-bit PCM LE
                const pcm = new Int16Array(input.length);
                for (let i = 0; i < input.length; i++) {
                    let s = Math.max(-1, Math.min(1, input[i]));
                    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                const bytes = new Uint8Array(pcm.buffer);
                // Base64 encode in chunks
                let bin = '';
                const chunk = 0x8000;
                for (let i = 0; i < bytes.length; i += chunk) {
                    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
                }
                const b64 = btoa(bin);
                try { socket.send(JSON.stringify({ pcm16: b64 })); } catch (_) {}
            };

            // Connect WebSocket for streaming chunks BEFORE starting recorder to avoid sending to closed socket
            const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
            socket = new WebSocket(`${wsScheme}://${window.location.host}/ws_stream`);

            socket.onopen = () => {
                console.log('Frontend: Direct WebSocket opened to /ws_stream for audio streaming.');
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
                // Use native timeslice; each ondataavailable blob is a self-contained segment
                try { mediaRecorder.start(segmentMs); console.log('Frontend: MediaRecorder started with segmentMs:', segmentMs); } catch (e) { console.warn('Frontend: start on open failed:', e); }
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
                    // Initialize and register current recording for this session
                    currentRecording = {
                        audioUrl: null,
                        serverUrl: null,
                        startTs: recordStartTs,
                        stopTs: null,
                        durationMs: null,
                        transcripts: {
                            google: [],
                            googleLive: [],
                            vertex: [],
                            gemini: []
                        }
                    };
                    recordings.push(currentRecording);
                    displayRecordings();
                } else if (data.transcript && typeof data.is_final !== 'undefined') {
                    // Live Google streaming transcript (append-only)
                    const line = document.createElement('div');
                    const prefix = data.is_final ? 'Google Live Final:' : 'Google Live:';
                    line.textContent = `${prefix} ${data.transcript}`;
                    if (liveTranscriptContainer) liveTranscriptContainer.appendChild(line);
                    if (currentRecording && data.is_final) {
                        currentRecording.transcripts.googleLive.push(data.transcript);
                        displayRecordings();
                    }
                } else if (data.type === 'chunk_saved' || data.type === 'chunk_transcript') {
                    // Ignore chunk UI updates; chunks are internal
                } else if (data.type === 'segment_saved') {
                    // Render single server-hosted playable audio per segment
                    let segList = document.getElementById('segmentList');
                    if (!segList) {
                        segList = document.createElement('div');
                        segList.id = 'segmentList';
                        (segmentContainer || recordingsContainer).appendChild(segList);
                    }
                    const idx = typeof data.id === 'number' ? data.id : data.idx;
                    const existing = document.getElementById(`segment-${idx}`);
                    const when = (typeof data.ts === 'number') ? new Date(data.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
                    const mime = (typeof data.mime === 'string' && data.mime) ? data.mime : (String(data.url).endsWith('.ogg') ? 'audio/ogg' : 'audio/webm');
                    const html = `Segment ${idx + 1} — ${when}: <audio controls id="segment-audio-${idx}"><source src="${data.url}" type="${mime}"></audio> <a href="${data.url}" download>Download</a>
                    <div id="segment-tx-list-${idx}" class="tx-list"></div>`;
                    if (existing) existing.innerHTML = html; else {
                        const segDiv = document.createElement('div');
                        segDiv.id = `segment-${idx}`;
                        segDiv.innerHTML = html;
                        segList.appendChild(segDiv);
                    }
                    const audioEl = document.getElementById(`segment-audio-${idx}`);
                    try { if (audioEl) audioEl.load(); } catch(_) {}
                    // Show a status row
                    const list = document.getElementById(`segment-tx-list-${idx}`);
                    if (list) {
                        const row = document.createElement('div');
                        row.textContent = '[Status] uploaded';
                        list.appendChild(row);
                    }
                } else if (data.type === 'segment_transcript' || data.type === 'segment_transcript_google') {
                    const idx = typeof data.id === 'number' ? data.id : data.idx;
                    const key = `google:${idx}:${data.transcript || ''}`;
                    if (seenTxKeys.has(key)) return;
                    seenTxKeys.add(key);
                    const list = document.getElementById(`segment-tx-list-${idx}`);
                    if (list) {
                        const row = document.createElement('div');
                        row.textContent = data.transcript ? `Google STT: ${data.transcript}` : 'Google STT: (no text)';
                        list.appendChild(row);
                    }
                    if (currentRecording) { currentRecording.transcripts.google.push(data.transcript || ''); displayRecordings(); }
                } else if (data.type === 'segment_transcript_vertex') {
                    const idx = typeof data.id === 'number' ? data.id : data.idx;
                    const key = `vertex:${idx}:${data.transcript || ''}`;
                    if (seenTxKeys.has(key)) return;
                    seenTxKeys.add(key);
                    const list = document.getElementById(`segment-tx-list-${idx}`);
                    if (list) {
                        const row = document.createElement('div');
                        row.textContent = data.transcript ? `Gemini (Vertex AI): ${data.transcript}` : 'Gemini (Vertex AI): (no text)';
                        list.appendChild(row);
                    }
                    if (currentRecording) { currentRecording.transcripts.vertex.push(data.transcript || ''); displayRecordings(); }
                } else if (data.type === 'segment_transcript_gemini') {
                    const idx = typeof data.id === 'number' ? data.id : data.idx;
                    const key = `gemini:${idx}:${data.transcript || ''}`;
                    if (seenTxKeys.has(key)) return;
                    seenTxKeys.add(key);
                    const list = document.getElementById(`segment-tx-list-${idx}`);
                    if (list) {
                        const row = document.createElement('div');
                        row.textContent = data.transcript ? `Gemini (API): ${data.transcript}` : 'Gemini (API): (no text)';
                        list.appendChild(row);
                    }
                    if (currentRecording) { currentRecording.transcripts.gemini.push(data.transcript || ''); displayRecordings(); }
                } else if (data.type === 'saved') {
                    // Server finalized and saved the recording file
                    const savedUrl = data.url;
                    console.log('Frontend: Server saved recording at:', savedUrl);
                    if (currentRecording) { currentRecording.serverUrl = savedUrl; displayRecordings(); }
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
                // Each event is a complete, standalone segment (timeslice mode)
                if (!event.data || event.data.size < 2048) return; // skip too-small blobs
                console.log('Frontend: Segment available:', event.data.size, 'bytes');
                const segBlob = event.data;
                try { audioChunks.push(segBlob); } catch(_) {}
                const ts = Date.now();
                let segList = document.getElementById('segmentList');
                if (!segList) {
                    segList = document.createElement('div');
                    segList.id = 'segmentList';
                    (segmentContainer || recordingsContainer).appendChild(segList);
                }
                const entry = document.createElement('div');
                entry.id = `segment-${ts}`;
                entry.textContent = `${new Date(ts).toLocaleTimeString()} — uploading...`;
                segList.appendChild(entry);
                try {
                    if (socket.readyState === WebSocket.OPEN) {
                        const arrayBuffer = await segBlob.arrayBuffer();
                        const b64seg = arrayBufferToBase64(arrayBuffer);
                        socket.send(JSON.stringify({ type: 'segment', audio: b64seg, id: ts, ts, mime: segBlob.type }));
                    }
                } catch (e) { console.warn('Frontend: failed to send segment blob', e); }
            };

            mediaRecorder.onstop = async () => {
                console.log('Frontend: MediaRecorder stopped.');
                if (segmentRotate) {
                    segmentRotate = false;
                    // Restart with new segmentMs timeslice
                    try {
                        mediaRecorder = new MediaRecorder(currentStream, recOptions);
                        mediaRecorder.ondataavailable = arguments.callee.bind(null);
                        mediaRecorder.start(segmentMs);
                        console.log('Frontend: MediaRecorder restarted with segmentMs:', segmentMs);
                    } catch (e) { console.warn('Frontend: restart failed:', e); }
                    return;
                }
                const stopTs = Date.now();
                if (currentRecording) { currentRecording.stopTs = stopTs; currentRecording.durationMs = stopTs - (currentRecording.startTs || stopTs); }
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'ping_stop' }));
                    socket.send(JSON.stringify({ end_stream: true }));
                    savedCloseTimer = setTimeout(() => {
                        try {
                            if (socket && socket.readyState === WebSocket.OPEN) socket.close();
                        } catch (_) {}
                    }, 1500);
                }

                const audioBlob = new Blob(audioChunks, { type: recMimeType || 'audio/webm' });
                const audioUrl = URL.createObjectURL(audioBlob);
                console.log('Frontend: Generated audio URL:', audioUrl);

                // Finalize single-session recording
                if (currentRecording) {
                    currentRecording.audioUrl = audioUrl;
                    console.log('Frontend: Updated current recording with audioUrl:', currentRecording);
                }
                displayRecordings(); // Display recordings with the new audio player
                currentRecording = null; // Reset for next session (recordings array keeps history)
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
        if (fullContainer) fullContainer.innerHTML = '';

        recordings.forEach((record, index) => {
            const recordDiv = document.createElement('div');
            recordDiv.className = 'recording-item';
            const startedAt = record.startTs ? new Date(record.startTs).toLocaleTimeString() : '';
            const endedAt = record.stopTs ? new Date(record.stopTs).toLocaleTimeString() : '';
            const dur = record.durationMs ? Math.round(record.durationMs / 1000) : 0;
            const playerAndDownload = `${record.audioUrl ? `<audio controls src="${record.audioUrl}"></audio>` : ''} ${record.serverUrl ? `<a href="${record.serverUrl}" download>Download</a>` : ''}`;
            const googleText = (record.transcripts && record.transcripts.google) ? record.transcripts.google.join(' ') : '';
            const googleLiveText = (record.transcripts && record.transcripts.googleLive) ? record.transcripts.googleLive.join(' ') : '';
            const vertexText = (record.transcripts && record.transcripts.vertex) ? record.transcripts.vertex.join(' ') : '';
            const geminiText = (record.transcripts && record.transcripts.gemini) ? record.transcripts.gemini.join(' ') : '';
            recordDiv.innerHTML = `
                <h3>Recording ${index + 1}</h3>
                <div>${startedAt && endedAt ? `Start: ${startedAt} · End: ${endedAt} · Duration: ${dur}s` : ''}</div>
                <div>${playerAndDownload}</div>
                <div style="margin-top:6px">
                    ${googleLiveText ? `<div>Google Live: ${googleLiveText}</div>` : ''}
                    ${googleText ? `<div>Google STT: ${googleText}</div>` : ''}
                    ${vertexText ? `<div>Gemini (Vertex AI): ${vertexText}</div>` : ''}
                    ${geminiText ? `<div>Gemini (API): ${geminiText}</div>` : ''}
                </div>
                <hr/>
            `;
            (fullContainer || recordingsContainer).appendChild(recordDiv);
        });
    }

    console.log('Frontend: DOMContentLoaded - Ready for interaction.');
});

