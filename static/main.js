// main.js is loaded as type="module" from app.py
import { getServices, getServicesCached } from '/static/ui/services.js';
import { bytesToLabel } from '/static/ui/format.js';
import { ensureTab as ensureUITab, activateTab as activateUITab } from '/static/ui/tabs.js';
import { renderRecordingPanel as renderPanel } from '/static/ui/renderers.js';
import { buildWSUrl, parseWSMessage, sendJSON, arrayBufferToBase64, ensureOpenSocket } from '/static/ui/ws.js';
import { showPendingCountdown, prependSegmentRow } from '/static/ui/segments.js';
import { setButtonsOnStart, setButtonsOnStop } from '/static/ui/recording.js';

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
    let lastRecordingId = null; // Track last recording id for late events
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
    const okSegmentModalBtn = document.getElementById('okSegmentModal');
    const modelInfo = document.getElementById('modelInfo');
    const lblGoogle = document.getElementById('lbl_google');
    const lblVertex = document.getElementById('lbl_vertex');
    const lblGemini = document.getElementById('lbl_gemini');
    const lblAws = document.getElementById('lbl_aws');
    const credGoogle = document.getElementById('cred_google');
    const credVertex = document.getElementById('cred_vertex');
    const credGemini = document.getElementById('cred_gemini');
    const credAws = document.getElementById('cred_aws');
    const geminiApiKeyInput = document.getElementById('geminiApiKey');
    const useGeminiKeyBtn = document.getElementById('useGeminiKey');
    const fullTranscriptContainer = document.getElementById('fullTranscriptContainer');
    const serviceAdminRoot = null; // removed separate admin; now in modal
    // Recorder helpers
    let currentStream = null;
    let recOptions = {};
    let recMimeType = '';
    let segmentTimerId = null;
    const transcribeTimeouts = new Map(); // key: `${recId}:${idx}:${svc}` -> timeoutId
    
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

    // Auth info already logged by server-injected script; avoid duplicate console noise

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
    async function ensureSocketOpen() {
        try {
            if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) {
                const wsUrl = buildWSUrl(window.location, '/ws_stream');
                socket = new WebSocket(wsUrl);
                // Attach lightweight handlers so status reflects before recording begins
                if (!socket._basicHandlersAttached) {
                    socket.addEventListener('open', () => {
                        connStatus.innerText = 'WebSocket: open';
                        try { sendJSON(socket, { type: 'hello' }); } catch(_) {}
                    });
                    socket.addEventListener('message', ev => {
                        try {
                            const msg = JSON.parse(ev.data);
                            if (msg && msg.type === 'pong') {
                                connStatus.innerText = `WebSocket: pong (${msg.ts || ''})`;
                            }
                        } catch (_) {}
                    });
                    socket.addEventListener('error', err => { console.warn('Frontend: WebSocket error', err); });
                    socket.addEventListener('close', () => { connStatus.innerText = 'WebSocket: closed'; });
                    socket._basicHandlersAttached = true;
                }
            }
        } catch(_) {}
    }
    if (openSegmentModalBtn && segmentModal) openSegmentModalBtn.addEventListener('click', async () => {
        segmentModal.style.display = 'block';
        await ensureSocketOpen();
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
    if (okSegmentModalBtn && segmentModal) okSegmentModalBtn.addEventListener('click', async () => {
        // Sync provider selections to backend even if user didn't toggle each checkbox
        try {
            const keys = ['google','vertex','gemini','aws'];
            for (const k of keys) {
                const el = document.getElementById(`svc_${k}`);
                if (!el) continue;
                try { await fetch('/services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k, enabled: !!el.checked }) }); } catch(_) {}
            }
        } catch(_) {}
        segmentModal.style.display = 'none';
        // Re-render current panel to reflect updated columns
        if (currentRecording) try { await renderRecordingPanel(currentRecording); } catch(_) {}
    });
    // Force open modal and socket on initial load
    if (segmentModal) {
        segmentModal.style.display = 'block';
        ensureSocketOpen();
    }

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

    function timeoutKey(recordId, idx, svc) {
        return `${recordId}:${idx}:${svc}`;
    }
    function clearSvcTimeout(recordId, idx, svc) {
        const k = timeoutKey(recordId, idx, svc);
        const t = transcribeTimeouts.get(k);
        if (t) {
            clearTimeout(t);
            transcribeTimeouts.delete(k);
        }
    }
    async function scheduleSegmentTimeouts(recordId, idx) {
        try {
            const services = await getServicesCached();
            const enabled = services.filter(s => s.enabled);
            const TIMEOUT_MS = Number(segmentMs) && Number(segmentMs) >= 1000 ? Number(segmentMs) + 500 : 30000;
            enabled.forEach(s => {
                const k = timeoutKey(recordId, idx, s.key);
                if (transcribeTimeouts.has(k)) return;
                const to = setTimeout(() => {
                    try {
                        const row = document.getElementById(`segrow-${recordId}-${idx}`);
                        if (!row) return;
                        const td = row.querySelector(`td[data-svc="${s.key}"]`);
                        if (td) td.textContent = 'no result (timeout)';
                        if (currentRecording && currentRecording.id === recordId) {
                            const arr = (currentRecording.timeouts[s.key] = currentRecording.timeouts[s.key] || []);
                            while (arr.length <= idx) arr.push(false);
                            arr[idx] = true;
                        }
                    } catch(_) {}
                    transcribeTimeouts.delete(k);
                }, TIMEOUT_MS);
                transcribeTimeouts.set(k, to);
            });
        } catch(_) {}
    }

    function updateInlineCredentials() {
        const ready = !!window.GOOGLE_AUTH_READY;
        const info = window.GOOGLE_AUTH_INFO || {};
        const snippet = (label) => `${label}: ${ready ? 'ready' : 'not ready'}${info.project_id ? ` · ${info.project_id}` : ''}`;
        if (credGoogle) credGoogle.textContent = snippet('Google');
        // Vertex shares the same underlying service account; mirror the same masked info
        if (credVertex) credVertex.textContent = snippet('Vertex');
    }
    function showModelInfo(key, extra) {
        updateInlineCredentials();
        if (!modelInfo) return;
        const ready = !!window.GOOGLE_AUTH_READY;
        const info = window.GOOGLE_AUTH_INFO || {};
        const parts = [];
        if (key === 'google') {
            parts.push(`Google STT: ${ready ? 'ready' : 'not ready'}`);
        } else if (key === 'vertex') {
            parts.push(`Gemini Vertex: ${ready ? 'ready' : 'not ready'}`);
        } else if (key === 'gemini') {
            parts.push('Gemini API: configured');
        } else if (key === 'aws') {
            parts.push('AWS Transcribe: beta');
        }
        if (info.project_id) parts.push(`project: ${info.project_id}`);
        if (extra) parts.push(extra);
        modelInfo.textContent = parts.join(' · ');
    }
    if (lblGoogle) lblGoogle.addEventListener('click', () => showModelInfo('google'));
    if (lblVertex) lblVertex.addEventListener('click', () => showModelInfo('vertex'));
    if (lblGemini) lblGemini.addEventListener('click', () => showModelInfo('gemini'));
    if (lblAws) lblAws.addEventListener('click', () => showModelInfo('aws'));
    // Initialize inline creds on load
    updateInlineCredentials();

    // Wire Gemini API key submission
    if (useGeminiKeyBtn && geminiApiKeyInput) {
        useGeminiKeyBtn.addEventListener('click', async () => {
            const key = (geminiApiKeyInput.value || '').trim();
            if (!key) return;
            try {
                // Use POST; this goes via HTTP, not WS. Delay UI spinner or disable only briefly.
                const res = await fetch('/gemini_api_key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: key }) });
                let data = null;
                try {
                    data = await res.json();
                } catch (e) {
                    console.warn('Frontend: non-JSON response from /gemini_api_key');
                    data = { ok: false, error: 'non_json_response' };
                }
                if (data && data.ok) {
                    if (credGemini) credGemini.textContent = `Gemini: ready · ${data.masked || ''}`;
                    // Toggle service enabled state
                    try { await fetch('/services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'gemini', enabled: true }) }); } catch(_) {}
                } else {
                    if (credGemini) credGemini.textContent = `Gemini: key error${data && data.error ? ` · ${data.error}` : ''}`;
                }
            } catch (e) {
                if (credGemini) credGemini.textContent = `Gemini: key error · ${e && e.message ? e.message : 'network'}`;
            }
        });
    }

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
            fullAppend: { googleLive: '', google: '', vertex: '', gemini: '' },
            timeouts: { google: [], vertex: [], gemini: [], aws: [] }
        };
        recordings.push(currentRecording);
        lastRecordingId = currentRecording.id;
        ensureRecordingTab(currentRecording);
        renderRecordingPanel(currentRecording);

        // No separate placeholder row; countdown pending row is used instead

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

            // Ensure persistent WebSocket is open; reuse if already open/connecting
            await ensureSocketOpen();
            const onSocketReady = () => {
                console.log('Frontend: WebSocket ready for audio streaming.');
                try {
                    sendJSON(socket, { type: 'hello' });
                    console.log('Frontend: Sent hello handshake.');
                } catch (e) {
                    console.warn('Frontend: Failed to send hello handshake:', e);
                }
                connStatus.innerText = 'WebSocket: open';
                startTranscribeButton.disabled = false;
                stopTranscribeButton.disabled = true;
                if (autoTranscribeToggle && autoTranscribeToggle.checked) {
                    try { sendJSON(socket, { type: 'transcribe', enabled: true }); } catch(_) {}
                    startTranscribeButton.style.display = 'none';
                    stopTranscribeButton.style.display = 'none';
                } else {
                    startTranscribeButton.style.display = '';
                    stopTranscribeButton.style.display = '';
                    // ensure default disabled state for stop when auto is off
                    stopTranscribeButton.disabled = true;
                }
                try { mediaRecorder.start(); console.log('Frontend: Full recorder started (continuous).'); } catch (e) { console.warn('Frontend: start on open failed:', e); }
                startSegmentLoop();
                // Ensure first pending row is created and subsequent cycles keep a visible countdown row
                try { showPendingCountdown(currentRecording.id, segmentMs, () => segmentLoopActive, () => (segmentRecorder && segmentRecorder.state === 'recording')); } catch(_) {}
                // Attach WS message handler for UI updates as a fallback when SSE isn't available
                try {
                    const handleSegmentSaved = async (data) => {
                        try {
                            if (!currentRecording) return;
                            const segIndex = (typeof data.idx === 'number') ? data.idx : data.id;
                            while (currentRecording.segments.length <= segIndex) currentRecording.segments.push(null);
                            const startMs = typeof data.ts === 'number' ? data.ts : Date.now();
                            const endMs = startMs + (typeof segmentMs === 'number' ? segmentMs : 10000);
                            currentRecording.segments[segIndex] = { idx: segIndex, url: data.url, mime: data.mime || '', size: data.size || null, ts: data.ts, startMs, endMs, clientId: data.id };
                            // Use shared helper to create the row immediately so playback appears in-session
                            try { await prependSegmentRow(currentRecording, segIndex, data, startMs, endMs); } catch(_) {}
                            // Re-create a fresh countdown row for the next segment window
                            try { showPendingCountdown(currentRecording.id, segmentMs, () => segmentLoopActive, () => (segmentRecorder && segmentRecorder.state === 'recording')); } catch(_) {}
                            // Ensure timeout is scheduled for the row's cells
                            try { await scheduleSegmentTimeouts(currentRecording.id, segIndex); } catch(_) {}
                        } catch(_) {}
                    };
                    const handleSaved = (data) => {
                        try {
                            const rec = currentRecording || (recordings.find(r => r && r.id === lastRecordingId) || recordings[recordings.length - 1]);
                            if (rec) {
                                if (data.url) rec.serverUrl = data.url;
                                if (typeof data.size === 'number') rec.serverSizeBytes = data.size;
                                const fullEl = document.getElementById(`fulltable-${rec.id}`);
                                if (fullEl) htmx.trigger(fullEl, 'refresh-full', { detail: { record: JSON.stringify(rec) } });
                            }
                        } catch(_) {}
                    };
                    const handleTranscript = (msg) => {
                        try {
                            if (!msg.transcript && !msg.error) console.log(`[WS:${msg.type}] empty result`, msg);
                            if (msg.error) console.log(`[WS:${msg.type}] error`, msg.error);
                            if (!currentRecording) return;
                            const segIndex = (typeof msg.idx === 'number') ? msg.idx : msg.id;
                            try {
                                const svc = (msg.type || '').replace('segment_transcript_', '') || '';
                                if (svc) {
                                    const arr = (currentRecording.transcripts[svc] = currentRecording.transcripts[svc] || []);
                                    while (arr.length <= segIndex) arr.push('');
                                    if (typeof msg.transcript === 'string') arr[segIndex] = msg.transcript;
                                    clearSvcTimeout(currentRecording.id, segIndex, svc);
                                }
                            } catch(_) {}
                            const row = document.getElementById(`segrow-${currentRecording.id}-${segIndex}`);
                            if (row) htmx.trigger(row, 'refresh-row', { detail: { record: JSON.stringify(currentRecording), idx: segIndex } });
                        } catch(_) {}
                    };
                    socket.addEventListener('message', (ev) => {
                        try {
                            const msg = JSON.parse(ev.data);
                            if (!msg || !msg.type) return;
                            if (msg.type === 'segment_saved') return handleSegmentSaved(msg);
                            if (msg.type === 'saved') return handleSaved(msg);
                            if (msg.type.startsWith('segment_transcript')) return handleTranscript(msg);
                        } catch(_) {}
                    });
                } catch(_) {}
            };
            if (socket.readyState === WebSocket.OPEN) {
                onSocketReady();
            } else {
                socket.addEventListener('open', onSocketReady, { once: true });
            }

            // WebSocket message handler is now moved to SSE/HTMX for UI updates; we keep WS for audio.

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
                    // Live countdown for this segment in a pending top row within the segments table
                    try {
                        showPendingCountdown(currentRecording.id, segmentMs, () => segmentLoopActive, () => (segmentRecorder && segmentRecorder.state === 'recording'));
                    } catch(_) {}
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
                // Keep persistent socket alive; do not send end_stream or close here
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
        // Close socket after a short delay to allow final 'saved' message, then reopen on next start
        try {
            if (socket && socket.readyState === WebSocket.OPEN) {
                setTimeout(() => { try { socket.close(); } catch(_) {} }, 500);
            }
        } catch(_) {}
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
                // ensure stop is disabled until explicit start click
                stopTranscribeButton.disabled = true;
                startTranscribeButton.disabled = false;
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
    if (testConnBtn) testConnBtn.addEventListener('click', async () => {
        const now = new Date().toLocaleTimeString();
        connStatus.innerText = `WebSocket: connecting… (${now})`;
        await ensureSocketOpen();
        const start = Date.now();
        const handler = (ev) => {
            const rtt = Date.now() - start;
            const responseTime = new Date().toLocaleTimeString();
            connStatus.innerText = `WebSocket: connected · ${rtt} ms RTT · ${responseTime}`;
        };
        try {
            socket.addEventListener('message', function onmsg(e){
                try { const m = JSON.parse(e.data); if (m && m.type === 'pong') { handler(); socket.removeEventListener('message', onmsg); } } catch(_) {}
            });
            socket.send(JSON.stringify({ type: 'ping' }));
            const pingTime = new Date().toLocaleTimeString();
            connStatus.innerText = `WebSocket: ping sent · ${pingTime}`;
            setTimeout(() => {
                if (connStatus.innerText.includes('ping sent')) {
                    const timeoutTime = new Date().toLocaleTimeString();
                    connStatus.innerText = `WebSocket: no response · timeout at ${timeoutTime}`;
                }
            }, 3000);
        } catch (e) {
            console.warn('Frontend: ping send failed:', e);
            const errorTime = new Date().toLocaleTimeString();
            connStatus.innerText = `WebSocket: ping failed · error at ${errorTime}`;
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

    // Close socket only on page unload/navigation
    window.addEventListener('beforeunload', () => { try { if (socket && socket.readyState === WebSocket.OPEN) socket.close(); } catch(_) {} });
    console.log('Frontend: DOMContentLoaded - Ready for interaction.');

    // Delegate click handler to force-load full audio into a blob and trigger download immediately
    document.addEventListener('click', async (ev) => {
        try {
            const el = ev.target && ev.target.closest ? ev.target.closest('[data-load-full]') : null;
            if (!el) return;
            ev.preventDefault(); ev.stopPropagation();
            const url = el.getAttribute('data-load-full') || '';
            if (!url) return;
            // show a lightweight loading hint
            const prevText = el.textContent;
            try { el.textContent = (prevText || '').replace(/\([^)]*\)/, '(loading…)') || 'loading…'; } catch(_) {}
            const resp = await fetch(url, { cache: 'no-store' });
            const blob = await resp.blob();
            const objectUrl = URL.createObjectURL(blob);
            // trigger download via a temporary anchor
            try {
                const a = document.createElement('a');
                a.href = objectUrl;
                a.download = '';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } catch(_) {}
            // find the nearest audio element in the same cell/container
            let audio = null;
            const td = el.closest ? el.closest('td') : null;
            if (td) audio = td.querySelector('audio');
            if (!audio) {
                const parent = el.parentElement;
                if (parent) audio = parent.querySelector('audio');
            }
            if (audio) {
                // Prefer updating <source> child to keep type; fallback to audio.src
                let srcEl = audio.querySelector('source');
                const mime = resp.headers && resp.headers.get ? (resp.headers.get('Content-Type') || '') : '';
                if (!srcEl) srcEl = document.createElement('source');
                srcEl.src = objectUrl;
                if (mime) srcEl.type = mime;
                if (!audio.contains(srcEl)) {
                    audio.innerHTML = '';
                    audio.appendChild(srcEl);
                }
                try { audio.load(); } catch(_) {}
            }
            try { if (prevText) el.textContent = prevText; } catch(_) {}
        } catch(_) {}
    });

    // Wire SSE (Server-Sent Events) to trigger HTMX fragment refreshes
    try {
        const es = new EventSource('/events');
        es.addEventListener('segment_saved', async (e) => {
            try {
                const data = JSON.parse(e.data || '{}');
                if (!currentRecording) return;
                const segIndex = (typeof data.idx === 'number') ? data.idx : data.id;
                while (currentRecording.segments.length <= segIndex) currentRecording.segments.push(null);
                const startMs = typeof data.ts === 'number' ? data.ts : Date.now();
                const endMs = startMs + (typeof segmentMs === 'number' ? segmentMs : 10000);
                currentRecording.segments[segIndex] = { idx: segIndex, url: data.url, mime: data.mime || '', size: data.size || null, ts: data.ts, startMs, endMs, clientId: data.id };
                const tbody = document.getElementById(`segtbody-${currentRecording.id}`);
                const rowId = `segrow-${currentRecording.id}-${segIndex}`;
                let row = document.getElementById(rowId);
                if (!row && tbody) {
                    row = document.createElement('tr');
                    row.id = rowId;
                    row.setAttribute('hx-post', '/render/segment_row');
                    row.setAttribute('hx-trigger', 'refresh-row');
                    row.setAttribute('hx-target', 'this');
                    row.setAttribute('hx-swap', 'outerHTML');
                    row.setAttribute('hx-vals', JSON.stringify({ record: JSON.stringify(currentRecording), idx: segIndex }));
                    // minimal placeholder cells so the row is visible before swap
                    row.innerHTML = '<td></td><td></td><td></td>';
                    // remove pending countdown row if present, then insert new row at top
                    const pending = document.getElementById(`segpending-${currentRecording.id}`);
                    if (pending) { try { tbody.removeChild(pending); } catch(_) {} }
                    tbody.insertBefore(row, tbody.firstChild);
                }
                // Trigger HTMX refresh on this row
                const target = document.getElementById(rowId);
                if (target) htmx.trigger(target, 'refresh-row', { detail: { record: JSON.stringify(currentRecording), idx: segIndex } });
            } catch(_) {}
        });
        es.addEventListener('saved', (e) => {
            try {
                const data = JSON.parse(e.data || '{}');
                const rec = currentRecording || (recordings.find(r => r && r.id === lastRecordingId) || recordings[recordings.length - 1]);
                if (rec) {
                    if (data.url) rec.serverUrl = data.url;
                    if (typeof data.size === 'number') rec.serverSizeBytes = data.size;
                    const fullEl = document.getElementById(`fulltable-${rec.id}`);
                    if (fullEl) htmx.trigger(fullEl, 'refresh-full', { detail: { record: JSON.stringify(rec) } });
                }
            } catch(_) {}
        });
        // transcripts events simply trigger row refresh if row exists
        const txHandler = (svc) => (e) => {
            try {
                const data = JSON.parse(e.data || '{}');
                if (!data || (!data.transcript && !data.error)) {
                    console.log(`[SSE:${svc}] empty result`, data);
                }
                if (data && data.error) {
                    console.log(`[SSE:${svc}] error`, data.error);
                }
                const segIndex = (typeof data.idx === 'number') ? data.idx : data.id;
                if (!currentRecording) return;
                try {
                    const arr = (currentRecording.transcripts[svc] = currentRecording.transcripts[svc] || []);
                    while (arr.length <= segIndex) arr.push('');
                    if (typeof data.transcript === 'string') arr[segIndex] = data.transcript;
                    clearSvcTimeout(currentRecording.id, segIndex, svc);
                } catch(_) {}
                const row = document.getElementById(`segrow-${currentRecording.id}-${segIndex}`);
                if (row) htmx.trigger(row, 'refresh-row', { detail: { record: JSON.stringify(currentRecording), idx: segIndex } });
            } catch(_) {}
        };
        es.addEventListener('segment_transcript_google', txHandler('google'));
        es.addEventListener('segment_transcript_vertex', txHandler('vertex'));
        es.addEventListener('segment_transcript_gemini', txHandler('gemini'));
        es.addEventListener('segment_transcript_aws', txHandler('aws'));
    } catch(_) {}

    // Test Transcribe wiring (Settings UI)
    try {
        const testAudio = document.getElementById('testAudio');
        const testUpload = document.getElementById('testUpload');
        const testRun = document.getElementById('testRun');
        const testRecord2s = document.getElementById('testRecord2s');
        const testResults = document.getElementById('testResults');
        let testBlob = null;
        // Auto-load built-in sample if present under /static
        if (testAudio && !testAudio.src) {
            try {
                testAudio.src = '/static/sample.ogg';
            } catch(_) {}
        }
        if (testUpload) testUpload.addEventListener('change', async (e) => {
            try {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                testBlob = f;
                if (testAudio) testAudio.src = URL.createObjectURL(f);
                if (testResults) testResults.textContent = 'Loaded custom audio.';
            } catch(_) {}
        });
        if (testRecord2s) testRecord2s.addEventListener('click', async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const rec = new MediaRecorder(stream);
                const chunks = [];
                rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
                rec.onstop = () => {
                    testBlob = new Blob(chunks, { type: 'audio/webm' });
                    if (testAudio) testAudio.src = URL.createObjectURL(testBlob);
                    if (testResults) testResults.textContent = 'Recorded 2s sample.';
                };
                rec.start();
                setTimeout(() => { try { rec.stop(); } catch(_) {} }, 2000);
            } catch(_) {}
        });
        if (testRun) testRun.addEventListener('click', async () => {
            try {
                if (!testBlob && testAudio && testAudio.src) {
                    const r = await fetch(testAudio.src);
                    testBlob = await r.blob();
                }
                if (!testBlob) { if (testResults) testResults.textContent = 'No audio selected.'; return; }
                const buf = await testBlob.arrayBuffer();
                const b64 = arrayBufferToBase64(buf);
                const mime = (testBlob.type || 'audio/webm');
                // determine selected providers (checked boxes)
                const selected = [];
                const labelMap = { google: 'Google', vertex: 'Vertex', gemini: 'Gemini', aws: 'AWS' };
                const keys = ['google','vertex','gemini','aws'];
                keys.forEach(k => { const el = document.getElementById(`svc_${k}`); if (el && el.checked) selected.push(k); });
                const testingWhat = selected.length ? selected.map(k => labelMap[k] || k).join('/') : 'enabled providers';
                if (testResults) testResults.textContent = `Testing… (${testingWhat})`;
                const res = await fetch('/test_transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio_b64: b64, mime, services: selected.join(',') }) });
                const data = await res.json();
                if (data && data.ok) {
                    const parts = [];
                    const want = selected.length ? selected : ['google','vertex','gemini','aws'];
                    want.forEach(k => {
                        const label = labelMap[k] || k;
                        const val = (data.results && (data.results[k] || data.results[`${k}_error`])) || 'n/a';
                        parts.push(`${label}: ${val}`);
                    });
                    if (testResults) testResults.textContent = parts.join(' | ');
                } else {
                    if (testResults) testResults.textContent = `Test failed: ${(data && data.error) || 'unknown'}`;
                }
            } catch(err) {
                if (testResults) testResults.textContent = `Test failed: ${err && err.message ? err.message : 'network'}`;
            }
        });
    } catch(_) {}
});

