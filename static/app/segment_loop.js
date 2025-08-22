// Segment recording loop utilities
// - Ensures gapless capture: next segment starts before previous upload
// - Inserts temp segment rows and replaces them on server confirmation

import { insertTempSegmentRow } from '/static/ui/segments.js';

export function arrayBufferToBase64(buffer) {
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
 * Build a startSegmentLoop function bound to the given state and helpers.
 * @param {() => MediaStream} getStream
 * @param {() => any} getRecOptions
 * @param {() => number} getSegmentMs
 * @param {(recorder: MediaRecorder) => void} onSegmentStart
 * @param {(ts: number, blob: Blob) => Promise<void>} uploadSegment
 * @param {() => any} getCurrentRecording
 * @param {() => boolean} isLoopActive
 * @param {(active: boolean) => void} setLoopActive
 * @param {WebSocket} socket
 * @returns {() => void} startLoop
 */
export function createSegmentLoop(getStream, getRecOptions, getSegmentMs, onSegmentStart, uploadSegment, getCurrentRecording, isLoopActive, setLoopActive, socket) {
  return function startSegmentLoop() {
    if (isLoopActive()) return;
    setLoopActive(true);
    const loopOnce = () => {
      if (!isLoopActive()) return;
      const ts = Date.now();
      let segmentRecorder;
      let loopStream = null;
      try {
        const baseStream = (typeof getStream === 'function') ? getStream() : null;
        if (!baseStream) { console.warn('Frontend: segmentLoop missing base stream, stopping.'); setLoopActive(false); return; }
        loopStream = (baseStream && typeof baseStream.clone === 'function') ? baseStream.clone() : baseStream;
        segmentRecorder = new MediaRecorder(loopStream, getRecOptions());
      } catch (e) { console.warn('Frontend: segmentRecorder create failed:', e); setLoopActive(false); try { if (loopStream && loopStream.getTracks) loopStream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {} return; }
      let segBlob = null;
      segmentRecorder.ondataavailable = (e) => { if (e.data && e.data.size) segBlob = e.data; };
      segmentRecorder.onstop = async () => {
        // Start next segment immediately to avoid gaps
        if (isLoopActive()) setTimeout(loopOnce, 10);
        // Upload previous blob after next has started
        if (segBlob && segBlob.size) {
          const rec = getCurrentRecording();
          try {
            const tempUrl = URL.createObjectURL(segBlob);
            insertTempSegmentRow(rec, ts, tempUrl, segBlob.size, ts, ts + (typeof getSegmentMs() === 'number' ? getSegmentMs() : 10000));
          } catch(_) {}
          try {
            if (socket && socket.readyState === WebSocket.OPEN) await uploadSegment(ts, segBlob);
          } catch(_) {}
        }
        // Always stop cloned stream tracks to release mic resources
        try { if (loopStream && loopStream.getTracks) loopStream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {}
      };
      try { segmentRecorder.start(); } catch (e) { console.warn('Frontend: segmentRecorder start failed:', e); setLoopActive(false); try { if (loopStream && loopStream.getTracks) loopStream.getTracks().forEach(t => { try { t.stop(); } catch(_) {} }); } catch(_) {} return; }
      if (typeof onSegmentStart === 'function') onSegmentStart(segmentRecorder);
      setTimeout(() => { try { if (segmentRecorder && segmentRecorder.state === 'recording') segmentRecorder.stop(); } catch (_) {} }, getSegmentMs());
    };
    loopOnce();
  };
}


