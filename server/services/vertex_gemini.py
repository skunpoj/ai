"""
server/services/vertex_gemini.py

Helpers for building Vertex GenAI audio contents and extracting text.
"""
import base64
from typing import Optional


def build_vertex_contents(segment_bytes: bytes, mime_type: str) -> list:
    b64 = base64.b64encode(segment_bytes).decode("ascii")
    return [{
        "role": "user",
        "parts": [
            {"inlineData": {"mimeType": mime_type, "data": b64}},
            {"text": "Transcribe the spoken audio to plain text. Return only the transcript."}
        ]
    }]


def extract_text_from_vertex_response(resp) -> str:
    try:
        return (resp.text or "").strip()
    except Exception:
        return ""


