// Segment UI helpers
// - showPendingCountdown: Displays a single, gapless countdown row per record
//   Uses a single requestAnimationFrame loop keyed by recordId to avoid flicker
//   and dynamically syncs the colspan with the table header.
// - prependSegmentRow: Creates a stable, client-owned row for a saved segment.
// - insertTempSegmentRow: Inserts a temporary row as soon as a segment stops
//   (before server confirmation) so playback is visible immediately. It tags
//   the row with data-temp-url so the caller can revoke the blob URL later.
import { getServicesCached } from '/static/ui/services.js';

export function showPendingCountdown(recordId, segmentMs, isActiveFn, isRecordingFn) {
  try {
    // Ensure only one countdown loop per recordId
    window.__segCountdown = window.__segCountdown || { rafs: new Map(), lastStart: new Map() };
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
      window.__segCountdown.lastStart.set(recordId, start);
      // Cancel any existing RAF loop for this recordId
      try {
        const prev = window.__segCountdown.rafs.get(recordId);
        if (prev) cancelAnimationFrame(prev);
      } catch(_) {}
      const tick = () => {
        const node = document.getElementById(pendingId);
        if (!node || !isActiveFn()) return;
        const elapsed = Date.now() - start;
        const remaining = Math.max(0, Math.ceil((segmentMs - elapsed) / 1000));
        const firstCell = node.firstChild;
        if (firstCell) {
          // Keep colspan in sync with current header
          try {
            const segTable = document.getElementById(`segtable-${recordId}`);
            if (segTable) {
              const cols = Math.max(1, segTable.querySelectorAll('thead th').length);
              if (firstCell.getAttribute('colspan') !== String(cols)) firstCell.setAttribute('colspan', String(cols));
            }
          } catch(_) {}
          firstCell.textContent = `Recording for ${remaining} seconds...`;
        }
        if (elapsed < segmentMs && isRecordingFn()) {
          const id = requestAnimationFrame(tick);
          window.__segCountdown.rafs.set(recordId, id);
        }
      };
      const id = requestAnimationFrame(tick);
      window.__segCountdown.rafs.set(recordId, id);
    };
    ensureReady(0);
  } catch(_) {}
}

