// UI renderers for recording panels
import { getServices } from '/static/ui/services.js';
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
  // Ensure a tab/panel exists for this record
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
  const playerAndDownload = `${record.audioUrl ? `<audio controls src="${record.audioUrl}"></audio>` : ''} ${record.serverUrl ? `<a href="${record.serverUrl}" download>Download</a>` : ''} ${sizeLabel ? `(${sizeLabel})` : ''}`;

  // Fetch current services dynamically from backend
  const services = (await getServices()).filter(s => !!s.enabled);

  // Segments grid rows
  let segRowsHtml = '';
  const maxSeg = Math.max(
    record.segments.length,
    record.transcripts.google.length,
    record.transcripts.vertex.length,
    record.transcripts.gemini.length
  );
  for (let i = 0; i < maxSeg; i++) {
    const seg = record.segments[i];
    const leftCells = `
      <td>${seg ? `<audio controls src="${seg.url}"></audio>` : ''} ${seg && seg.url ? `<a href="${seg.url}" download>Download</a>` : ''} ${seg && seg.size ? `(${bytesToLabel(seg.size)})` : ''}</td>
      <td>${seg && seg.startMs ? new Date(seg.startMs).toLocaleTimeString() : ''}</td>
      <td>${seg && seg.endMs ? new Date(seg.endMs).toLocaleTimeString() : ''}</td>
    `;
    const svcCells = services.map(svc => `<td data-svc="${svc.key}">${(record.transcripts[svc.key] && typeof record.transcripts[svc.key][i] !== 'undefined') ? (record.transcripts[svc.key][i] || '') : ''}</td>`).join('');
    const hxVals = JSON.stringify({ record: JSON.stringify(record), idx: i }).replace(/"/g, '&quot;');
    segRowsHtml += `<tr id="segrow-${record.id}-${i}" hx-post="/render/segment_row" hx-trigger="refresh-row" hx-target="this" hx-swap="outerHTML" hx-vals="${hxVals}">${leftCells}${svcCells}</tr>`;
  }

  // Full record comparison row: one cell per service
  const fullCells = services.map(svc => `<td data-svc="${svc.key}">${record.fullAppend[svc.key] || ''}</td>`).join('');

  const fullHxVals = JSON.stringify({ record: JSON.stringify(record) }).replace(/"/g, '&quot;');
  panel.innerHTML = `
    <div style="margin-bottom:8px">
      ${startedAt && endedAt ? `Start: ${startedAt} · End: ${endedAt} · Duration: ${dur}s` : ''}
    </div>
    <div style="margin-bottom:8px">${playerAndDownload}</div>
    <div id="fulltable-${record.id}" hx-post="/render/full_row" hx-trigger="refresh-full" hx-target="this" hx-swap="innerHTML" hx-vals="${fullHxVals}">
      <h3>Full Record</h3>
      <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse; width:100%">
        <thead>
          <tr>
            ${services.map(s => `<th>${s.label}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          <tr>${fullCells}</tr>
        </tbody>
      </table>
      <div style="margin-top:6px; font-size:12px; color:#aaa">Live (finalized) Google stream: ${record.fullAppend.googleLive || ''}</div>
    </div>
    <div style="margin-top:12px">
      <h3>Segments</h3>
      <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse; width:100%">
        <thead>
          <tr>
            <th>Segment</th>
            <th>Start</th>
            <th>End</th>
            ${services.map(s => `<th>${s.label}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${segRowsHtml}
        </tbody>
      </table>
    </div>
  `;
}


