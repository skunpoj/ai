import { getServices, getServicesCached } from '/static/ui/services.js';
import { ensureTab as ensureUITab, activateTab as activateUITab, setElapsed as setTabElapsed, finalizeTab } from '/static/ui/tabs.js';
import { renderRecordingPanel as renderPanel } from '/static/ui/renderers.js';
// WebSocket helpers removed; HTTP-only
import { showPendingCountdown, prependSegmentRow } from '/static/ui/segments.js';
import { acquireWakeLock, releaseWakeLock, initWakeLockVisibilityReacquire } from '/static/app/wake_lock.js';
import { createMediaRecorderWithFallback, safelyStopStream } from '/static/app/recorder_utils.js';
import { pendingRowsByIdx, pendingRowsByClientId, pendingRowsByServerId, insertedRows, pendingInsertTimers, segmentIdToIndex, idxKey, clientKey, serverKey, mergePending, setPending, getServerId, resetSegmentsState } from '/static/app/segments_state.js';

document.addEventListener('DOMContentLoaded', () => {
    // Ensure Markdown is rendered for any cells with class "marked" after HTMX swaps
    function renderMarkdownInCells(root) {
        try {
            const scope = root || document;
            const nodes = scope.querySelectorAll('td.marked, div.marked');
            nodes.forEach(el => {
                try {
                    if (el.dataset.mdRendered === '1') return;
                    const src = el.textContent || '';
                    if (!src) return;
                    if (window.marked && typeof window.marked.parse === 'function') {
                        el.innerHTML = window.marked.parse(src);
                        el.dataset.mdRendered = '1';
                    }
                } catch(_) {}
            });
        } catch(_) {}
    }
    // Initial pass on load (in case server rendered any .marked content inline)
    try { renderMarkdownInCells(document); } catch(_) {}
    // Re-render after any HTMX content swap
    try {
        document.body.addEventListener('htmx:afterSwap', (e) => {
            try { renderMarkdownInCells(e && e.target ? e.target : document); } catch(_) {}
        });
    } catch(_) {}
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
    // Fixed segment duration per recording; captured at Start Record
    let activeSegmentMs = null;
    // Track in-flight segment uploads and defer finalization until all are done
    let pendingUploads = 0;
    let finalizeRequested = false;

    // UI
    const startRecordingButton = document.getElementById('startRecording');
    const stopRecordingButton = document.getElementById('stopRecording');
    const startTranscribeButton = document.getElementById('startTranscribe');
    const stopTranscribeButton = document.getElementById('stopTranscribe');
    const toggleSegMetaToolbar = document.getElementById('toggleSegMetaToolbar');
    const toggleTimeColToolbar = document.getElementById('toggleTimeColToolbar');
    const showLocalPreviewToggle = document.getElementById('showLocalPreviewToggle');
    const autoTranscribeToggle = document.getElementById('autoTranscribeToggle');
    const tabsBar = document.getElementById('recordTabs');
    const panelsHost = document.getElementById('recordPanels');
    const segmentLenGroup = document.getElementById('segmentLenGroup');
    const openSegmentModalBtn = document.getElementById('openSegmentModal');
    const segmentModal = document.getElementById('segmentModal');
    const okSegmentModalBtn = document.getElementById('okSegmentModal');
    // WS UI removed
    const testConnBtn = null;
    const connStatus = null;
    const testAudio = document.getElementById('testAudio');
    const settingsTabGeneralBtn = document.getElementById('settingsTabGeneralBtn');
    const settingsTabSumBtn = document.getElementById('settingsTabSumBtn');
    const settingsTabTransBtn = document.getElementById('settingsTabTransBtn');
    const settingsTabAdvBtn = document.getElementById('settingsTabAdvBtn');
    const settingsTabContentGeneral = document.getElementById('settingsTabContentGeneral');
    const settingsTabContentSum = document.getElementById('settingsTabContentSum');
    const settingsTabContentTrans = document.getElementById('settingsTabContentTrans');
    const settingsTabContentAdv = document.getElementById('settingsTabContentAdv');
    const uploadFullToggle = document.getElementById('uploadFullToggle');
    const exportFullToggle = document.getElementById('exportFullToggle');
    let uploadFullOnStop = false; // default OFF
    let exportFullOnStop = false; // default OFF
    let showLocalPreview = true; // default ON by default; can be toggled in Settings
    try { if (uploadFullToggle) { uploadFullOnStop = !!uploadFullToggle.checked; uploadFullToggle.addEventListener('change', () => { uploadFullOnStop = !!uploadFullToggle.checked; }); } } catch(_) {}
    try { if (exportFullToggle) { exportFullOnStop = !!exportFullToggle.checked; exportFullToggle.addEventListener('change', () => { exportFullOnStop = !!exportFullToggle.checked; }); } } catch(_) {}
    try { if (showLocalPreviewToggle) { showLocalPreview = !!showLocalPreviewToggle.checked; showLocalPreviewToggle.addEventListener('change', async () => { showLocalPreview = !!showLocalPreviewToggle.checked; if (currentRecording) { currentRecording.useLocalPreview = showLocalPreview; await renderRecordingPanel(currentRecording); } }); } } catch(_) {}
    const testUpload = document.getElementById('testUpload');
    const testRecord2s = document.getElementById('testRecord2s');
    const testRun = document.getElementById('testRun');
    const testViaWS = null;
    const testResults = document.getElementById('testResults');
    const saveSummaryPromptBtn = document.getElementById('saveSummaryPrompt');
    const fullSummaryPromptInput = document.getElementById('fullSummaryPrompt');
    const tplPlainBtn = document.getElementById('tplPlain');
    const tplMarkdownBtn = document.getElementById('tplMarkdown');
    const tplBulletsBtn = document.getElementById('tplBullets');
    const translationLangSelect = document.getElementById('translationLang');
    const translationPromptInput = document.getElementById('translationPrompt');
    let segmentMs = (typeof window !== 'undefined' && typeof window.SEGMENT_MS !== 'undefined') ? window.SEGMENT_MS : 10000;

    initWakeLockVisibilityReacquire(() => (!!(mediaRecorder && mediaRecorder.state === 'recording') || !!segmentLoopActive));
    let connCheckInterval = null;
    let testBlob = null;
    let testActiveStream = null;

    function ensureRecordingTab(record) { if (!tabsBar || !panelsHost) return; ensureUITab(tabsBar, panelsHost, record); }
    async function renderRecordingPanel(record) {
        ensureRecordingTab(record);
        try { await renderPanel(record); } catch(_) {}
        // After Stop, request the summary into the dedicated summary container; keep full record visible until summary arrives
        try {
            if (record && record.stopTs) {
                const summaryDiv = document.getElementById(`summarytable-${record.id}`);
                const vals = JSON.stringify({ record: JSON.stringify(record) });
                if (summaryDiv) {
                    summaryDiv.setAttribute('hx-vals', vals.replace(/\"/g,'\\\"'));
                    summaryDiv.dispatchEvent(new CustomEvent('refresh-summary', { bubbles: true }));
                }
            }
        } catch(_) {}
    }

    // Elapsed timer while recording
    let elapsedTimerId = null;
    function startElapsedTimer(record) {
        try { if (elapsedTimerId) clearInterval(elapsedTimerId); } catch(_) {}
        elapsedTimerId = setInterval(() => {
            try {
                const sec = Math.max(0, Math.round((Date.now() - (record.startTs || Date.now()))/1000));
                setTabElapsed(tabsBar, record.id, sec);
            } catch(_) {}
        }, 1000);
    }
    function stopElapsedTimer(record) {
        try { if (elapsedTimerId) { clearInterval(elapsedTimerId); elapsedTimerId = null; } } catch(_) {}
        try { finalizeTab(tabsBar, record); } catch(_) {}
    }

    // Async remux polling
    async function startRemuxAsync(record) {
        try {
            const recId = String((record && record.startTs) || Date.now());
            const r = await fetch('/export_full_async', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ recording_id: recId }) });
            const j = await r.json();
            if (!(j && j.ok && j.job_id)) return;
            const jobId = j.job_id;
            const statusEl = document.getElementById(`fullstatus-${record.id}`) || (function(){ const d=document.createElement('div'); d.id=`fullstatus-${record.id}`; d.textContent='Exporting full…'; const panel=document.getElementById(`panel-${record.id}`); if(panel) panel.prepend(d); return d; })();
            let tries = 0;
            const poll = async () => {
                try {
                    const pr = await fetch(`/export_status?job_id=${encodeURIComponent(jobId)}`);
                    const pj = await pr.json();
                    if (pj && pj.ok) {
                        if (pj.status === 'done' && pj.url) {
                            statusEl.textContent = '';
                            statusEl.style.display = 'none';
                            // Attach link to meta
                            const meta = document.getElementById(`recordmeta-${record.id}`);
                            if (meta) {
                                const a = document.createElement('a'); a.href = pj.url; a.download=''; a.textContent='Download Full'; a.style.marginLeft='8px';
                                meta.appendChild(a);
                            }
                            return;
                        } else if (pj.status === 'error') {
                            statusEl.textContent = 'Export failed';
                            return;
                        } else {
                            statusEl.textContent = `Exporting full… (${pj.status})`;
                        }
                    }
                } catch(_) {}
                if (tries++ < 120) setTimeout(poll, 1000);
            };
            poll();
        } catch(_) {}
    }

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
            const durMs = (typeof activeSegmentMs === 'number' && activeSegmentMs > 0) ? activeSegmentMs : segmentMs;
            const TIMEOUT_MS = Number(durMs) && Number(durMs) >= 1000 ? Number(durMs) + 500 : 30000;
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

    async function openSocket() { return null; }

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
    function startConnAutoCheck() {}
    function stopConnAutoCheck() {}

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

    function recomputeFullAppendFromTranscripts(rec) {
        try {
            const tx = rec.transcripts || {};
            rec.fullAppend = rec.fullAppend || {};
            Object.keys(tx).forEach(k => {
                try {
                    const arr = Array.isArray(tx[k]) ? tx[k] : [];
                    rec.fullAppend[k] = arr.filter(Boolean).join(' ').trim();
                } catch(_) {}
            });
        } catch(_) {}
    }

    async function performFinalizeIfReady() {
        try {
            if (!finalizeRequested) return;
            if (pendingUploads > 0) return;
            if (!currentRecording) return;
            // Ensure last segment has been transcribed (slot exists) before proceeding
            try {
                const rec = currentRecording;
                const segs = Array.isArray(rec.segments) ? rec.segments.filter(Boolean) : [];
                const lastIdx = segs.length ? Math.max.apply(null, segs.map(s => Number(s.idx || 0))) : -1;
                if (lastIdx >= 0) {
                    const svcs = await getServicesCached();
                    const enabledKeys = svcs.filter(s => s.enabled).map(s => s.key);
                    const hasSlot = enabledKeys.some(k => {
                        const arr = (rec.transcripts && rec.transcripts[k]) || [];
                        return arr.length > lastIdx; // slot exists => transcript arrived (possibly empty)
                    });
                    if (!hasSlot) {
                        setTimeout(() => { try { performFinalizeIfReady(); } catch(_) {} }, 120);
                        return;
                    }
                }
            } catch(_) {}
            // Build fully appended text from all segments, then render and summarize
            recomputeFullAppendFromTranscripts(currentRecording);
            currentRecording.useLocalPreview = !!showLocalPreview;
            try { console.log('[Finalize] fullAppend snapshot', JSON.parse(JSON.stringify(currentRecording.fullAppend||{}))); } catch(_) {}
            await renderRecordingPanel(currentRecording);
            // Process HTMX on the newly rendered panel to enable summary container
            try { if (window && window.htmx && typeof window.htmx.process === 'function') { const p = document.getElementById(`panel-${currentRecording.id}`); if (p) window.htmx.process(p); } } catch(_) {}
            // Render summary into its container using a direct POST; hide full block after success
            try {
                const summaryDiv = document.getElementById(`summarytable-${currentRecording.id}`);
                if (summaryDiv) {
                    const compact = { id: currentRecording.id, stopTs: currentRecording.stopTs, fullAppend: currentRecording.fullAppend, transcripts: currentRecording.transcripts };
                    // Prefer JSON to avoid HTML parsing inconsistencies; render ourselves
                    const fd = new FormData();
                    fd.append('record', JSON.stringify(compact));
                    fetch('/render/full_row_json', { method: 'POST', body: fd })
                      .then(r => r.json())
                      .then(data => {
                          try {
                              if (!data || data.ok === false) throw new Error('no_summary');
                              const md = String(data.summary_text || '').trim();
                              summaryDiv.innerHTML = '';
                              const holder = document.createElement('div');
                              holder.className = 'marked';
                              holder.textContent = md;
                              summaryDiv.appendChild(holder);
                              summaryDiv.style.display = 'block';
                          } catch(_) {
                              summaryDiv.innerHTML = '<small style="color:#aaa">No summary.</small>';
                              summaryDiv.style.display = 'block';
                          }
                          // Render markdown
                          try {
                              const el = summaryDiv.querySelector('.marked');
                              if (el) {
                                  const src = el.textContent || '';
                                  if (src && window.marked && typeof window.marked.parse === 'function') el.innerHTML = window.marked.parse(src);
                              }
                          } catch(_) {}
                          try { const full = document.getElementById(`fulltable-${currentRecording.id}`); if (full && summaryDiv.textContent && summaryDiv.textContent.trim()) full.style.display = 'none'; } catch(_) {}
                      })
                      .catch(() => {
                          // Fallback: if fetch fails, try HTMX once
                          try { if (window && window.htmx && typeof window.htmx.ajax === 'function') window.htmx.ajax('POST', '/render/full_row', { target: summaryDiv, swap: 'innerHTML', values: { record: JSON.stringify(compact) } }); } catch(_) {}
                      });
                }
            } catch(_) {}
            finalizeRequested = false;
        } catch(_) {}
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
            const seededEnd = (seeded && typeof seeded.endMs === 'number') ? seeded.endMs : (seededStart + (typeof activeSegmentMs === 'number' ? activeSegmentMs : (typeof segmentMs === 'number' ? segmentMs : 10000)));
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
    // Toolbar toggles for Download/Size and Time columns
    try {
        if (toggleSegMetaToolbar) toggleSegMetaToolbar.addEventListener('change', () => {
            try {
                document.body.classList.toggle('hide-segmeta', !toggleSegMetaToolbar.checked);
            } catch(_) {}
        });
        if (toggleTimeColToolbar) toggleTimeColToolbar.addEventListener('change', () => {
            try {
                document.body.classList.toggle('hide-timecol', !toggleTimeColToolbar.checked);
            } catch(_) {}
        });
        // Apply initial state
        document.body.classList.toggle('hide-segmeta', !(toggleSegMetaToolbar && toggleSegMetaToolbar.checked));
        document.body.classList.toggle('hide-timecol', !(toggleTimeColToolbar && toggleTimeColToolbar.checked));
    } catch(_) {}

    // Simple toast
    function toast(msg) {
        try {
            let t = document.getElementById('toast');
            if (!t) {
                t = document.createElement('div');
                t.id = 'toast';
                t.style.position = 'fixed';
                t.style.bottom = '14px';
                t.style.left = '50%';
                t.style.transform = 'translateX(-50%)';
                t.style.background = 'rgba(0,0,0,0.85)';
                t.style.color = '#fff';
                t.style.padding = '8px 12px';
                t.style.borderRadius = '6px';
                t.style.fontSize = '12px';
                t.style.zIndex = '99999';
                document.body.appendChild(t);
            }
            t.textContent = msg;
            t.style.display = 'block';
            setTimeout(() => { try { t.style.display = 'none'; } catch(_) {} }, 1500);
        } catch(_) {}
    }
    // Settings: Save Summary Prompt
    try {
        if (saveSummaryPromptBtn && fullSummaryPromptInput) {
            saveSummaryPromptBtn.addEventListener('click', async () => {
                try {
                    const prompt = String(fullSummaryPromptInput.value || '').trim();
                    if (!prompt) return;
                    const r = await fetch('/summary_prompt', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt }) });
                    const j = await r.json().catch(() => ({}));
                    if (j && j.ok) toast('Summary prompt saved'); else toast('Save failed');
                } catch(_) {}
            });
        }
    } catch(_) {}
    // Settings: Prompt templates
    try {
        const setVal = (txt) => { try { fullSummaryPromptInput.value = txt; } catch(_) {} };
        if (tplPlainBtn && fullSummaryPromptInput) tplPlainBtn.addEventListener('click', () => setVal(
            'Summarize the following transcription into clear, concise sentences capturing key points, decisions, and action items. Avoid filler. Preserve factual content. Return plain text only. Do NOT return JSON, HTML, Markdown, or code blocks.'
        ));
        if (tplMarkdownBtn && fullSummaryPromptInput) tplMarkdownBtn.addEventListener('click', () => setVal(
            'Summarize the following transcription as GitHub-flavored Markdown with short headings and bullet points. Use simple lists, no tables or HTML. Keep it concise and factual.'
        ));
        if (tplBulletsBtn && fullSummaryPromptInput) tplBulletsBtn.addEventListener('click', () => setVal(
            '- Key points and facts\n- Decisions\n- Action items (assignee if known)\n\nReturn plain text bullet list only.'
        ));
    } catch(_) {}
    // Settings: Save Translation Settings
    try {
        const saveBtn = document.getElementById('saveTranslationSettings');
        if (saveBtn && translationPromptInput && translationLangSelect) {
            saveBtn.addEventListener('click', async () => {
                try {
                    const prompt = String(translationPromptInput.value || '').trim();
                    const lang = String(translationLangSelect.value || '').trim();
                    const r = await fetch('/translation_settings', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt, lang }) });
                    const j = await r.json().catch(() => ({}));
                    if (j && j.ok) toast('Translation settings saved'); else toast('Save failed');
                } catch(_) {}
            });
        }
    } catch(_) {}
    // Settings: Save & Close (fallback to JS to ensure it always works)
    try {
        const settingsSaveBtn = document.getElementById('settingsSaveBtn');
        const settingsForm = document.getElementById('settingsForm');
        if (settingsSaveBtn && settingsForm) {
            try { settingsForm.addEventListener('submit', (e) => { try { e.preventDefault(); } catch(_) {} return false; }); } catch(_) {}
            settingsSaveBtn.addEventListener('click', async () => {
                try {
                    const fd = new FormData(settingsForm);
                    const body = new URLSearchParams();
                    for (const [k, v] of fd.entries()) {
                        if (typeof v === 'string') body.append(k, v);
                        else if (v && typeof v.name === 'string') body.append(k, v.name);
                    }
                    const r = await fetch('/settings_bulk', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
                    if (r && r.ok) toast('Settings saved'); else toast('Save failed');
                    // Reflect checkbox state to server-backed toggles
                    try {
                        const keys = ['google','vertex','gemini','aws'];
                        for (const k of keys) {
                            const el = document.getElementById(`svc_${k}`);
                            if (!el) continue;
                            await fetch('/services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k, enabled: !!el.checked }) });
                        }
                        // Update client flags for conditional UI (e.g., Translation column)
                        try {
                            const tr = document.getElementById('enableTranslation');
                            if (tr) { window.APP_FLAGS = window.APP_FLAGS || {}; window.APP_FLAGS.enable_translation = !!tr.checked; }
                        } catch(_) {}
                    } catch(_) {}
                } catch(_) {}
                try { if (segmentModal) segmentModal.style.display = 'none'; } catch(_) {}
                try { stopConnAutoCheck(); } catch(_) {}
                try { if (currentRecording) await renderRecordingPanel(currentRecording); } catch(_) {}
            });
        }
    } catch(_) {}
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

    // Settings tab switching
    try {
        const activate = (which) => {
            try {
                settingsTabContentGeneral.style.display = (which==='general')?'block':'none';
                settingsTabContentSum.style.display = (which==='sum')?'block':'none';
                settingsTabContentTrans.style.display = (which==='trans')?'block':'none';
                if (settingsTabContentAdv) settingsTabContentAdv.style.display = (which==='adv')?'block':'none';
                settingsTabGeneralBtn.style.background = (which==='general')?'#333':'#222';
                settingsTabGeneralBtn.style.color = (which==='general')?'#fff':'#aaa';
                settingsTabSumBtn.style.background = (which==='sum')?'#333':'#222';
                settingsTabSumBtn.style.color = (which==='sum')?'#fff':'#aaa';
                settingsTabTransBtn.style.background = (which==='trans')?'#333':'#222';
                settingsTabTransBtn.style.color = (which==='trans')?'#fff':'#aaa';
                if (settingsTabAdvBtn) { settingsTabAdvBtn.style.background = (which==='adv')?'#333':'#222'; settingsTabAdvBtn.style.color = (which==='adv')?'#fff':'#aaa'; }
            } catch(_) {}
        };
        if (settingsTabGeneralBtn) settingsTabGeneralBtn.addEventListener('click', () => activate('general'));
        if (settingsTabSumBtn) settingsTabSumBtn.addEventListener('click', () => activate('sum'));
        if (settingsTabTransBtn) settingsTabTransBtn.addEventListener('click', () => activate('trans'));
        if (settingsTabAdvBtn) settingsTabAdvBtn.addEventListener('click', () => activate('adv'));
        // Default to General on open
        try { activate('general'); } catch(_) {}
    } catch(_) {}

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

    // Hide full record after summary rendered into its container
    try {
        document.body.addEventListener('htmx:afterSwap', (e) => {
            try {
                const tgt = e && e.target;
                if (!tgt || !tgt.id) return;
                if (tgt.id.startsWith('summarytable-')) {
                    const id = tgt.id.substring('summarytable-'.length);
                    const full = document.getElementById(`fulltable-${id}`);
                    if (full) full.style.display = 'none';
                }
            } catch(_) {}
        });
    } catch(_) {}
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

    // Removed WS test
    if (segmentLenGroup) {
        const radios = segmentLenGroup.querySelectorAll('input[type="radio"][name="segmentLen"]');
        radios.forEach(r => {
            if (Number(r.value) === Number(segmentMs)) r.checked = true;
            r.addEventListener('change', () => {
                const v = Number(r.value);
                if (!Number.isNaN(v) && v >= 5000 && v <= 300000) {
                    segmentMs = v;
                    // Do not stop active recorders when changing segment length
                    try {
                        if (testRecord2s) {
                            const secs = Math.round(Number(segmentMs || 10000)/1000);
                            testRecord2s.textContent = `Record sample (${secs}s)`;
                        }
                    } catch(_) {}
                }
            });
        });
        try {
            if (testRecord2s) {
                const secs = Math.round(Number(segmentMs || 10000)/1000);
                testRecord2s.textContent = `Record sample (${secs}s)`;
            }
        } catch(_) {}
    }

    startRecordingButton.addEventListener('click', async () => {
        startRecordingButton.disabled = true;
        stopRecordingButton.disabled = false;
        startTranscribeButton.disabled = false;
        stopTranscribeButton.disabled = true;
        enableGoogleSpeech = false;
        // Capture current setting for this recording only
        activeSegmentMs = Number(segmentMs || 10000);
        resetSegmentsState();
        await prepareNewRecording();
        try { await acquireWakeLock(); } catch(_) {}
        // HTTP-only; no socket
        // Do not auto-enable transcribe here
        // Recorder
        try { startElapsedTimer(currentRecording); } catch(_) {}
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
                }
                try { if (currentRecording) stopElapsedTimer(currentRecording); } catch(_) {}
                // Defer full-row insert/summary until all segment uploads and transcripts are processed
                finalizeRequested = true;
                await performFinalizeIfReady();
                if (exportFullOnStop) {
                    try { await startRemuxAsync(currentRecording); } catch(_) {}
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
        // No socket to disable
        try { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch(_) {}
        try { transcribeTimeouts.forEach((to) => { try { clearTimeout(to); } catch(_) {} }); transcribeTimeouts.clear(); } catch(_) {}
        try { segmentIdToIndex.clear(); } catch(_) {}
        // Stop rotating loop
        try { segmentLoopActive = false; if (segmentRecorder && segmentRecorder.state === 'recording') segmentRecorder.stop(); } catch(_) {}
        try { if (currentRecording) stopElapsedTimer(currentRecording); } catch(_) {}
    });

    // Ensure tab switches or visibility changes do not stop recording automatically
    try {
        document.addEventListener('visibilitychange', () => { /* keep alive */ });
        window.addEventListener('blur', () => { /* keep alive */ });
        window.addEventListener('focus', () => { /* keep alive */ });
    } catch(_) {}

    startTranscribeButton.addEventListener('click', () => {
        enableGoogleSpeech = true;
        startTranscribeButton.disabled = true;
        stopTranscribeButton.disabled = false;
        // HTTP-only
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
        // HTTP-only
    });
    // Rotating-per-segment implementation (HTTP per-segment upload)
    function startRotatingSegment() {
        if (segmentLoopActive) return;
        segmentLoopActive = true;
        let segIdx = 0;
        const runOne = () => {
            if (!segmentLoopActive || !currentStream) return;
            const ts = Date.now();
            const base = (currentRecording && currentRecording.startTs) || ts;
            const dur = Number(activeSegmentMs || segmentMs || 10000);
            const startMs = base + (segIdx * dur);
            const endMs = startMs + dur;
            // Pre-seed segment entry
            try { while (currentRecording.segments.length <= segIdx) currentRecording.segments.push(null); } catch(_) {}
            const seeded = { idx: segIdx, url: '', mime: recMimeType || 'audio/webm', size: 0, ts, startMs, endMs, clientId: ts };
            try { currentRecording.segments[segIdx] = seeded; } catch(_) {}
            // Start a fresh recorder for this slice
            try { segmentRecorder = new MediaRecorder(currentStream, recOptions); } catch(e) { console.warn('Segment recorder init failed', e); segmentLoopActive = false; return; }
            let handled = false; // guard against multiple ondataavailable
            let capturedBlob = null;
            const thisIdx = segIdx;
            segmentRecorder.ondataavailable = async (e) => {
                if (handled) return;
                if (!e.data || !e.data.size) return;
                handled = true;
                try {
                    capturedBlob = e.data;
                    const ab = await capturedBlob.arrayBuffer();
                    const bytes = new Uint8Array(ab);
                    let bin = ''; const CHUNK = 0x8000; for (let i=0;i<bytes.length;i+=CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i,i+CHUNK));
                    const b64 = btoa(bin);
                    const recId = String((currentRecording && currentRecording.startTs) || Date.now());
                    const payload = { recording_id: recId, audio_b64: b64, mime: capturedBlob.type || 'audio/webm', duration_ms: (activeSegmentMs || segmentMs), id: ts, idx: thisIdx, ts };
                    pendingUploads += 1;
                    const res = await fetch('/segment_upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    const data = await res.json();
                    if (data && data.ok) {
                        const saved = data.saved || {}; const url = saved.url || '';
                        try { currentRecording.segments[thisIdx] = Object.assign({}, seeded, { url, mime: saved.mime || (capturedBlob && capturedBlob.type) || '', size: saved.size || (capturedBlob && capturedBlob.size) || 0, startMs, endMs }); } catch(_) {}
                        try {
                            const row = await prependSegmentRow(currentRecording, thisIdx, { url, mime: saved.mime || (capturedBlob && capturedBlob.type), size: saved.size || (capturedBlob && capturedBlob.size), ts }, startMs, endMs);
                            if (!row) {
                                try { await renderRecordingPanel(currentRecording); } catch(_) {}
                                try { await prependSegmentRow(currentRecording, thisIdx, { url, mime: saved.mime || (capturedBlob && capturedBlob.type), size: saved.size || (capturedBlob && capturedBlob.size), ts }, startMs, endMs); } catch(_) {}
                            }
                        } catch(_) {}
                        const results = data.results || {};
                        Object.keys(results).forEach(svc => {
                            const txt = results[svc] || '';
                            const arr = (currentRecording.transcripts[svc] = currentRecording.transcripts[svc] || []);
                            while (arr.length <= thisIdx) arr.push('');
                            arr[thisIdx] = txt;
                            try { const row = document.getElementById(`segrow-${currentRecording.id}-${thisIdx}`); if (row) { const td = row.querySelector(`td[data-svc="${svc}"]`); if (td) td.textContent = txt; } } catch(_) {}
                        });
                        // Update fullAppend live
                        try {
                            Object.keys(results).forEach(svc => {
                                const txt = results[svc] || '';
                                if (!txt) return;
                                currentRecording.fullAppend = currentRecording.fullAppend || {};
                                const old = currentRecording.fullAppend[svc] || '';
                                currentRecording.fullAppend[svc] = (old ? (old + ' ' + txt) : txt).trim();
                                const fullCell = document.querySelector(`#fulltable-${currentRecording.id} td[data-svc="${svc}"]`);
                                if (fullCell) fullCell.textContent = currentRecording.fullAppend[svc];
                            });
                        } catch(_) {}
                    } else {
                        console.warn('segment_upload failed', data);
                    }
                } catch(err) {
                    console.warn('segment upload error', err);
                } finally {
                    try { pendingUploads = Math.max(0, pendingUploads - 1); } catch(_) {}
                    try { await performFinalizeIfReady(); } catch(_) {}
                }
            };
            segmentRecorder.onstop = () => {
                // Start next slice only once the current recorder has fully stopped
                if (!segmentLoopActive) return;
                segIdx = thisIdx + 1;
                setTimeout(() => { if (segmentLoopActive) runOne(); }, 0);
            };
            try { segmentRecorder.start(); } catch(e) { console.warn('segmentRecorder start failed', e); segmentLoopActive = false; return; }
            setTimeout(() => { try { if (segmentRecorder && segmentRecorder.state === 'recording') segmentRecorder.stop(); } catch(_) {} }, dur);
        };
        runOne();
    }
});


