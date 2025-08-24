"""
server/segment_store.py

In-memory segment table for the current process. Provides simple helpers to
insert a segment record and append/update transcripts for the same row.

This can be swapped to SQLite or another DB later without changing callers.
"""
from typing import Dict, Any, Optional
import itertools


_id_counter = itertools.count(1)
_segments: Dict[int, Dict[str, Any]] = {}


def insert_segment(recording_id: str, idx: int, url: str, mime: str, size: int, client_id: Optional[int], ts: int, start_ms: int, end_ms: int) -> Dict[str, Any]:
    seg_id = next(_id_counter)
    row = {
        "segment_id": seg_id,
        "recording_id": recording_id,
        "idx": idx,
        "url": url,
        "mime": mime,
        "size": int(size) if isinstance(size, int) else size,
        "client_id": client_id,
        "ts": ts,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "transcripts": { "google": "", "vertex": "", "gemini": "", "aws": "" },
    }
    _segments[seg_id] = row
    return row


def append_transcript(segment_id: int, provider: str, text: str) -> Optional[Dict[str, Any]]:
    row = _segments.get(int(segment_id))
    if not row:
        return None
    provider = str(provider or "").strip()
    if not provider:
        return row
    try:
        prev = row.get("transcripts", {}).get(provider, "")
        joined = (prev + (" " if prev and text else "") + (text or "")).strip()
        row.setdefault("transcripts", {})[provider] = joined
    except Exception:
        pass
    return row


def get_segment(segment_id: int) -> Optional[Dict[str, Any]]:
    return _segments.get(int(segment_id))


