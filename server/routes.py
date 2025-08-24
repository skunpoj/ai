"""
server/routes.py

Route builders for the FastHTML app. The index view composes the page
and injects config and masked auth info for the frontend.
"""
import json
from typing import List, Dict, Any
from fasthtml.common import *
from server.config import CHUNK_MS, SEGMENT_MS_DEFAULT
from server.views.settings import build_settings_modal
from server.state import app_state
from server.services.registry import list_services as registry_list, set_service_enabled
from starlette.responses import HTMLResponse
from starlette.responses import JSONResponse
import hashlib
import json as _json
import threading
import subprocess
import shlex
import os
import time
from server.services.gemini_api import extract_text_from_gemini_response


def build_segment_modal() -> Any:
    return build_settings_modal()


def build_index():
    title = "Live Transcription & Translation"
    return Title(title), \
        Link(rel="icon", href="/static/favicon.ico"), \
        Style("""
html, body { margin:0; padding:0; }
body { background:transparent; }
* { border:0 !important; }
table { border-collapse:collapse; border-spacing:0; width:100%; }
th, td { padding:0; }
hr { display:none; }
/* Hide segment metadata (download + size) when toggled off */
.hide-segmeta tbody[id^="segtbody-"] small[id^="segsize-"],
.hide-segmeta tbody[id^="segtbody-"] a[download][data-load-full],
.hide-segmeta small[data-load-full],
.hide-segmeta a[download][data-load-full] {
  display: none !important;
}
/* Hide combined Time column when toggled off (separate toggle) */
.hide-timecol th[data-col="time"],
.hide-timecol td[data-col="time"] {
  display: none !important;
}
        """), \
        Div(
            Div(
                Button("Start Record", id="startRecording"),
                Button("Stop Record", id="stopRecording", disabled=True),
                Button("Settings", id="openSegmentModal"),
            # ),
            # Div(
                Input(type="checkbox", id="autoTranscribeToggle", checked=True),
                Label("Auto Transcribe", _for="autoTranscribeToggle"),
                Input(type="checkbox", id="toggleSegMetaToolbar", checked=True),
                Label("Download", _for="toggleSegMetaToolbar"),
                Input(type="checkbox", id="toggleTimeColToolbar", checked=True),
                Label("Time", _for="toggleTimeColToolbar", checked=True),
                Button("Start Transcribe", id="startTranscribe", disabled=True),
                Button("Stop Transcribe", id="stopTranscribe", disabled=True),
                # YouTube URL transcription controls
                Input(type="text", id="ytUrl", placeholder="YouTube URL", style="min-width:240px;margin-left:8px"),
                Button("Transcribe YouTube", id="transcribeYoutubeBtn"),
            ),
            # Removed redundant transcription status line
            Div(id="liveTranscriptContainer"),
            build_segment_modal(),
            Div(
                H2("Recordings"),
                Div(id="recordTabs", style="display:flex;gap:0;flex-wrap:wrap;margin:0 0 8px 0"),
                Div(id="recordPanels")
            ),
            # HTMX is bundled by FastHTML; no need to load separately
            Script(f"let CHUNK_MS = {CHUNK_MS};"),
            Script(f"let SEGMENT_MS = {SEGMENT_MS_DEFAULT};"),
            Script("window.SEGMENT_MS = SEGMENT_MS;"),
            # Ensure MarkedJS is available globally for client-side markdown rendering
            Script(src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"),
            Script(
                f"window.GOOGLE_AUTH_INFO = {json.dumps(app_state.auth_info or {})};\n"
                f"window.GOOGLE_AUTH_READY = {( 'true' if (app_state.speech_client and app_state.streaming_config) else 'false' )};\n"
                "console.log('Frontend: Google auth on load:', { ready: window.GOOGLE_AUTH_READY, info: window.GOOGLE_AUTH_INFO });\n"
                "try { const cg = document.getElementById('cred_google'); if (cg) { const i = window.GOOGLE_AUTH_INFO||{}; cg.textContent = `Google: ${window.GOOGLE_AUTH_READY ? 'ready' : 'not ready'}${i.project_id ? ' · ' + i.project_id : ''}`; } } catch(_) {}\n"
                "try { const cv = document.getElementById('cred_vertex'); if (cv) { const i = window.GOOGLE_AUTH_INFO||{}; cv.textContent = `Vertex: ${window.GOOGLE_AUTH_READY ? 'ready' : 'not ready'}${i.project_id ? ' · ' + i.project_id : ''}`; } } catch(_) {}"
            ),
            Script(
                f"window.APP_FLAGS = window.APP_FLAGS || {{}}; window.APP_FLAGS.enable_translation = { 'true' if getattr(app_state, 'enable_translation', False) else 'false' };"
            ),
            # New modular frontend controller replaces legacy main.js
            Script(src="/static/app/app.js", type="module")
        )


def services_json() -> List[Dict[str, Any]]:
    """Return current services from registry; frontend adapts columns dynamically."""
    return registry_list()


# --- Async remux job management (in-memory) ---
_remux_jobs: Dict[str, Dict[str, Any]] = {}


def _safe_id(recording_id: str) -> str:
    return ''.join([c if c.isalnum() or c in ('-', '_') else '_' for c in str(recording_id or '')])


def _run_ffmpeg_concat(session_dir: str, out_path: str) -> None:
    list_path = os.path.join(session_dir, 'list.txt')
    with open(list_path, 'w', encoding='utf-8') as lf:
        for name in sorted(os.listdir(session_dir)):
            if name.startswith('segment_') and (name.endswith('.ogg') or name.endswith('.webm')):
                p = os.path.join(session_dir, name)
                p_posix = p.replace('\\\\','/').replace('\\','/')
                lf.write(f"file '{p_posix}'\n")
    cmd = f"ffmpeg -y -f concat -safe 0 -i {shlex.quote(list_path)} -c copy {shlex.quote(out_path)}"
    r = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if r.returncode != 0:
        cmd2 = f"ffmpeg -y -f concat -safe 0 -i {shlex.quote(list_path)} -c:a libopus -b:a 64k {shlex.quote(out_path)}"
        r2 = subprocess.run(cmd2, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
        if r2.returncode != 0:
            raise RuntimeError('ffmpeg_failed')


def _start_remux_job(recording_id: str) -> str:
    job_id = f"remux_{int(time.time()*1000)}_{os.getpid()}"
    root = os.path.join(os.path.abspath('static'), 'recordings')
    safe_rec_id = _safe_id(recording_id)
    session_dir = os.path.join(root, f'session_{safe_rec_id}')
    first = next((n for n in sorted(os.listdir(session_dir)) if n.startswith('segment_') and (n.endswith('.ogg') or n.endswith('.webm'))), None)
    if not first:
        raise RuntimeError('no_segments')
    out_ext = '.ogg' if first.endswith('.ogg') else '.webm'
    out_path = os.path.join(root, f'session_{safe_rec_id}_full{out_ext}')
    _remux_jobs[job_id] = {"status": "queued", "url": None, "error": None}

    def worker():
        try:
            _remux_jobs[job_id]["status"] = "running"
            _run_ffmpeg_concat(session_dir, out_path)
            url = f"/static/recordings/session_{safe_rec_id}_full{out_ext}"
            _remux_jobs[job_id]["status"] = "done"
            _remux_jobs[job_id]["url"] = url
        except Exception as e:
            _remux_jobs[job_id]["status"] = "error"
            _remux_jobs[job_id]["error"] = str(e)

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    return job_id


def export_full_async(recording_id: str = '') -> Any:
    try:
        if not recording_id:
            return JSONResponse({"ok": False, "error": "missing_recording_id"})
        job_id = _start_remux_job(recording_id)
        return JSONResponse({"ok": True, "job_id": job_id})
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"server_error: {e}"})


