// Segment UI helpers: pending countdown row and top-prepend segment rows
import { getServicesCached } from '/static/ui/services.js';

export function showPendingCountdown(recordId, segmentMs, isActiveFn, isRecordingFn) {
  try {
    const ensureReady = (attempts = 0) => {
      const tbody = document.getElementById(`segtbody-${recordId}`);
      if (!tbody) {
        if (attempts < 20) return setTimeout(() => ensureReady(attempts + 1), 25);
        return;
      }
      const pendingId = `segpending-${recordId}`;
      let tr = document.getElementById(pendingId);
      if (!tr) {
        tr = document.createElement('tr');
        tr.id = pendingId;
        const td = document.createElement('td');
        const segTable = document.getElementById(`segtable-${recordId}`);
        let colCount = 4;
        try { if (segTable) colCount = Math.max(1, segTable.querySelectorAll('thead th').length); } catch(_) {}
        td.setAttribute('colspan', String(colCount));
        tr.appendChild(td);
        tbody.insertBefore(tr, tbody.firstChild);
      }
      const start = Date.now();
      const tick = () => {
        const node = document.getElementById(pendingId);
        if (!node || !isActiveFn()) return;
        const elapsed = Date.now() - start;
        const remaining = Math.max(0, Math.ceil((segmentMs - elapsed) / 1000));
        const firstCell = node.firstChild;
        if (firstCell) firstCell.textContent = `Recording for ${remaining} seconds...`;
        if (elapsed < segmentMs && isRecordingFn()) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    ensureReady(0);
  } catch(_) {}
}

export async function prependSegmentRow(record, segIndex, data, startMs, endMs) {
  const tbody = document.getElementById(`segtbody-${record.id}`);
  if (!tbody) return null;
  const rowId = `segrow-${record.id}-${segIndex}`;
  if (document.getElementById(rowId)) return document.getElementById(rowId);
  const tr = document.createElement('tr');
  tr.id = rowId;
  tr.setAttribute('hx-post', '/render/segment_row');
  tr.setAttribute('hx-trigger', 'refresh-row');
  tr.setAttribute('hx-target', 'this');
  tr.setAttribute('hx-swap', 'outerHTML');
  tr.setAttribute('hx-vals', JSON.stringify({ record: JSON.stringify(record), idx: segIndex }));
  const audioCell = document.createElement('td');
  const sizeLabel = data.size ? `(${(data.size/1024).toFixed(0)} KB)` : '';
  const mime = (data.url && data.url.toLowerCase().endsWith('.ogg')) ? 'audio/ogg' : 'audio/webm';
  audioCell.innerHTML = `${data.url ? `<audio controls><source src="${data.url}" type="${mime}"></audio>` : ''} ${sizeLabel}`;
  const startCell = document.createElement('td');
  startCell.textContent = formatElapsed(startMs - (record.startTs || startMs));
  const endCell = document.createElement('td');
  endCell.textContent = formatElapsed(endMs - (record.startTs || endMs));
  tr.appendChild(audioCell);
  tr.appendChild(startCell);
  tr.appendChild(endCell);
  try {
    const services = await getServicesCached();
    services.filter(s => s.enabled).forEach(s => {
      const td = document.createElement('td');
      td.setAttribute('data-svc', s.key);
      td.textContent = 'transcribing…';
      tr.appendChild(td);
    });
  } catch(_) {}
  const pending = document.getElementById(`segpending-${record.id}`);
  if (pending) { try { tbody.removeChild(pending); } catch(_) {} }
  tbody.insertBefore(tr, tbody.firstChild);
  return tr;
}

export function formatElapsed(deltaMs) {
  try {
    if (typeof deltaMs !== 'number' || !isFinite(deltaMs)) return '';
    const total = Math.max(0, Math.round(deltaMs / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  } catch(_) { return ''; }
}



