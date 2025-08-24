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

    # --- Tabs bar ---
    tabs_bar = Div(
        Button("General", id="settingsTabGeneralBtn", type="button", style="padding:6px 10px;border:1px solid #444;border-bottom:0;background:#333;color:#fff;margin-right:4px"),
        Button("Summarization", id="settingsTabSumBtn", type="button", style="padding:6px 10px;border:1px solid #444;border-bottom:0;background:#222;color:#aaa;margin-right:4px"),
        Button("Translation", id="settingsTabTransBtn", type="button", style="padding:6px 10px;border:1px solid #444;border-bottom:0;background:#222;color:#aaa;margin-right:4px"),
        Button("Advanced", id="settingsTabAdvBtn", type="button", style="padding:6px 10px;border:1px solid #444;border-bottom:0;background:#222;color:#aaa"),
        style="display:flex;gap:0;margin-bottom:0"
    )

    # --- Tab contents ---
    tab_general = Div(
        Div(
            Div(len_group, style="margin-bottom:8px"),
            H5("Providers"),
            Div(
                Div(
                    Input(type="checkbox", id="svc_aws", name="aws"),
                    Label("AWS (beta)", _for="svc_aws", id="lbl_aws", style="cursor:pointer"),
                    Small("", id="cred_aws", style="margin-left:6px;color:#aaa"),
                    style="margin-bottom:8px"
                ),
                Div(
                    Input(type="checkbox", id="svc_google", name="google"),
                    Label("Google STT", _for="svc_google", id="lbl_google", style="cursor:pointer"),
                    Small("", id="cred_google", style="margin-left:6px;color:#aaa"),
                    style="margin-bottom:8px"
                ),
                Div(
                    Input(type="checkbox", id="svc_vertex", name="vertex"),
                    Label("Gemini Vertex", _for="svc_vertex", id="lbl_vertex", style="cursor:pointer"),
                    Small("", id="cred_vertex", style="margin-left:6px;color:#aaa"),
                    style="margin-bottom:8px"
                ),
                Div(
                    Input(type="checkbox", id="svc_gemini", name="gemini", checked=True),
                    Label("Gemini API", _for="svc_gemini", id="lbl_gemini", style="cursor:pointer"),
                    Small("", id="cred_gemini", style="margin-left:6px;color:#aaa"),
                    style="margin-bottom:8px"
                ),
                # Local preview moved to Advanced tab
            ),
            Div(
                Input(
                    type="text",
                    id="geminiApiKey", name="gemini_api_key",
                    placeholder=(app_state.gemini_api_key_masked or "Enter Gemini API Key"),
                    style="width:100%;height:28px"
                ),
                Button(
                    "Apply",
                    id="useGeminiKey",
                    type="button",
                    hx_post="/gemini_api_key",
                    hx_include="#geminiApiKey",
                    hx_target="#geminiSaveMsg",
                    hx_swap="innerHTML",
                    style="height:28px;padding:0 10px;font-size:12px"
                ),
                style="margin-bottom:8px;display:grid;grid-template-columns:1fr auto;gap:8px"
            ),
            Div(id="geminiSaveMsg", style="min-height:18px;margin-bottom:8px"),
            Hr(),
            H5("Transcribe Test"),
            Div(Audio(controls=True, id="testAudio", style="width:100%")),
            Div(
                Input(type="file", id="testUpload", accept="audio/*"),
                Button("Record sample", id="testRecord2s", type="button", style="padding:4px 10px;font-size:12px"),
                Button("Transcribe Test", id="testRun", type="button", style="padding:4px 10px;font-size:12px"),
                style="margin-bottom:8px;display:flex;gap:8px;align-items:center"
            ),
            Small("Results:", style="color:#aaa"),
            Div(id="testResults", style="min-height:24px;max-height:180px;overflow:auto;margin-bottom:8px"),
            id="providerCheckboxes"
        ),
        id="settingsTabContentGeneral",
        style="padding:8px;border:1px solid #444;background:#1e1e1e"
    )

    tab_sum = Div(
        H5("Full Transcript Summary Prompt"),
        Div(
            Input(type="checkbox", id="enableSummarization", name="enable_summarization", checked=bool(getattr(app_state, 'enable_summarization', True))),
            Label("Enable summarization (default ON)", _for="enableSummarization"),
            style="display:flex;gap:8px;align-items:center;margin-bottom:6px"
        ),
        Textarea(app_state.full_summary_prompt or "", name="full_summary_prompt", id="fullSummaryPrompt", style="width:100%;min-height:80px"),
        Div(
            Button("Plain text", id="tplPlain", type="button", style="padding:4px 8px;margin-right:6px"),
            Button("Markdown", id="tplMarkdown", type="button", style="padding:4px 8px;margin-right:6px"),
            Button("Bullets (concise)", id="tplBullets", type="button", style="padding:4px 8px;margin-right:6px"),
            Small("Click a template to populate the prompt textarea", style="color:#aaa;margin-left:6px"),
            style="margin:6px 0 8px 0"
        ),
        Small("Used to summarize provider full transcripts into the full row."),
        id="settingsTabContentSum",
        style="padding:8px;border:1px solid #444;background:#1e1e1e;display:none"
    )

    tab_trans = Div(
        H5("Translation"),
        Div(
            Input(type="checkbox", id="enableTranslation", name="enable_translation", checked=bool(getattr(app_state, 'enable_translation', False))),
            Label("Enable translation (default OFF)", _for="enableTranslation"),
            style="display:flex;gap:8px;align-items:center;margin-bottom:6px"
        ),
        Div(
            Label("Language:", _for="translationLang", style="margin-right:6px"),
            Select(
                Option("English", value="en", selected=(app_state.translation_lang=="en")),
                Option("Thai", value="th", selected=(app_state.translation_lang=="th")),
                Option("Japanese", value="ja", selected=(app_state.translation_lang=="ja")),
                Option("Chinese (Simplified)", value="zh", selected=(app_state.translation_lang=="zh")),
                name="translation_lang", id="translationLang"
            ),
            style="display:flex;gap:8px;align-items:center;margin-bottom:6px"
        ),
        Textarea(app_state.translation_prompt or "", name="translation_prompt", id="translationPrompt", style="width:100%;min-height:60px"),
        Small("Prompt template used per-segment for Translation column (Gemini)."),
        id="settingsTabContentTrans",
        style="padding:8px;border:1px solid #444;background:#1e1e1e;display:none"
    )

    tab_adv = Div(
        H5("Advanced"),
        Div(
            Input(type="checkbox", id="uploadFullToggle", name="upload_full"),
            Label("Upload full on Stop", _for="uploadFullToggle"),
            style="margin-bottom:8px;display:flex;gap:8px;align-items:center"
        ),
        Div(
            Input(type="checkbox", id="exportFullToggle", name="export_full"),
            Label("Server export (remux) full on Stop", _for="exportFullToggle"),
            style="margin-bottom:8px;display:flex;gap:8px;align-items:center"
        ),
        Div(
            Input(type="checkbox", id="showLocalPreviewToggle", name="local_preview", checked=True),
            Label("Local preview", _for="showLocalPreviewToggle"),
            style="margin-bottom:8px;display:flex;gap:8px;align-items:center"
        ),
        id="settingsTabContentAdv",
        style="padding:8px;border:1px solid #444;background:#1e1e1e;display:none"
    )

    # Intervals are already placed inside General tab content above

    # Wrap all tabs in a single HTMX form for bulk save
    form = Form(
        tabs_bar,
        tab_general,
        tab_sum,
        tab_trans,
        tab_adv,
        Div(
            Button(
                "Save and Close", id="settingsSaveBtn", type="button",
                style="padding:10px 14px;font-size:14px"
            ),
            style="text-align:center;margin-top:8px"
        ),
        id="settingsForm",
    )
    content = Div(
        form,
        id="segmentModalInner",
        style="background:#222;padding:16px;border:1px solid #444;max-width:960px;width:96vw;max-height:90vh;margin:5vh auto;overflow:auto;-webkit-overflow-scrolling:touch;box-sizing:border-box",
    )
    modal = Div(
        content,
        id="segmentModal",
        style="display:none;position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;overflow:auto",
    )
    return modal


