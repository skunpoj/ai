"""
server/services/vertex_langchain.py

LangChain-based orchestrator for Vertex AI Gemini transcription.

Currently, LangChain's Vertex integrations focus on text/chat. This adapter
wraps the Vertex audio transcription using the underlying Vertex client while
keeping the orchestration entrypoint via LangChain for future prompt flows.
"""
from typing import Optional

try:
    from langchain_google_vertexai import VertexAI
except Exception:
    VertexAI = None  # type: ignore


def is_available() -> bool:
    return VertexAI is not None


def transcribe_segment_via_langchain(vertex_client: object, model_name: str, segment_bytes: bytes, mime_type: str) -> str:
    """Transcribe a single audio segment using the Vertex client.

    We return to the lower-level client for audio, but the function acts as a
    placeholder to insert LangChain chains if/when audio paths are surfaced.
    """
    try:
        # Use the google-genai SDK client that server/state.py initialized
        # and invoke generate_content with inlineData for audio mime.
        contents = [{
            "role": "user",
            "parts": [
                {"inlineData": {"mimeType": mime_type, "data": segment_bytes}},
                {"text": "Transcribe the spoken audio to plain text. Return only the transcript."}
            ]
        }]
        resp = vertex_client.models.generate_content(model=model_name, contents=contents)
        try:
            return (resp.text or "").strip()
        except Exception:
            return ""
    except Exception:
        return ""


