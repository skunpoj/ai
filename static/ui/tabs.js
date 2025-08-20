export function ensureTab(tabsBar, panelsHost, record) {
    const existing = document.getElementById(`tab-${record.id}`);
    if (existing) return;
    const tabBtn = document.createElement('button');
    tabBtn.id = `tab-${record.id}`;
    tabBtn.textContent = new Date(record.startTs || Date.now()).toLocaleTimeString();
    tabBtn.addEventListener('click', () => activateTab(tabsBar, panelsHost, record.id));
    tabsBar.appendChild(tabBtn);

    const panel = document.createElement('div');
    panel.id = `panel-${record.id}`;
    panel.style.display = 'none';
    panelsHost.appendChild(panel);
    activateTab(tabsBar, panelsHost, record.id);
}

export function activateTab(tabsBar, panelsHost, recordId) {
    [...panelsHost.children].forEach(ch => ch.style.display = 'none');
    const panel = document.getElementById(`panel-${recordId}`);
    if (panel) panel.style.display = 'block';
    [...tabsBar.children].forEach(btn => btn.classList.remove('active'));
    const tabBtn = document.getElementById(`tab-${recordId}`);
    if (tabBtn) tabBtn.classList.add('active');
}


