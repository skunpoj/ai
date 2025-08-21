"""
server/views/settings.py

Settings modal UI components for the FastHTML app.

Separating this keeps routing thin and UI composition modular.
"""
from fasthtml.common import *


def build_settings_modal() -> Any:
    """Return the Settings modal (segment length + provider toggles + Gemini key)."""
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
            Div(
                Input(type="checkbox", id="svc_aws"),
                Label("AWS (beta)", _for="svc_aws", id="lbl_aws", style="cursor:pointer"),
                Small("", id="cred_aws", style="margin-left:6px;color:#aaa"),
                style="margin-bottom:8px"
            ),
            Div(
                Input(type="checkbox", id="svc_google"),
                Label("Google STT", _for="svc_google", id="lbl_google", style="cursor:pointer"),
                Small("", id="cred_google", style="margin-left:6px;color:#aaa"),
                style="margin-bottom:8px"
            ),
            Div(
                Input(type="checkbox", id="svc_vertex"),
                Label("Gemini Vertex", _for="svc_vertex", id="lbl_vertex", style="cursor:pointer"),
                Small("", id="cred_vertex", style="margin-left:6px;color:#aaa"),
                style="margin-bottom:8px"
            ),
            Div(
                Input(type="checkbox", id="svc_gemini", checked=True),
                Label("Gemini API", _for="svc_gemini", id="lbl_gemini", style="cursor:pointer"),
                Small("", id="cred_gemini", style="margin-left:6px;color:#aaa"),
                style="margin-bottom:8px"
            ),
            Div(
                Input(type="text", id="geminiApiKey", placeholder="Enter Gemini API Key", style="width:100%"),
                Button("Apply", id="useGeminiKey"),
                style="margin-bottom:8px;display:grid;grid-template-columns:1fr auto;gap:8px"
            ),
            id="providerCheckboxes"
        ),
        Div(Button("Check Connection", id="testConnection"), P("WebSocket: not connected", id="connStatus"))
    )

    content = Div(
        H3("Settings"),
        len_group,
        provider_checks,
        Div(Button("OK", id="okSegmentModal"), style="text-align:center;margin-top:8px"),
        id="segmentModalContent",
        style="background:#222;padding:16px;border:1px solid #444;max-width:520px;margin:10% auto",
    )
    modal = Div(
        content,
        id="segmentModal",
        style="display:block;position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999",
    )
    return modal


