// Create a tab button and content panel for a given recording, if it doesn't exist
export function ensureTab(tabsBar, panelsHost, record) {
    const existing = document.getElementById(`tab-${record.id}`);
    if (existing) return;
    const tabBtn = document.createElement('button');
    tabBtn.id = `tab-${record.id}`;
    const startLbl = new Date(record.startTs || Date.now()).toLocaleTimeString();
    tabBtn.textContent = startLbl; // Abbreviated label; updated on stop with end/duration
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
    [...panelsHost.children].forEach(ch => ch.style.display = 'none');
    const panel = document.getElementById(`panel-${recordId}`);
    if (panel) panel.style.display = 'block';
    [...tabsBar.children].forEach(btn => btn.classList.remove('active'));
    const tabBtn = document.getElementById(`tab-${recordId}`);
    if (tabBtn) tabBtn.classList.add('active');
}