export async function prependSegmentRow(record, segIndex, data, startMs, endMs) {
  // Creates a durable segment row (no HTMX swaps during recording). Transcript
  // cells are updated in-place as provider results arrive.
  const tbody = document.getElementById(`segtbody-${record.id}`);
  if (!tbody) return null;
  const rowId = `segrow-${record.id}-${segIndex}`;
  const existing = document.getElementById(rowId);
  if (existing) {
    try { existing.setAttribute('data-start-ms', String(startMs)); } catch(_) {}
    try {
      const timeCell = existing.querySelector('td[data-col="time"]');
      const playbackCell = existing.lastElementChild;
      if (playbackCell) {
        const sizeLabel = data.size ? `(${(data.size/1024).toFixed(0)} KB)` : '';
        const mime = (data.url && data.url.toLowerCase().endsWith('.ogg')) ? 'audio/ogg' : 'audio/webm';
        const sizeHtml = sizeLabel ? `<small id="segsize-${record.id}-${segIndex}" data-load-full="${data.url || ''}" style="cursor:pointer">${sizeLabel}</small>` : '';
        playbackCell.innerHTML = `${data.url ? `<audio controls><source src="${data.url}" type="${mime}"></audio>` : ''} ${sizeHtml}`;
      }
      if (timeCell) {
        const startStr = formatElapsed(startMs - (record.startTs || startMs));
        const endStr = formatElapsed(endMs - (record.startTs || endMs));
        timeCell.textContent = `${startStr} – ${endStr}`;
      }
    } catch(_) {}
    return existing;
  }
  const tr = document.createElement('tr');
  tr.id = rowId;
  try { tr.setAttribute('data-start-ms', String(startMs)); } catch(_) {}
  try { tr.setAttribute('data-idx', String(segIndex)); } catch(_) {}
  tr.setAttribute('hx-post', '/render/segment_row');
  tr.setAttribute('hx-trigger', 'refresh-row');
  tr.setAttribute('hx-target', 'this');
  tr.setAttribute('hx-swap', 'outerHTML');
  tr.setAttribute('hx-vals', JSON.stringify({ record: JSON.stringify(record), idx: segIndex }));
  const timeCell = document.createElement('td');
  timeCell.style.padding = '0';
  try { timeCell.style.whiteSpace = 'nowrap'; } catch(_) {}
  timeCell.setAttribute('data-col', 'time');
  const startStr = formatElapsed(startMs - (record.startTs || startMs));
  const endStr = formatElapsed(endMs - (record.startTs || endMs));
  timeCell.textContent = `${startStr} – ${endStr}`;
  tr.appendChild(timeCell);
  try {
    const services = await getServicesCached();
    services.filter(s => s.enabled).forEach(s => {
      const td = document.createElement('td');
      td.style.padding = '0';
      td.setAttribute('data-svc', s.key);
      td.textContent = 'transcribing…';
      tr.appendChild(td);
    });
  } catch(_) {}
  // Translation cell placeholder
  try {
    const td = document.createElement('td');
    td.style.padding = '0';
    td.setAttribute('data-svc', 'translation');
    td.textContent = '';
    tr.appendChild(td);
  } catch(_) {}
  // Playback cell last
  const audioCell = document.createElement('td');
  audioCell.style.padding = '0';
  const sizeLabel = data.size ? `(${(data.size/1024).toFixed(0)} KB)` : '';
  const mime = (data.url && data.url.toLowerCase().endsWith('.ogg')) ? 'audio/ogg' : 'audio/webm';
  const sizeHtml = sizeLabel ? `<small id="segsize-${record.id}-${segIndex}" data-load-full="${data.url || ''}" style="cursor:pointer">${sizeLabel}</small>` : '';
  audioCell.innerHTML = `${data.url ? `<audio controls><source src="${data.url}" type="${mime}"></audio>` : ''} ${sizeHtml}`;
  tr.appendChild(audioCell);
  // Insert sorted by explicit segment index when available; fallback to startMs ascending
  try {
    const children = Array.from(tbody.children);
    const pendingTop = document.getElementById(`segpending-${record.id}`);
    const startVal = Number(startMs) || 0;
    let inserted = false;
    for (const child of children) {
      if (!child || !(child.id || '').length) continue;
      if (pendingTop && child === pendingTop) continue;
      if (!/^seg(row|temp)-/.test(child.id)) continue;
      // Prefer ordering by data-idx when present on both rows
      const otherIdxAttr = child.getAttribute('data-idx');
      if (otherIdxAttr !== null && !Number.isNaN(Number(otherIdxAttr))) {
        const otherIdx = Number(otherIdxAttr);
        // Descending order (newest first)
        if (!Number.isNaN(segIndex) && otherIdx < segIndex) { tbody.insertBefore(tr, child); inserted = true; break; }
      } else {
        const other = Number(child.getAttribute('data-start-ms') || '0');
        if (other < startVal) { tbody.insertBefore(tr, child); inserted = true; break; }
      }
    }
    if (!inserted) {
      if (pendingTop && pendingTop.parentElement === tbody) {
        try { tbody.insertBefore(tr, pendingTop.nextSibling); } catch(_) { tbody.appendChild(tr); }
      } else {
        tbody.appendChild(tr);
      }
    }
  } catch(_) { tbody.insertBefore(tr, tbody.firstChild); }
  return tr;
}

