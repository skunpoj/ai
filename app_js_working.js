import { getServices, getServicesCached } from '/static/ui/services.js';
import { ensureTab as ensureUITab, activateTab as activateUITab } from '/static/ui/tabs.js';
import { renderRecordingPanel as renderPanel } from '/static/ui/renderers.js';
import { sendJSON, ensureOpenSocket } from '/static/ui/ws.js';
import { createWsMessageHandler } from '/static/ui/ws_handlers.js';
import { showPendingCountdown, prependSegmentRow } from '/static/ui/segments.js';
import { acquireWakeLock, releaseWakeLock, initWakeLockVisibilityReacquire } from '/static/app/wake_lock.js';
import { createMediaRecorderWithFallback, safelyStopStream } from '/static/app/recorder_utils.js';
import { pendingRowsByIdx, pendingRowsByClientId, pendingRowsByServerId, insertedRows, pendingInsertTimers, segmentIdToIndex, idxKey, clientKey, serverKey, mergePending, setPending, getServerId, resetSegmentsState } from '/static/app/segments_state.js';

document.addEventListener('DOMContentLoaded', () => {
    // State
    let socket = null;
    let mediaRecorder = null;
    let fullChunks = [];
    let currentStream = null;
    let currentRecording = null;
    let recordings = [];
    let lastRecordingId = null;
    let recordStartTs = null;
    let segmentLoopActive = false;
    let segmentRecorder = null;
    let recOptions = {};
    let recMimeType = '';
    let enableGoogleSpeech = false;
    let transcribePending = false;
    const USE_TIMESLICE = false;
    const transcribeTimeouts = new Map();

    // UI
    const startRecordingButton = document.getElementById('startRecording');
    const stopRecordingButton = document.getElementById('stopRecording');
    const startTranscribeButton = document.getElementById('startTranscribe');
    const stopTranscribeButton = document.getElementById('stopTranscribe');
    const autoTranscribeToggle = document.getElementById('autoTranscribeToggle');
    const tabsBar = document.getElementById('recordTabs');
    const panelsHost = document.getElementById('recordPanels');
    const segmentLenGroup = document.getElementById('segmentLenGroup');
    const openSegmentModalBtn = document.getElementById('openSegmentModal');
    const segmentModal = document.getElementById('segmentModal');
    const okSegmentModalBtn = document.getElementById('okSegmentModal');
    const testConnBtn = document.getElementById('testConnection');
    const connStatus = document.getElementById('connStatus');
    const testAudio = document.getElementById('testAudio');
    const uploadFullToggle = document.getElementById('uploadFullToggle');
    const exportFullToggle = document.getElementById('exportFullToggle');
    let uploadFullOnStop = false; // default OFF
    let exportFullOnStop = false; // default OFF
    try { if (uploadFullToggle) { uploadFullOnStop = !!uploadFullToggle.checked; uploadFullToggle.addEventListener('change', () => { uploadFullOnStop = !!uploadFullToggle.checked; }); } } catch(_) {}
    try { if (exportFullToggle) { exportFullOnStop = !!exportFullToggle.checked; exportFullToggle.addEventListener('change', () => { exportFullOnStop = !!exportFullToggle.checked; }); } } catch(_) {}
    const testUpload = document.getElementById('testUpload');
    const testRecord2s = document.getElementById('testRecord2s');
    const testRun = document.getElementById('testRun');
    const testViaWS = document.getElementById('testViaWS');
    const testResults = document.getElementById('testResults');
    let segmentMs = (typeof window !== 'undefined' && typeof window.SEGMENT_MS !== 'undefined') ? window.SEGMENT_MS : 10000;

    initWakeLockVisibilityReacquire(() => (!!(mediaRecorder && mediaRecorder.state === 'recording') || !!segmentLoopActive));
    let connCheckInterval = null;
    let testBlob = null;
    let testActiveStream = null;

    function ensureRecordingTab(record) { if (!tabsBar || !panelsHost) return; ensureUITab(tabsBar, panelsHost, record); }
    async function renderRecordingPanel(record) { ensureRecordingTab(record); try { await renderPanel(record); } catch(_) {} }

    function clearSvcTimeout(recordId, idx, svc) {
        const k = `${recordId}:${idx}:${svc}`;
        const t = transcribeTimeouts.get(k);
        if (t) { try { clearTimeout(t); } catch(_) {} transcribeTimeouts.delete(k); }
    }
    async function scheduleSegmentTimeouts(recordId, idx) {
        try {
            const isActive = (!!segmentLoopActive) || (!!mediaRecorder && mediaRecorder.state === 'recording');
            if (!isActive) return;
            const services = await getServicesCached();
            const enabled = services.filter(s => s.enabled);
            const TIMEOUT_MS = Number(segmentMs) && Number(segmentMs) >= 1000 ? Number(segmentMs) + 500 : 30000;
            enabled.forEach(s => {
                const k = `${recordId}:${idx}:${s.key}`;
                if (transcribeTimeouts.has(k)) return;
                const to = setTimeout(() => {
                    try {
                        const row = document.getElementById(`segrow-${recordId}-${idx}`);
                        if (!row) return;
                        const td = row.querySelector(`td[data-svc="${s.key}"]`);
                        if (td && (!td.textContent || !td.textContent.trim())) td.textContent = 'no result (timeout)';
                    } catch(_) {}
                    transcribeTimeouts.delete(k);
                }, TIMEOUT_MS);
                transcribeTimeouts.set(k, to);
            });
        } catch(_) {}
    }

    async function getMicStream() {
        const attempts = [
            { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, sampleRate: 48000 } },
            { audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } } },
            { audio: true }
        ];
        let lastErr = null;
        for (const c of attempts) {
            try { return await navigator.mediaDevices.getUserMedia(c); } catch(e) { lastErr = e; }
        }
        throw lastErr || new Error('Failed to acquire microphone');
    }

    async function openSocket() {
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return socket;
        const tryPath = (path) => new Promise((resolve, reject) => {
            try { if (connStatus) connStatus.innerText = `WebSocket: connecting… ${path}`; } catch(_) {}
            const ws = ensureOpenSocket(path, (w) => {
                try { sendJSON(w, { type: 'hello' }); } catch(_) {}
                try { if (connStatus) connStatus.innerText = `WebSocket: open ${path}`; } catch(_) {}
                resolve(w);
            });
            const wsOnMessage = createWsMessageHandler({
                onReady: () => { try { if (connStatus) connStatus.innerText = `WebSocket: open ${path}`; } catch(_) {} },
                onSegmentSaved: (data) => handleSegmentSaved(data),
                onTranscript: (_svc, data) => handleTranscript(data),
                onSaved: (data) => handleSaved(data),
                onPong: (data) => { try { if (connStatus) connStatus.innerText = `WebSocket: pong (${(data && data.ts) || ''}) ${path}`; } catch(_) {} },
                onAuth: () => {}, onAck: () => {},
            });
            ws.onmessage = wsOnMessage;
            ws.onerror = () => { try { if (connStatus) connStatus.innerText = `WebSocket: error ${path}`; } catch(_) {} };
            ws.onclose = () => { try { if (connStatus) connStatus.innerText = `WebSocket: closed ${path}`; } catch(_) {} };
            if (ws.readyState === WebSocket.OPEN) {
                try { if (connStatus) connStatus.innerText = `WebSocket: open ${path}`; } catch(_) {}
                resolve(ws);
            }
            // Fallback timeout if connecting hangs
            setTimeout(() => {
                try {
                    if (ws.readyState !== WebSocket.OPEN) {
                        try { ws.close(); } catch(_) {}
                        reject(new Error(`timeout ${path}`));
                    }
                } catch(_) { reject(new Error(`timeout ${path}`)); }
            }, 2500);
        });
        const ws = await tryPath('/ws_stream');
        socket = ws; return ws;
    }

    function runConnCheckOnce() {
        (async () => {
            try { if (connStatus) connStatus.innerText = `WebSocket: checking… ${new Date().toLocaleTimeString()}`; } catch(_) {}
            try { await openSocket(); } catch(_) {}
            try {
                const start = Date.now();
                const onPong = function onmsg(e){
                    try {
                        const m = JSON.parse(e.data);
                        if (m && m.type === 'pong') {
                            try { if (connStatus) connStatus.innerText = `WebSocket: connected · ${Date.now()-start} ms RTT · ${new Date().toLocaleTimeString()}`; } catch(_) {}
                            try { socket.removeEventListener('message', onPong); } catch(_) {}
                        }
                    } catch(_) {}
                };
                if (socket && socket.readyState === WebSocket.OPEN) {
                    try { socket.addEventListener('message', onPong); } catch(_) {}
                    try { socket.send(JSON.stringify({ type: 'ping' })); } catch(_) {}
                    setTimeout(() => {
                        try {
                            if (connStatus && (connStatus.innerText || '').includes('checking…')) {
                                connStatus.innerText = `WebSocket: not connected · ${new Date().toLocaleTimeString()}`;
                                try { socket.removeEventListener('message', onPong); } catch(_) {}
                            }
                        } catch(_) {}
                    }, 3000);
                } else {
                    // If still not OPEN after openSocket attempt, do not assert not connected until next interval
                    setTimeout(() => {
                        try {
                            if (!(socket && socket.readyState === WebSocket.OPEN) && connStatus && (connStatus.innerText || '').includes('checking…')) {
                                connStatus.innerText = `WebSocket: not connected · ${new Date().toLocaleTimeString()}`;
                            }
                        } catch(_) {}
                    }, 3000);
                }
            } catch(_) {}
        })();
    }
    function startConnAutoCheck() {
        try { if (connCheckInterval) return; } catch(_) {}
        // Run immediately and then every 10s
        runConnCheckOnce();
        connCheckInterval = setInterval(runConnCheckOnce, 10000);
    }
    function stopConnAutoCheck() {
        try { if (connCheckInterval) { clearInterval(connCheckInterval); connCheckInterval = null; } } catch(_) {}
    }

    async function prepareNewRecording() {
        resetSegmentsState();
        recordStartTs = Date.now();
        transcribePending = false;
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
            transcripts: { google: [], googleLive: [], vertex: [], gemini: [], aws: [] },
            fullAppend: { googleLive: '', google: '', vertex: '', gemini: '', aws: '' },
            timeouts: { google: [], vertex: [], gemini: [], aws: [] },
            _compatIdx: -1
        };
        recordings.push(currentRecording);
        lastRecordingId = currentRecording.id;
        ensureRecordingTab(currentRecording);
        try { await renderRecordingPanel(currentRecording); } catch(_) {}
    }

    // Event Handlers
    async function handleSegmentSaved(data) {
        try {
            const rec = currentRecording || (recordings.find(r => r && r.id === lastRecordingId) || null);
            if (!rec) return;
            // Ensure the segments table exists before inserting rows
            try {
                if (!document.getElementById(`segtbody-${rec.id}`)) {
                    await renderRecordingPanel(rec);
                }
            } catch(_) {}
            let segIndex = (typeof data.idx === 'number') ? data.idx : -1;
            const serverId = getServerId(data);
            if (segIndex < 0 && typeof data.id === 'number') {
                try { const found = rec.segments.find(s => s && s.clientId === data.id); if (found) segIndex = found.idx; } catch(_) {}
            }
            if (segIndex < 0) segIndex = rec.segments.length;
            while (rec.segments.length <= segIndex) rec.segments.push(null);
            const seeded = rec.segments[segIndex] || {};
            const seededStart = (seeded && typeof seeded.startMs === 'number') ? seeded.startMs : ((typeof data.ts === 'number') ? data.ts : Date.now());
            const seededEnd = (seeded && typeof seeded.endMs === 'number') ? seeded.endMs : (seededStart + (typeof segmentMs === 'number' ? segmentMs : 10000));
            rec.segments[segIndex] = { idx: segIndex, url: data.url, mime: data.mime || '', size: data.size || null, ts: data.ts, startMs: seededStart, endMs: seededEnd, clientId: data.id, serverId };
            if (serverId) segmentIdToIndex.set(`${rec.id}:${serverId}`, segIndex);
            // Persist saved info
            const payload = { url: data.url, mime: data.mime || '', size: data.size || null, ts: data.ts, startMs: seededStart, endMs: seededEnd, id: data.id, segment_id: serverId };
            const K = idxKey(rec.id, segIndex);
            const base = setPending(pendingRowsByIdx, K, cur => { cur.saved = payload; return cur; });
            if (typeof data.id === 'number') setPending(pendingRowsByClientId, clientKey(rec.id, data.id), cur => mergePending(cur, base));
            if (serverId) setPending(pendingRowsByServerId, serverKey(rec.id, serverId), cur => mergePending(cur, base));
            // Single insertion path: insert here only; retry shortly if DOM not ready yet
            if (!document.getElementById(`segrow-${rec.id}-${segIndex}`)) {
                try {
                    const row = await prependSegmentRow(rec, segIndex, payload, seededStart, seededEnd);
                    if (!row) {
                        setTimeout(async () => { try { await renderRecordingPanel(rec); await prependSegmentRow(rec, segIndex, payload, seededStart, seededEnd); } catch(_) {} }, 50);
                    }
                } catch(_) {}
            }
            insertedRows.add(K);
            scheduleSegmentTimeouts(rec.id, segIndex);
        } catch(_) {}
    }

    async function handleTranscript(msg) {
        try {
            const rec = currentRecording || (recordings.find(r => r && r.id === lastRecordingId) || null);
            if (!rec) return;
            const serverId = getServerId(msg);
            let segIndex = (typeof msg.idx === 'number') ? msg.idx : -1;
            if (segIndex < 0 && serverId) {
                try { const mapped = segmentIdToIndex.get(`${rec.id}:${serverId}`); if (typeof mapped === 'number') segIndex = mapped; } catch(_) {}
            }
            if (segIndex < 0 && typeof msg.id === 'number') {
                try { const found = rec.segments.find(s => s && s.clientId === msg.id); if (found) segIndex = found.idx; } catch(_) {}
            }
            if (segIndex < 0) return;
            // Update arrays and cells only; no insertion here
            let svc = (msg.type || '').replace('segment_transcript_', '') || '';
            if (!svc) svc = msg.svc || msg.provider || msg.service || '';
            if (!svc) return;
            if (typeof msg.transcript === 'string' && msg.transcript.length) {
                const arr = (rec.transcripts[svc] = rec.transcripts[svc] || []);
                while (arr.length <= segIndex) arr.push('');
                arr[segIndex] = msg.transcript;
                clearSvcTimeout(rec.id, segIndex, svc);
                const row = document.getElementById(`segrow-${rec.id}-${segIndex}`);
                if (row) { const td = row.querySelector(`td[data-svc="${svc}"]`); if (td) td.textContent = msg.transcript; }
                // Recompute full text from array
                try {
                    const fullArr = rec.transcripts[svc] || [];
                    const joined = Array.isArray(fullArr) ? fullArr.filter(Boolean).join(' ') : '';
                    rec.fullAppend = rec.fullAppend || {}; rec.fullAppend[svc] = joined;
                    const fullCell = document.querySelector(`#fulltable-${rec.id} td[data-svc="${svc}"]`);
                    if (fullCell) fullCell.textContent = joined;
                } catch(_) {}
            }
        } catch(_) {}
    }

    function handleSaved(data) {
        try {
            const rec = currentRecording || (recordings.find(r => r && r.id === lastRecordingId) || null);
            if (!rec) return;
            if (data.url) rec.serverUrl = data.url;
            if (typeof data.size === 'number') rec.serverSizeBytes = data.size;
            renderRecordingPanel(rec);
        } catch(_) {}
    }

    // Controls
    // Ensure sample audio is loaded in settings modal
    try { if (testAudio && !testAudio.src) testAudio.src = '/static/sample.ogg'; } catch(_) {}
    // Auto-connection check every 10s while app is loaded
    // Auto-WS check runs only while Settings modal is open

    // Wire settings modal open to ensure WS connection and sync provider toggles
    if (openSegmentModalBtn && segmentModal) openSegmentModalBtn.addEventListener('click', async () => {
        try { segmentModal.style.display = 'block'; } catch(_) {}
        try { startConnAutoCheck(); } catch(_) {}
        try { await openSocket(); } catch(_) {}
        try {
            const map = {
                google: document.getElementById('svc_google'),
                vertex: document.getElementById('svc_vertex'),
                gemini: document.getElementById('svc_gemini'),
                aws: document.getElementById('svc_aws')
            };
            const svcs = await getServices();
            svcs.forEach(s => { if (map[s.key]) map[s.key].checked = !!s.enabled; });
        } catch(_) {}
    });
    if (okSegmentModalBtn && segmentModal) okSegmentModalBtn.addEventListener('click', async () => {
        try {
            const keys = ['google','vertex','gemini','aws'];
            for (const k of keys) {
                const el = document.getElementById(`svc_${k}`);
                if (!el) continue;
                try { await fetch('/services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k, enabled: !!el.checked }) }); } catch(_) {}
            }
        } catch(_) {}
        try { segmentModal.style.display = 'none'; } catch(_) {}
        try { stopConnAutoCheck(); } catch(_) {}
        if (currentRecording) try { await renderRecordingPanel(currentRecording); } catch(_) {}
    });

    // Manual connection check
    if (testConnBtn) testConnBtn.addEventListener('click', async () => {
        const now = new Date().toLocaleTimeString();
        try { if (connStatus) connStatus.innerText = `WebSocket: connecting… (${now})`; } catch(_) {}
        await openSocket();
        const start = Date.now();
        try {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.addEventListener('message', function onmsg(e){
                    try { const m = JSON.parse(e.data); if (m && m.type === 'pong') { try { if (connStatus) connStatus.innerText = `WebSocket: connected · ${Date.now()-start} ms RTT · ${new Date().toLocaleTimeString()}`; } catch(_) {} socket.removeEventListener('message', onmsg); } } catch(_) {}
                });
                socket.send(JSON.stringify({ type: 'ping' }));
                try { if (connStatus) connStatus.innerText = `WebSocket: ping sent · ${new Date().toLocaleTimeString()}`; } catch(_) {}
                setTimeout(() => {
                    try {
                        if (connStatus && (connStatus.innerText || '').includes('ping sent')) {
                            connStatus.innerText = `WebSocket: no response · timeout at ${new Date().toLocaleTimeString()}`;
                        }
                    } catch(_) {}
                }, 3000);
            }
        } catch(_) {}
    });

    // Test Transcribe wiring
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
            try { if (testActiveStream && testActiveStream.getTracks) testActiveStream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
            testActiveStream = stream;
            const rec = new MediaRecorder(stream);
            const chunks = [];
            rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
            rec.onstop = () => {
                testBlob = new Blob(chunks, { type: 'audio/webm' });
                if (testAudio) testAudio.src = URL.createObjectURL(testBlob);
                if (testResults) testResults.textContent = `Recorded sample (${Math.round(Number(segmentMs||10000)/1000)}s).`;
                try { stream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
                testActiveStream = null;
            };
            rec.start();
            setTimeout(() => { try { rec.stop(); } catch(_) {} }, Number(segmentMs || 10000));
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
            const bytes = new Uint8Array(buf);
            let binary = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            const b64 = btoa(binary);
            const mime = (testBlob.type || 'audio/webm');
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

    // Test via WS: record one segment using same timeslice pipeline and await transcripts
    if (testViaWS) testViaWS.addEventListener('click', async () => {
        try {
            if (testResults) testResults.textContent = 'Testing via WS…';
            await openSocket();
            // Lazily enable transcribe before sending first test slice
            try { if (socket && socket.readyState === WebSocket.OPEN) sendJSON(socket, { type: 'transcribe', enabled: true }); } catch(_) {}
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const ref = { value: '' };
            const mr = createMediaRecorderWithFallback(stream, ref);
            const localIdx = 0; // single slice test
            const startTs = Date.now();
            const segDur = Number(segmentMs || 10000);
            let done = false;
            const onMessage = (ev) => {
                try {
                    const m = JSON.parse(ev.data);
                    if (m && typeof m.idx === 'number' && m.idx === localIdx && /^segment_transcript_/.test(m.type)) {
                        const svc = (m.type || '').replace('segment_transcript_', '') || '';
                        const txt = m.transcript || m.error || '';
                        if (testResults) testResults.textContent = `${svc}: ${txt}`;
                        done = true;
                        try { socket.removeEventListener('message', onMessage); } catch(_) {}
                    }
                } catch(_) {}
            };
            try { socket.addEventListener('message', onMessage); } catch(_) {}
            mr.ondataavailable = async (e) => {
                if (!e.data || !e.data.size || done) return;
                try {
                    const buf = await e.data.arrayBuffer();
                    const b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
                    sendJSON(socket, { type: 'segment', audio: b64, id: startTs, idx: localIdx, ts: Date.now(), mime: e.data.type, duration_ms: segDur });
                } catch(_) {}
            };
            mr.onstop = () => {
                try { stream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
                setTimeout(() => { try { socket.removeEventListener('message', onMessage); } catch(_) {} }, 1000);
                if (!done && testResults) testResults.textContent = 'No provider transcript received.';
            };
            try { mr.start(segDur); } catch(_) {}
            setTimeout(() => { try { mr.stop(); } catch(_) {} }, segDur);
        } catch(err) {
            if (testResults) testResults.textContent = `Test via WS failed: ${err && err.message ? err.message : 'error'}`;
        }
    });
    if (segmentLenGroup) {
        const radios = segmentLenGroup.querySelectorAll('input[type="radio"][name="segmentLen"]');
        radios.forEach(r => {
            if (Number(r.value) === Number(segmentMs)) r.checked = true;
            r.addEventListener('change', () => {
                const v = Number(r.value);
                if (!Number.isNaN(v) && v >= 5000 && v <= 300000) {
                    segmentMs = v;
                    try { if (mediaRecorder && mediaRecorder.state === 'recording') { try { mediaRecorder.stop(); } catch(_) {} } } catch(_) {}
                }
            });
        });
    }

    startRecordingButton.addEventListener('click', async () => {
        startRecordingButton.disabled = true;
        stopRecordingButton.disabled = false;
        startTranscribeButton.disabled = false;
        stopTranscribeButton.disabled = true;
        enableGoogleSpeech = false;
        resetSegmentsState();
        await prepareNewRecording();
        try { await acquireWakeLock(); } catch(_) {}
        await openSocket();
        // Do not auto-enable transcribe here; it will enable on first segment
        // Recorder
        try {
            safelyStopStream(currentStream); currentStream = null;
            currentStream = await getMicStream();
            const ref = { value: '' };
            mediaRecorder = createMediaRecorderWithFallback(currentStream, ref);
            recMimeType = ref.value || 'audio/webm';
            fullChunks = [];
            mediaRecorder.ondataavailable = async (e) => {
                if (!e.data || !e.data.size) return;
                fullChunks.push(e.data);
                // NOTE: no timeslice segment uploads here. Rotating-per-segment handles per-slice uploads.
            };
            mediaRecorder.onstop = async () => {
                try { segmentLoopActive = false; } catch(_) {}
                try { if (currentStream && currentStream.getTracks) currentStream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
                currentStream = null;
                const stopTs = Date.now();
                if (currentRecording) { currentRecording.stopTs = stopTs; currentRecording.durationMs = stopTs - (currentRecording.startTs || stopTs); }
                const audioBlob = new Blob(fullChunks, { type: recMimeType || 'audio/webm' });
                if (currentRecording) {
                    currentRecording.audioUrl = URL.createObjectURL(audioBlob);
                    currentRecording.clientSizeBytes = audioBlob.size;
                    renderRecordingPanel(currentRecording);
                }
                if (uploadFullOnStop) {
                    try {
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            const fullBuf = await audioBlob.arrayBuffer();
                            const b64full = btoa(String.fromCharCode.apply(null, new Uint8Array(fullBuf)));
                            sendJSON(socket, { type: 'full_upload', audio: b64full, mime: recMimeType || 'audio/webm' });
                        }
                    } catch(_) {}
                }
                if (exportFullOnStop) {
                    try {
                        // Ask server to export full by concatenating saved segments for this recording id
                        const recId = String((currentRecording && currentRecording.startTs) || Date.now());
                        const res = await fetch('/export_full', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_id: recId }) });
                        const data = await res.json();
                        console.log('HTTP: export_full response', data);
                        // Insert an additional full row if server returns a URL
                        if (data && data.ok && data.url && currentRecording) {
                            // Render full row via HTMX refresh
                            currentRecording.serverUrl2 = data.url;
                            await renderRecordingPanel(currentRecording);
                        }
                    } catch(_) {}
                }
            };
            // Start continuous full recorder (no timeslice)
            try { mediaRecorder.start(); } catch(e) { alert('Recording failed'); throw e; }
            // Start rotating-per-segment loop (HTTP per-segment upload)
            try { startRotatingSegment(); } catch(_) {}
        } catch (e) {
            alert('Microphone/Recorder error');
            startRecordingButton.disabled = false;
            stopRecordingButton.disabled = true;
        }
    });

    stopRecordingButton.addEventListener('click', () => {
        try { releaseWakeLock(); } catch(_) {}
        startRecordingButton.disabled = false;
        stopRecordingButton.disabled = true;
        startTranscribeButton.disabled = true;
        stopTranscribeButton.disabled = true;
        try { if (autoTranscribeToggle && autoTranscribeToggle.checked && socket && socket.readyState === WebSocket.OPEN) sendJSON(socket, { type: 'transcribe', enabled: false }); } catch(_) {}
        try { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch(_) {}
        try { transcribeTimeouts.forEach((to) => { try { clearTimeout(to); } catch(_) {} }); transcribeTimeouts.clear(); } catch(_) {}
        try { segmentIdToIndex.clear(); } catch(_) {}
        // Stop rotating loop
        try { segmentLoopActive = false; if (segmentRecorder && segmentRecorder.state === 'recording') segmentRecorder.stop(); } catch(_) {}
    });

    startTranscribeButton.addEventListener('click', () => {
        enableGoogleSpeech = true;
        startTranscribeButton.disabled = true;
        stopTranscribeButton.disabled = false;
        try { if (socket && socket.readyState === WebSocket.OPEN) sendJSON(socket, { type: 'transcribe', enabled: true }); } catch(_) {}
    });
    if (autoTranscribeToggle) {
        const applyAutoState = () => {
            const isOn = !!autoTranscribeToggle.checked;
            if (isOn) {
                startTranscribeButton.style.display = 'none';
                stopTranscribeButton.style.display = 'none';
                // Delay enabling transcribe until first segment slice
            } else {
                startTranscribeButton.style.display = '';
                stopTranscribeButton.style.display = '';
                stopTranscribeButton.disabled = true;
                startTranscribeButton.disabled = false;
            }
        };
        autoTranscribeToggle.addEventListener('change', applyAutoState);
        applyAutoState();
    }
    stopTranscribeButton.addEventListener('click', () => {
        enableGoogleSpeech = false;
        startTranscribeButton.disabled = false;
        stopTranscribeButton.disabled = true;
        try { if (socket && socket.readyState === WebSocket.OPEN) sendJSON(socket, { type: 'transcribe', enabled: false }); } catch(_) {}
    });
    // Rotating-per-segment implementation (HTTP per-segment upload)
    function startRotatingSegment() {
        if (segmentLoopActive) return;
        segmentLoopActive = true;
        let segIdx = 0;
        const step = () => {
            if (!segmentLoopActive || !currentStream) return;
            const ts = Date.now();
            const base = (currentRecording && currentRecording.startTs) || ts;
            const dur = Number(segmentMs || 10000);
            const startMs = base + (segIdx * dur);
            const endMs = startMs + dur;
            try { while (currentRecording.segments.length <= segIdx) currentRecording.segments.push(null); } catch(_) {}
            const seeded = { idx: segIdx, url: '', mime: recMimeType || 'audio/webm', size: 0, ts, startMs, endMs, clientId: ts };
            try { currentRecording.segments[segIdx] = seeded; } catch(_) {}
            let localBlob = null;
            try { segmentRecorder = new MediaRecorder(currentStream, recOptions); } catch(e) { console.warn('Segment recorder init failed', e); segmentLoopActive = false; return; }
            segmentRecorder.ondataavailable = (e) => { if (e.data && e.data.size) localBlob = e.data; };
            segmentRecorder.onstop = async () => {
                if (localBlob && localBlob.size) {
                    try {
                        const ab = await localBlob.arrayBuffer();
                        const bytes = new Uint8Array(ab);
                        let bin = ''; const CHUNK = 0x8000; for (let i=0;i<bytes.length;i+=CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i,i+CHUNK));
                        const b64 = btoa(bin);
                        const recId = String((currentRecording && currentRecording.startTs) || Date.now());
                        const payload = { recording_id: recId, audio_b64: b64, mime: localBlob.type || 'audio/webm', duration_ms: segmentMs, id: ts, idx: segIdx, ts };
                        const res = await fetch('/segment_upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                        const data = await res.json();
                        if (data && data.ok) {
                            const saved = data.saved || {}; const url = saved.url || '';
                            try { currentRecording.segments[segIdx] = Object.assign({}, seeded, { url, mime: saved.mime || localBlob.type || '', size: saved.size || localBlob.size || 0 }); } catch(_) {}
                            try { await prependSegmentRow(currentRecording, segIdx, { url, mime: saved.mime || localBlob.type, size: saved.size || localBlob.size, ts }, startMs, endMs); } catch(_) {}
                            const results = data.results || {};
                            Object.keys(results).forEach(svc => {
                                const txt = results[svc] || '';
                                const arr = (currentRecording.transcripts[svc] = currentRecording.transcripts[svc] || []);
                                while (arr.length <= segIdx) arr.push('');
                                arr[segIdx] = txt;
                                try { const row = document.getElementById(`segrow-${currentRecording.id}-${segIdx}`); if (row) { const td = row.querySelector(`td[data-svc="${svc}"]`); if (td) td.textContent = txt; } } catch(_) {}
                            });
                        } else {
                            console.warn('segment_upload failed', data);
                        }
                    } catch(e) { console.warn('segment upload error', e); }
                }
                segIdx += 1;
                if (segmentLoopActive) setTimeout(step, 0);
            };
            try { segmentRecorder.start(); } catch(e) { console.warn('segmentRecorder start failed', e); segmentLoopActive = false; return; }
            setTimeout(() => { try { if (segmentRecorder && segmentRecorder.state === 'recording') segmentRecorder.stop(); } catch(_) {} }, dur);
        };
        step();
    }
});


