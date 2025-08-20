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

    const startRecordingButton = document.getElementById('startRecording');
    const stopRecordingButton = document.getElementById('stopRecording');
    const startTranscribeButton = document.getElementById('startTranscribe');
    const stopTranscribeButton = document.getElementById('stopTranscribe');
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
    const serviceAdminRoot = document.getElementById('serviceAdmin');
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
    if (openSegmentModalBtn && segmentModal) openSegmentModalBtn.addEventListener('click', () => { segmentModal.style.display = 'block'; });
    if (closeSegmentModalBtn && segmentModal) closeSegmentModalBtn.addEventListener('click', () => { segmentModal.style.display = 'none'; });

    // Admin: load and render service toggles
    /**
     * Render admin service toggles and wire POST /services to enable/disable providers.
     * @returns {Promise<void>}
     */
    async function loadAndRenderServiceAdmin() {
        if (!serviceAdminRoot) return;
        const svcs = await getServices();
        serviceAdminRoot.innerHTML = '';
        const container = document.createElement('div');
        svcs.forEach(svc => {
            const row = document.createElement('div');
            row.style.marginBottom = '4px';
            const label = document.createElement('label');
            label.style.display = 'inline-flex';
            label.style.alignItems = 'center';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!svc.enabled;
            cb.addEventListener('change', async () => {
                try {
                    await fetch('/services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: svc.key, enabled: cb.checked }) });
                    // Re-render current panel so columns can update if needed
                    if (currentRecording) await renderRecordingPanel(currentRecording);
                } catch (e) { console.warn('Admin: toggle failed', e); }
            });
            const span = document.createElement('span');
            span.textContent = ` ${svc.label} (${svc.key})`;
            label.appendChild(cb);
            label.appendChild(span);
            row.appendChild(label);
            container.appendChild(row);
        });
        serviceAdminRoot.appendChild(container);
    }
    loadAndRenderServiceAdmin();

    // Start a new recording session; create a new tab immediately,
    // connect the websocket, and start the full and segment recorders.
    startRecordingButton.addEventListener('click', async () => {
        startRecordingButton.disabled = true;
        stopRecordingButton.disabled = false;
        startTranscribeButton.disabled = false; // allow transcribe only during recording
        stopTranscribeButton.disabled = true;
        transcriptionElement.innerText = "Transcription: ";
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
                // Start continuous full recorder
                try { mediaRecorder.start(); console.log('Frontend: Full recorder started (continuous).'); } catch (e) { console.warn('Frontend: start on open failed:', e); }
                // Start per-segment recorder loop to guarantee fresh headers/footers per segment
                startSegmentLoop();
            };

            // WebSocket message handler: updates UI and recording state
            socket.onmessage = event => {
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
                        renderRecordingPanel(currentRecording);
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
                        renderRecordingPanel(currentRecording);
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
                        renderRecordingPanel(currentRecording);
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
                        renderRecordingPanel(currentRecording);
                    }
                } else if (data.type === 'saved') {
                    // Server finalized and saved the recording file
                    const savedUrl = data.url;
                    console.log('Frontend: Server saved recording at:', savedUrl);
                    if (currentRecording) {
                        currentRecording.serverUrl = savedUrl;
                        if (typeof data.size === 'number') currentRecording.serverSizeBytes = data.size;
                        renderRecordingPanel(currentRecording);
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
    async function renderRecordingPanel(record) { await renderPanel(record); }

    function displayRecordings() {
        // Kept for compatibility if other code calls it; re-render active panel if any currentRecording
        if (currentRecording) renderRecordingPanel(currentRecording);
    }

    console.log('Frontend: DOMContentLoaded - Ready for interaction.');
});

