/**
 * Build a WebSocket URL from the current location and a path
 * @param {Location} location
 * @param {string} path
 * @returns {string}
 */
export function buildWSUrl(location, path) {
  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsScheme}://${location.host}${path}`;
}

/**
 * Safely parse a JSON WebSocket message
 * @param {MessageEvent} event
 * @returns {any|null}
 */
export function parseWSMessage(event) {
  try {
    return JSON.parse(event.data);
  } catch (_) {
    console.warn('WS: Non-JSON message ignored');
    return null;
  }
}

/**
 * Send a JSON object over a WebSocket
 * @param {WebSocket} socket
 * @param {any} obj
 */
export function sendJSON(socket, obj) {
  socket.send(JSON.stringify(obj));
}

/**
 * Encode ArrayBuffer to base64 string
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // 32KB
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode.apply(null, sub));
  }
  return btoa(chunks.join(''));
}


