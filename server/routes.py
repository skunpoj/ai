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
        Style("""
html, body { margin:0; padding:0; }
body { background:transparent; }
* { border:0 !important; }
table { border-collapse:collapse; border-spacing:0; width:100%; }
th, td { padding:0; }
hr { display:none; }
/* Hide segment metadata (download + size) when toggled off */
.hide-segmeta tbody[id^="segtbody-"] small[id^="segsize-"],
.hide-segmeta tbody[id^="segtbody-"] a[download][data-load-full] {
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
                Button("Start Recording", id="startRecording"),
                Button("Stop Recording", id="stopRecording", disabled=True),
                Button("Settings", id="openSegmentModal"),
            # ),
            # Div(
                Input(type="checkbox", id="autoTranscribeToggle", checked=True),
                Label("Auto Transcribe", _for="autoTranscribeToggle"),
                Input(type="checkbox", id="toggleSegMetaToolbar", checked=True),
                Label("file size", _for="toggleSegMetaToolbar"),
                Input(type="checkbox", id="toggleTimeColToolbar", checked=True),
                Label("Time elapsed", _for="toggleTimeColToolbar"),
                Button("Start Transcribe", id="startTranscribe", disabled=True),
                Button("Stop Transcribe", id="stopTranscribe", disabled=True),
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
            Script(
                f"window.GOOGLE_AUTH_INFO = {json.dumps(app_state.auth_info or {})};\n"
                f"window.GOOGLE_AUTH_READY = {( 'true' if (app_state.speech_client and app_state.streaming_config) else 'false' )};\n"
                "console.log('Frontend: Google auth on load:', { ready: window.GOOGLE_AUTH_READY, info: window.GOOGLE_AUTH_INFO });\n"
                "try { const cg = document.getElementById('cred_google'); if (cg) { const i = window.GOOGLE_AUTH_INFO||{}; cg.textContent = `Google: ${window.GOOGLE_AUTH_READY ? 'ready' : 'not ready'}${i.project_id ? ' · ' + i.project_id : ''}`; } } catch(_) {}\n"
                "try { const cv = document.getElementById('cred_vertex'); if (cv) { const i = window.GOOGLE_AUTH_INFO||{}; cv.textContent = `Vertex: ${window.GOOGLE_AUTH_READY ? 'ready' : 'not ready'}${i.project_id ? ' · ' + i.project_id : ''}`; } } catch(_) {}"
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

    # Build top meta table to ensure consistent left padding with segment rows
    src_url = record.get("serverUrl") or record.get("audioUrl")
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
    full_header = Tr(*[Th(s["label"], style="border:0;padding:0") for s in services])
    full_cells: List[Any] = [Td(((record.get("fullAppend", {}) or {}).get(s["key"], "")), data_svc=s["key"]) for s in services]
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
        hx_trigger="refresh-full",
        hx_target="this",
        hx_swap="innerHTML",
        hx_vals=json.dumps({"record": record})
    )

    # Segments table
    seg_header = Tr(
        Th("Segment", style="border:0;padding:0"),
        Th("Time", style="border:0;padding:0", data_col="time"),
        *[Th(s["label"], style="border:0;padding:0") for s in services]
    )
    seg_rows: List[Any] = []
    # Prepend a full-record line at top; provider cells show cumulative transcript during recording
    full_line_cells: List[Any] = []
    for s in services:
        full_line_cells.append(Td(((record.get("fullAppend", {}) or {}).get(s["key"], "")), data_svc=s["key"]))
    seg_rows.append(
        Tr(
            Td("Full", id=f"fullcell-{record.get('id','')}", style="white-space:nowrap"),
            Td("", data_col="time", id=f"fulltime-{record.get('id','')}") ,
            *full_line_cells,
            id=f"fullrowline-{record.get('id','')}"
        )
    )
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
    seg_cell_children: List[Any] = []
    if seg and seg.get("url"):
        seg_cell_children.append(Audio(Source(src=seg["url"], type=seg.get("mime") or "audio/webm"), controls=True))
        try:
            seg_cell_children.append(Space())
            seg_cell_children.append(A("📥", href=seg.get("url") or "", download=True, title="Download", **{"data-load-full": seg.get("url") or ""}, style="cursor:pointer;text-decoration:none"))
        except Exception:
            pass
        if isinstance(seg.get("size"), int):
            kb = int(seg["size"]/1024)
            try:
                seg_cell_children.append(Space())
                seg_cell_children.append(Small(f"({kb} KB)", id=f"segsize-{record.get('id','')}-{idx}", **{"data-load-full": (seg.get("url") or "")}, style="cursor:pointer"))
            except Exception:
                seg_cell_children.append(Space(f" ({kb} KB)"))
    seg_cell = Td(*seg_cell_children)
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
    import json as __json
    return Tr(
        seg_cell,
        time_cell,
        *svc_cells,
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
        # Provider table shows only provider texts; player/icon/size belong in segments top row on stop
        full_cells: List[Any] = []
        for s in services:
            val = ((record.get("fullAppend", {}) or {}).get(s["key"], ""))
            full_cells.append(Td(val, data_svc=s["key"]))
        full_row = Tr(*full_cells, id=f"fullrow-{record.get('id','')}")
        table = Table(THead(full_header), TBody(full_row), border="0", cellpadding="4", cellspacing="0", style="border-collapse:collapse; border:0; width:100%")
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