def export_status(job_id: str = '') -> Any:
    try:
        job = _remux_jobs.get(job_id)
        if not job:
            return JSONResponse({"ok": False, "error": "job_not_found"})
        return JSONResponse({"ok": True, **job})
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"server_error: {e}"})


def build_panel_html(record: Dict[str, Any]) -> str:
    """Build the HTML for the panel given a record dict."""
    services = [s for s in services_json() if s.get("enabled")]

    def _td(txt: str) -> Any:
        return Td(txt)

    # Build top meta table to ensure consistent left padding with segment rows
    # Show player only for server-side full file, not local client preview
    src_url = record.get("serverUrl")
    player_bits: List[Any] = []
    if src_url:
        try:
            mt = "audio/ogg" if (str(src_url).lower().endswith(".ogg") or "/ogg" in str(src_url).lower()) else "audio/webm"
        except Exception:
            mt = "audio/webm"
        player_bits.append(Audio(Source(src=src_url, type=mt), controls=True))
        try:
            if record.get("serverUrl"):
                player_bits.append(Space(" "))
                player_bits.append(A("📥", href=record.get("serverUrl"), download=True, title="Download", **{"data-load-full": record.get("serverUrl")}, style="cursor:pointer;text-decoration:none"))
        except Exception:
            pass
    size_val = 0
    try:
        size_val = int(record.get("serverSizeBytes") or record.get("clientSizeBytes") or 0)
    except Exception:
        size_val = 0
    if size_val > 0:
        try:
            human = f"({int(size_val/1024)} KB)" if size_val >= 1024 else f"({size_val} B)"
            url = record.get("serverUrl") or src_url or ""
            player_bits.append(Space())
            player_bits.append(Small(human, **{"data-load-full": url}, style="cursor:pointer"))
        except Exception:
            pass
    dur_ms = record.get("durationMs") or 0
    dur_s = int(dur_ms/1000) if isinstance(dur_ms, int) else 0
    hdr = Div(
        (f"Start: {_fmt_time(record.get('startTs'))} · End: {_fmt_time(record.get('stopTs'))} · Duration: {dur_s}s" if record.get("startTs") and record.get("stopTs") else ""),
        style="margin-bottom:8px"
    )
    player_div = Div(*player_bits, style="margin-bottom:8px", id=f"recordmeta-{record.get('id','')}")
    # Align header and playback with segment playback column by inserting three lead cells
    meta_table = Table(
        TBody(
            Tr(
                Td("", style="padding:0"),
                Td("", style="padding:0"),
                Td("", style="padding:0"),
                # Td(H3("Full Record", style="margin:0;padding:0"), style="padding:0")
            ),
            Tr(
                Td("", style="padding:0"),
                Td("", style="padding:0"),
                Td("", style="padding:0"),
                Td(hdr, style="padding:0")
            ),
        ),
        border="0",
        cellpadding="0",
        cellspacing="0",
        style="border-collapse:collapse; border-spacing:0; border:0; width:100%",
    )

    # Provider table (one column per enabled service); live text filled via WS
    # Add Translation column header at end. Use 'marked' class for client-side markdown rendering.
    full_header = Tr(*[Th(s["label"], style="border:0;padding:0") for s in services], Th("Translation", style="border:0;padding:0"))
    full_cells: List[Any] = [Td(((record.get("fullAppend", {}) or {}).get(s["key"], "")), data_svc=s["key"], cls='marked') for s in services]
    # Placeholder translation cell for full row (can be empty or computed later)
    full_cells.append(Td(((record.get("fullAppend", {}) or {}).get("translation", "")), data_svc="translation"))
    provider_table = Table(
        THead(full_header),
        TBody(Tr(*full_cells, id=f"fullrow-{record.get('id','')}") ),
        border="0",
        cellpadding="0",
        cellspacing="0",
        style="border-collapse:collapse; border-spacing:0; border:0; width:100%",
    )
    full_table = Div(
        provider_table,
        id=f"fulltable-{record.get('id','')}",
        hx_post="/render/full_row",
        hx_trigger="load, refresh-full",
        hx_target="this",
        hx_swap="innerHTML",
        hx_vals=json.dumps({"record": record})
    )

    # Segments table
    seg_header = Tr(
        Th("Time", style="border:0;padding:0", data_col="time"),
        *[Th(s["label"], style="border:0;padding:0") for s in services],
        Th("Translation", style="border:0;padding:0"),
        Th("Playback", style="border:0;padding:0")
    )
    seg_rows: List[Any] = []
    segments: List[Dict[str, Any]] = record.get("segments", []) or []
    transcripts: Dict[str, List[str]] = record.get("transcripts", {}) or {}
    # Determine max rows across all providers
    # Render only present segments in descending order; cell text filled by client
    present_idx = [i for i in range(len(segments)) if i < len(segments) and segments[i]]
    present_idx.sort(reverse=True)
    for i in present_idx:
        seg_rows.append(_render_segment_row(record, services, i))
    seg_table = Table(
        THead(seg_header),
        TBody(*seg_rows, id=f"segtbody-{record.get('id','')}") ,
        border="0",
        cellpadding="0",
        cellspacing="0",
        style="border-collapse:collapse; border-spacing:0; border:0; width:100%",
        id=f"segtable-{record.get('id','')}"
    )

    panel = Div(
        full_table,
        Div(
            seg_table,
            style="margin-top:12px")
    )
    return str(panel)


