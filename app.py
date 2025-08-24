import os
from dotenv import load_dotenv
from fasthtml.common import *
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket

# Fresh minimal app using FastHTML built-in websocket extension and inline UI

load_dotenv()

import sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

try:
    from google import genai as genai_sdk
    from google.genai import types as genai_types
except Exception:
    genai_sdk = None
    genai_types = None

app, rt = fast_app(exts='ws')

# Serve static for saved recordings only; UI is inline
_STATIC = os.path.join(_ROOT, "static")
os.makedirs(os.path.join(_STATIC, "recordings"), exist_ok=True)
try:
    app.mount("/static", StaticFiles(directory=_STATIC), name="static")
except Exception:
    pass


# --- Minimal provider: Gemini consumer API (optional) ---
class GeminiClient:
    def __init__(self, api_key: str, model_name: str = "gemini-2.5-flash") -> None:
        self._client = genai_sdk.Client(api_key=api_key) if genai_sdk else None
        self._model = model_name

    def transcribe(self, raw: bytes, mime_type: str) -> str:
        if not self._client:
            return ""
        try:
            parts = [
                "Transcribe the spoken audio to plain text. Return only the transcript.",
                genai_types.Part.from_bytes(raw, mime_type=mime_type) if genai_types else {"mime_type": mime_type, "data": raw},
            ]
            resp = self._client.models.generate_content(model=self._model, contents=parts)
            # Try new SDK candidates path first
            try:
                cands = getattr(resp, "candidates", None) or []
                if cands and getattr(cands[0], "content", None) and getattr(cands[0].content, "parts", None):
                    texts = [getattr(p, "text", "") for p in cands[0].content.parts]
                    text = " ".join([t.strip() for t in texts if isinstance(t, str) and t.strip()]).strip()
                    if text:
                        return text
            except Exception:
                pass
            # Legacy .text
            txt = getattr(resp, "text", None)
            if isinstance(txt, str) and txt.strip():
                return txt.strip()
            return ""
        except Exception as e:
            print(f"Gemini transcribe error: {e}")
            return ""


GEMINI: GeminiClient | None
try:
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    GEMINI = GeminiClient(key) if key and genai_sdk else None
    if GEMINI:
        print("Gemini client ready (consumer API)")
    else:
        print("Gemini client not configured; transcripts will be empty")
except Exception as e:
    print(f"Gemini init failed: {e}")
    GEMINI = None


@rt("/")
def index():
    # Delegate to modular routes; avoids second app/UI definition
    from server.routes import build_index as _build
    return _build()


