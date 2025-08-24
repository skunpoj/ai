"""
server/views/settings.py

Settings modal UI components for the FastHTML app.

Separating this keeps routing thin and UI composition modular.
"""
from fasthtml.common import *
from server.state import app_state


def build_settings_modal() -> Any:
    """Return the Settings modal (segment length + provider toggles + Gemini key)."""
    first_row = Div(
        H5("Intervals"),
        Input(type="radio", name="segmentLen", id="seg5", value="5000"), Label("5", _for="seg5"),
        Input(type="radio", name="segmentLen", id="seg10", value="10000", checked=True), Label("10", _for="seg10"),
        Input(type="radio", name="segmentLen", id="seg30", value="30000"), Label("30", _for="seg30"),
        Input(type="radio", name="segmentLen", id="seg45", value="45000"), Label("45", _for="seg45"),
        Input(type="radio", name="segmentLen", id="seg60", value="60000"), Label("60", _for="seg60"),
    )
    second_row = Div(
        Input(type="radio", name="segmentLen", id="seg90", value="90000"), Label("90", _for="seg90"),
        Input(type="radio", name="segmentLen", id="seg120", value="120000"), Label("120", _for="seg120"),
        # Input(type="radio", name="segmentLen", id="seg150", value="150000"), Label("150", _for="seg150"),
        Input(type="radio", name="segmentLen", id="seg180", value="180000"), Label("180", _for="seg180"),
        Input(type="radio", name="segmentLen", id="seg300", value="300000"), Label("300", _for="seg300"),
    )
    len_group = Div(first_row, second_row, id="segmentLenGroup")

    provider_checks = Div(
        Div(
            Div(
                H5("Providers"),
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
            # Hr(),
            # H5("Display"),
            # Div(
            #     Input(type="checkbox", id="toggleSegMeta", checked=True),
            #     Label("Show segment download & size", _for="toggleSegMeta"),
            #     style="margin-bottom:8px;display:flex;gap:8px;align-items:center"
            # ),
            Div(
                Input(
                    type="text",
                    id="geminiApiKey",
                    placeholder=(app_state.gemini_api_key_masked or "Enter Gemini API Key"),
                    style="width:100%;height:28px"
                ),
                # Match height with input; compact padding
                Button("Apply", id="useGeminiKey", style="height:28px;padding:0 10px;font-size:12px"),
                style="margin-bottom:8px;display:grid;grid-template-columns:1fr auto;gap:8px"
            ),
            Div(
                Input(type="checkbox", id="uploadFullToggle"),
                Label("Upload full on Stop", _for="uploadFullToggle"),
                style="margin-bottom:8px;display:flex;gap:8px;align-items:center"
            ),
            Div(
                Input(type="checkbox", id="exportFullToggle"),
                Label("Server export (remux) full on Stop", _for="exportFullToggle"),
                style="margin-bottom:8px;display:flex;gap:8px;align-items:center"
            ),
            Hr(),
            H5("Transcribe Test"),
            Div(Audio(controls=True, id="testAudio", style="width:100%")),
            Div(
                Input(type="file", id="testUpload", accept="audio/*"),
                Button("Record 2s", id="testRecord2s", style="padding:4px 10px;font-size:12px"),
                Button("Transcribe Test", id="testRun", style="padding:4px 10px;font-size:12px"),
                Button("Test via WS", id="testViaWS", style="padding:4px 10px;font-size:12px"),
                style="margin-bottom:8px;display:flex;gap:8px;align-items:center"
            ),
            Small("Results:", style="color:#aaa"),
            Div(id="testResults", style="min-height:24px;max-height:180px;overflow:auto;margin-bottom:8px"),
            id="providerCheckboxes"
        ),
        Div(
            Button("Check Connection", id="testConnection", style="padding:4px 10px;font-size:12px"),
            P("WebSocket: checking…", id="connStatus", style="margin:0"),
            style="display:flex;gap:8px;align-items:center"
        )
    )

    content = Div(
        len_group,
        provider_checks,
        # Keep OK larger than other buttons
        Div(Button("OK", id="okSegmentModal", style="padding:10px 14px;font-size:14px"), style="text-align:center;margin-top:8px"),
        id="segmentModalContent",
        style="background:#222;padding:16px;border:1px solid #444;max-width:960px;width:96vw;max-height:90vh;margin:5vh auto;overflow:auto;-webkit-overflow-scrolling:touch;box-sizing:border-box",
    )
    modal = Div(
        content,
        id="segmentModal",
        style="display:block;position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;overflow:auto",
    )
    return modal


