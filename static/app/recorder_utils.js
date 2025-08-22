// Recording utilities (extracted from main.js)

export function safelyStopStream(stream) {
  try {
    if (stream && stream.getTracks) {
      const tracks = stream.getTracks();
      const anyLive = tracks.some(t => (t.readyState === 'live'));
      if (!anyLive) return;
      tracks.forEach(t => { try { t.stop(); } catch(_) {} });
    }
  } catch(_) {}
}

export function createMediaRecorderWithFallback(stream, recMimeTypeRef) {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    '' // default
  ];
  for (const t of types) {
    try {
      const opts = t ? { mimeType: t } : undefined;
      const mr = new MediaRecorder(stream, opts);
      if (t && !recMimeTypeRef.value) recMimeTypeRef.value = t;
      return mr;
    } catch(_) {}
  }
  throw new Error('MediaRecorder unsupported');
}


