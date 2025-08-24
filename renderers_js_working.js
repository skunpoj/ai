// UI renderers for recording panels
// - Shows download icon 📥 and file size next to audio
// - Displays segment start/end as elapsed m:ss from recording start
import { getServices } from '/static/ui/services.js';
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
  const srcUrl = record.serverUrl || record.audioUrl || '';
  const mime = srcUrl.toLowerCase().endsWith('.ogg') ? 'audio/ogg' : 'audio/webm';
  const sizeHtml = sizeLabel ? `<small id="size-${record.id}" data-load-full="${srcUrl}" style="cursor:pointer">(${sizeLabel})</small>` : '';
  const downloadIcon = srcUrl ? `<a href="${srcUrl}" download title="Download" data-load-full="${srcUrl}" style="cursor:pointer;text-decoration:none">📥</a>` : '';
  const playerAndDownload = `${srcUrl ? `<audio controls><source src="${srcUrl}" type="${mime}"></audio>` : ''} ${srcUrl ? `${downloadIcon} ${sizeHtml}` : ''}`;

  const services = (await getServices()).filter(s => !!s.enabled);

  let segRowsHtml = '';
  // If recording has stopped and we have a full recording URL, insert a top full row
  let fullTopHtml = '';
  try {
    if (record && record.stopTs && (record.serverUrl || record.audioUrl)) {
      const url = record.serverUrl || record.audioUrl;
      const bytes = (typeof record.serverSizeBytes === 'number' && record.serverSizeBytes > 0) ? record.serverSizeBytes : (record.clientSizeBytes || 0);
      const kb = bytes ? Math.max(1, Math.round(bytes/1024)) : 0;
      const sizeHtml = kb ? ` <small data-load-full="${url}" style="cursor:pointer">(${kb} KB)</small>` : '';
      const playerHtml = `<audio controls><source src="${url}" type="${mime}"></audio>`;
      const dlHtml = `<a href="${url}" download title="Download" data-load-full="${url}" style="cursor:pointer;text-decoration:none">📥</a>`;
      // span all columns (Segment + Time + providers)
      const colCount = 2 + services.length;
      fullTopHtml = `<tr id="fullrowline-${record.id}"><td colspan="${colCount}">${playerHtml} ${dlHtml}${sizeHtml}</td></tr>`;
    }
  } catch(_) {}
  // No Full row during recording; full player is inserted into the top row only on Stop
  const presentIdx = [];
  const segs = Array.isArray(record.segments) ? record.segments : [];
  for (let i = 0; i < segs.length; i++) if (segs[i]) presentIdx.push(i);
  presentIdx.sort((a, b) => b - a);
  for (const i of presentIdx) {
    const seg = segs[i];
    const segMime = (seg && seg.url && seg.url.toLowerCase().endsWith('.ogg')) ? 'audio/ogg' : 'audio/webm';
    const sl = seg && seg.size ? bytesToLabel(seg.size) : '';
    const segUrl = seg && seg.url ? seg.url : '';
    const timeStr = (seg && seg.startMs && seg.endMs)
      ? `${formatElapsed(seg.startMs - (record.startTs || seg.startMs))} – ${formatElapsed(seg.endMs - (record.startTs || seg.endMs))}`
      : '';
    const leftCells = `
      <td>${segUrl ? `<audio controls><source src="${segUrl}" type="${segMime}"></audio>` : ''} ${segUrl ? `<a href="${segUrl}" download title="Download" data-load-full="${segUrl}" style="cursor:pointer;text-decoration:none">📥</a>` : ''} ${sl ? `<small id="segsize-${record.id}-${i}" data-load-full="${segUrl}" style="cursor:pointer">(${sl})</small>` : ''}</td>
      <td data-col="time">${timeStr}</td>
    `;
    const svcCells = services.map(svc => {
      const tx = (record.transcripts && record.transcripts[svc.key]) || [];
      const val = (typeof tx[i] !== 'undefined') ? (tx[i] || '') : '';
      let display = val ? val : '';
      const timeouts = (record.timeouts && record.timeouts[svc.key]) || [];
      if (!val && i < timeouts.length && timeouts[i]) display = 'no result (timeout)';
      return `<td data-svc="${svc.key}">${display}</td>`;
    }).join('');
    const hxVals = JSON.stringify({ record: JSON.stringify(record), idx: i }).replace(/"/g, '&quot;');
    segRowsHtml += `<tr id="segrow-${record.id}-${i}" hx-post="/render/segment_row" hx-trigger="refresh-row" hx-target="this" hx-swap="outerHTML" hx-vals="${hxVals}">${leftCells}${svcCells}</tr>`;
  }

  const fullHxVals = JSON.stringify({ record: JSON.stringify(record) }).replace(/"/g, '&quot;');
  // Recompute full text cells from per-segment arrays to avoid duplicates
  const fullCells = services.map(svc => {
    const arr = (record.transcripts && record.transcripts[svc.key]) ? record.transcripts[svc.key] : [];
    const joined = Array.isArray(arr) ? arr.filter(Boolean).join(' ') : '';
    return `<td data-svc="${svc.key}">${joined}</td>`;
  }).join('');

  panel.innerHTML = `
    <div>
      <div id="fulltable-${record.id}" hx-post="/render/full_row" hx-trigger="load, refresh-full" hx-target="this" hx-swap="innerHTML" hx-vals="${fullHxVals}">
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
    </div>
    <div style="margin-top:12px">
      <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse; border-spacing:0; border:0; width:100%">
        <thead>
          <tr>
            <th style="border:0">Segment</th>
            <th style="border:0" data-col="time">Time</th>
            ${services.map(s => `<th style=\"border:0\">${s.label}</th>`).join('')}
          </tr>
        </thead>
        <tbody id="segtbody-${record.id}">
          ${fullTopHtml}${segRowsHtml}
        </tbody>
      </table>
    </div>
  `;
}


