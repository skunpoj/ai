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
  const playerAndDownload = `${srcUrl ? `<audio controls><source src="${srcUrl}" type="${mime}"></audio>` : ''} ${downloadIcon} ${sizeHtml}`;

  const services = (await getServices()).filter(s => !!s.enabled);

  let segRowsHtml = '';
  const presentIdx = [];
  for (let i = 0; i < record.segments.length; i++) if (record.segments[i]) presentIdx.push(i);
  presentIdx.sort((a, b) => b - a);
  for (const i of presentIdx) {
    const seg = record.segments[i];
    const segMime = (seg && seg.url && seg.url.toLowerCase().endsWith('.ogg')) ? 'audio/ogg' : 'audio/webm';
    const sl = seg && seg.size ? bytesToLabel(seg.size) : '';
    const segUrl = seg && seg.url ? seg.url : '';
    const leftCells = `
      <td>${segUrl ? `<audio controls><source src="${segUrl}" type="${segMime}"></audio>` : ''} ${segUrl ? `<a href="${segUrl}" download title="Download" data-load-full="${segUrl}" style="cursor:pointer;text-decoration:none">📥</a>` : ''} ${sl ? `<small id="segsize-${record.id}-${i}" data-load-full="${segUrl}" style="cursor:pointer">(${sl})</small>` : ''}</td>
      <td>${seg && seg.startMs ? formatElapsed(seg.startMs - (record.startTs || seg.startMs)) : ''}</td>
      <td>${seg && seg.endMs ? formatElapsed(seg.endMs - (record.startTs || seg.endMs)) : ''}</td>
    `;
    const svcCells = services.map(svc => {
      const val = (record.transcripts[svc.key] && typeof record.transcripts[svc.key][i] !== 'undefined') ? (record.transcripts[svc.key][i] || '') : '';
      let display = val ? val : '';
      const timeouts = (record.timeouts && record.timeouts[svc.key]) || [];
      if (!val && i < timeouts.length && timeouts[i]) display = 'no result (timeout)';
      return `<td data-svc="${svc.key}">${display}</td>`;
    }).join('');
    const hxVals = JSON.stringify({ record: JSON.stringify(record), idx: i }).replace(/"/g, '&quot;');
    segRowsHtml += `<tr id="segrow-${record.id}-${i}" hx-post="/render/segment_row" hx-trigger="refresh-row" hx-target="this" hx-swap="outerHTML" hx-vals="${hxVals}">${leftCells}${svcCells}</tr>`;
  }

  const fullCells = services.map(svc => `<td data-svc="${svc.key}">${record.fullAppend[svc.key] || ''}</td>`).join('');
  const fullHxVals = JSON.stringify({ record: JSON.stringify(record) }).replace(/"/g, '&quot;');

  panel.innerHTML = `
    <div>
      <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse; border-spacing:0; border:0; width:100%">
        <tbody>
          <tr>
            <td style="padding:0"></td>
            <td style="padding:0"></td>
            <td style="padding:0"></td>
            <td style="padding:0"><h3 style="margin:0;padding:0">Full Record</h3></td>
          </tr>
          <tr>
            <td style="padding:0"></td>
            <td style="padding:0"></td>
            <td style="padding:0"></td>
            <td style="padding:0"><div style="margin-bottom:8px">${startedAt && endedAt ? `Start: ${startedAt} · End: ${endedAt} · Duration: ${dur}s` : ''}</div></td>
          </tr>
          <tr>
            <td style="padding:0"></td>
            <td style="padding:0"></td>
            <td style="padding:0"></td>
            <td style="padding:0"><div id="recordmeta-${record.id}" style="margin-bottom:8px">${playerAndDownload}</div></td>
          </tr>
        </tbody>
      </table>
      <div id="fulltable-${record.id}" hx-post="/render/full_row" hx-trigger="refresh-full" hx-target="this" hx-swap="innerHTML" hx-vals="${fullHxVals}">
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
      <h3>Segments</h3>
      <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse; border-spacing:0; border:0; width:100%">
        <thead>
          <tr>
            <th style="border:0">Segment</th>
            <th style="border:0">Start</th>
            <th style="border:0">End</th>
            ${services.map(s => `<th style=\"border:0\">${s.label}</th>`).join('')}
          </tr>
        </thead>
        <tbody id="segtbody-${record.id}">
          ${segRowsHtml}
        </tbody>
      </table>
    </div>
  `;
}


