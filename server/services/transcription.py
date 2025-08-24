"""
server/services/transcription.py

Centralized transcription helpers used by both the WebSocket segment flow and
the Settings modal /test_transcribe endpoint. This consolidates provider calls
so we have a single source of truth for retries, content construction, and
response parsing.
"""
from typing import Dict, Any, Optional, List

from server.state import app_state
from server.services.registry import is_enabled as service_enabled
from server.services.google_stt import recognize_segment as recognize_google_segment
from server.services.vertex_gemini import build_vertex_contents, extract_text_from_vertex_response
from server.services.vertex_langchain import is_available as lc_vertex_available, transcribe_segment_via_langchain
from server.services.gemini_api import extract_text_from_gemini_response


def _choose_mime_order(ext_or_mime: str) -> List[str]:
    s = (ext_or_mime or '').lower()
    if ('ogg' in s) or s.endswith('.ogg'):
        return ["audio/ogg", "audio/webm"]
    return ["audio/webm", "audio/ogg"]


async def transcribe_google(raw: bytes, ext_or_mime: str) -> str:
    if not (service_enabled("google") and app_state.speech_client is not None):
        return ""
    try:
        ext = "ogg" if ("ogg" in (ext_or_mime or "").lower()) else "webm"
        return await recognize_google_segment(app_state.speech_client, raw, ext)
    except Exception:
        return ""


def transcribe_vertex(raw: bytes, ext_or_mime: str) -> str:
    if not (service_enabled("vertex") and app_state.vertex_client is not None):
        return ""
    order = _choose_mime_order(ext_or_mime)
    try:
        if lc_vertex_available():
            for mt in order:
                text = transcribe_segment_via_langchain(app_state.vertex_client, app_state.vertex_model_name, raw, mt)
                if text:
                    return text
            return ""
        # Fallback to raw SDK call
        last_exc = None
        for mt in order:
            try:
                resp = app_state.vertex_client.models.generate_content(
                    model=app_state.vertex_model_name,
                    contents=build_vertex_contents(raw, mt)
                )
                return extract_text_from_vertex_response(resp)
            except Exception as e:
                last_exc = e
                continue
        if last_exc:
            raise last_exc
        return ""
    except Exception:
        return ""


def transcribe_gemini(raw: bytes, ext_or_mime: str) -> str:
    if not (service_enabled("gemini") and getattr(app_state, 'gemini_model', None) is not None):
        return ""
    order = _choose_mime_order(ext_or_mime)
    last_exc = None
    for mt in order:
        try:
            resp = app_state.gemini_model.generate_content([
                {"text": "Transcribe the spoken audio to plain text. Return only the transcript."},
                {"mime_type": mt, "data": raw}
            ])
            return extract_text_from_gemini_response(resp)
        except Exception as e:
            last_exc = e
            continue
    if last_exc:
        # Surface last exception string to help with debugging callers when desired
        return ""
    return ""


def transcribe_gemini_raise(raw: bytes, ext_or_mime: str) -> str:
    """Same as transcribe_gemini but raises the last provider exception if all attempts fail.

    Useful for WS path to surface real errors to logs and clients.
    """
    if not (service_enabled("gemini") and getattr(app_state, 'gemini_model', None) is not None):
        return ""
    order = _choose_mime_order(ext_or_mime)
    last_exc = None
    for mt in order:
        try:
            resp = app_state.gemini_model.generate_content([
                {"text": "Transcribe the spoken audio to plain text. Return only the transcript."},
                {"mime_type": mt, "data": raw}
            ])
            txt = extract_text_from_gemini_response(resp)
            return txt
        except Exception as e:
            last_exc = e
            continue
    if last_exc:
        raise last_exc
    return ""


async def transcribe_all(raw: bytes, mime: str = "") -> Dict[str, Any]:
    """Return a dict of provider -> transcript (or provider_error keys) for enabled services.

    Providers tried: google (async), vertex, gemini. Missing/disabled providers return nothing.
    """
    results: Dict[str, Any] = {}
    # Google (async)
    try:
        txt = await transcribe_google(raw, mime)
        if txt is not None:
            results["google"] = txt
    except Exception as e:
        results["google_error"] = str(e)
    # Vertex (sync)
    try:
        vtxt = transcribe_vertex(raw, mime)
        if vtxt is not None:
            results["vertex"] = vtxt
    except Exception as e:
        results["vertex_error"] = str(e)
    # Gemini (sync)
    try:
        gtxt = transcribe_gemini(raw, mime)
        if gtxt is not None:
            results["gemini"] = gtxt
    except Exception as e:
        results["gemini_error"] = str(e)
    # Translation (only when enabled)
    try:
        if getattr(app_state, 'enable_translation', False) and getattr(app_state, 'gemini_model', None) is not None:
            base_txt = results.get('google') or results.get('vertex') or results.get('gemini') or ''
            if base_txt:
                prompt = (app_state.translation_prompt or 'Translate the following text into the TARGET language.')
                lang = (app_state.translation_lang or 'en')
                resp = app_state.gemini_model.generate_content([
                    {"text": f"{prompt}\nTARGET: {lang}"},
                    {"text": base_txt}
                ])
                from server.services.gemini_api import extract_text_from_gemini_response as _extract
                results['translation'] = _extract(resp)
    except Exception as e:
        results['translation_error'] = str(e)
    return results