@app.ws("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    import base64, asyncio
    from pathlib import Path
    session_ts = str(int(__import__('time').time()*1000))
    seg_dir = Path(_STATIC) / "recordings" / f"session_{session_ts}"
    seg_dir.mkdir(parents=True, exist_ok=True)

    try:
        while True:
            msg = await websocket.receive_json()
            mtype = msg.get("type") if isinstance(msg, dict) else None
            if mtype == "hello":
                await websocket.send_json({"type": "ready"})
                continue
            if mtype == "segment":
                try:
                    raw = base64.b64decode((msg.get("audio") or "").encode("utf-8"))
                except Exception:
                    raw = b""
                idx = int(msg.get("idx") or 0)
                mime = (msg.get("mime") or "audio/webm").lower()
                ext = "ogg" if "ogg" in mime else "webm"
                p = seg_dir / f"segment_{idx}.{ext}"
                try:
                    with open(p, "wb") as f:
                        f.write(raw)
                except Exception:
                    pass
                # send ack to render row
                start_ms = int(msg.get("start") or 0)
                end_ms = int(msg.get("end") or 0)
                rng = f"{_fmt_ms(start_ms)} – {_fmt_ms(end_ms)}" if start_ms and end_ms else ""
                await websocket.send_json({"type": "segment_saved", "idx": idx, "url": f"/static/recordings/session_{session_ts}/segment_{idx}.{ext}", "range": rng})
                # transcribe inline, sequentially
                text = ""
                if GEMINI and (msg.get("auto") is None or bool(msg.get("auto", True))):
                    try:
                        # try preferred container first, then fallback
                        order = ["audio/ogg", "audio/webm"] if ext == "ogg" else ["audio/webm", "audio/ogg"]
                        for mt in order:
                            text = GEMINI.transcribe(raw, mt)
                            if text:
                                break
                    except Exception as e:
                        text = ""
                        print(f"transcribe error idx={idx}: {e}")
                await websocket.send_json({"type": "transcript", "idx": idx, "text": text, "svc": "gemini"})
                continue
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass


def _fmt_ms(ms: int) -> str:
    try:
        if not ms:
            return "0:00"
        s = int(round(ms/1000))
        return f"{s//60}:{(s%60):02d}"
    except Exception:
        return ""


# Disabled minimal inline server; main app below will serve
# serve()

import os
from dotenv import load_dotenv
from fasthtml.common import *
from starlette.staticfiles import StaticFiles
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
from server.state import app_state, set_full_summary_prompt, set_translation_prompt, set_translation_lang
from server.routes import build_index, render_panel, render_segment_row, render_full_row, _render_segment_row
from server.ws import ws_handler
from server.services.registry import list_services as registry_list, set_service_enabled
from server.services.registry import is_enabled as service_enabled
from server.services.google_stt import recognize_segment as recognize_google_segment
from server.services.vertex_gemini import build_vertex_contents, extract_text_from_vertex_response
from server.services.vertex_langchain import is_available as lc_vertex_available, transcribe_segment_via_langchain
from server.services.gemini_api import extract_text_from_gemini_response
from server.sse_bus import stream as sse_stream
# inline helper for base64 decode (avoid import cycle)
def _b64_to_bytes(data_url_or_b64: str) -> bytes:
    import base64
    try:
        s = data_url_or_b64
        if s.startswith("data:") and "," in s:
            s = s.split(",",1)[1]
        # Normalize whitespace and padding
        s = s.strip().replace('\n','').replace('\r','')
        missing = (-len(s)) % 4
        if missing:
            s += "=" * missing
        try:
            return base64.b64decode(s)
        except Exception:
            return base64.urlsafe_b64decode(s)
    except Exception:
        return b""
from typing import Any, List, Dict
from starlette.responses import JSONResponse, HTMLResponse
import json
import os, base64, time

# --- Credentials Handling (START) ---
cred = ensure_google_credentials_from_env()
# --- Credentials Handling (END) ---

# Audio recording parameters (moved to config for reuse)
SEGMENT_MS = SEGMENT_MS_DEFAULT

# Include HTMX SSE extension for server-sent events
_HDRS = (Script(src="https://unpkg.com/htmx-ext-sse@2.2.3/sse.js"),)
app, rt = fast_app(exts='ws', hdrs=_HDRS) # WS for audio; SSE for UI updates
# Track active websockets for forced shutdown
try:
    if not hasattr(app.state, 'ws_clients'):
        app.state.ws_clients = set()
except Exception:
    pass
# Serve static from an absolute path to avoid CWD-related 404s
_STATIC_DIR = os.path.join(_ROOT, "static")
app.static_route_exts(prefix="/static", static_path=_STATIC_DIR) # Configure static files serving
# Fallback generic static mount to ensure uncommon extensions (e.g., .ogg) are served
try:
    app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")
except Exception:
    pass

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

@rt("/services_bulk", methods=["POST"])
def update_services_bulk(req: Any) -> Any:
    # Accept HTMX form with checkbox names; enable when present
    try:
        data = req.form()
        desired = {
            'aws': bool(data.get('aws')),
            'google': bool(data.get('google')),
            'vertex': bool(data.get('vertex')),
            'gemini': bool(data.get('gemini')),
        }
        for key, enabled in desired.items():
            try:
                set_service_enabled(key, enabled)
            except Exception:
                pass
        return HTMLResponse("<small style=\"color:#6f6\">Saved.</small>")
    except Exception:
        return HTMLResponse("<small style=\"color:#f66\">Save failed.</small>")

@rt("/settings_bulk", methods=["POST"])
def settings_bulk(
    aws: str = '', google: str = '', vertex: str = '', gemini: str = '',
    full_summary_prompt: str = '', translation_prompt: str = '', translation_lang: str = '',
    gemini_api_key: str = '', enable_summarization: str = '', enable_translation: str = ''
) -> Any:
    try:
        # Providers
        for key, val in [('aws', aws), ('google', google), ('vertex', vertex), ('gemini', gemini)]:
            try:
                set_service_enabled(key, bool(val))
            except Exception:
                pass
        # Prompts & language
        try:
            if isinstance(full_summary_prompt, str) and full_summary_prompt.strip():
                set_full_summary_prompt(full_summary_prompt.strip())
        except Exception:
            pass
        try:
            if isinstance(translation_prompt, str) and translation_prompt.strip():
                set_translation_prompt(translation_prompt.strip())
        except Exception:
            pass
        try:
            if isinstance(translation_lang, str) and translation_lang.strip():
                set_translation_lang(translation_lang.strip())
        except Exception:
            pass
        # Gemini API key
        try:
            if isinstance(gemini_api_key, str) and gemini_api_key.strip():
                ok = app_state.set_gemini_api_key(gemini_api_key.strip())
                if not ok:
                    return HTMLResponse("<small style=\"color:#f66\">Gemini key invalid or failed.</small>")
        except Exception:
            pass
        # Feature flags (checkbox present -> non-empty)
        try:
            app_state.enable_summarization = bool(enable_summarization)
        except Exception:
            pass
        try:
            app_state.enable_translation = bool(enable_translation)
        except Exception:
            pass
        return HTMLResponse("<small style=\"color:#6f6\">Settings saved.</small>")
    except Exception:
        return HTMLResponse("<small style=\"color:#f66\">Save failed.</small>")

@rt("/summary_prompt", methods=["POST"])
def update_summary_prompt(req: Any = None) -> Any:
    # HTMX form handler; returns a small confirmation HTML snippet
    try:
        data = req.form() if req is not None else {}
        val = (data.get("prompt") or "").strip()
        if not val:
            return HTMLResponse("<small style=\"color:#f66\">Prompt cannot be empty.</small>")
        set_full_summary_prompt(val)
        return HTMLResponse("<small style=\"color:#6f6\">Saved.</small>")
    except Exception:
        return HTMLResponse("<small style=\"color:#f66\">Save failed.</small>")

@rt("/translation_settings", methods=["POST"])
def update_translation_settings(req: Any = None) -> Any:
    # HTMX form handler
    try:
        data = req.form() if req is not None else {}
        prompt = (data.get("prompt") or "").strip()
        lang = (data.get("lang") or "").strip()
        if prompt:
            set_translation_prompt(prompt)
        if lang:
            set_translation_lang(lang)
        return HTMLResponse("<small style=\"color:#6f6\">Saved.</small>")
    except Exception:
        return HTMLResponse("<small style=\"color:#f66\">Save failed.</small>")

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


@app.ws("/ws_stream")
async def ws_stream(websocket: WebSocket):
    try:
        # Ensure handshake is accepted immediately
        try:
            await websocket.accept()
        except Exception:
            pass
        try:
            app.state.ws_clients.add(websocket)
        except Exception:
            pass
        await ws_handler(websocket)
    except Exception as e:
        print(f"Error in ws_handler: {e}")
    finally:
        try:
            app.state.ws_clients.discard(websocket)
        except Exception:
            pass

# Force-close any lingering websockets on shutdown
async def _close_all_ws():
    try:
        clients = list(getattr(app.state, 'ws_clients', set()))
        for ws in clients:
            try:
                await ws.close(code=1001)
            except Exception:
                pass
    except Exception:
        pass

try:
    app.add_event_handler('shutdown', _close_all_ws)
except Exception:
    pass

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
        try:
            import json as __dbg_json
            print("[render_full_row_route] incoming record.fullAppend:", __dbg_json.dumps(rec.get("fullAppend", {}), ensure_ascii=False))
            print("[render_full_row_route] incoming record.transcripts keys:", list((rec.get("transcripts", {}) or {}).keys()))
        except Exception:
            pass
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
        # Compute summaries using Gemini when enabled and only after Stop
        from server.services.gemini_api import extract_text_from_gemini_response as _extract
        summaries = {}
        if bool(getattr(app_state, 'enable_summarization', True)) and getattr(app_state, 'gemini_model', None) is not None and bool(rec.get('stopTs')):
            for s in services:
                key = s["key"]
                full_text = ((rec.get("fullAppend", {}) or {}).get(key, ""))
                # Fallback to joined per-segment transcripts if fullAppend is empty
                if not full_text:
                    try:
                        arr = ((rec.get("transcripts", {}) or {}).get(key, []) or [])
                        if isinstance(arr, list):
                            full_text = " ".join([str(x) for x in arr if x])
                    except Exception:
                        full_text = ""
                if not full_text:
                    summaries[key] = ""
                    continue
                try:
                    prompt = (app_state.full_summary_prompt or "Summarize the transcription.")
                    resp = app_state.gemini_model.generate_content([
                        {"text": prompt},
                        {"text": full_text}
                    ])
                    summaries[key] = _extract(resp) or ""
                except Exception:
                    summaries[key] = full_text
        try:
            print("[render_full_row_route] summaries keys:", list(summaries.keys()))
            for k, v in summaries.items():
                print(f"[render_full_row_route] summary[{k}] =", (v or "").replace("\n"," ")[:200])
        except Exception:
            pass
        # First column: leave out download in this simplified table (kept in panel meta)
        cells = []
        for s in services:
            key = s["key"]
            show_summary = bool(getattr(app_state, 'enable_summarization', True)) and bool(rec.get('stopTs'))
            if show_summary:
                val = summaries.get(key)
                if val is None:
                    val = ((rec.get("fullAppend", {}) or {}).get(key, ""))
                    if not val:
                        try:
                            arr = ((rec.get("transcripts", {}) or {}).get(key, []) or [])
                            if isinstance(arr, list):
                                val = " ".join([str(x) for x in arr if x])
                        except Exception:
                            val = ""
            else:
                val = ((rec.get("fullAppend", {}) or {}).get(key, ""))
                if not val:
                    try:
                        arr = ((rec.get("transcripts", {}) or {}).get(key, []) or [])
                        if isinstance(arr, list):
                            val = " ".join([str(x) for x in arr if x])
                    except Exception:
                        val = ""
            cells.append(Td(val, data_svc=key))
        row = Tr(*cells, id=f"fullrow-{rec.get('id','')}")
        table = Table(
            Thead(header),
            Tbody(row),
            border="0", cellpadding="4", cellspacing="0", style="border-collapse:collapse; border:0; width:100%"
        )
        return HTMLResponse(str(table))
    except Exception:
        return HTMLResponse("<table></table>")

@rt("/events")
async def sse_events() -> Any:
    from starlette.responses import StreamingResponse
    return StreamingResponse(sse_stream(), media_type="text/event-stream")

@rt("/test_transcribe", methods=["POST"])
async def test_transcribe(audio_b64: str = "", mime: str = "", services: str = "") -> Any:
    from starlette.responses import JSONResponse
    try:
        print(f"HTTP /test_transcribe: mime={mime} services={services}")
        raw = _b64_to_bytes(audio_b64)
        if not raw:
            print("HTTP /test_transcribe: no_audio")
            return JSONResponse({"ok": False, "error": "no_audio"})
        # Delegate to centralized transcription helper and optionally filter results
        from server.services.transcription import transcribe_all
        full = await transcribe_all(raw, mime)
        requested = set([s.strip() for s in (services or "").split(",") if s.strip()])
        if requested:
            filtered = { k: v for k, v in full.items() if k.split('_')[0] in requested }
        else:
            filtered = full
        print(f"HTTP /test_transcribe: results_keys={list(filtered.keys())}")
        return JSONResponse({"ok": True, "results": filtered})
    except Exception as e:
        from starlette.responses import JSONResponse
        return JSONResponse({"ok": False, "error": f"server_error: {e}"})


@rt("/segment_upload", methods=["POST"])
async def segment_upload(recording_id: str = '', audio_b64: str = '', mime: str = '', duration_ms: int = 10000, id: int = 0, idx: int = 0, ts: int = 0) -> Any:
    try:
        rec_id = str(recording_id or '')
        if not rec_id:
            rec_id = str(int(time.time()*1000))
        try:
            seg_bytes = base64.b64decode((audio_b64 or '').encode('utf-8'))
        except Exception:
            seg_bytes = b''
        client_mime = (mime or '').lower()
        ext = 'ogg' if ('ogg' in client_mime) else 'webm'
        root = os.path.join(os.path.abspath('static'), 'recordings')
        os.makedirs(root, exist_ok=True)
        # Sanitize rec_id for filesystem
        safe_rec_id = ''.join([c if c.isalnum() or c in ('-', '_') else '_' for c in rec_id])
        session_dir = os.path.join(root, f'session_{safe_rec_id}')
        os.makedirs(session_dir, exist_ok=True)
        seg_index = int(idx or 0)
        seg_path = os.path.join(session_dir, f'segment_{seg_index}.{ext}')
        with open(seg_path, 'wb') as f:
            f.write(seg_bytes)
        seg_url = f"/static/recordings/session_{safe_rec_id}/segment_{seg_index}.{ext}"
        try:
            print(f"HTTP segment_upload: saved idx={seg_index} url={seg_url} size={len(seg_bytes)} mime={client_mime}")
        except Exception:
            pass
        saved = {
            "idx": seg_index,
            "url": seg_url,
            "id": id,
            "ts": ts or int(time.time()*1000),
            "ext": ext,
            "mime": client_mime,
            "size": len(seg_bytes)
        }
        # Dispatch providers sequentially (simple) and collect results
        results = {}
        errors = {}
        try:
            if service_enabled('google') and app_state.speech_client is not None:
                try:
                    txt = await recognize_google_segment(app_state.speech_client, seg_bytes, ext)
                except Exception:
                    import traceback; errors['google'] = traceback.format_exc(); txt = ''
                results['google'] = txt
                try: print(f"HTTP segment_upload: google idx={seg_index} len={len(txt or '')}")
                except Exception: pass
        except Exception:
            pass
        try:
            if service_enabled('vertex') and app_state.vertex_client is not None:
                txt = ''
                try:
                    order = ['audio/ogg','audio/webm'] if ext == 'ogg' else ['audio/webm','audio/ogg']
                    if lc_vertex_available():
                        for mt in order:
                            txt = transcribe_segment_via_langchain(app_state.vertex_client, app_state.vertex_model_name, seg_bytes, mt)
                            if txt:
                                break
                    else:
                        resp = None
                        last_exc = None
                        for mt in order:
                            try:
                                resp = app_state.vertex_client.models.generate_content(
                                    model=app_state.vertex_model_name,
                                    contents=build_vertex_contents(seg_bytes, mt)
                                )
                                break
                            except Exception as ie:
                                last_exc = ie
                                continue
                        if resp is None and last_exc:
                            raise last_exc
                        txt = extract_text_from_vertex_response(resp)
                except Exception:
                    import traceback; errors['vertex'] = traceback.format_exc(); txt = ''
                results['vertex'] = txt
                try: print(f"HTTP segment_upload: vertex idx={seg_index} len={len(txt or '')}")
                except Exception: pass
        except Exception:
            pass
        try:
            if service_enabled('gemini') and getattr(app_state, 'gemini_model', None) is not None:
                txt = ''
                try:
                    order = ['audio/ogg','audio/webm'] if ext == 'ogg' else ['audio/webm','audio/ogg']
                    resp = None
                    last_exc = None
                    for mt in order:
                        try:
                            resp = app_state.gemini_model.generate_content([
                                {"text": "Transcribe the spoken audio to plain text. Return only the transcript."},
                                {"mime_type": mt, "data": seg_bytes}
                            ])
                            break
                        except Exception as ie:
                            last_exc = ie
                            continue
                    if resp is None and last_exc:
                        raise last_exc
                    txt = extract_text_from_gemini_response(resp)
                except Exception:
                    import traceback; errors['gemini'] = traceback.format_exc(); txt = ''
                results['gemini'] = txt
                try: print(f"HTTP segment_upload: gemini idx={seg_index} len={len(txt or '')}")
                except Exception: pass
        except Exception:
            pass
        # AWS placeholder
        try:
            if service_enabled('aws'):
                from server.services import aws_transcribe
                txt = ''
                try:
                    txt = aws_transcribe.recognize_segment_placeholder(seg_bytes, media_format=("ogg" if ext=="ogg" else "webm"))
                except Exception:
                    import traceback; errors['aws'] = traceback.format_exc(); txt = ''
                results['aws'] = txt
                try: print(f"HTTP segment_upload: aws idx={seg_index} len={len(txt or '')}")
                except Exception: pass
        except Exception:
            pass
        # Gemini translation per-segment using saved translation prompt/lang (only when enabled)
        try:
            if getattr(app_state, 'enable_translation', False) and getattr(app_state, 'gemini_model', None) is not None:
                tr_txt = ''
                try:
                    # Choose a base transcript to translate
                    base_txt = results.get('google') or results.get('vertex') or results.get('gemini') or ''
                    if base_txt:
                        prompt = (app_state.translation_prompt or 'Translate the following text into the TARGET language.')
                        lang = (app_state.translation_lang or 'en')
                        resp = app_state.gemini_model.generate_content([
                            {"text": f"{prompt}\nTARGET: {lang}"},
                            {"text": base_txt}
                        ])
                        tr_txt = extract_text_from_gemini_response(resp)
                except Exception:
                    import traceback; errors['translation'] = traceback.format_exc(); tr_txt = ''
                results['translation'] = tr_txt
        except Exception:
            pass
        return JSONResponse({"ok": True, "saved": saved, "results": results, "errors": errors})
    except Exception:
        import traceback
        return JSONResponse({"ok": False, "saved": None, "results": {}, "errors": {"fatal": traceback.format_exc()}})


@rt("/export_full", methods=["POST"])
async def export_full(recording_id: str = '') -> Any:
    try:
        rec_id = str(recording_id or '')
        if not rec_id:
            return JSONResponse({"ok": False, "error": "missing_recording_id"})
        safe_rec_id = ''.join([c if c.isalnum() or c in ('-', '_') else '_' for c in rec_id])
        root = os.path.join(os.path.abspath('static'), 'recordings')
        session_dir = os.path.join(root, f'session_{safe_rec_id}')
        if not os.path.isdir(session_dir):
            return JSONResponse({"ok": False, "error": "session_not_found"})
        # Try ffmpeg remux first
        try:
            import subprocess, shlex
            # Build concat list file
            list_path = os.path.join(session_dir, 'list.txt')
            with open(list_path, 'w', encoding='utf-8') as lf:
                for name in sorted(os.listdir(session_dir)):
                    if name.startswith('segment_') and (name.endswith('.ogg') or name.endswith('.webm')):
                        lf.write(f"file '{os.path.join(session_dir, name).replace('\\\\','/').replace('\\','/')}'\n")
            # Decide container by first segment extension
            first = next((n for n in sorted(os.listdir(session_dir)) if n.startswith('segment_') and (n.endswith('.ogg') or n.endswith('.webm'))), None)
            if not first:
                raise RuntimeError('no_segments')
            out_ext = '.ogg' if first.endswith('.ogg') else '.webm'
            out_path = os.path.join(root, f'session_{safe_rec_id}_full{out_ext}')
            # Try stream copy
            cmd = f"ffmpeg -y -f concat -safe 0 -i {shlex.quote(list_path)} -c copy {shlex.quote(out_path)}"
            r = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            if r.returncode != 0:
                # Fallback to re-encode Opus for OGG; for WebM use libopus as well
                cmd2 = f"ffmpeg -y -f concat -safe 0 -i {shlex.quote(list_path)} -c:a libopus -b:a 64k {shlex.quote(out_path)}"
                r2 = subprocess.run(cmd2, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
                if r2.returncode != 0:
                    raise RuntimeError('ffmpeg_failed')
            url = f"/static/recordings/session_{safe_rec_id}_full{out_ext}"
            return JSONResponse({"ok": True, "url": url, "method": "ffmpeg"})
        except Exception:
            # ZIP fallback
            import shutil
            zip_path = os.path.join(root, f'session_{safe_rec_id}_segments.zip')
            try:
                if os.path.isfile(zip_path):
                    os.remove(zip_path)
            except Exception:
                pass
            shutil.make_archive(zip_path[:-4], 'zip', session_dir)
            url = f"/static/recordings/session_{safe_rec_id}_segments.zip"
            return JSONResponse({"ok": True, "url": url, "method": "zip"})
    except Exception:
        import traceback
        return JSONResponse({"ok": False, "error": traceback.format_exc()})

# Wire async remux routes here to ensure 'rt' is available
from server.routes import export_full_async as _export_full_async_impl, export_status as _export_status_impl

@rt("/export_full_async", methods=["POST"])
def export_full_async_route(recording_id: str = '') -> Any:
    return _export_full_async_impl(recording_id=recording_id)

@rt("/export_status", methods=["GET"])
def export_status_route(job_id: str = '') -> Any:
    return _export_status_impl(job_id=job_id)

if __name__ == "__main__":
    try:
        import uvicorn
        # Explicit host/port; disable reload to prevent double-start
        uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5001)), reload=False, log_level="info")
    except Exception:
        # Fallback to framework serve if uvicorn is unavailable
        serve()

