// Wake Lock utilities for mobile devices
// - Provides acquire/release helpers for screen wake lock
// - Adds an optional visibilitychange handler to reacquire when the page is visible

let wakeLock = null; // WakeLockSentinel

export async function acquireWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return; // Not supported
    if (wakeLock) return; // Already held
    wakeLock = await navigator.wakeLock.request('screen');
    try { wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch(_) {}
    console.log('Frontend: Screen wake lock acquired.');
  } catch (e) {
    console.warn('Frontend: Failed to acquire wake lock:', e && e.message ? e.message : e);
    wakeLock = null;
  }
}

export async function releaseWakeLock() {
  try {
    if (wakeLock && wakeLock.release) await wakeLock.release();
  } catch(_) {}
  wakeLock = null;
  console.log('Frontend: Screen wake lock released.');
}

// getIsRecording: () => boolean — returns true when recording is active
export function initWakeLockVisibilityReacquire(getIsRecording) {
  try {
    document.addEventListener('visibilitychange', async () => {
      try {
        if (document.visibilityState === 'visible') {
          if (typeof getIsRecording === 'function' && getIsRecording()) await acquireWakeLock();
        }
      } catch(_) {}
    });
  } catch(_) {}
}


