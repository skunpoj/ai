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
import hashlib
import json as _json


def build_segment_modal() -> Any:
    return build_settings_modal()


def build_index():
    title = "Live Transcription & Translation"
    return Title(title), \
        Link(rel="icon", href="/static/favicon.ico"), \
        Div(
            Div(
                Button("Start Recording", id="startRecording"),
                Button("Stop Recording", id="stopRecording", disabled=True),
                Button("Settings", id="openSegmentModal"),
            # ),
            # Div(
                Input(type="checkbox", id="autoTranscribeToggle", checked=True),
                Label("Auto Transcribe", _for="autoTranscribeToggle"),
                Button("Start Transcribe", id="startTranscribe", disabled=True),
                Button("Stop Transcribe", id="stopTranscribe", disabled=True),
            ),
            # Removed redundant transcription status line
            Div(id="liveTranscriptContainer"),
            build_segment_modal(),
            Div(
                H2("Recordings"),
                Div(id="recordTabs", style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"),
                Div(id="recordPanels")
            ),
            # HTMX is bundled by FastHTML; no need to load separately
            Script(f"let CHUNK_MS = {CHUNK_MS};"),
            Script(f"let SEGMENT_MS = {SEGMENT_MS_DEFAULT};"),
            Script("window.SEGMENT_MS = SEGMENT_MS;"),
            Script(
                f"window.GOOGLE_AUTH_INFO = {json.dumps(app_state.auth_info or {})};\n"
                f"window.GOOGLE_AUTH_READY = {( 'true' if (app_state.speech_client and app_state.streaming_config) else 'false' )};\n"
                "console.log('Frontend: Google auth on load:', { ready: window.GOOGLE_AUTH_READY, info: window.GOOGLE_AUTH_INFO });\n"
                "try { const cg = document.getElementById('cred_google'); if (cg) { const i = window.GOOGLE_AUTH_INFO||{}; cg.textContent = `Google: ${window.GOOGLE_AUTH_READY ? 'ready' : 'not ready'}${i.project_id ? ' · ' + i.project_id : ''}${i.client_email_masked ? ' · ' + i.client_email_masked : ''}${i.private_key_id_masked ? ' · ' + i.private_key_id_masked : ''}`; } } catch(_) {}\n"
                "try { const cv = document.getElementById('cred_vertex'); if (cv) { const i = window.GOOGLE_AUTH_INFO||{}; cv.textContent = `Vertex: ${window.GOOGLE_AUTH_READY ? 'ready' : 'not ready'}${i.project_id ? ' · ' + i.project_id : ''}${i.client_email_masked ? ' · ' + i.client_email_masked : ''}${i.private_key_id_masked ? ' · ' + i.private_key_id_masked : ''}`; } } catch(_) {}"
            ),
            Script(src="/static/main.js", type="module")
        )


def services_json() -> List[Dict[str, Any]]:
    """Return current services from registry; frontend adapts columns dynamically."""
    return registry_list()


def build_panel_html(record: Dict[str, Any]) -> str:
    """Build the HTML for the panel given a record dict."""
    services = [s for s in services_json() if s.get("enabled")]

    def _td(txt: str) -> Any:
        return Td(txt)

    # Full record section (no 'Transcribing…' indicator)
    full_header = Tr(*[Th(s["label"]) for s in services])
    # show size in first cell if serverUrl present (no explicit download link)
    first_cell_bits: List[Any] = []
    if record.get("serverUrl"):
        human = ""
        try:
            size = int(record.get("serverSizeBytes") or 0)
            if size >= 1048576:
                human = f"({round(size/1048576,1)} MB)"
            elif size >= 1024:
                human = f"({int(round(size/1024))} KB)"
            elif size > 0:
                human = f"({size} B)"
        except Exception:
            human = ""
        first_cell_bits = [Small(human)]
    full_cells = []
    for s in services:
        val = ((record.get("fullAppend", {}) or {}).get(s["key"], ""))
        # prepend size label only in first service column
        if not full_cells and first_cell_bits:
            full_cells.append(Td(*first_cell_bits, data_svc=s["key"]))
        else:
            full_cells.append(Td(val, data_svc=s["key"]))
    full_row = Tr(*full_cells, id=f"fullrow-{record.get('id','')}")
    full_table = Table(
        THead(full_header),
        TBody(full_row),
        border="1",
        cellpadding="4",
        cellspacing="0",
        style="border-collapse:collapse; width:100%",
        id=f"fulltable-{record.get('id','')}",
        hx_post="/render/full_row",
        hx_trigger="refresh-full from:body",
        hx_target="this",
        hx_swap="innerHTML",
        hx_vals=json.dumps({"record": record})
    )

    # Segments table
    seg_header = Tr(Th("Segment"), Th("Start"), Th("End"), *[Th(s["label"]) for s in services])
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
        border="1",
        cellpadding="4",
        cellspacing="0",
        style="border-collapse:collapse; width:100%",
        id=f"segtable-{record.get('id','')}"
    )

    # Header info
    started = record.get("startTs")
    ended = record.get("stopTs")
    dur_ms = record.get("durationMs") or 0
    dur_s = int(dur_ms/1000) if isinstance(dur_ms, int) else 0
    hdr = Div(
        (f"Start: {_fmt_time(started)} · End: {_fmt_time(ended)} · Duration: {dur_s}s" if started and ended else ""),
        style="margin-bottom:8px"
    )
    # Player only (download available via browser control UI); keep size label
    player_bits: List[Any] = []
    # Prefer serverUrl so the playback points at a resolvable file immediately when available
    src_url = record.get("serverUrl") or record.get("audioUrl")
    if src_url:
        player_bits.append(Audio(Source(src=src_url, type="audio/webm"), controls=True))
    # no explicit download link
    size_bytes = 0
    if isinstance(record.get("serverSizeBytes"), int) and record["serverSizeBytes"] > 0:
        size_bytes = record["serverSizeBytes"]
    elif isinstance(record.get("clientSizeBytes"), int) and record["clientSizeBytes"] > 0:
        size_bytes = record["clientSizeBytes"]
    if size_bytes > 0:
        kb = int(size_bytes/1024)
        player_bits.append(Space(f" ({kb} KB)"))
    # Ensure the meta container has a predictable id for live updates
    player_div = Div(*player_bits, style="margin-bottom:8px", id=f"recordmeta-{record.get('id','')}")

    panel = Div(
        hdr,
        player_div,
        Div(
            # H3("Full Record"),
            full_table
            ),
        Div(
            H3("Segments"),
            seg_table,
            # SSE hooks for htmx to trigger fragment refreshes
            Div(hx_sse="connect:/events event:segment_saved", hx_trigger="sse:segment_saved"),
            Div(hx_sse="connect:/events event:saved", hx_trigger="sse:saved"),
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
    seg_cell_children: List[Any] = []
    if seg and seg.get("url"):
        seg_cell_children.append(Audio(Source(src=seg["url"], type=seg.get("mime") or "audio/webm"), controls=True))
        if isinstance(seg.get("size"), int):
            kb = int(seg["size"]/1024)
            seg_cell_children.append(Space(f" ({kb} KB)"))
    seg_cell = Td(*seg_cell_children)
    start_cell = Td(("" if not seg else ("" if not seg.get("startMs") else str(_fmt_time(seg["startMs"])))))
    end_cell = Td(("" if not seg else ("" if not seg.get("endMs") else str(_fmt_time(seg["endMs"])))))
    svc_cells = []
    for s in services:
        arr = transcripts.get(s["key"], []) or []
        txt = arr[idx] if idx < len(arr) else ""
        svc_cells.append(Td(txt or "transcribing…", data_svc=s["key"]))
    import json as __json
    return Tr(
        seg_cell,
        start_cell,
        end_cell,
        *svc_cells,
        id=f"segrow-{record.get('id','')}-{idx}",
        hx_post="/render/segment_row",
        hx_trigger="refresh-row from:body",
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
        full_header = Tr(*[Th(s["label"]) for s in services])
        # Build first column with download icon + size when available
        first_cell_bits: List[Any] = []
        try:
            if record.get("serverUrl"):
                human = ""
                size = int(record.get("serverSizeBytes") or 0)
                if size >= 1048576:
                    human = f"({round(size/1048576,1)} MB)"
                elif size >= 1024:
                    human = f"({int(round(size/1024))} KB)"
                elif size > 0:
                    human = f"({size} B)"
                first_cell_bits = [A("📥", href=record.get("serverUrl"), download=True, title="Download"), Space(" "), Small(human)]
        except Exception:
            first_cell_bits = []
        full_cells: List[Any] = []
        for s in services:
            val = ((record.get("fullAppend", {}) or {}).get(s["key"], ""))
            if not full_cells and first_cell_bits:
                full_cells.append(Td(*first_cell_bits, data_svc=s["key"]))
            else:
                full_cells.append(Td(val, data_svc=s["key"]))
        full_row = Tr(*full_cells, id=f"fullrow-{record.get('id','')}")
        table = Table(THead(full_header), TBody(full_row), border="1", cellpadding="4", cellspacing="0", style="border-collapse:collapse; width:100%")
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

