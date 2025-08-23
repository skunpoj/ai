// main.js is loaded as type="module" from app.py
import { getServices, getServicesCached } from '/static/ui/services.js';
import { bytesToLabel } from '/static/ui/format.js';
import { ensureTab as ensureUITab, activateTab as activateUITab } from '/static/ui/tabs.js';
import { renderRecordingPanel as renderPanel } from '/static/ui/renderers.js';
import { buildWSUrl, parseWSMessage, sendJSON, ensureOpenSocket } from '/static/ui/ws.js';
import { showPendingCountdown, prependSegmentRow, insertTempSegmentRow } from '/static/ui/segments.js';
import { setButtonsOnStart, setButtonsOnStop } from '/static/ui/recording.js';
import { acquireWakeLock, releaseWakeLock, initWakeLockVisibilityReacquire } from '/static/app/wake_lock.js';
import { createSegmentLoop, arrayBufferToBase64 as ab2b64 } from '/static/app/segment_loop.js';
import { safelyStopStream, createMediaRecorderWithFallback } from '/static/app/recorder_utils.js';

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
    let pendingStop = false; // Mark that user requested stop; close WS after saved
    // Ensure this flag is in the outer scope so UI buttons can toggle it reliably
    let enableGoogleSpeech = false;
    // Segment timing
    let segmentBuffer = [];
    let lastChunkBlob = null; // unused in timeslice mode
    let segmentStartTs = null; // unused in timeslice mode
    let segmentRotate = false; // when true, onstop restarts recorder with new timeslice
    const USE_COMPAT_SINGLE_RECORDER = true; // Minimal stable mode: one recorder with timeslice for segments
    // Removed client-side ETag caches; htmx triggers drive updates declaratively

    // Mobile Wake Lock (Screen) to prevent auto-lock during recording.
    // - Acquired on Start Recording; released on Stop Recording
    // - Reacquired on visibilitychange when returning to the page
    // Reacquire wake lock on visibility when recording
    initWakeLockVisibilityReacquire(() => (!!(mediaRecorder && mediaRecorder.state === 'recording') || !!segmentLoopActive));

    // Lightweight diagnostics to verify runtime prerequisites; safe to remove later
    function runDiagnostics(tag) {
        try {
            const issues = [];
            if (typeof MediaRecorder === 'undefined') issues.push('MediaRecorder missing');
            if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) issues.push('getUserMedia missing');
            if (typeof WebSocket === 'undefined') issues.push('WebSocket missing');
            if (!document.getElementById('recordTabs')) issues.push('recordTabs missing');
            if (!document.getElementById('recordPanels')) issues.push('recordPanels missing');
            if (typeof showPendingCountdown !== 'function') issues.push('showPendingCountdown missing');
            if (!document.getElementById('segmentModal')) issues.push('segmentModal missing');
            if (issues.length) console.warn('Diagnostics:', tag || '', issues.join(' | '));
            else console.log('Diagnostics OK', tag || '');
        } catch(e) { console.warn('Diagnostics error', e); }
    }

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
    const toggleSegMeta = document.getElementById('toggleSegMeta');
    const toggleSegMetaToolbar = document.getElementById('toggleSegMetaToolbar');
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
    // Stop and release any active MediaStream tracks (microphone)
    function stopCurrentStreamTracks() { try { safelyStopStream(currentStream); } catch(_) {} currentStream = null; }
    let recOptions = {};
    let recMimeType = '';
    let segmentTimerId = null;
    const transcribeTimeouts = new Map(); // key: `${recId}:${idx}:${svc}` -> timeoutId
    const pendingCellUpdates = new Map(); // key: `${recId}:${idx}:${svc}` -> latest transcript
    const pendingCellUpdatesByClientId = new Map(); // key: `${recId}:${clientId}:${svc}`
    const segmentIdToIndex = new Map(); // key: `${recId}:${serverId}` -> idx
    const pendingCellUpdatesByServerId = new Map(); // key: `${recId}:${serverId}:${svc}`
    function getServerId(obj) { try { return obj && (obj.segment_id || obj.sid || obj.server_id || null); } catch(_) { return null; } }
    // Insert-once strategy: wait until we have saved info AND at least one transcript
    const pendingRowsByIdx = new Map(); // `${recId}:${idx}` -> { saved: {...}, transcripts: {svc:text}, inserted: bool }
    const pendingRowsByClientId = new Map(); // `${recId}:${clientId}` -> partial same shape
    const pendingRowsByServerId = new Map(); // `${recId}:${serverId}` -> partial same shape
    const insertedRows = new Set(); // `${recId}:${idx}` rows already inserted
    const pendingInsertTimers = new Map(); // `${recId}:${idx}` -> timeoutId
    const FORCE_WAIT_FOR_TRANSCRIPT = false; // when true, do not fallback-insert rows without transcripts
    function idxKey(recId, idx){ return `${recId}:${idx}`; }
    function clientKey(recId, clientId){ return `${recId}:${clientId}`; }
    function serverKey(recId, serverId){ return `${recId}:${serverId}`; }
    function normalizeId(v){ try { return v === undefined || v === null ? '' : String(v); } catch(_) { return ''; } }
    function mergePending(dst, src){ if (!src) return dst; dst.saved = dst.saved || src.saved || null; dst.transcripts = Object.assign({}, src.transcripts || {}, dst.transcripts || {}); dst.inserted = !!(dst.inserted || src.inserted); return dst; }
    function setPending(map, key, updater){ const cur = map.get(key) || { saved: null, transcripts: {}, inserted: false }; const next = updater ? updater(cur) : cur; map.set(key, next); return next; }
    function collectEnabledServicesSync(){ try { const services = window.__services_cache; if (Array.isArray(services)) return services.filter(s=>s && s.enabled).map(s=>s.key); } catch(_) {} return ['google','vertex','gemini','aws']; }
    // Insert the row exactly once (idempotent). Requires saved info and at least one transcript
    async function maybeInsertRowOnce(rec, segIndex){
        const k = idxKey(rec.id, segIndex);
        if (insertedRows.has(k)) return;
        const p = pendingRowsByIdx.get(k);
        if (!p || !p.saved) return;
        const tx = p.transcripts || {};
        const enabled = collectEnabledServicesSync();
        const hasAnyTx = enabled.some(svc => typeof tx[svc] === 'string' && tx[svc].length);
        if (!hasAnyTx) {
            if (FORCE_WAIT_FOR_TRANSCRIPT) return; // strictly wait until some transcript arrives
        }
        const d = p.saved;
        try {
            await prependSegmentRow(rec, segIndex, d, d.startMs || d.ts || Date.now(), d.endMs || ((d.startMs || d.ts || Date.now()) + (typeof segmentMs === 'number' ? segmentMs : 10000)));
        } catch(e) { console.log('Frontend: prependSegmentRow failed', e); }
        try {
            const row = document.getElementById(`segrow-${rec.id}-${segIndex}`);
            if (row) {
                if (typeof d.id === 'number') row.setAttribute('data-client-id', String(d.id));
                const sid = getServerId(d); if (sid) row.setAttribute('data-server-id', String(sid));
                enabled.forEach(svc => {
                    const text = tx[svc];
                    if (typeof text === 'string' && text.length) {
                        // Persist in arrays for consistency with existing logic
                        try {
                            const arr = (rec.transcripts[svc] = rec.transcripts[svc] || []);
                            while (arr.length <= segIndex) arr.push('');
                            arr[segIndex] = text;
                        } catch(_) {}
                        const td = row.querySelector(`td[data-svc="${svc}"]`);
                        if (td) td.textContent = text;
                        rec.fullAppend = rec.fullAppend || {}; const prev = rec.fullAppend[svc] || ''; rec.fullAppend[svc] = prev ? (prev + ' ' + text) : text;
                        // Update full provider cell or trigger render if absent
                        try {
                            const fullCell = document.querySelector(`#fulltable-${rec.id} td[data-svc="${svc}"]`);
                            if (fullCell) fullCell.textContent = rec.fullAppend[svc];
                            else {
                                const fullWrap = document.getElementById(`fulltable-${rec.id}`);
                                if (fullWrap && typeof htmx !== 'undefined') htmx.ajax('POST', '/render/full_row', { target: fullWrap, values: { record: JSON.stringify(rec) }, swap: 'innerHTML' });
                            }
                        } catch(_) {}
                    }
                });
            }
        } catch(_) {}
        try { if (!hasAnyTx) scheduleSegmentTimeouts(rec.id, segIndex); else scheduleSegmentTimeouts(rec.id, segIndex); } catch(_) {}
        insertedRows.add(k);
        // cleanup auxiliary maps for this segment
        try { const sid = getServerId(p.saved); if (sid) pendingRowsByServerId.delete(serverKey(rec.id, sid)); } catch(_) {}
        try { if (typeof p.saved.id === 'number') pendingRowsByClientId.delete(clientKey(rec.id, p.saved.id)); } catch(_) {}
        // clear any pending fallback timer
        try { const t = pendingInsertTimers.get(k); if (t) { clearTimeout(t); pendingInsertTimers.delete(k); } } catch(_) {}
    }

    // Fallback: if no transcript arrives in time, insert the row with blank cells so UI progresses
    async function forceInsertWithoutTx(rec, segIndex){
        const k = idxKey(rec.id, segIndex);
        if (insertedRows.has(k)) return;
        const p = pendingRowsByIdx.get(k);
        if (!p || !p.saved) return;
        const d = p.saved;
        try {
            await prependSegmentRow(rec, segIndex, d, d.startMs || d.ts || Date.now(), d.endMs || ((d.startMs || d.ts || Date.now()) + (typeof segmentMs === 'number' ? segmentMs : 10000)));
        } catch(e) { console.log('Frontend: prependSegmentRow (fallback) failed', e); }
        insertedRows.add(k);
        // schedule provider timeouts to mark 'no result' cells
        try { scheduleSegmentTimeouts(rec.id, segIndex); } catch(_) {}
        try { const t = pendingInsertTimers.get(k); if (t) { clearTimeout(t); pendingInsertTimers.delete(k); } } catch(_) {}
    }
    function findSegmentRowEl(recId, segIndex, clientId, serverId) {
        try {
            if (typeof segIndex === 'number' && segIndex >= 0) {
                const byIdx = document.getElementById(`segrow-${recId}-${segIndex}`);
                if (byIdx) return byIdx;
            }
            const root = document.getElementById(`segtbody-${recId}`) || document;
            if (typeof clientId === 'number') {
                const byClient = root.querySelector(`tr[data-client-id="${clientId}"]`);
                if (byClient) return byClient;
            }
            if (serverId) {
                const byServer = root.querySelector(`tr[data-server-id="${serverId}"]`);
                if (byServer) return byServer;
            }
        } catch(_) {}
        return null;
    }
    let audioCtxInstance = null; // Shared AudioContext to fully release audio resources on stop
    let testActiveStream = null; // Tracks settings-modal test recorder stream
    
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

    // Request microphone with progressive fallbacks to avoid overconstrained errors
    async function getMicStreamWithFallback() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('getUserMedia not supported in this browser');
        }
        const attempts = [
            { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, sampleRate: 48000 } },
            { audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } } },
            { audio: true }
        ];
        let lastErr = null;
        for (const constraints of attempts) {
            try { return await navigator.mediaDevices.getUserMedia(constraints); } catch (e) { lastErr = e; }
        }
        // Try with a specific audioinput deviceId if available
        try {
            const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d && d.kind === 'audioinput');
            for (const d of devices) {
                try { return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: d.deviceId } } }); } catch(_) {}
                try { return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { ideal: d.deviceId } } }); } catch(_) {}
            }
        } catch(_) {}
        throw lastErr || new Error('Failed to acquire microphone');
    }

    // moved to recorder_utils.js
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
        runDiagnostics('openSegmentModal');
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

    // Display toggle: show/hide segment download & size labels
    (function wireSegMetaToggle(){
        try {
            const key = 'ui.showSegMeta';
            const apply = (on) => {
                const root = document.documentElement || document.body;
                if (!root) return;
                if (on) root.classList.remove('hide-segmeta');
                else root.classList.add('hide-segmeta');
            };
            const saved = localStorage.getItem(key);
            const initial = saved === null ? true : (saved === 'true');
            apply(initial);
            if (toggleSegMeta) {
                toggleSegMeta.checked = initial;
                toggleSegMeta.addEventListener('change', () => {
                    const on = !!toggleSegMeta.checked;
                    localStorage.setItem(key, String(on));
                    apply(on);
                    if (toggleSegMetaToolbar) toggleSegMetaToolbar.checked = on;
                });
            }
            if (toggleSegMetaToolbar) {
                toggleSegMetaToolbar.checked = initial;
                toggleSegMetaToolbar.addEventListener('change', () => {
                    const on = !!toggleSegMetaToolbar.checked;
                    localStorage.setItem(key, String(on));
                    apply(on);
                    if (toggleSegMeta) toggleSegMeta.checked = on;
                });
            }
        } catch(_) {}
    })();

    // Separate toggle for Time column (toolbar only)
    (function wireTimeColToggle(){
        try {
            const toggleTimeColToolbar = document.getElementById('toggleTimeColToolbar');
            const key = 'ui.showTimeCol';
            const apply = (on) => {
                const root = document.documentElement || document.body;
                if (!root) return;
                if (on) root.classList.remove('hide-timecol');
                else root.classList.add('hide-timecol');
            };
            const saved = localStorage.getItem(key);
            const initial = saved === null ? true : (saved === 'true');
            apply(initial);
            if (toggleTimeColToolbar) {
                toggleTimeColToolbar.checked = initial;
                toggleTimeColToolbar.addEventListener('change', () => {
                    const on = !!toggleTimeColToolbar.checked;
                    localStorage.setItem(key, String(on));
                    apply(on);
                });
            }
        } catch(_) {}
    })();

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
            const isActive = (!!segmentLoopActive) || (!!mediaRecorder && mediaRecorder.state === 'recording');
            if (!isActive) { console.log('Frontend: skip scheduling timeout (not active)', { recordId, idx }); return; }
            const services = await getServicesCached();
            const enabled = services.filter(s => s.enabled);
            const TIMEOUT_MS = Number(segmentMs) && Number(segmentMs) >= 1000 ? Number(segmentMs) + 500 : 30000;
            enabled.forEach(s => {
                const k = timeoutKey(recordId, idx, s.key);
                if (transcribeTimeouts.has(k)) return;
                // If transcript already present, skip scheduling
                try {
                    if (currentRecording && currentRecording.transcripts && currentRecording.transcripts[s.key]) {
                        const arr = currentRecording.transcripts[s.key];
                        if (idx < arr.length && typeof arr[idx] === 'string' && arr[idx].trim()) {
                            console.log('Frontend: skip timeout (already has transcript)', { recordId, idx, svc: s.key });
                            return;
                        }
                    }
                } catch(_) {}
                const to = setTimeout(() => {
                    if (!segmentLoopActive) { transcribeTimeouts.delete(k); return; }
                    // If a transcript arrived, do not apply timeout
                    try {
                        if (currentRecording && currentRecording.transcripts && currentRecording.transcripts[s.key]) {
                            const arr = currentRecording.transcripts[s.key];
                            if (idx < arr.length && typeof arr[idx] === 'string' && arr[idx].trim()) {
                                transcribeTimeouts.delete(k);
                                console.log('Frontend: timeout skipped (transcript present)', { recordId, idx, svc: s.key });
                                return;
                            }
                        }
                    } catch(_) {}
                    try {
                        const row = document.getElementById(`segrow-${recordId}-${idx}`);
                        if (!row) return;
                        const td = row.querySelector(`td[data-svc="${s.key}"]`);
                        if (td) { td.textContent = 'no result (timeout)'; console.log('Frontend: timeout applied', { recordId, idx, svc: s.key }); }
                        if (currentRecording && currentRecording.id === recordId) {
                            const arr = (currentRecording.timeouts[s.key] = currentRecording.timeouts[s.key] || []);
                            while (arr.length <= idx) arr.push(false);
                            arr[idx] = true;
                        }
                    } catch(_) {}
                    transcribeTimeouts.delete(k);
                }, TIMEOUT_MS);
                transcribeTimeouts.set(k, to);
                console.log('Frontend: scheduled timeout', { recordId, idx, svc: s.key, ms: TIMEOUT_MS });
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
        runDiagnostics('startRecording');
        // Prevent mobile devices from auto-locking while recording
        try { await acquireWakeLock(); } catch(_) {}

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
            timeouts: { google: [], vertex: [], gemini: [], aws: [] },
            _compatIdx: -1
        };
        recordings.push(currentRecording);
        lastRecordingId = currentRecording.id;
        ensureRecordingTab(currentRecording);
        renderRecordingPanel(currentRecording);

        // No separate placeholder row; countdown pending row is used instead

        // Step 0.5: preemptively stop settings-modal test stream if running
        try { if (testActiveStream && testActiveStream.getTracks) testActiveStream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
        testActiveStream = null;

        // Step 1: Acquire microphone stream with focused error handling
        let stream = null;
        try {
            stopCurrentStreamTracks();
            stream = await getMicStreamWithFallback();
        } catch (err) {
            console.error('Frontend: Microphone acquisition failed:', err);
            let msg = 'Error accessing microphone. Please ensure permissions are granted.';
            try {
                const name = err && (err.name || err.code) || '';
                if (name === 'NotAllowedError' || name === 'PermissionDeniedError') msg = 'Microphone permission denied. Please allow access and try again.';
                else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') msg = 'No microphone found. Please connect a mic and try again.';
                else if (name === 'NotReadableError' || name === 'TrackStartError') msg = 'Microphone is in use by another application. Close other apps and retry.';
                else if (name === 'OverconstrainedError') msg = 'Selected audio constraints are not supported by your device. Try a different input device.';
                if (name) msg += `\n(${name})`;
            } catch(_) {}
            alert(msg);
            startRecordingButton.disabled = false;
            stopRecordingButton.disabled = true;
            return;
        }

        try {
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
            try {
                const ref = { value: recMimeType };
                mediaRecorder = createMediaRecorderWithFallback(currentStream, ref);
                if (!recMimeType) recMimeType = ref.value || recMimeType;
            } catch (e) {
                console.error('Frontend: Failed to create MediaRecorder with fallbacks:', e);
                alert(`Recording setup failed. Please try again.${e && (e.name || e.code) ? ` (${e.name || e.code})` : ''}`);
                safelyStopStream(currentStream);
                stopCurrentStreamTracks();
                startRecordingButton.disabled = false;
                stopRecordingButton.disabled = true;
                return;
            }
            fullChunks = [];
            mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size) {
                    fullChunks.push(e.data);
                    if (USE_COMPAT_SINGLE_RECORDER) {
                        try {
                            const segBlob = e.data;
                            const ts = Date.now();
                            // Derive a 0-based segment index for stable ordering
                            try { currentRecording._compatIdx = (typeof currentRecording._compatIdx === 'number') ? (currentRecording._compatIdx + 1) : 0; } catch(_) { currentRecording._compatIdx = 0; }
                            const segIndex = currentRecording._compatIdx;
                            // Seed segments array with a placeholder so transcript updates can target this row
                            try {
                                while (currentRecording.segments.length <= segIndex) currentRecording.segments.push(null);
                                const base = currentRecording.startTs || ts;
                                const segDur = (typeof segmentMs === 'number' && segmentMs > 0) ? segmentMs : 10000;
                                const startMs = base + (segIndex * segDur);
                                const endMs = startMs + segDur;
                                currentRecording.segments[segIndex] = { idx: segIndex, url: '', mime: segBlob.type || '', size: segBlob.size || 0, ts, startMs, endMs, clientId: ts };
                            } catch(_) {}
                            // Upload to backend via WebSocket with client id and idx for server mapping
                            try {
                                if (socket && socket.readyState === WebSocket.OPEN) {
                                    segBlob.arrayBuffer().then(buf => {
                                        const b64 = ab2b64(buf);
                                        try { socket.send(JSON.stringify({ type: 'segment', audio: b64, id: ts, idx: segIndex, ts, mime: segBlob.type, duration_ms: segmentMs })); } catch(_) {}
                                    }).catch(()=>{});
                                }
                            } catch(_) {}
                            // Defer any UI insertion until we have transcript(s)
                        } catch(_) {}
                    }
                }
            };

            // Build AudioWorklet graph for PCM16 capture (replaces deprecated ScriptProcessorNode)
            try { if (audioCtxInstance && typeof audioCtxInstance.close === 'function') await audioCtxInstance.close(); } catch(_) {}
            audioCtxInstance = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            try { await audioCtxInstance.audioWorklet.addModule('/static/audio/pcm-worklet.js'); } catch (e) { console.warn('Frontend: failed to add worklet, falling back', e); }
            if (audioCtxInstance.audioWorklet) {
            const source = audioCtxInstance.createMediaStreamSource(stream);
                try {
                    const workletNode = (typeof AudioWorkletNode !== 'undefined')
                        ? new AudioWorkletNode(audioCtxInstance, 'pcm16-worklet', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
                        : null;
                    if (workletNode) {
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
                        workletNode.connect(audioCtxInstance.destination);
                    } else {
                        console.warn('Frontend: AudioWorkletNode not available; skipping PCM16 live capture.');
                    }
                } catch (e) {
                    console.warn('Frontend: Failed to initialize AudioWorkletNode; skipping PCM16 live capture.', e);
                }
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
                if (USE_COMPAT_SINGLE_RECORDER) {
                    try { mediaRecorder.start(segmentMs); console.log('Frontend: Full recorder started (timeslice=', segmentMs, ').'); } catch (e) {
                        console.warn('Frontend: mediaRecorder.start(timeslice) failed:', e);
                        alert(`Recording setup failed. Please try again.${e && (e.name || e.code) ? ` (${e.name || e.code})` : ''}`);
                        try { if (currentStream && currentStream.getTracks) currentStream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
                        stopCurrentStreamTracks();
                        startRecordingButton.disabled = false;
                        stopRecordingButton.disabled = true;
                        return;
                    }
                    // Remove countdown usage in compat mode; show a running clock next to the active tab
                    try {
                        const tabBtn = document.getElementById(`tab-${currentRecording.id}`);
                        if (tabBtn) {
                            const start = Date.now();
                            if (window.__recClockRaf) cancelAnimationFrame(window.__recClockRaf);
                            const tick = () => {
                                const elapsed = Math.max(0, Math.round((Date.now() - start)/1000));
                                tabBtn.textContent = `${new Date(currentRecording.startTs).toLocaleTimeString()} (+${elapsed}s)`;
                                window.__recClockRaf = requestAnimationFrame(tick);
                            };
                            window.__recClockRaf = requestAnimationFrame(tick);
                        }
                    } catch(_) {}
                } else {
                    try { mediaRecorder.start(); console.log('Frontend: Full recorder started (continuous).'); }
                    catch (e) {
                        console.warn('Frontend: mediaRecorder.start failed:', e);
                        alert(`Recording setup failed. Please try again.${e && (e.name || e.code) ? ` (${e.name || e.code})` : ''}`);
                        try { if (currentStream && currentStream.getTracks) currentStream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
                        stopCurrentStreamTracks();
                        startRecordingButton.disabled = false;
                        stopRecordingButton.disabled = true;
                        return;
                    }
                startSegmentLoop();
                // Ensure first pending row is created and subsequent cycles keep a visible countdown row
                try { showPendingCountdown(currentRecording.id, segmentMs, () => segmentLoopActive, () => (segmentRecorder && segmentRecorder.state === 'recording')); } catch(_) {}
                }
                // Attach WS message handler for UI updates as a fallback when SSE isn't available
                try {
                    const handleSegmentSaved = async (data) => {
                        try {
                            const rec = currentRecording || (recordings.find(r => r && r.id === lastRecordingId) || null);
                            if (!rec) return;
                            let segIndex = (typeof data.idx === 'number') ? data.idx : -1;
                            if (segIndex < 0 && typeof data.id === 'number') {
                                try {
                                    const found = rec.segments.find(s => s && s.clientId === data.id);
                                    if (found && typeof found.idx === 'number') segIndex = found.idx;
                                } catch(_) {}
                            }
                            const serverId = getServerId(data);
                            if (segIndex < 0) segIndex = rec.segments.length;
                            while (rec.segments.length <= segIndex) rec.segments.push(null);
                            const seeded = rec.segments[segIndex] || {};
                            const seededStart = (seeded && typeof seeded.startMs === 'number') ? seeded.startMs : ((typeof data.ts === 'number') ? data.ts : Date.now());
                            const seededEnd = (seeded && typeof seeded.endMs === 'number') ? seeded.endMs : (seededStart + (typeof segmentMs === 'number' ? segmentMs : 10000));
                            rec.segments[segIndex] = { idx: segIndex, url: data.url, mime: data.mime || '', size: data.size || null, ts: data.ts, startMs: seededStart, endMs: seededEnd, clientId: data.id, serverId };
                            // Map serverId -> idx for future transcript routing
                            if (serverId) {
                                try { segmentIdToIndex.set(`${rec.id}:${serverId}`, segIndex); } catch(_) {}
                            }
                            // Remove any temp row for this client timestamp
                            try { const temp = document.getElementById(`segtemp-${rec.id}-${data.id}`); if (temp && temp.parentElement) temp.parentElement.removeChild(temp); } catch(_) {}
                            // Store saved info; defer insertion until transcript(s) arrive
                            try {
                                const payload = { url: data.url, mime: data.mime || '', size: data.size || null, ts: data.ts, startMs: seededStart, endMs: seededEnd, id: data.id, segment_id: serverId };
                                const K = idxKey(rec.id, segIndex);
                                const base = setPending(pendingRowsByIdx, K, cur => { cur.saved = payload; return cur; });
                                if (typeof data.id === 'number') setPending(pendingRowsByClientId, clientKey(rec.id, data.id), cur => mergePending(cur, base));
                                if (serverId) setPending(pendingRowsByServerId, serverKey(rec.id, serverId), cur => mergePending(cur, base));
                                // schedule fallback insertion only when not strictly waiting for transcript
                                try {
                                    if (!FORCE_WAIT_FOR_TRANSCRIPT && !pendingInsertTimers.has(K)) {
                                        const TIMEOUT_MS = Number(segmentMs) && Number(segmentMs) >= 1000 ? (Number(segmentMs) + 1500) : 30000;
                                        const to = setTimeout(() => {
                                            try { forceInsertWithoutTx(rec, segIndex); } catch(_) {}
                                        }, TIMEOUT_MS);
                                        pendingInsertTimers.set(K, to);
                                    }
                                } catch(_) {}
                                // If server already included transcripts, store and try insert
                                if (data.transcripts || data.tx) {
                                    const tx = data.transcripts || data.tx || {};
                                    const merged = setPending(pendingRowsByIdx, K, cur => { cur.transcripts = Object.assign({}, cur.transcripts || {}, tx); return cur; });
                                    await maybeInsertRowOnce(rec, segIndex);
                                }
                                // Merge any transcripts that arrived earlier keyed by client/server id, then try insert
                                try {
                                    if (typeof data.id === 'number') {
                                        const part = pendingRowsByClientId.get(clientKey(rec.id, data.id));
                                        if (part) setPending(pendingRowsByIdx, K, cur => mergePending(cur, part));
                                    }
                                    if (serverId) {
                                        const part2 = pendingRowsByServerId.get(serverKey(rec.id, serverId));
                                        if (part2) setPending(pendingRowsByIdx, K, cur => mergePending(cur, part2));
                                    }
                                } catch(_) {}
                                await maybeInsertRowOnce(rec, segIndex);
                            } catch(_) {}
                            // Prefer single-shot update: if server includes transcripts now, apply them all
                            try {
                                const tx = data.transcripts || data.tx || null;
                                if (tx && typeof tx === 'object') {
                                    const services = Object.keys(tx);
                                    services.forEach(svc => {
                                        const text = tx[svc];
                                        if (typeof text !== 'string' || !text.length) return;
                                        const arr = (rec.transcripts[svc] = rec.transcripts[svc] || []);
                                        while (arr.length <= segIndex) arr.push('');
                                        arr[segIndex] = text;
                                        // Clear timeout for this provider
                                        clearSvcTimeout(rec.id, segIndex, svc);
                                        // Update segment cell
                                        try {
                                            const row = document.getElementById(`segrow-${rec.id}-${segIndex}`);
                                            if (row) {
                                                const td = row.querySelector(`td[data-svc="${svc}"]`);
                                                if (td) td.textContent = text;
                                            }
                                        } catch(_) {}
                                        // Append to full provider cell
                                        rec.fullAppend = rec.fullAppend || {};
                                        const prev = rec.fullAppend[svc] || '';
                                        rec.fullAppend[svc] = prev ? (prev + ' ' + text) : text;
                                        try {
                                            const fullCell = document.querySelector(`#fulltable-${rec.id} td[data-svc="${svc}"]`);
                                            if (fullCell) fullCell.textContent = rec.fullAppend[svc];
                                        } catch(_) {}
                                    });
                                }
                            } catch(_) {}
                            // If a temp row still exists for this client id, merge queued clientId transcripts into the new row
                            try {
                                const prefix = `${rec.id}:${data.id}:`;
                                for (const [k, txt] of pendingCellUpdatesByClientId.entries()) {
                                    if (!k.startsWith(prefix)) continue;
                                    const parts = k.split(':');
                                    const svc = parts[2] || '';
                                    const row = document.getElementById(`segrow-${rec.id}-${segIndex}`);
                                    if (row) {
                                        const td = row.querySelector(`td[data-svc="${svc}"]`);
                                        if (td && typeof txt === 'string') td.textContent = txt;
                                        pendingCellUpdatesByClientId.delete(k);
                                    }
                                }
                            } catch(_) {}
                            // Flush any transcripts queued by serverId
                            try {
                                if (serverId) {
                                    const prefix2 = `${rec.id}:${serverId}:`;
                                    for (const [k, txt] of pendingCellUpdatesByServerId.entries()) {
                                        if (!k.startsWith(prefix2)) continue;
                                        const parts = k.split(':');
                                        const svc = parts[2] || '';
                                        const row = document.getElementById(`segrow-${rec.id}-${segIndex}`);
                                        if (row) {
                                            const td = row.querySelector(`td[data-svc="${svc}"]`);
                                            if (td && typeof txt === 'string') td.textContent = txt;
                                            pendingCellUpdatesByServerId.delete(k);
                                        }
                                    }
                                }
                            } catch(_) {}
                            // No countdown row in compat mode; scheduling deferred until insertion
                            // Flush any pending transcript updates queued before the row existed
                            try {
                                const services = ['google','vertex','gemini','aws'];
                                for (const svc of services) {
                                    const key = `${rec.id}:${segIndex}:${svc}`;
                                    if (pendingCellUpdates.has(key)) {
                                        const txt = pendingCellUpdates.get(key);
                                        const row = document.getElementById(`segrow-${rec.id}-${segIndex}`);
                                        if (row) {
                                            const td = row.querySelector(`td[data-svc="${svc}"]`);
                                            if (td) td.textContent = txt;
                                        }
                                        pendingCellUpdates.delete(key);
                                    }
                                    // Also flush updates keyed by clientId if present
                                    const key2 = `${rec.id}:${data.id}:${svc}`;
                                    if (pendingCellUpdatesByClientId.has(key2)) {
                                        const txt = pendingCellUpdatesByClientId.get(key2);
                                        const row = document.getElementById(`segrow-${rec.id}-${segIndex}`);
                                        if (row) {
                                            const td = row.querySelector(`td[data-svc="${svc}"]`);
                                            if (td) td.textContent = txt;
                                        }
                                        pendingCellUpdatesByClientId.delete(key2);
                                    }
                                }
                            } catch(_) {}
                        } catch(_) {}
                    };
                    const handleSaved = (data) => {
                        try {
                            const rec = currentRecording || (recordings.find(r => r && r.id === lastRecordingId) || recordings[recordings.length - 1]);
                            if (rec) {
                                if (data.url) rec.serverUrl = data.url;
                                if (typeof data.size === 'number') rec.serverSizeBytes = data.size;
                                // Inline update meta: audio src, download icon, size label
                                const meta = document.getElementById(`recordmeta-${rec.id}`);
                                if (meta && rec.serverUrl) {
                                    try {
                                        // Ensure audio points to server URL
                                        let audio = meta.querySelector('audio');
                                        if (audio) {
                                            let srcEl = audio.querySelector('source');
                                            if (!srcEl) { srcEl = document.createElement('source'); audio.appendChild(srcEl); }
                                            srcEl.src = rec.serverUrl; srcEl.type = (rec.serverUrl.toLowerCase().includes('.ogg') ? 'audio/ogg' : 'audio/webm');
                                            try { audio.load(); } catch(_) {}
                                        }
                                        // Ensure download link exists
                                        let dl = meta.querySelector('a[data-load-full]');
                                        if (!dl) {
                                            dl = document.createElement('a');
                                            dl.textContent = '📥'; dl.title = 'Download'; dl.style.cursor = 'pointer'; dl.style.textDecoration = 'none';
                                            meta.appendChild(document.createTextNode(' '));
                                            meta.appendChild(dl);
                                        }
                                        dl.setAttribute('href', rec.serverUrl);
                                        dl.setAttribute('download', '');
                                        dl.setAttribute('data-load-full', rec.serverUrl);
                                        // Ensure size label exists
                                        const sizeBytes = (typeof rec.serverSizeBytes === 'number' && rec.serverSizeBytes > 0) ? rec.serverSizeBytes : (rec.clientSizeBytes || 0);
                                        if (sizeBytes) {
                                            const kb = Math.max(1, Math.round(sizeBytes/1024));
                                            let sm = meta.querySelector('small[data-load-full]');
                                            if (!sm) { sm = document.createElement('small'); meta.appendChild(document.createTextNode(' ')); meta.appendChild(sm); }
                                            sm.textContent = `(${kb} KB)`;
                                            sm.setAttribute('data-load-full', rec.serverUrl);
                                            sm.style.cursor = 'pointer';
                                        }
                                    } catch(_) {}
                                }
                                // Recompute fullAppend from transcripts to fill any missed segments
                                try {
                                    const services = ['google','vertex','gemini','aws'];
                                    services.forEach(svc => {
                                        const arr = (rec.transcripts && rec.transcripts[svc]) ? rec.transcripts[svc] : [];
                                        const joined = Array.isArray(arr) ? arr.filter(Boolean).join(' ') : '';
                                        rec.fullAppend = rec.fullAppend || {};
                                        if (joined) rec.fullAppend[svc] = joined;
                                        const fullCell = document.querySelector(`#fulltable-${rec.id} td[data-svc="${svc}"]`);
                                        if (fullCell && joined) {
                                            const hasDownloadChild = !!fullCell.querySelector('[data-load-full]');
                                            if (hasDownloadChild) {
                                                let span = fullCell.querySelector('span.full-text');
                                                if (!span) { span = document.createElement('span'); span.className = 'full-text'; fullCell.appendChild(document.createTextNode(' ')); fullCell.appendChild(span); }
                                                span.textContent = joined;
                                            } else {
                                                fullCell.textContent = joined;
                                            }
                                        }
                                    });
                                } catch(_) {}
                            }
                            // If user requested stop, close WS shortly after save confirmation
                            if (pendingStop && socket && socket.readyState === WebSocket.OPEN) {
                                if (savedCloseTimer) { try { clearTimeout(savedCloseTimer); } catch(_) {} }
                                savedCloseTimer = setTimeout(() => { try { socket.close(); } catch(_) {} }, 300);
                            }
                        } catch(_) {}
                    };
                    const handleTranscript = async (msg) => {
                        try {
                            if (!msg.transcript && !msg.error) console.log(`[WS:${msg.type}] empty result`, msg);
                            if (msg.error) console.log(`[WS:${msg.type}] error`, msg.error);
                            const rec = currentRecording || (recordings.find(r => r && r.id === lastRecordingId) || null);
                            if (!rec) return;
                            const serverId = getServerId(msg);
                            let segIndex = (typeof msg.idx === 'number') ? msg.idx : -1;
                            if (segIndex < 0 && serverId) {
                                try {
                                    const mapped = segmentIdToIndex.get(`${rec.id}:${serverId}`);
                                    if (typeof mapped === 'number') segIndex = mapped;
                                } catch(_) {}
                            }
                            if (segIndex < 0 && typeof msg.id === 'number') {
                                // Fallback to client timestamp id mapping
                                try {
                                    const found = rec.segments.find(s => s && s.clientId === msg.id);
                                    if (found) segIndex = found.idx;
                                } catch(_) {}
                            }
                            if (segIndex < 0) { console.log(`[WS:${msg.type}] missing idx/id, queueing by client/server id`, msg); }
                            try {
                                let svc = (msg.type || '').replace('segment_transcript_', '') || '';
                                if (!svc) svc = msg.svc || msg.provider || msg.service || '';
                                if (svc) {
                                    // Always append a live indicator (or queue it if full table not rendered yet)
                                    if (typeof msg.transcript === 'string' && msg.transcript.trim()) {
                                        try {
                                            const cell = ensureFullCell(rec.id, svc);
                                            if (cell) appendFullLiveText(rec.id, svc, msg.transcript.trim());
                                            else addPendingFullLive(rec, svc, msg.transcript.trim());
                                        } catch(_) {}
                                    }
                                    if (typeof msg.transcript === 'string' && msg.transcript.length) {
                                        if (segIndex >= 0) {
                                            const K = idxKey(rec.id, segIndex);
                                            setPending(pendingRowsByIdx, K, cur => { cur.transcripts = Object.assign({}, cur.transcripts || {}, { [svc]: msg.transcript }); return cur; });
                                            try { if (serverId) segmentIdToIndex.set(`${rec.id}:${serverId}`, segIndex); } catch(_) {}
                                            await maybeInsertRowOnce(rec, segIndex);
                                            // If row already exists, update arrays and cells immediately
                                    try {
                                        const row = document.getElementById(`segrow-${rec.id}-${segIndex}`);
                                        if (row) {
                                                    const arr = (rec.transcripts[svc] = rec.transcripts[svc] || []);
                                                    while (arr.length <= segIndex) arr.push('');
                                                    arr[segIndex] = msg.transcript;
                                                    clearSvcTimeout(rec.id, segIndex, svc);
                                            const td = row.querySelector(`td[data-svc="${svc}"]`);
                                                    if (td) td.textContent = msg.transcript;
                                                    rec.fullAppend = rec.fullAppend || {};
                                                    const prev = rec.fullAppend[svc] || '';
                                                    rec.fullAppend[svc] = prev ? (prev + ' ' + msg.transcript) : msg.transcript;
                                                    try { setFullAssignedText(rec.id, svc, rec.fullAppend[svc]); } catch(_) {}
                                        }
                                    } catch(_) {}
                                        } else {
                                            if (typeof msg.id === 'number') setPending(pendingRowsByClientId, clientKey(rec.id, msg.id), cur => { cur.transcripts = Object.assign({}, cur.transcripts || {}, { [svc]: msg.transcript }); return cur; });
                                            if (serverId) setPending(pendingRowsByServerId, serverKey(rec.id, serverId), cur => { cur.transcripts = Object.assign({}, cur.transcripts || {}, { [svc]: msg.transcript }); return cur; });
                                        }
                                    }
                                }
                            } catch(e) { console.log('Frontend: handleTranscript update failed', e); }
                                        } catch(_) {}
                    };
                    const handleSegmentAck = async (msg) => {
                        try {
                            const rec = currentRecording || (recordings.find(r => r && r.id === lastRecordingId) || null);
                            if (!rec) return;
                            const serverId = getServerId(msg);
                            let segIndex = (typeof msg.idx === 'number') ? msg.idx : -1;
                            if (segIndex < 0 && typeof msg.id === 'number') {
                                try { const found = rec.segments.find(s => s && s.clientId === msg.id); if (found) segIndex = found.idx; } catch(_) {}
                            }
                            if (segIndex < 0 && serverId) {
                                try { const mapped = segmentIdToIndex.get(`${rec.id}:${serverId}`); if (typeof mapped === 'number') segIndex = mapped; } catch(_) {}
                            }
                            if (segIndex < 0) segIndex = rec.segments.length;
                            while (rec.segments.length <= segIndex) rec.segments.push(null);
                            const seeded = rec.segments[segIndex] || {};
                            rec.segments[segIndex] = Object.assign({}, seeded, { idx: segIndex, clientId: (typeof msg.id === 'number' ? msg.id : seeded.clientId), serverId });
                            if (serverId) segmentIdToIndex.set(`${rec.id}:${serverId}`, segIndex);
                            // Merge any pending transcript/save parts onto idx key now
                            try {
                                if (typeof msg.id === 'number') {
                                    const part = pendingRowsByClientId.get(clientKey(rec.id, msg.id));
                                    if (part) setPending(pendingRowsByIdx, idxKey(rec.id, segIndex), cur => mergePending(cur, part));
                                }
                                if (serverId) {
                                    const part2 = pendingRowsByServerId.get(serverKey(rec.id, serverId));
                                    if (part2) setPending(pendingRowsByIdx, idxKey(rec.id, segIndex), cur => mergePending(cur, part2));
                                }
                                await maybeInsertRowOnce(rec, segIndex);
                            } catch(_) {}
                        } catch(_) {}
                    };
                    socket.addEventListener('message', (ev) => {
                        try {
                            const msg = JSON.parse(ev.data);
                            if (!msg || !msg.type) return;
                            if (msg.type === 'segment_ack') return handleSegmentAck(msg);
                            if (msg.type === 'segment_row') return handleSegmentSaved(msg);
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

            // WebSocket handlers drive live UI updates; SSE may be used only for saved/segment_saved.

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

            const startSegmentLoop = createSegmentLoop(
                () => currentStream,
                () => recOptions,
                () => segmentMs,
                // onSegmentStart: show countdown for the fresh recorder instance
                (recorder) => { 
                    // Track the currently active segment MediaRecorder so we can stop it on demand
                    segmentRecorder = recorder;
                    try { recorder.addEventListener('stop', () => { if (segmentRecorder === recorder) segmentRecorder = null; }); } catch(_) {}
                    try { showPendingCountdown(currentRecording.id, segmentMs, () => segmentLoopActive, () => (recorder && recorder.state === 'recording')); } catch(_) {}
                },
                // uploadSegment: encode and send to WS
                async (ts, blob) => {
                    try { const arrayBuffer = await blob.arrayBuffer(); const b64 = ab2b64(arrayBuffer); socket.send(JSON.stringify({ type: 'segment', audio: b64, id: ts, ts, mime: blob.type })); } catch(_) {}
                },
                () => currentRecording,
                () => segmentLoopActive,
                (active) => { segmentLoopActive = active; },
                socket
            );

            /**
             * Stop the repeating segment recorder loop.
             */
            function stopSegmentLoop() {
                segmentLoopActive = false;
                try { if (segmentRecorder && segmentRecorder.state === 'recording') segmentRecorder.stop(); } catch (_) {}
                // Clear reference so future checks don't hold onto a stale recorder
                segmentRecorder = null;
            }

            // Finalize the full recording; upload the blob, and close the socket
            mediaRecorder.onstop = async () => {
                console.log('Frontend: MediaRecorder stopped.');
                if (segmentRotate) { segmentRotate = false; stopSegmentLoop(); startSegmentLoop(); return; }
                const stopTs = Date.now();
                if (currentRecording) { currentRecording.stopTs = stopTs; currentRecording.durationMs = stopTs - (currentRecording.startTs || stopTs); }

                stopSegmentLoop();
                // Close audio context to fully release any audio resources
                try { if (audioCtxInstance && typeof audioCtxInstance.close === 'function') await audioCtxInstance.close(); } catch(_) {}
                audioCtxInstance = null;
                const audioBlob = new Blob(fullChunks, { type: recMimeType || 'audio/webm' });
                const audioUrl = URL.createObjectURL(audioBlob);
                console.log('Frontend: Generated audio URL:', audioUrl);

                // Finalize single-session recording
                if (currentRecording) {
                    currentRecording.audioUrl = audioUrl;
                    currentRecording.clientSizeBytes = audioBlob.size;
                    console.log('Frontend: Updated current recording with audioUrl:', currentRecording);
                    // Insert a full recording row at the very top of the segments table (created only on Stop)
                    try {
                        const tbody = document.getElementById(`segtbody-${currentRecording.id}`);
                        if (tbody) {
                            let tr = document.getElementById(`fullrowline-${currentRecording.id}`);
                            if (!tr) {
                                tr = document.createElement('tr');
                                tr.id = `fullrowline-${currentRecording.id}`;
                                const td = document.createElement('td');
                                // Determine total column count from thead
                                let colCount = 2; // Segment + Time (minimum)
                                try {
                                    const segTable = document.getElementById(`segtable-${currentRecording.id}`);
                                    if (segTable) colCount = Math.max(1, segTable.querySelectorAll('thead th').length);
                                } catch(_) {}
                                td.setAttribute('colspan', String(colCount));
                                tr.appendChild(td);
                                tbody.insertBefore(tr, tbody.firstChild);
                            }
                            const mime = (audioUrl && audioUrl.toLowerCase().includes('.ogg')) ? 'audio/ogg' : (recMimeType || 'audio/webm');
                            // Match segment size label style: parentheses, clickable to force-load
                            // Match segment size label format: integer KB in parentheses
                            const sizeBytes = (typeof currentRecording.serverSizeBytes === 'number' && currentRecording.serverSizeBytes > 0)
                                ? currentRecording.serverSizeBytes : (audioBlob.size || 0);
                            const kb = sizeBytes ? Math.max(1, Math.round(sizeBytes/1024)) : 0;
                            const sizeHtml = kb ? ` <small data-load-full="${audioUrl}" style="cursor:pointer">(${kb} KB)</small>` : '';
                            const playerHtml = `<audio controls><source src="${audioUrl}" type="${mime}"></audio>`;
                            const dlHtml = `<a href="${audioUrl}" download title="Download" style="cursor:pointer;text-decoration:none">📥</a>`;
                            tr.firstChild.innerHTML = `${playerHtml} ${dlHtml}${sizeHtml}`;
                            // Stop the running clock on stop
                            try { if (window.__recClockRaf) cancelAnimationFrame(window.__recClockRaf); } catch(_) {}
                        }
                        // Update tab button with compact start->end (duration)
                        try {
                            const tabBtn = document.getElementById(`tab-${currentRecording.id}`);
                            if (tabBtn) {
                                const s = new Date(currentRecording.startTs).toLocaleTimeString();
                                const e = new Date(currentRecording.stopTs).toLocaleTimeString();
                                const d = Math.max(0, Math.round((currentRecording.durationMs || 0)/1000));
                                tabBtn.textContent = `${s}→${e} (${d}s)`;
                            }
                        } catch(_) {}
                        const hdr = document.getElementById(`recordhdr-${currentRecording.id}`);
                        if (hdr) {
                            hdr.textContent = ''; // clear header info; tab now carries the timing
                        }
                    } catch(_) {}
                }
                // Upload full recording before closing socket
                try {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        const fullBuf = await audioBlob.arrayBuffer();
                        const b64full = arrayBufferToBase64(fullBuf);
                        sendJSON(socket, { type: 'full_upload', audio: b64full, mime: recMimeType || 'audio/webm' });
                    }
                } catch (_) {}
                // Close socket as requested; will reopen on next Start Recording
                try { if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close(); } catch(_) {}
                // Final defensive cleanup of mic stream to avoid OS-level "in use" conflicts
                stopCurrentStreamTracks();
                if (currentRecording) renderRecordingPanel(currentRecording);
                currentRecording = null; // Reset for next session (recordings array keeps history)
            };
        } catch (err) {
            console.error('Frontend: Recording setup failed:', err);
            const name = err && (err.name || err.code) ? ` (${err.name || err.code})` : '';
            alert(`Recording setup failed. Please try again.${name}`);
            try { if (stream && stream.getTracks) stream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
            try { stopCurrentStreamTracks(); } catch(_) {}
            startRecordingButton.disabled = false;
            stopRecordingButton.disabled = true;
        }
    });

    stopRecordingButton.addEventListener('click', () => {
        console.log("Frontend: Stop Recording button clicked.");
        // Release wake lock now that we're stopping recording
        try { releaseWakeLock(); } catch(_) {}
        startRecordingButton.disabled = false;
        stopRecordingButton.disabled = true;
        startTranscribeButton.disabled = true; // disable transcribe controls when not recording
        stopTranscribeButton.disabled = true;
        // Immediately stop segment loop to avoid starting a new segment after user stops
        try { segmentLoopActive = false; } catch(_) {}
        try { if (segmentRecorder && segmentRecorder.state === 'recording') segmentRecorder.stop(); } catch(_) {}
        try { if (audioCtxInstance && typeof audioCtxInstance.close === 'function') audioCtxInstance.close(); } catch(_) {}
        audioCtxInstance = null;
        pendingStop = true;
        if (autoTranscribeToggle && autoTranscribeToggle.checked) {
            // Ensure we notify backend to stop transcribe when auto mode ends
            try { if (socket && socket.readyState === WebSocket.OPEN) sendJSON(socket, { type: 'transcribe', enabled: false }); } catch(_) {}
        }
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
        // Clear any pending per-segment timeouts to avoid post-stop overrides
        try {
            transcribeTimeouts.forEach((to) => { try { clearTimeout(to); } catch(_) {} });
            transcribeTimeouts.clear();
        } catch(_) {}
        // Do not close socket here; wait for 'saved' confirmation to close
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
        const panelEl = document.getElementById(`panel-${record.id}`);
        if (!panelEl) return;
        // Use client renderer for initial structure to avoid 400 during early recording
        try { await renderPanel(record); } catch (_) {}
        // Trigger a provider table refresh via HTMX once panel is mounted in DOM
        setTimeout(() => {
            try {
                const fullEl = document.getElementById(`fulltable-${record.id}`);
                if (fullEl && typeof htmx !== 'undefined') {
                    htmx.trigger(fullEl, 'refresh-full');
                }
            } catch(_) {}
        }, 0);
    }

    async function refreshFullRow(record) {
        const table = document.getElementById(`fulltable-${record.id}`);
        if (!table) return;
        // Post fresh values so server renders current snapshot
        htmx.ajax('POST', '/render/full_row', { target: table, values: { record: JSON.stringify(record) }, swap: 'innerHTML' });
    }

    // Live provider cell helpers
    function ensureFullCell(recordId, svc) {
        try { return document.querySelector(`#fulltable-${recordId} td[data-svc="${svc}"]`); } catch(_) { return null; }
    }
    function addPendingFullLive(record, svc, text) {
        try {
            if (!record || !svc || !text) return;
            record._pendingFullLive = record._pendingFullLive || {};
            const prev = record._pendingFullLive[svc] || '';
            record._pendingFullLive[svc] = prev ? (prev + ' ' + text) : text;
        } catch(_) {}
    }
    function flushFullLive(record) {
        try {
            if (!record || !record._pendingFullLive) return;
            const map = record._pendingFullLive;
            Object.keys(map).forEach(svc => {
                const txt = map[svc];
                if (txt) {
                    try { appendFullLiveText(record.id, svc, txt); } catch(_) {}
                }
            });
        } catch(_) {}
    }
    function setFullAssignedText(recordId, svc, text) {
        try {
            const cell = ensureFullCell(recordId, svc);
            if (!cell) return;
            let span = cell.querySelector('span.full-text');
            if (!span) {
                span = document.createElement('span');
                span.className = 'full-text';
                try { if (cell.firstChild) cell.appendChild(document.createTextNode(' ')); } catch(_) {}
                cell.appendChild(span);
            }
            span.textContent = text || '';
        } catch(_) {}
    }
    function appendFullLiveText(recordId, svc, text) {
        try {
            if (!text) return;
            let cell = ensureFullCell(recordId, svc);
            if (!cell) {
                // Attempt to re-render the full provider table so cells exist
                try {
                    const fullWrap = document.getElementById(`fulltable-${recordId}`);
                    if (fullWrap && typeof htmx !== 'undefined') {
                        htmx.ajax('POST', '/render/full_row', { target: fullWrap, values: { record: JSON.stringify(currentRecording || {}) }, swap: 'innerHTML' });
                    }
                } catch(_) {}
                // Try again after a short delay
                try { setTimeout(() => appendFullLiveText(recordId, svc, text), 80); } catch(_) {}
                return;
            }
            let live = cell.querySelector('span.full-live');
            if (!live) {
                live = document.createElement('span');
                live.className = 'full-live';
                live.style.opacity = '0.7';
                try { if (cell.firstChild) cell.appendChild(document.createTextNode(' ')); } catch(_) {}
                cell.appendChild(live);
            }
            const sep = live.textContent && live.textContent.length ? ' ' : '';
            live.textContent = (live.textContent || '') + sep + text;
        } catch(_) {}
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
            console.log('Frontend: data-load-full click', { url, tag: el.tagName, id: el.id });
            // show a lightweight loading hint
            const prevText = el.textContent;
            try { el.textContent = (prevText || '').replace(/\([^)]*\)/, '(loading…)') || 'loading…'; } catch(_) {}
            let objectUrl = '';
            let mime = '';
            if (url.startsWith('blob:')) {
                objectUrl = url;
            } else {
                const resp = await fetch(url, { cache: 'no-store' });
                const blob = await resp.blob();
                objectUrl = URL.createObjectURL(blob);
                mime = resp.headers && resp.headers.get ? (resp.headers.get('Content-Type') || '') : '';
            }
            // trigger download via a temporary anchor
            try {
                const a = document.createElement('a');
                a.href = objectUrl;
                a.download = '';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                console.log('Frontend: triggered download for', url);
            } catch(err) { console.log('Frontend: download trigger failed', err); }
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
                if (!srcEl) srcEl = document.createElement('source');
                srcEl.src = objectUrl;
                if (mime) srcEl.type = mime;
                if (!audio.contains(srcEl)) {
                    audio.innerHTML = '';
                    audio.appendChild(srcEl);
                }
                try { audio.load(); } catch(err) { console.log('Frontend: audio reload failed', err); }
            }
            try { if (prevText) el.textContent = prevText; } catch(_) {}
        } catch(err) {
            console.log('Frontend: data-load-full click failed', err);
        }
    });

    // Wire SSE (Server-Sent Events) to trigger HTMX fragment refreshes
    try {
        // Disable SSE wiring; WS handles live updates and saved events
        // const es = new EventSource('/events');
        // es.addEventListener('segment_saved', ...);
        // es.addEventListener('saved', ...);
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
                const segIndex = (typeof data.idx === 'number') ? data.idx : -1;
                if (segIndex < 0) { console.log(`[SSE:${svc}] missing idx, skip`, data); return; }
                if (!currentRecording) return;
                try {
                    const arr = (currentRecording.transcripts[svc] = currentRecording.transcripts[svc] || []);
                    while (arr.length <= segIndex) arr.push('');
                    if (typeof data.transcript === 'string') arr[segIndex] = data.transcript;
                    clearSvcTimeout(currentRecording.id, segIndex, svc);
                    // Append to fullAppend ONLY if not already appended for this segment to avoid duplicates
                    if (typeof data.transcript === 'string' && data.transcript.trim()) {
                        currentRecording._appended = currentRecording._appended || {};
                        const key = `${svc}:${segIndex}`;
                        if (!currentRecording._appended[key]) {
                            currentRecording.fullAppend = currentRecording.fullAppend || {};
                            const prev = currentRecording.fullAppend[svc] || '';
                            currentRecording.fullAppend[svc] = prev ? (prev + ' ' + data.transcript.trim()) : data.transcript.trim();
                            currentRecording._appended[key] = true;
                            const fullEl = document.getElementById(`fulltable-${currentRecording.id}`);
                            if (fullEl) {
                                try { htmx.ajax('POST', '/render/full_row', { target: fullEl, values: { record: JSON.stringify(currentRecording) }, swap: 'innerHTML' }); } catch(_) {}
                            }
                        }
                    }
                } catch(_) {}
                const row = document.getElementById(`segrow-${currentRecording.id}-${segIndex}`);
                if (row && row.parentElement) {
                    try { row.setAttribute('hx-vals', JSON.stringify({ record: JSON.stringify(currentRecording), idx: segIndex })); } catch(_) {}
                    try { htmx.ajax('POST', '/render/segment_row', { target: row, values: { record: JSON.stringify(currentRecording), idx: segIndex }, swap: 'outerHTML' }); } catch(_) {}
                }
            } catch(_) {}
        };
        // Disable SSE transcript events; live updates handled via WebSocket only
        // es.addEventListener('segment_transcript_google', txHandler('google'));
        // es.addEventListener('segment_transcript_vertex', txHandler('vertex'));
        // es.addEventListener('segment_transcript_gemini', txHandler('gemini'));
        // es.addEventListener('segment_transcript_aws', txHandler('aws'));
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
                // Store active test stream so main recorder can preemptively stop it
                try { if (testActiveStream && testActiveStream.getTracks) testActiveStream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
                testActiveStream = stream;
                const rec = new MediaRecorder(stream);
                const chunks = [];
                rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
                rec.onstop = () => {
                    testBlob = new Blob(chunks, { type: 'audio/webm' });
                    if (testAudio) testAudio.src = URL.createObjectURL(testBlob);
                    if (testResults) testResults.textContent = 'Recorded 2s sample.';
                    // Ensure stream tracks are released to prevent lingering "mic in use"
                    try { stream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
                    testActiveStream = null;
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
                const b64 = ab2b64(buf);
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

