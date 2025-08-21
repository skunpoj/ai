import os
from dotenv import load_dotenv
from fasthtml.common import *
from starlette.websockets import WebSocket, WebSocketDisconnect # Explicitly import WebSocket classes from starlette

# Transcription is now controlled at runtime via Start/Stop Transcribe
ENABLE_GOOGLE_SPEECH = True

# Load .env before reading any credential env vars
load_dotenv()

import sys
from pathlib import Path
# Ensure project root is on sys.path so 'utils' and 'server' are importable in all environments
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from utils.credentials import ensure_google_credentials_from_env
from server.config import CHUNK_MS, SEGMENT_MS_DEFAULT
from server.state import app_state
from server.routes import build_index, render_panel, render_segment_row, render_full_row, _render_segment_row
from server.ws import ws_handler
from server.services.registry import list_services as registry_list, set_service_enabled
from server.sse_bus import stream as sse_stream
from server.routes import _b64_to_bytes
from typing import Any, List, Dict
from starlette.responses import JSONResponse, HTMLResponse
import json

# --- Credentials Handling (START) ---
cred = ensure_google_credentials_from_env()
# --- Credentials Handling (END) ---

# Audio recording parameters (moved to config for reuse)
SEGMENT_MS = SEGMENT_MS_DEFAULT

app, rt = fast_app(exts='ws') # Ensure 'exts='ws'' is present
# Serve static from an absolute path to avoid CWD-related 404s
_STATIC_DIR = os.path.join(_ROOT, "static")
app.static_route_exts(prefix="/static", static_path=_STATIC_DIR) # Configure static files serving

print(f"Current working directory: {os.getcwd()}")
print(f"Absolute path to static directory: {_STATIC_DIR}")

# Initialize shared clients/state for modular services (Google STT, Gemini API, Vertex)
try:
    app_state.init_google_speech()
    app_state.init_gemini_api()
    app_state.init_vertex()
except Exception as e:
    print(f"Error initializing app_state: {e}")

"""
app.py: Application bootstrap
- Loads environment and credentials
- Initializes shared state (Google STT, Gemini API, Vertex) via server/state.py
- Wires HTTP routes and WebSocket endpoint

All provider client initializations occur in server/state.py to avoid multiple
sources of truth and to simplify testing and future maintenance.
"""

@rt("/")
def index() -> Any:
    """Render the index page via server/routes.build_index()."""
    return build_index()

@rt("/services")
def list_services() -> Any:
    """Return JSON array of service descriptors for dynamic frontend columns."""
    return JSONResponse(registry_list())

@rt("/services", methods=["POST"])
def update_service(req: Any) -> Any:
    """Enable/disable services dynamically at runtime.

    Request JSON body:
      { key: string, enabled: boolean }

    Returns updated list of services.
    """
    try:
        data = req.json()
        key = data.get("key")
        enabled = bool(data.get("enabled", True))
        return JSONResponse(set_service_enabled(key, enabled))
    except Exception:
        return JSONResponse(registry_list())

@rt("/gemini_api_key", methods=["POST"])
def set_gemini_key(api_key: str = '') -> Any:
    # FastHTML will map form/JSON fields into function args when named; avoid requiring req
    try:
        key_val = (api_key or '').strip()
        if not key_val:
            return JSONResponse({"ok": False, "error": "Missing api_key"})
        ok = app_state.set_gemini_api_key(key_val)
        if ok:
            try:
                set_service_enabled("gemini", True)
            except Exception:
                pass
        return JSONResponse({
            "ok": ok,
            "masked": app_state.gemini_api_key_masked,
            "enabled": ok
        })
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"server_error: {e}"})


@app.ws("/ws_stream") # Dedicated WebSocket endpoint for audio streaming
async def ws_test(websocket: WebSocket):
    print("Backend: ENTERED /ws_stream function (audio streaming).") # CRITICAL TEST LOG
    try:
        await ws_handler(websocket)
    except Exception as e:
        print(f"Error in ws_handler: {e}")

# Register HTMX partial endpoints here to avoid decorator dependency on 'rt' in server.routes
@rt("/render/panel", methods=["GET","POST"])
def render_panel_route(req: Any) -> Any:
    return render_panel(req)

