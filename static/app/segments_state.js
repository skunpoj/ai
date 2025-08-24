// Shared segment state and helpers, imported by main controller

// Pending per-segment data until both saved info and transcripts arrive
export const pendingRowsByIdx = new Map(); // `${recId}:${idx}` -> { saved, transcripts, inserted }
export const pendingRowsByClientId = new Map(); // `${recId}:${clientId}` -> partial
export const pendingRowsByServerId = new Map(); // `${recId}:${serverId}` -> partial

// Tracks rows already inserted to avoid duplicates
export const insertedRows = new Set(); // `${recId}:${idx}`

// Fallback timers for forced insertions without transcripts
export const pendingInsertTimers = new Map(); // `${recId}:${idx}` -> timeoutId

// Map server-assigned segment id to local index for routing transcripts
export const segmentIdToIndex = new Map(); // `${recId}:${serverId}` -> idx

export function idxKey(recId, idx) { return `${recId}:${idx}`; }
export function clientKey(recId, clientId) { return `${recId}:${clientId}`; }
export function serverKey(recId, serverId) { return `${recId}:${serverId}`; }

export function normalizeId(v) {
    try { return v === undefined || v === null ? '' : String(v); } catch(_) { return ''; }
}

export function mergePending(dst, src) {
    if (!src) return dst;
    dst.saved = dst.saved || src.saved || null;
    dst.transcripts = Object.assign({}, src.transcripts || {}, dst.transcripts || {});
    dst.inserted = !!(dst.inserted || src.inserted);
    return dst;
}

export function setPending(map, key, updater) {
    const cur = map.get(key) || { saved: null, transcripts: {}, inserted: false };
    const next = updater ? updater(cur) : cur;
    map.set(key, next);
    return next;
}

export function getServerId(obj) {
    try { return obj && (obj.segment_id || obj.sid || obj.server_id || null); } catch(_) { return null; }
}

export function resetSegmentsState() {
    try { pendingRowsByIdx.clear(); } catch(_) {}
    try { pendingRowsByClientId.clear(); } catch(_) {}
    try { pendingRowsByServerId.clear(); } catch(_) {}
    try { insertedRows.clear(); } catch(_) {}
    try { pendingInsertTimers.forEach((to) => { try { clearTimeout(to); } catch(_) {} }); pendingInsertTimers.clear(); } catch(_) {}
    try { segmentIdToIndex.clear(); } catch(_) {}
}