export function insertTempSegmentRow(record, clientTs, url, size, startMs, endMs) {
  try {
    const tbody = document.getElementById(`segtbody-${record.id}`);
    if (!tbody) return null;
    const tempId = `segtemp-${record.id}-${clientTs}`;
    if (document.getElementById(tempId)) return document.getElementById(tempId);
    const tr = document.createElement('tr');
    tr.id = tempId;
    // Tag so caller can revoke object URL once server row replaces this temp row
    if (url) try { tr.setAttribute('data-temp-url', url); } catch(_) {}
    try { tr.setAttribute('data-start-ms', String(startMs)); } catch(_) {}
    try { tr.setAttribute('data-idx', String(record && typeof record._compatIdx === 'number' ? record._compatIdx : -1)); } catch(_) {}
    tr.setAttribute('data-client-ts', String(clientTs));
    try { tr.setAttribute('data-client-id', String(clientTs)); } catch(_) {}
    const timeCell = document.createElement('td');
    timeCell.style.padding = '0';
    try { timeCell.style.whiteSpace = 'nowrap'; } catch(_) {}
    timeCell.setAttribute('data-col', 'time');
    const startStr = formatElapsed(startMs - (record.startTs || startMs));
    const endStr = formatElapsed(endMs - (record.startTs || endMs));
    timeCell.textContent = `${startStr} – ${endStr}`;
    tr.appendChild(timeCell);
    // Append placeholder provider cells to keep columns aligned
    try {
      getServicesCached().then(services => {
        services.filter(s => s.enabled).forEach(s => {
          const td = document.createElement('td');
          td.style.padding = '0';
          td.setAttribute('data-svc', s.key);
          td.textContent = 'transcribing…';
          tr.appendChild(td);
        });
        // Translation placeholder
        const ttd = document.createElement('td');
        ttd.style.padding = '0';
        ttd.setAttribute('data-svc', 'translation');
        ttd.textContent = '';
        tr.appendChild(ttd);
      }).catch(() => {});
    } catch(_) {}
    // Playback cell last
    const audioCell = document.createElement('td');
    audioCell.style.padding = '0';
    const kb = size ? `(${(size/1024).toFixed(0)} KB)` : '';
    const mime = (url && url.toLowerCase().endsWith('.ogg')) ? 'audio/ogg' : 'audio/webm';
    const sizeHtml = kb ? `<small style=\"cursor:default\">${kb}</small>` : '';
    audioCell.innerHTML = `${url ? `<audio controls><source src="${url}" type="${mime}"></audio>` : ''} ${sizeHtml}`;
    tr.appendChild(audioCell);
    // Insert sorted by explicit index when present, otherwise by startMs ascending
    try {
      const children = Array.from(tbody.children);
      const pendingTop = document.getElementById(`segpending-${record.id}`);
      const startVal = Number(startMs) || 0;
      let inserted = false;
      for (const child of children) {
        if (!child || !(child.id || '').length) continue;
        if (pendingTop && child === pendingTop) continue;
        if (!/^seg(row|temp)-/.test(child.id)) continue;
        const otherIdxAttr = child.getAttribute('data-idx');
        if (otherIdxAttr !== null && !Number.isNaN(Number(otherIdxAttr)) && !Number.isNaN(Number(tr.getAttribute('data-idx')))) {
          // Descending by index (newest first)
          if (Number(otherIdxAttr) < Number(tr.getAttribute('data-idx'))) { tbody.insertBefore(tr, child); inserted = true; break; }
        } else {
          const other = Number(child.getAttribute('data-start-ms') || '0');
          if (other < startVal) { tbody.insertBefore(tr, child); inserted = true; break; }
        }
      }
      if (!inserted) {
        if (pendingTop && pendingTop.parentElement === tbody) {
          try { tbody.insertBefore(tr, pendingTop.nextSibling); } catch(_) { tbody.appendChild(tr); }
        } else {
          tbody.appendChild(tr);
        }
      }
    } catch(_) { tbody.insertBefore(tr, tbody.firstChild); }
    return tr;
  } catch(_) { return null; }
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



