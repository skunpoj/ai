"""
server/services/gemini_api.py

Helpers for extracting text from Gemini consumer API responses across SDKs:
- google-generativeai (legacy): response.text
- google.genai (new): response.candidates[0].content.parts[].text
"""
from typing import Any, List


def _from_candidates(resp: Any) -> str:
    try:
        candidates = getattr(resp, "candidates", None) or (isinstance(resp, dict) and resp.get("candidates"))
        if not candidates:
            return ""
        cand0 = candidates[0]
        content = getattr(cand0, "content", None) or (isinstance(cand0, dict) and cand0.get("content"))
        if not content:
            return ""
        parts: List[Any] = getattr(content, "parts", None) or (isinstance(content, dict) and content.get("parts")) or []
        texts: List[str] = []
        for p in parts:
            txt = getattr(p, "text", None) or (isinstance(p, dict) and p.get("text"))
            if isinstance(txt, str) and txt.strip():
                texts.append(txt.strip())
        return "\n".join(texts).strip()
    except Exception:
        return ""


def extract_text_from_gemini_response(resp: Any) -> str:
    # Legacy SDK path
    try:
        txt = getattr(resp, "text", None)
        if isinstance(txt, str) and txt.strip():
            return txt.strip()
    except Exception:
        pass
    # New google.genai path
    txt2 = _from_candidates(resp)
    if txt2:
        return txt2
    # Dict-like fallback
    try:
        if isinstance(resp, dict) and "text" in resp and isinstance(resp["text"], str):
            return resp["text"].strip()
    except Exception:
        pass
    return ""