def render_panel(req) -> Any:
    """Render a recording panel (full-record + segments) as an HTMX partial.

    Accepts either JSON or form body with key 'record'.
    """
    try:
        try:
            data = req.json()
        except Exception:
            data = req.form()
        raw = data.get("record", {})
        record: Dict[str, Any] = raw if isinstance(raw, dict) else (_json.loads(raw) if isinstance(raw, str) else {})
    except Exception:
        record = {}
    try:
        html = build_panel_html(record)
        return HTMLResponse(html)
    except Exception:
        # Never 400; return empty panel so client can continue
        return HTMLResponse("")


def _fmt_time(ts: Any) -> str:
    try:
        import datetime
        return datetime.datetime.fromtimestamp(int(ts)/1000).strftime("%H:%M:%S")
    except Exception:
        return ""


def _render_segment_row(record: Dict[str, Any], services: List[Dict[str, Any]], idx: int) -> Any:
    segments: List[Dict[str, Any]] = record.get("segments", []) or []
    transcripts: Dict[str, List[str]] = record.get("transcripts", {}) or {}
    seg = segments[idx] if idx < len(segments) else None
    # Build provider cells first
    time_str = ""
    try:
        if seg and seg.get("startMs") and seg.get("endMs"):
            time_str = f"{_fmt_time(seg['startMs'])} – {_fmt_time(seg['endMs'])}"
    except Exception:
        time_str = ""
    time_cell = Td(time_str, data_col="time")
    svc_cells = []
    timeouts: Dict[str, List[bool]] = (record.get("timeouts") or {}) if isinstance(record, dict) else {}
    for s in services:
        arr = transcripts.get(s["key"], []) or []
        txt = arr[idx] if idx < len(arr) else ""
        try:
            to_arr = timeouts.get(s["key"], []) or []
            if (not txt) and idx < len(to_arr) and to_arr[idx]:
                txt = "no result (timeout)"
        except Exception:
            pass
        svc_cells.append(Td(txt or "", data_svc=s["key"]))
    # Translation cell (computed client/server via Gemini)
    trans_arr = (transcripts.get("translation", []) or []) if isinstance(transcripts, dict) else []
    trans_txt = trans_arr[idx] if idx < len(trans_arr) else ""
    svc_cells.append(Td(trans_txt or "", data_svc="translation"))
    import json as __json
    # Playback last
    play_kids: List[Any] = []
    if seg and seg.get("url"):
        play_kids.append(Audio(Source(src=seg["url"], type=seg.get("mime") or "audio/webm"), controls=True))
        try:
            play_kids.append(Space())
            play_kids.append(A("📥", href=seg.get("url") or "", download=True, title="Download", style="cursor:pointer;text-decoration:none"))
        except Exception:
            pass
        if isinstance(seg.get("size"), int):
            kb = int(seg["size"]/1024)
            try:
                play_kids.append(Space())
                play_kids.append(Small(f"({kb} KB)"))
            except Exception:
                play_kids.append(Space(f" ({kb} KB)"))
    play_cell = Td(*play_kids)
    return Tr(
        time_cell,
        *svc_cells,
        play_cell,
        id=f"segrow-{record.get('id','')}-{idx}",
        hx_post="/render/segment_row",
        hx_trigger="refresh-row",
        hx_target="this",
        hx_swap="outerHTML",
        hx_vals=__json.dumps({"record": record, "idx": idx})
    )


