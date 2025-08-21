"""
server/routes.py

Route builders for the FastHTML app. The index view composes the page
and injects config and masked auth info for the frontend.
"""
import json
from typing import List, Dict, Any
from fasthtml.common import *
from server.config import CHUNK_MS, SEGMENT_MS_DEFAULT
from server.state import app_state
from server.services.registry import list_services as registry_list
from starlette.responses import HTMLResponse
import hashlib
import json as _json


def build_segment_modal() -> Any:
    """Return the segment length modal as a single unambiguous call tree."""
    first_row = Div(
        Input(type="radio", name="segmentLen", id="seg5", value="5000"), Label("5s", _for="seg5"),
        Input(type="radio", name="segmentLen", id="seg10", value="10000", checked=True), Label("10s", _for="seg10"),
        Input(type="radio", name="segmentLen", id="seg30", value="30000"), Label("30s", _for="seg30"),
        Input(type="radio", name="segmentLen", id="seg45", value="45000"), Label("45s", _for="seg45"),
        Input(type="radio", name="segmentLen", id="seg60", value="60000"), Label("60s", _for="seg60"),
    )
    second_row = Div(
        Input(type="radio", name="segmentLen", id="seg90", value="90000"), Label("90s", _for="seg90"),
        Input(type="radio", name="segmentLen", id="seg120", value="120000"), Label("120s", _for="seg120"),
        Input(type="radio", name="segmentLen", id="seg150", value="150000"), Label("150s", _for="seg150"),
        Input(type="radio", name="segmentLen", id="seg180", value="180000"), Label("180s", _for="seg180"),
        Input(type="radio", name="segmentLen", id="seg300", value="300000"), Label("300s", _for="seg300"),
    )
    len_group = Div(first_row, second_row, id="segmentLenGroup")
    provider_checks = Div(
        H3("Providers"),
        Div(
            Input(type="checkbox", id="svc_google"), Label("Google STT", _for="svc_google"),
            Input(type="checkbox", id="svc_vertex", checked=True), Label("Gemini Vertex", _for="svc_vertex"),
            Input(type="checkbox", id="svc_gemini"), Label("Gemini API", _for="svc_gemini"),
            Input(type="checkbox", id="svc_aws"), Label("AWS (beta)", _for="svc_aws"),
            id="providerCheckboxes", style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px"
        ),
        Div(Button("Check Connection", id="testConnection"), P("WebSocket: not connected", id="connStatus"))
    )
    content = Div(
        H3("Settings"),
        len_group,
        provider_checks,
        Button("OK", id="okSegmentModal"),
        id="segmentModalContent",
        style="background:#222;padding:16px;border:1px solid #444;max-width:520px;margin:10% auto",
    )
    modal = Div(
        content,
        id="segmentModal",
        style="display:block;position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999",
    )
    return modal


def build_index():
    title = "Live Transcription & Translation"
    return Title(title), \
        Link(rel="icon", href="/static/favicon.ico"), \
        Div(
            Div(
                Button("Start Recording", id="startRecording"),
                Button("Stop Recording", id="stopRecording", disabled=True),
                Button("Setting", id="openSegmentModal"),
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
                "console.log('Frontend: Google auth on load:', { ready: window.GOOGLE_AUTH_READY, info: window.GOOGLE_AUTH_INFO });"
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
    full_row = Tr(*[Td((record.get("fullAppend", {}) or {}).get(s["key"], "")) for s in services], id=f"fullrow-{record.get('id','')}")
    full_table = Table(
        THead(full_header),
        TBody(full_row),
        border="1",
        cellpadding="4",
        cellspacing="0",
        style="border-collapse:collapse; width:100%",
        id=f"fulltable-{record.get('id','')}",
        hx_post="/render/full_row",
        hx_trigger="refresh-full",
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
    # Player + download
    player_bits: List[Any] = []
    if record.get("audioUrl"):
        player_bits.append(Audio(Source(src=record["audioUrl"], type="audio/webm"), controls=True))
    if record.get("serverUrl"):
        player_bits.append(Space(" "))
        player_bits.append(A("Download", href=record["serverUrl"], download=True))
    if isinstance(record.get("serverSizeBytes"), int) and record["serverSizeBytes"] > 0:
        kb = int(record["serverSizeBytes"]/1024)
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
        seg_cell_children.append(Space(" "))
        seg_cell_children.append(A("Download", href=seg["url"], download=True))
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
        svc_cells.append(Td(txt or "transcribing…"))
    import json as __json
    return Tr(
        seg_cell,
        start_cell,
        end_cell,
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
        full_row = Tr(*[Td(((record.get("fullAppend", {}) or {}).get(s["key"], ""))) for s in services], id=f"fullrow-{record.get('id','')}")
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

