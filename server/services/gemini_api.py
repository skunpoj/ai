"""
server/services/gemini_api.py

Helpers for extracting text from Gemini consumer API responses.
"""
from typing import Optional


def extract_text_from_gemini_response(resp) -> str:
    try:
        return (resp.text or "").strip()
    except Exception:
        return ""