def render_segment_row(req) -> Any:
    # Parse tolerant: fall back to minimal defaults on any error
    try:
        try:
            data = req.json()
        except Exception:
            data = req.form()
        record_raw = (data or {}).get("record", {})
        record: Dict[str, Any] = record_raw if isinstance(record_raw, dict) else (_json.loads(record_raw) if isinstance(record_raw, str) else {})
        idx: int = int((data or {}).get("idx", 0))
    except Exception:
        record = {}
        idx = 0
    try:
        services = [s for s in services_json() if s.get("enabled")]
        try:
            import json as __dbg_json
            print("[render_full_row] incoming record.fullAppend:", __dbg_json.dumps(record.get("fullAppend", {}), ensure_ascii=False) )
            print("[render_full_row] incoming record.transcripts keys:", list((record.get("transcripts", {}) or {}).keys()))
        except Exception:
            pass
        row = _render_segment_row(record, services, idx)
        html = str(row)
    except Exception:
        html = "<tr></tr>"
    etag = hashlib.sha256(html.encode("utf-8")).hexdigest()
    inm = req.headers.get("if-none-match") or req.headers.get("hx-etag") or ""
    if inm == etag:
        return HTMLResponse(status_code=304, content="")
    resp = HTMLResponse(content=html)
    resp.headers["ETag"] = etag
    resp.headers["HX-ETag"] = etag
    return resp


