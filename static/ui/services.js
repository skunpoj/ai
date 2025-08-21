// Returns list of available services from backend.
// Falls back to a default set if the endpoint isn't available.
// Each item has { key, label, enabled }.
export async function getServices() {
    const fallback = [
        { key: 'google', label: 'Google STT' },
        { key: 'vertex', label: 'Gemini (Vertex AI)' },
        { key: 'gemini', label: 'Gemini (API)' },
        { key: 'aws', label: 'AWS Transcribe (beta)' }
    ];
    try {
        const res = await fetch('/services', { cache: 'no-store' });
        if (!res.ok) return fallback;
        const data = await res.json();
        if (!Array.isArray(data)) return fallback;
        return data.filter(s => s && s.key && s.label).map(s => ({ key: s.key, label: s.label, enabled: !!s.enabled }));
    } catch (_) {
        return fallback;
    }
}


// Lightweight client-side cache to avoid repeated fetches during a tight loop
let _svcCache = { ts: 0, data: null };
export async function getServicesCached(ttlMs = 1500) {
    const now = Date.now();
    if (_svcCache.data && (now - _svcCache.ts) < ttlMs) return _svcCache.data;
    const data = await getServices();
    _svcCache = { ts: now, data };
    return data;
}