@rt("/render/segment_row", methods=["GET","POST"])
def render_segment_row_route(record: str = '', idx: int = 0) -> Any:
    try:
        rec = record if isinstance(record, dict) else (json.loads(record) if isinstance(record, str) and record else {})
    except Exception:
        rec = {}
    try:
        services = [s for s in registry_list() if s.get("enabled")]
        row = _render_segment_row(rec, services, int(idx) if idx is not None else 0)
        return HTMLResponse(str(row))
    except Exception:
        return HTMLResponse("<tr></tr>")

@rt("/render/full_row", methods=["GET","POST"])
def render_full_row_route(record: str = '') -> Any:
    try:
        rec = record if isinstance(record, dict) else (json.loads(record) if isinstance(record, str) and record else {})
    except Exception:
        rec = {}
    try:
        services = [s for s in registry_list() if s.get("enabled")]
        header = Tr(*[Th(s["label"]) for s in services])
        row = Tr(*[Td(((rec.get("fullAppend", {}) or {}).get(s["key"], ""))) for s in services], id=f"fullrow-{rec.get('id','')}")
        table = Table(THead(header), TBody(row), border="1", cellpadding="4", cellspacing="0", style="border-collapse:collapse; width:100%")
        return HTMLResponse(str(table))
    except Exception:
        return HTMLResponse("<table></table>")

@rt("/events")
async def sse_events() -> Any:
    from starlette.responses import StreamingResponse
    return StreamingResponse(sse_stream(), media_type="text/event-stream")

@rt("/test_transcribe", methods=["POST"])
async def test_transcribe(audio_b64: str = "", mime: str = "") -> Any:
    from starlette.responses import JSONResponse
    try:
        raw = _b64_to_bytes(audio_b64)
        if not raw:
            return JSONResponse({"ok": False, "error": "no_audio"})
        # very small helper to invoke enabled providers synchronously for a short clip
        results = {}
        try:
            from server.services.registry import is_enabled as svc_enabled
            from server.state import app_state
            from server.services.google_stt import recognize_segment as recognize_google_segment
            from server.services.vertex_gemini import build_vertex_contents, extract_text_from_vertex_response
            from server.services.vertex_langchain import is_available as lc_vertex_available, transcribe_segment_via_langchain
            from server.services.gemini_api import extract_text_from_gemini_response
            # Google
            if svc_enabled("google") and app_state.speech_client is not None:
                try:
                    results["google"] = await recognize_google_segment(app_state.speech_client, raw, ("ogg" if "ogg" in (mime or "").lower() else "webm"))
                except Exception as e:
                    results["google_error"] = str(e)
            # Vertex
            if svc_enabled("vertex") and app_state.vertex_client is not None:
                try:
                    order = ["audio/ogg", "audio/webm"] if ("ogg" in (mime or "").lower()) else ["audio/webm", "audio/ogg"]
                    text = ""
                    if lc_vertex_available():
                        for mt in order:
                            text = transcribe_segment_via_langchain(app_state.vertex_client, app_state.vertex_model_name, raw, mt)
                            if text: break
                    else:
                        resp = None
                        last_exc = None
                        for mt in order:
                            try:
                                resp = app_state.vertex_client.models.generate_content(model=app_state.vertex_model_name, contents=build_vertex_contents(raw, mt))
                                break
                            except Exception as ie:
                                last_exc = ie
                                continue
                        if resp is None and last_exc: raise last_exc
                        text = extract_text_from_vertex_response(resp)
                    results["vertex"] = text
                except Exception as e:
                    results["vertex_error"] = str(e)
            # Gemini API
            if svc_enabled("gemini") and app_state.gemini_model is not None:
                try:
                    order = ["audio/ogg", "audio/webm"] if ("ogg" in (mime or "").lower()) else ["audio/webm", "audio/ogg"]
                    resp = None
                    last_exc = None
                    for mt in order:
                        try:
                            resp = app_state.gemini_model.generate_content([
                                {"text": "Transcribe the spoken audio to plain text. Return only the transcript."},
                                {"mime_type": mt, "data": raw}
                            ])
                            break
                        except Exception as ie:
                            last_exc = ie
                            continue
                    if resp is None and last_exc: raise last_exc
                    results["gemini"] = extract_text_from_gemini_response(resp)
                except Exception as e:
                    results["gemini_error"] = str(e)
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"server_error: {e}"})
        return JSONResponse({"ok": True, "results": results})
    except Exception as e:
        from starlette.responses import JSONResponse
        return JSONResponse({"ok": False, "error": f"server_error: {e}"})

serve()