def render_full_row(req) -> Any:
    # Parse tolerant: fall back to minimal defaults on any error
    try:
        try:
            data = req.json()
        except Exception:
            data = req.form()
        record_raw = (data or {}).get("record", {})
        record: Dict[str, Any] = record_raw if isinstance(record_raw, dict) else (_json.loads(record_raw) if isinstance(record_raw, str) else {})
    except Exception:
        record = {}
    try:
        services = [s for s in services_json() if s.get("enabled")]
        # Match the provider table built in build_panel_html: service columns + Translation
        # Summary table shows only provider columns (no Translation column here)
        full_header = THead(Tr(*[Th(s["label"]) for s in services]))
        # Compute summaries using Gemini if configured
        summaries: Dict[str, str] = {}
        if getattr(app_state, 'enable_summarization', True) and app_state.gemini_model is not None:
            for s in services:
                key = s["key"]
                full_text = ((record.get("fullAppend", {}) or {}).get(key, ""))
                # Fallback: if fullAppend is empty, derive from per-segment transcripts
                if not full_text:
                    try:
                        seg_arr = ((record.get("transcripts", {}) or {}).get(key, []) or [])
                        if isinstance(seg_arr, list):
                            full_text = " ".join([str(x) for x in seg_arr if x])
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
                    summaries[key] = extract_text_from_gemini_response(resp) or ""
                except Exception:
                    summaries[key] = full_text
        try:
            print("[render_full_row] summaries keys:", list(summaries.keys()))
            for k, v in summaries.items():
                print(f"[render_full_row] summary[{k}] =", (v or "").replace("\n"," ")[:200])
        except Exception:
            pass
        # Build cells using summaries when available after Stop; else raw fullAppend
        full_cells: List[Any] = []
        for s in services:
            key = s["key"]
            val = None
            try:
                if bool(record.get('stopTs')) and key in summaries:
                    val = summaries.get(key)
            except Exception:
                pass
            if val is None:
                val = ((record.get("fullAppend", {}) or {}).get(key, ""))
            full_cells.append(Td(val or "", data_svc=key, cls='marked'))
        full_row = TBody(Tr(*full_cells, id=f"fullrow-{record.get('id','')}") )
        table = Table(full_header, full_row, border="0", cellpadding="4", cellspacing="0", style="border-collapse:collapse; border:0; width:100%")
        html = str(table)
    except Exception:
        html = "<table></table>"
    etag = hashlib.sha256(html.encode("utf-8")).hexdigest()
    inm = req.headers.get("if-none-match") or req.headers.get("hx-etag") or ""
    if inm == etag:
        return HTMLResponse(status_code=304, content="")
    resp = HTMLResponse(content=html)
    resp.headers["ETag"] = etag
    resp.headers["HX-ETag"] = etag
    return resp

