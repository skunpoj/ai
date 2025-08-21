// main.js is loaded as type="module" from app.py
import { getServices } from '/static/ui/services.js';
import { bytesToLabel } from '/static/ui/format.js';
import { ensureTab as ensureUITab, activateTab as activateUITab } from '/static/ui/tabs.js';
import { renderRecordingPanel as renderPanel } from '/static/ui/renderers.js';
import { buildWSUrl, parseWSMessage, sendJSON, arrayBufferToBase64 } from '/static/ui/ws.js';

// Main frontend controller: wires recording controls, websocket, segments loop,
// tabbed UI, and dynamic provider columns.
document.addEventListener('DOMContentLoaded', () => {
    let mediaRecorder; // Continuous full recorder
    let audioChunks = [];
    let fullRecorder; // alias for clarity; use mediaRecorder as full recorder
    let fullChunks = [];
    let segmentRecorder = null;
    let segmentLoopActive = false;
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
    // Removed client-side ETag caches; htmx triggers drive updates declaratively

    const startRecordingButton = document.getElementById('startRecording');
    const stopRecordingButton = document.getElementById('stopRecording');
    const startTranscribeButton = document.getElementById('startTranscribe');
    const stopTranscribeButton = document.getElementById('stopTranscribe');
    const autoTranscribeToggle = document.getElementById('autoTranscribeToggle');
    const transcriptionElement = document.getElementById('transcription');
    const liveTranscriptContainer = document.getElementById('liveTranscriptContainer');
    const recordingsContainer = document.getElementById('recordingsContainer');
    const tabsBar = document.getElementById('recordTabs');
    const panelsHost = document.getElementById('recordPanels');
    const chunkContainer = null; // Removed redundant chunk UI
    const toggleGoogleSpeechCheckbox = document.getElementById('toggleGoogleSpeech');
    const segmentLenGroup = document.getElementById('segmentLenGroup');
    const openSegmentModalBtn = document.getElementById('openSegmentModal');
    const segmentModal = document.getElementById('segmentModal');
    const closeSegmentModalBtn = document.getElementById('closeSegmentModal');
    const fullTranscriptContainer = document.getElementById('fullTranscriptContainer');
    const serviceAdminRoot = null; // removed separate admin; now in modal
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
                if (!Number.isNaN(v) && v >= 5000 && v <= 300000) {
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
    if (openSegmentModalBtn && segmentModal) openSegmentModalBtn.addEventListener('click', async () => {
        segmentModal.style.display = 'block';
        // Initialize provider checkboxes to reflect backend registry
        try {
            const map = {
                google: document.getElementById('svc_google'),
                vertex: document.getElementById('svc_vertex'),
                gemini: document.getElementById('svc_gemini'),
                aws: document.getElementById('svc_aws')
            };
            const svcs = await getServices();
            svcs.forEach(s => { if (map[s.key]) map[s.key].checked = !!s.enabled; });
        } catch (_) {}
    });
    if (closeSegmentModalBtn && segmentModal) closeSegmentModalBtn.addEventListener('click', () => { segmentModal.style.display = 'none'; });

    // Wire provider toggles in modal to backend
    async function wireProviderModal() {
        const map = {
            google: document.getElementById('svc_google'),
            vertex: document.getElementById('svc_vertex'),
            gemini: document.getElementById('svc_gemini'),
            aws: document.getElementById('svc_aws')
        };
        for (const [key, el] of Object.entries(map)) {
            if (!el) continue;
            el.addEventListener('change', async () => {
                try {
                    await fetch('/services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, enabled: el.checked }) });
                    if (currentRecording) await renderRecordingPanel(currentRecording);
                } catch (e) { console.warn('Provider toggle failed', key); }
            });
        }
    }
    wireProviderModal();

    // Start a new recording session; create a new tab immediately,
    // connect the websocket, and start the full and segment recorders.
    startRecordingButton.addEventListener('click', async () => {
        startRecordingButton.disabled = true;
        stopRecordingButton.disabled = false;
        startTranscribeButton.disabled = false; // allow transcribe only during recording
        stopTranscribeButton.disabled = true;
        if (transcriptionElement) transcriptionElement.innerText = "";
        // Do NOT clear previous recordings; new recording gets its own tab
        if (chunkContainer) chunkContainer.innerHTML = '';
        if (liveTranscriptContainer) liveTranscriptContainer.innerHTML = '';

        console.log("Frontend: Start Recording button clicked.");

        // Transcription control is via buttons; default off at start
        enableGoogleSpeech = false;
        recordStartTs = Date.now();
        currentRecording = {
            id: `rec-${recordStartTs}`,
            audioUrl: null,
            serverUrl: null,
            serverSizeBytes: null,
            clientSizeBytes: null,
            startTs: recordStartTs,
            stopTs: null,
            durationMs: null,
            segments: [],
            transcripts: { google: [], googleLive: [], vertex: [], gemini: [] },
            fullAppend: { googleLive: '', google: '', vertex: '', gemini: '' }
        };
        recordings.push(currentRecording);
        ensureRecordingTab(currentRecording);
        renderRecordingPanel(currentRecording);

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
            // Full recorder (continuous) collects fullChunks for final full recording
            mediaRecorder = new MediaRecorder(currentStream, recOptions);
            fullChunks = [];
            mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size) fullChunks.push(e.data);
            };

            // Build AudioWorklet graph for PCM16 capture (replaces deprecated ScriptProcessorNode)
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            try { await audioCtx.audioWorklet.addModule('/static/audio/pcm-worklet.js'); } catch (e) { console.warn('Frontend: failed to add worklet, falling back', e); }
            if (audioCtx.audioWorklet) {
            const source = audioCtx.createMediaStreamSource(stream);
                const workletNode = new AudioWorkletNode(audioCtx, 'pcm16-worklet', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
                workletNode.port.onmessage = ev => {
                if (!enableGoogleSpeech || !socket || socket.readyState !== WebSocket.OPEN) return;
                    const bytes = new Uint8Array(ev.data);
                let bin = '';
                const chunk = 0x8000;
                for (let i = 0; i < bytes.length; i += chunk) {
                    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
                }
                const b64 = btoa(bin);
                try { socket.send(JSON.stringify({ pcm16: b64 })); } catch (_) {}
            };
                source.connect(workletNode);
                workletNode.connect(audioCtx.destination);
            }

            // Connect WebSocket for streaming chunks BEFORE starting recorder to avoid sending to closed socket
            const wsUrl = buildWSUrl(window.location, '/ws_stream');
            socket = new WebSocket(wsUrl);

            socket.onopen = () => {
                console.log('Frontend: Direct WebSocket opened to /ws_stream for audio streaming.');
                // MediaRecorder.start() will be called only after 'ready' signal from backend
                try {
                    sendJSON(socket, { type: 'hello' });
                    console.log('Frontend: Sent hello handshake.');
                } catch (e) {
                    console.warn('Frontend: Failed to send hello handshake:', e);
                }
                connStatus.innerText = 'WebSocket: open';
                startTranscribeButton.disabled = false;
                stopTranscribeButton.disabled = false;
                // If Auto Transcribe is ON, immediately start transcribing
                if (autoTranscribeToggle && autoTranscribeToggle.checked) {
                    try { sendJSON(socket, { type: 'transcribe', enabled: true }); } catch(_) {}
                    startTranscribeButton.style.display = 'none';
                    stopTranscribeButton.style.display = 'none';
                } else {
                    startTranscribeButton.style.display = '';
                    stopTranscribeButton.style.display = '';
                }
                // Start continuous full recorder
                try { mediaRecorder.start(); console.log('Frontend: Full recorder started (continuous).'); } catch (e) { console.warn('Frontend: start on open failed:', e); }
                // Start per-segment recorder loop to guarantee fresh headers/footers per segment
                startSegmentLoop();
            };

            // WebSocket message handler: updates UI and recording state
            socket.onmessage = async event => {
                console.log('Frontend: Received WebSocket message:', event.data);
                const data = parseWSMessage(event);
                if (!data) return;
                console.log('Frontend: Parsed WebSocket data:', data);

                if (data.type === "ready") {
                    console.log('Frontend: Backend ready signal received. Recorder status:', mediaRecorder.state);
                    try {
                        sendJSON(socket, { type: 'ping_start' });
                        console.log('Frontend: Sent ping_start.');
                    } catch (e) {
                        console.warn('Frontend: Failed to send ping_start:', e);
                    }
                    // Ensure auto transcribe engages after backend signals ready
                    if (autoTranscribeToggle && autoTranscribeToggle.checked) {
                        try { sendJSON(socket, { type: 'transcribe', enabled: true }); } catch (_) {}
                        if (startTranscribeButton && stopTranscribeButton) {
                            startTranscribeButton.style.display = 'none';
                            stopTranscribeButton.style.display = 'none';
                        }
                    }
                    // Ensure we have a current recording created on start; just refresh UI
                    ensureRecordingTab(currentRecording);
                    renderRecordingPanel(currentRecording);
                } else if (data.transcript && typeof data.is_final !== 'undefined') {
                    // Live Google streaming transcript (append-only)
                    const line = document.createElement('div');
                    const prefix = data.is_final ? 'Google Live Final:' : 'Google Live:';
                    line.textContent = `${prefix} ${data.transcript}`;
                    if (liveTranscriptContainer) liveTranscriptContainer.appendChild(line);
                    if (currentRecording && data.is_final) {
                        currentRecording.transcripts.googleLive.push(data.transcript);
                        currentRecording.fullAppend.googleLive = `${currentRecording.fullAppend.googleLive}${currentRecording.fullAppend.googleLive ? ' ' : ''}${data.transcript}`;
                        renderRecordingPanel(currentRecording);
                    }
                } else if (data.type === 'chunk_saved' || data.type === 'chunk_transcript') {
                    // Ignore chunk UI updates; chunks are internal
                } else if (data.type === 'segment_saved') {
                    // Render single server-hosted playable audio per segment
                    const segIndex = (typeof data.idx === 'number') ? data.idx : data.id;
                    const mime = (typeof data.mime === 'string' && data.mime) ? data.mime : (String(data.url).endsWith('.ogg') ? 'audio/ogg' : 'audio/webm');
                    if (currentRecording) {
                        while (currentRecording.segments.length <= segIndex) currentRecording.segments.push(null);
                        const startMs = typeof data.ts === 'number' ? data.ts : Date.now();
                        const endMs = startMs + (typeof segmentMs === 'number' ? segmentMs : 10000);
                        currentRecording.segments[segIndex] = { idx: segIndex, url: data.url, mime, size: data.size || null, ts: data.ts, startMs, endMs, clientId: data.id };
                        // Refresh only the affected row
                        await refreshSegmentRow(currentRecording, segIndex);
                    }
                } else if (data.type === 'segment_transcript' || data.type === 'segment_transcript_google') {
                    const segIndex = (typeof data.idx === 'number') ? data.idx : data.id;
                    const key = `google:${segIndex}:${data.transcript || ''}`;
                    if (seenTxKeys.has(key)) return;
                    seenTxKeys.add(key);
                    if (currentRecording) {
                        while (currentRecording.transcripts.google.length <= segIndex) currentRecording.transcripts.google.push('');
                        currentRecording.transcripts.google[segIndex] = data.transcript || '';
                        if (data.transcript) currentRecording.fullAppend.google = `${currentRecording.fullAppend.google}${currentRecording.fullAppend.google ? ' ' : ''}${data.transcript}`.trim();
                        // Client-side in-place update
                        const row = document.getElementById(`segrow-${currentRecording.id}-${segIndex}`);
                        if (row) {
                            const td = row.querySelector('td[data-svc="google"]');
                            if (td) td.textContent = currentRecording.transcripts.google[segIndex] || '';
                        }
                        const full = document.querySelector(`#fulltable-${currentRecording.id} td[data-svc="google"]`);
                        if (full) {
                            full.textContent = currentRecording.fullAppend.google || '';
                            const fs = document.getElementById(`fullstatus-${currentRecording.id}`);
                            if (fs) fs.style.display = 'none';
                        }
                    }
                } else if (data.type === 'segment_transcript_vertex') {
                    const segIndex = (typeof data.idx === 'number') ? data.idx : data.id;
                    const key = `vertex:${segIndex}:${data.transcript || ''}`;
                    if (seenTxKeys.has(key)) return;
                    seenTxKeys.add(key);
                    if (currentRecording) {
                        while (currentRecording.transcripts.vertex.length <= segIndex) currentRecording.transcripts.vertex.push('');
                        currentRecording.transcripts.vertex[segIndex] = data.transcript || '';
                        if (data.transcript) currentRecording.fullAppend.vertex = `${currentRecording.fullAppend.vertex}${currentRecording.fullAppend.vertex ? ' ' : ''}${data.transcript}`.trim();
                        const row = document.getElementById(`segrow-${currentRecording.id}-${segIndex}`);
                        if (row) {
                            const td = row.querySelector('td[data-svc="vertex"]');
                            if (td) td.textContent = currentRecording.transcripts.vertex[segIndex] || '';
                        }
                        const full = document.querySelector(`#fulltable-${currentRecording.id} td[data-svc="vertex"]`);
                        if (full) {
                            full.textContent = currentRecording.fullAppend.vertex || '';
                            const fs = document.getElementById(`fullstatus-${currentRecording.id}`);
                            if (fs) fs.style.display = 'none';
                        }
                    }
                } else if (data.type === 'segment_transcript_gemini') {
                    const segIndex = (typeof data.idx === 'number') ? data.idx : data.id;
                    const key = `gemini:${segIndex}:${data.transcript || ''}`;
                    if (seenTxKeys.has(key)) return;
                    seenTxKeys.add(key);
                    if (currentRecording) {
                        while (currentRecording.transcripts.gemini.length <= segIndex) currentRecording.transcripts.gemini.push('');
                        currentRecording.transcripts.gemini[segIndex] = data.transcript || '';
                        if (data.transcript) currentRecording.fullAppend.gemini = `${currentRecording.fullAppend.gemini}${currentRecording.fullAppend.gemini ? ' ' : ''}${data.transcript}`.trim();
                        const row = document.getElementById(`segrow-${currentRecording.id}-${segIndex}`);
                        if (row) {
                            const td = row.querySelector('td[data-svc="gemini"]');
                            if (td) td.textContent = currentRecording.transcripts.gemini[segIndex] || '';
                        }
                        const full = document.querySelector(`#fulltable-${currentRecording.id} td[data-svc="gemini"]`);
                        if (full) {
                            full.textContent = currentRecording.fullAppend.gemini || '';
                            const fs = document.getElementById(`fullstatus-${currentRecording.id}`);
                            if (fs) fs.style.display = 'none';
                        }
                    }
                } else if (data.type === 'saved') {
                    // Server finalized and saved the recording file
                    const savedUrl = data.url;
                    console.log('Frontend: Server saved recording at:', savedUrl);
                    if (currentRecording) {
                        currentRecording.serverUrl = savedUrl;
                        if (typeof data.size === 'number') currentRecording.serverSizeBytes = data.size;
                        // Update download link and size inline
                        const meta = document.getElementById(`recordmeta-${currentRecording.id}`);
                        if (meta) {
                            const size = (typeof currentRecording.serverSizeBytes === 'number' && currentRecording.serverSizeBytes > 0) ? currentRecording.serverSizeBytes : currentRecording.clientSizeBytes || 0;
                            const human = size >= 1048576 ? `${(size/1048576).toFixed(1)} MB` : (size >= 1024 ? `${Math.round(size/1024)} KB` : `${size} B`);
                            meta.innerHTML = `${currentRecording.audioUrl ? `<audio controls src="${currentRecording.audioUrl}"></audio>` : ''} ${currentRecording.serverUrl ? `<a href="${currentRecording.serverUrl}" download>Download</a>` : ''} ${size ? `(${human})` : ''}`;
                        }
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
                    // Redundant, indicator lives near full record title
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

            /**
             * Encode an ArrayBuffer into base64 string for transport
             * @param {ArrayBuffer} buffer
             * @returns {string}
             */
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

            /**
             * Start the per-segment recorder loop. Each iteration records a short
             * container (WebM/OGG) so server-side STT handles clean headers.
             */
            function startSegmentLoop() {
                if (segmentLoopActive) return;
                segmentLoopActive = true;
                const loopOnce = () => {
                    if (!segmentLoopActive) return;
                    const ts = Date.now();
                    try { segmentRecorder = new MediaRecorder(currentStream, recOptions); } catch (e) { console.warn('Frontend: segmentRecorder create failed:', e); segmentLoopActive = false; return; }
                    let segBlob = null;
                    segmentRecorder.ondataavailable = (e) => { if (e.data && e.data.size) segBlob = e.data; };
                    segmentRecorder.onstop = async () => {
                        if (segBlob && segBlob.size) {
                            console.log('Frontend: Segment available:', segBlob.size, 'bytes');
                            // UI for segments handled in renderRecordingPanel upon server echo
                            try {
                                if (socket.readyState === WebSocket.OPEN) {
                                    const arrayBuffer = await segBlob.arrayBuffer();
                                    const b64seg = arrayBufferToBase64(arrayBuffer);
                                    socket.send(JSON.stringify({ type: 'segment', audio: b64seg, id: ts, ts, mime: segBlob.type }));
                                }
                            } catch (_) {}
                        }
                        if (segmentLoopActive) setTimeout(loopOnce, 0);
                    };
                    try { segmentRecorder.start(); } catch (e) { console.warn('Frontend: segmentRecorder start failed:', e); segmentLoopActive = false; return; }
                    setTimeout(() => { try { if (segmentRecorder && segmentRecorder.state === 'recording') segmentRecorder.stop(); } catch (_) {} }, segmentMs);
                };
                loopOnce();
            }

            /**
             * Stop the repeating segment recorder loop.
             */
            function stopSegmentLoop() {
                segmentLoopActive = false;
                try { if (segmentRecorder && segmentRecorder.state === 'recording') segmentRecorder.stop(); } catch (_) {}
            }

            // Finalize the full recording; upload the blob, and close the socket
            mediaRecorder.onstop = async () => {
                console.log('Frontend: MediaRecorder stopped.');
                if (segmentRotate) { segmentRotate = false; stopSegmentLoop(); startSegmentLoop(); return; }
                const stopTs = Date.now();
                if (currentRecording) { currentRecording.stopTs = stopTs; currentRecording.durationMs = stopTs - (currentRecording.startTs || stopTs); }

                stopSegmentLoop();
                const audioBlob = new Blob(fullChunks, { type: recMimeType || 'audio/webm' });
                const audioUrl = URL.createObjectURL(audioBlob);
                console.log('Frontend: Generated audio URL:', audioUrl);

                // Finalize single-session recording
                if (currentRecording) {
                    currentRecording.audioUrl = audioUrl;
                    currentRecording.clientSizeBytes = audioBlob.size;
                    console.log('Frontend: Updated current recording with audioUrl:', currentRecording);
                }
                // Upload full recording before closing socket
                try {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        const fullBuf = await audioBlob.arrayBuffer();
                        const b64full = arrayBufferToBase64(fullBuf);
                        sendJSON(socket, { type: 'full_upload', audio: b64full, mime: recMimeType || 'audio/webm' });
                    }
                } catch (_) {}
                if (socket.readyState === WebSocket.OPEN) {
                    sendJSON(socket, { type: 'ping_stop' });
                    sendJSON(socket, { end_stream: true });
                    savedCloseTimer = setTimeout(() => {
                        try {
                            if (socket && socket.readyState === WebSocket.OPEN) socket.close();
                        } catch (_) {}
                    }, 1500);
                }
                if (currentRecording) renderRecordingPanel(currentRecording);
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
        if (autoTranscribeToggle && autoTranscribeToggle.checked) {
            // Ensure we notify backend to stop transcribe when auto mode ends
            try { if (socket && socket.readyState === WebSocket.OPEN) sendJSON(socket, { type: 'transcribe', enabled: false }); } catch(_) {}
        }
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
    // Auto Transcribe Toggle (checkbox, default ON)
    if (autoTranscribeToggle) {
        const applyAutoState = () => {
            const isOn = !!autoTranscribeToggle.checked;
            if (isOn) {
                startTranscribeButton.style.display = 'none';
                stopTranscribeButton.style.display = 'none';
                // If socket open and recording, start transcribe
                try { if (socket && socket.readyState === WebSocket.OPEN) sendJSON(socket, { type: 'transcribe', enabled: true }); } catch(_) {}
            } else {
                startTranscribeButton.style.display = '';
                stopTranscribeButton.style.display = '';
            }
        };
        autoTranscribeToggle.addEventListener('change', applyAutoState);
        // Apply initial state from server (checked by default)
        applyAutoState();
    }
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

    // Manual connection check button (inside modal)
    if (testConnBtn) testConnBtn.addEventListener('click', () => {
        if (!socket) { alert('Socket not created yet. Click Start Recording first.'); return; }
        try { socket.send(JSON.stringify({ type: 'ping' })); connStatus.innerText = 'WebSocket: ping sent'; }
        catch (e) { console.warn('Frontend: ping send failed:', e); connStatus.innerText = 'WebSocket: ping failed'; }
    });

    /**
     * Ensure a tab/panel exists for the provided record
     * @param {object} record
     */
    function ensureRecordingTab(record) { if (!tabsBar || !panelsHost) return; ensureUITab(tabsBar, panelsHost, record); }
    /**
     * Activate the tab for a given record id
     * @param {string} recordId
     */
    function activateTab(recordId) { if (!tabsBar || !panelsHost) return; activateUITab(tabsBar, panelsHost, recordId); }

    /**
     * Render the panel for a given recording by delegating to UI renderer module
     * @param {object} record
     * @returns {Promise<void>}
     */
    async function renderRecordingPanel(record) {
        ensureRecordingTab(record);
        const panelId = `panel-${record.id}`;
        // Render client-side to avoid initial server 400, but keep hx-enabled fragments for subsequent server updates
        try { await renderPanel(record); } catch (_) {}
        // After panel render, trigger initial full and rows refresh via htmx triggers, but only once nodes exist
        setTimeout(() => {
            const fullEl = document.getElementById(`fulltable-${record.id}`);
            if (fullEl) htmx.trigger(fullEl, 'refresh-full', { detail: { record: JSON.stringify(record) } });
            const maxSeg = Math.max(
                record.segments.length,
                record.transcripts.google.length,
                record.transcripts.vertex.length,
                record.transcripts.gemini.length,
                (record.transcripts.aws || []).length
            );
            for (let i = 0; i < maxSeg; i++) {
                const row = document.getElementById(`segrow-${record.id}-${i}`);
                if (row) htmx.trigger(row, 'refresh-row', { detail: { record: JSON.stringify(record), idx: i } });
            }
        }, 0);
    }

    async function refreshFullRow(record) {
        const table = document.getElementById(`fulltable-${record.id}`);
        if (!table) return;
        // Post fresh values so server renders current snapshot
        htmx.ajax('POST', '/render/full_row', { target: table, values: { record: JSON.stringify(record) }, swap: 'innerHTML' });
    }

    async function refreshSegmentRows(record) {
        const maxSeg = Math.max(
            record.segments.length,
            record.transcripts.google.length,
            record.transcripts.vertex.length,
            record.transcripts.gemini.length,
            (record.transcripts.aws || []).length
        );
        for (let i = 0; i < maxSeg; i++) {
            await refreshSegmentRow(record, i);
        }
    }

    async function refreshSegmentRow(record, idx) {
        const rowId = `segrow-${record.id}-${idx}`;
        const rowEl = document.getElementById(rowId);
        if (!rowEl) {
            // Create rows by re-rendering panel once, then attempt swap
            await renderRecordingPanel(record);
        }
        const target = document.getElementById(rowId);
        if (!target) return;
        // Post fresh values so server renders current snapshot
        htmx.ajax('POST', '/render/segment_row', { target, values: { record: JSON.stringify(record), idx }, swap: 'outerHTML' });
    }

    function displayRecordings() {
        // Kept for compatibility if other code calls it; re-render active panel if any currentRecording
        if (currentRecording) renderRecordingPanel(currentRecording);
    }

    console.log('Frontend: DOMContentLoaded - Ready for interaction.');
});

