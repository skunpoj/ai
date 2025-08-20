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
    content = Div(
        H3("Segment length"),
        len_group,
        Button("Close", id="closeSegmentModal"),
        id="segmentModalContent",
        style="background:#222;padding:16px;border:1px solid #444;max-width:520px;margin:10% auto",
    )
    modal = Div(
        content,
        id="segmentModal",
        style="display:none;position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999",
    )
    return modal


def build_index():
    title = "Live Transcription & Translation"
    return Title(title), \
        Link(rel="icon", href="/static/favicon.ico"), \
        H1(title), \
        Div(
            # Admin: service toggles
            Div(
                H2("Admin: Services"),
                Div(id="serviceAdmin", style="margin-bottom:12px"),
            ),
            Div(
                Button("Start Recording", id="startRecording"),
                Button("Stop Recording", id="stopRecording", disabled=True),
                Button("Check Connection", id="testConnection"),
                P("WebSocket: not connected", id="connStatus"),
            ),
            Div(
                Button("Start Transcribe", id="startTranscribe", disabled=True),
                Button("Stop Transcribe", id="stopTranscribe", disabled=True),
                Button("Segment length", id="openSegmentModal"),
            ),
            P("Transcription: ", id="transcription"),
            Div(id="liveTranscriptContainer"),
            build_segment_modal(),
            Div(
                H2("Recordings"),
                Div(id="recordTabs", style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"),
                Div(id="recordPanels")
            ),
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


