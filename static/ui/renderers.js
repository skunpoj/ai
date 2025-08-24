// UI renderers for recording panels
// - Shows download icon 📥 and file size next to audio
// - Displays segment start/end as elapsed m:ss from recording start
import { getServicesCached as getServices } from '/static/ui/services.js';
import { formatElapsed } from '/static/ui/segments.js';
import { bytesToLabel } from '/static/ui/format.js';
import { ensureTab as ensureUITab } from '/static/ui/tabs.js';

/**
 * Render the UI panel for a single recording tab.
 * - Builds a full-record comparison table (one column per enabled service)
 * - Builds a segments table with audio/download/size, start/end, and service transcripts
 *
 * @param {object} record - The recording object with segments and transcripts
 * @returns {Promise<void>} resolves after DOM is updated
 */
export async function renderRecordingPanel(record) {
  const tabsBar = document.getElementById('recordTabs');
  const panelsHost = document.getElementById('recordPanels');
  if (tabsBar && panelsHost) ensureUITab(tabsBar, panelsHost, record);
  const panel = document.getElementById(`panel-${record.id}`);
  if (!panel) return;

  const startedAt = record.startTs ? new Date(record.startTs).toLocaleTimeString() : '';
  const endedAt = record.stopTs ? new Date(record.stopTs).toLocaleTimeString() : '';
  const dur = record.durationMs ? Math.round(record.durationMs / 1000) : 0;
  const sizeLabel = (typeof record.serverSizeBytes === 'number' && record.serverSizeBytes > 0)
    ? bytesToLabel(record.serverSizeBytes)
    : (typeof record.clientSizeBytes === 'number' ? bytesToLabel(record.clientSizeBytes) : '');
  // Show local preview only when explicitly toggled on in the record object
  const allowLocal = !!record.useLocalPreview;
  const srcUrl = record.serverUrl || (allowLocal ? (record.audioUrl || '') : '');
  const mime = srcUrl.toLowerCase().endsWith('.ogg') ? 'audio/ogg' : 'audio/webm';
  const sizeHtml = sizeLabel ? `<small id="size-${record.id}" data-load-full="${srcUrl}" style="cursor:pointer">(${sizeLabel})</small>` : '';
  const downloadIcon = srcUrl ? `<a href="${srcUrl}" download title="Download" data-load-full="${srcUrl}" style="cursor:pointer;text-decoration:none">📥</a>` : '';
  const playerAndDownload = `${srcUrl ? `<audio controls><source src="${srcUrl}" type="${mime}"></audio>` : ''} ${srcUrl ? `${downloadIcon} ${sizeHtml}` : ''}`;

  // Cache services more aggressively to avoid repeated /services fetches during rapid UI updates
  const services = (await getServices(8000)).filter(s => !!s.enabled);
  const translationEnabled = !!(window && window.APP_FLAGS && window.APP_FLAGS.enable_translation);

  let segRowsHtml = '';
  // If recording has stopped and we have a full recording URL or local preview (when enabled), insert a single integrated full row (texts + playback)
  let fullTopHtml = '';
  try {
    if (record && record.stopTs && (record.serverUrl || (allowLocal && record.audioUrl))) {
      const url = record.serverUrl || (allowLocal ? record.audioUrl : '');
      const bytes = (typeof record.serverSizeBytes === 'number' && record.serverSizeBytes > 0) ? record.serverSizeBytes : (record.clientSizeBytes || 0);
      const kb = bytes ? Math.max(1, Math.round(bytes/1024)) : 0;
      const sizeHtml = kb ? ` <small data-load-full="${url}" style="cursor:pointer">(${kb} KB)</small>` : '';
      const playerHtml = `<audio controls><source src="${url}" type="${mime}"></audio>`;
      const dlHtml = `<a href="${url}" download title="Download" data-load-full="${url}" style="cursor:pointer;text-decoration:none">📥</a>`;
      const fullTexts = services.map(svc => {
        const arr = (record.transcripts && record.transcripts[svc.key]) ? record.transcripts[svc.key] : [];
        const joined = Array.isArray(arr) ? arr.filter(Boolean).join(' ') : '';
        return `<td data-svc="${svc.key}">${joined}</td>`;
      }).join('');
      const emptyTime = `<td data-col="time">full record</td>`;
      const transJoined = (() => {
        try {
          const arr = (record.transcripts && record.transcripts.translation) ? record.transcripts.translation : [];
          return Array.isArray(arr) ? arr.filter(Boolean).join(' ') : '';
        } catch(_) { return ''; }
      })();
      const transCell = translationEnabled ? `<td data-svc="translation">${transJoined}</td>` : '';
      const playCell = `<td>${playerHtml} ${dlHtml}${sizeHtml}</td>`;
      segRowsHtml += `<tr id="fullrowseg-${record.id}">${emptyTime}${fullTexts}${transCell}${playCell}</tr>`;
    }
  } catch(_) {}
  // No Full row during recording; full player text/row only appears after Stop
  const presentIdx = [];
  const segs = Array.isArray(record.segments) ? record.segments : [];
  for (let i = 0; i < segs.length; i++) if (segs[i]) presentIdx.push(i);
  // Show newest rows first while recording (descending by index)
  presentIdx.sort((a, b) => b - a);
  for (const i of presentIdx) {
    const seg = segs[i];
    const segMime = (seg && seg.url && seg.url.toLowerCase().endsWith('.ogg')) ? 'audio/ogg' : 'audio/webm';
    const sl = seg && seg.size ? bytesToLabel(seg.size) : '';
    const segUrl = seg && seg.url ? seg.url : '';
    const timeStr = (seg && seg.startMs && seg.endMs)
      ? `${formatElapsed(seg.startMs - (record.startTs || seg.startMs))} – ${formatElapsed(seg.endMs - (record.startTs || seg.endMs))}`
      : '';
    const timeCell = `<td data-col="time">${timeStr}</td>`;
    const svcCells = services.map(svc => {
      const tx = (record.transcripts && record.transcripts[svc.key]) || [];
      const val = (typeof tx[i] !== 'undefined') ? (tx[i] || '') : '';
      let display = val ? val : '';
      const timeouts = (record.timeouts && record.timeouts[svc.key]) || [];
      if (!val && i < timeouts.length && timeouts[i]) display = 'no result (timeout)';
      return `<td data-svc="${svc.key}">${display}</td>`;
    }).join('');
    const transCell = translationEnabled ? `<td data-svc="translation">${(((record.transcripts||{}).translation||[])[i]||'')}</td>` : ``;
    const playCell = `<td>${segUrl ? `<audio controls><source src="${segUrl}" type="${segMime}"></audio>` : ''} ${segUrl ? `<a href="${segUrl}" download title="Download" data-load-full="${segUrl}" style="cursor:pointer;text-decoration:none">📥</a>` : ''} ${sl ? `<small id="segsize-${record.id}-${i}" data-load-full="${segUrl}" style="cursor:pointer">(${sl})</small>` : ''}</td>`;
    const hxVals = JSON.stringify({ record: JSON.stringify(record), idx: i }).replace(/"/g, '&quot;');
    segRowsHtml += `<tr id="segrow-${record.id}-${i}" hx-post="/render/segment_row" hx-trigger="refresh-row" hx-target="this" hx-swap="outerHTML" hx-vals="${hxVals}">${timeCell}${svcCells}${transCell}${playCell}</tr>`;
  }

  const fullHxVals = JSON.stringify({ record: JSON.stringify(record) }).replace(/"/g, '&quot;');
  // If the full table already exists (e.g., summary was swapped in), avoid rebuilding it.
  // Only update the segments tbody to preserve server-rendered summary content.
  try {
    const existingFull = document.getElementById(`fulltable-${record.id}`);
    if (existingFull) {
      // Keep server summary; just update rows and refresh with the latest record snapshot
      const segBody = document.getElementById(`segtbody-${record.id}`);
      if (segBody) segBody.innerHTML = `${fullTopHtml}${segRowsHtml}`;
      // Do not trigger summary here to avoid duplicate /render/full_row calls; app.js handles it once
      return;
    }
  } catch(_) {}
  // Always render joined full transcript immediately; the server will replace with a
  // summary via HTMX when available (after stop). This avoids a blank state.
  const fullCells = services.map(svc => {
    const arr = (record.transcripts && record.transcripts[svc.key]) ? record.transcripts[svc.key] : [];
    const joined = Array.isArray(arr) ? arr.filter(Boolean).join(' ') : '';
    return `<td data-svc="${svc.key}">${joined}</td>`;
  }).join('');

  // Placeholder header must include Translation to match server full_row response
  panel.innerHTML = `
    <div>
      <div id="fulltable-${record.id}">
        <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse; border-spacing:0; border:0; width:100%">
          <thead>
            <tr>
              ${services.map(s => `<th style="border:0">${s.label}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr>${fullCells}</tr>
          </tbody>
        </table>
      </div>
      <div id="summarytable-${record.id}" hx-post="/render/full_row" hx-trigger="refresh-summary" hx-target="this" hx-swap="innerHTML" hx-vals="${fullHxVals}" style="min-height:24px;margin-top:6px;display:block">
        <small style="color:#aaa">Waiting for summary…</small>
      </div>
    </div>
    <div style="margin-top:12px">
      <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse; border-spacing:0; border:0; width:100%">
        <thead>
          <tr>
            <th style="border:0" data-col="time">Time</th>
            ${services.map(s => `<th style=\"border:0\">${s.label}</th>`).join('')}
            ${translationEnabled ? '<th style="border:0">Translation</th>' : ''}
            <th style="border:0">Playback</th>
          </tr>
        </thead>
        <tbody id="segtbody-${record.id}">
          ${fullTopHtml}${segRowsHtml}
        </tbody>
      </table>
    </div>
  `;
  // Ensure HTMX processes dynamically inserted hx-* attributes (summary container)
  try { if (window && window.htmx && typeof window.htmx.process === 'function') window.htmx.process(panel); } catch(_) {}
}


