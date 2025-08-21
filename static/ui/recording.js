// Recording control helpers (start/stop): clean separation from main
export function setButtonsOnStart(startBtn, stopBtn, startTxBtn, stopTxBtn) {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  startTxBtn.disabled = false;
  stopTxBtn.disabled = true;
}

export function setButtonsOnStop(startBtn, stopBtn, startTxBtn, stopTxBtn) {
  startBtn.disabled = false;
  stopBtn.disabled = true;
  startTxBtn.disabled = true;
  stopTxBtn.disabled = true;
}


