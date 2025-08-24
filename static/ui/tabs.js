// Create a tab button and content panel for a given recording, if it doesn't exist
export function ensureTab(tabsBar, panelsHost, record) {
    const existing = document.getElementById(`tab-${record.id}`);
    if (existing) return;
    const tabBtn = document.createElement('button');
    tabBtn.id = `tab-${record.id}`;
    const startLbl = new Date(record.startTs || Date.now()).toLocaleTimeString([], { hour12: false });
    tabBtn.textContent = startLbl; // Abbreviated label; updated on stop with end/duration
    // Elapsed timer span
    const timerSpan = document.createElement('span');
    timerSpan.id = `elapsed-${record.id}`;
    timerSpan.style.marginLeft = '6px';
    timerSpan.style.fontSize = '11px';
    timerSpan.style.opacity = '0.8';
    tabBtn.appendChild(timerSpan);
    tabBtn.addEventListener('click', () => activateTab(tabsBar, panelsHost, record.id));
    tabsBar.appendChild(tabBtn);

    const panel = document.createElement('div');
    panel.id = `panel-${record.id}`;
    panel.style.display = 'none';
    panelsHost.appendChild(panel);
    activateTab(tabsBar, panelsHost, record.id);
}

// Activate a tab by record id; shows its panel and styles the active tab button
export function activateTab(tabsBar, panelsHost, recordId) {
    // Pure view switch; must not affect recording state
    [...panelsHost.children].forEach(ch => ch.style.display = 'none');
    const panel = document.getElementById(`panel-${recordId}`);
    if (panel) panel.style.display = 'block';
    [...tabsBar.children].forEach(btn => btn.classList.remove('active'));
    const tabBtn = document.getElementById(`tab-${recordId}`);
    if (tabBtn) tabBtn.classList.add('active');
}

// Lightweight helpers used by app.js to show elapsed time and final summary
export function setElapsed(tabsBar, recordId, seconds) {
    const sp = document.getElementById(`elapsed-${recordId}`);
    if (!sp) return;
    const mm = Math.floor(seconds / 60);
    const ss = seconds % 60;
    sp.textContent = `(${mm}:${String(ss).padStart(2,'0')})`;
}

export function finalizeTab(tabsBar, record) {
    const btn = document.getElementById(`tab-${record.id}`);
    if (!btn) return;
    const start = new Date(record.startTs || Date.now()).toLocaleTimeString([], { hour12: false });
    const stop = new Date(record.stopTs || Date.now()).toLocaleTimeString([], { hour12: false });
    const durSec = Math.max(0, Math.round((record.durationMs || 0)/1000));
    btn.textContent = `${start} → ${stop} (${durSec}s)`;
}


