## Code Reference

This document describes modules, functions, and their usage across the project. It also notes where functions are referenced to help identify dead code.

Conventions:
- Used by: brief pointer to call sites or routes
- Returns/Side effects: important outputs or DOM/HTML generation
- Notes: caveats, error handling, or assumptions

---

### app.py

- index() [top, minimal]
  - Purpose: Minimal root handler for the simple FastHTML prototype.
  - Used by: Early app boot section; superseded by the later `index()` defined below.
  - Notes: In current wiring, the later definition at L265 is the active one.

- _fmt_ms(ms: int) -> str
  - Purpose: Format milliseconds into m:ss for simple WS prototype.
  - Used by: Minimal WebSocket endpoint code near the top (prototype).

- _b64_to_bytes(data_url_or_b64: str) -> bytes
  - Purpose: Robust base64 decode (data URL or raw base64) with padding normalization.
  - Used by: `/test_transcribe`, possibly other helper endpoints.

- index() -> Any [main]
  - Purpose: Render index page via `server.routes.build_index()`.
  - Used by: GET `/` (main entry point).

- list_services() -> Any
  - Purpose: Return JSON array of enabled services from runtime registry.
  - Used by: GET `/services` (frontend dynamic columns).

- update_service(req) -> Any
  - Purpose: Toggle a single service enabled flag.
  - Used by: POST `/services` (settings UI interactions).

- update_services_bulk(req) -> Any
  - Purpose: Bulk toggle services via HTMX form.
  - Used by: POST `/services_bulk` (settings modal Save & Close).

- settings_bulk(...) -> Any
  - Purpose: Save provider toggles, prompts, translation language, API key, and feature flags.
  - Used by: POST `/settings_bulk`.

- update_summary_prompt(req) -> Any
  - Purpose: Save the full transcript summarization prompt; returns JSON `{ ok }`.
  - Used by: POST `/summary_prompt` (settings modal shortcut).

- update_translation_settings(req) -> Any
  - Purpose: Save translation prompt and target language; returns JSON `{ ok }`.
  - Used by: POST `/translation_settings`.

- set_gemini_key(api_key: str) -> Any
  - Purpose: Configure Gemini API key at runtime; returns JSON with masked key and enablement.
  - Used by: POST `/gemini_api_key` (settings modal Apply).

- render_panel_route(req) -> Any
  - Purpose: HTMX partial wrapper for `server.routes.render_panel`.
  - Used by: POST `/render/panel` (internal; current UI renders panels client-side).

- render_segment_row_route(record, idx) -> Any
  - Purpose: HTMX partial to re-render a single segment row.
  - Used by: POST `/render/segment_row` (segments table refresh).

- render_full_row_route(record) -> Any
  - Purpose: Server-side HTML table for full-row (provider headers; one row of summary/append text).
  - Used by: POST `/render/full_row` (legacy/HTMX fallback path).

- render_full_row_json(record) -> Any
  - Purpose: JSON API for summary; returns `{ ok, labels, keys, summaries, summary_text, stopTs }`.
  - Used by: POST `/render/full_row_json` (primary path used by `static/app/app.js`).

- export_full_async_route(recording_id) -> Any
  - Purpose: Start server-side remux job to produce a single full audio file.
  - Used by: POST `/export_full_async`.

- export_status_route(job_id) -> Any
  - Purpose: Query async remux job status.
  - Used by: GET `/export_status`.

---

### server/routes.py

- build_segment_modal() -> Any
  - Purpose: Return settings modal DOM (delegates to `server.views.settings.build_settings_modal`).
  - Used by: `build_index()`.

- build_index()
  - Purpose: Build the entire index page, including styles, toolbar, settings modal, scripts, and the panels host.
  - Used by: `app.py` main index route.

- services_json() -> List[Dict]
  - Purpose: Proxy list of services from `registry` for internal use.
  - Used by: rendering functions in this module.

- _safe_id(recording_id: str) -> str
  - Purpose: Sanitize recording id for filesystem operations.
  - Used by: export/remux helpers.

- _run_ffmpeg_concat(session_dir: str, out_path: str) -> None
  - Purpose: Execute ffmpeg concat or re-encode fallback.
  - Used by: async remux worker.

- _start_remux_job(recording_id: str) -> str
  - Purpose: Spawn background thread to remux segments; register job id.
  - Used by: `export_full_async`.

- export_full_async(recording_id) -> Any
  - Purpose: Start remux job; returns `{ ok, job_id }`.
  - Used by: App endpoints.

- export_status(job_id) -> Any
  - Purpose: Return job status and URL when done.
  - Used by: App endpoints.

- build_panel_html(record: Dict[str, Any]) -> str
  - Purpose: Compose the recording panel: top full table placeholder and segments table.
  - Used by: `render_panel`.

- render_panel(req) -> Any
  - Purpose: Parse incoming `record` and return the render of a panel.
  - Used by: HTMX partial route (wrapper exists in app.py).

- _fmt_time(ts) -> str
  - Purpose: Human format timestamp.
  - Used by: `_render_segment_row` and panel meta.

- _render_segment_row(record, services, idx) -> Any
  - Purpose: Compose a single segment table row with provider cells, translation cell, and playback cell.
  - Used by: `render_panel` initial table and `render_segment_row` partial.

- render_segment_row(req) -> Any
  - Purpose: HTMX partial handler to refresh a single segment row; includes ETag handling.
  - Used by: POST `/render/segment_row`.

- render_full_row(req) -> Any
  - Purpose: Server-side summary table (provider headers only); cells are class `marked` to support markdown.
  - Used by: POST `/render/full_row` (legacy/secondary path).

---

### server/state.py

- AppState (class)
  - Purpose: Holds provider clients, masked auth info, and runtime prompts/feature flags.
  - Key attributes: `speech_client`, `gemini_model`, `vertex_client`, `full_summary_prompt`, `translation_prompt`, `translation_lang`, `enable_summarization`, `enable_translation`.
  - Key methods:
    - init_google_speech(): initialize Google Cloud STT client and masked auth.
    - init_gemini_api(): configure Gemini API client via `google.genai` or legacy `google-generativeai`.
    - init_vertex(): set up Vertex AI client using `google.genai` with project/location.
    - set_gemini_api_key(api_key): runtime config for consumer Gemini API.

- set_full_summary_prompt(prompt)
  - Purpose: Set `app_state.full_summary_prompt`.
  - Used by: settings routes.

- set_translation_prompt(prompt)
  - Purpose: Set translation prompt template.
  - Used by: translation settings route.

- set_translation_lang(lang)
  - Purpose: Set default translation target language.
  - Used by: translation settings route.

---

### server/services

- registry.py
  - list_services() -> List[Service]
    - Purpose: Return current ordered services with enabled flags.
    - Used by: UI renderers and `/services` endpoints.
  - set_service_enabled(key, enabled)
    - Purpose: Toggle service enabled flags.
    - Used by: `/services` POST and settings save.
  - is_enabled(key) -> bool
    - Purpose: Check if provider is enabled.
    - Used by: segment upload/transcription.

- gemini_api.py
  - _from_candidates(resp) -> str
    - Purpose: Extract text from SDK response candidates.
    - Used by: `extract_text_from_gemini_response`.
  - extract_text_from_gemini_response(resp) -> str
    - Purpose: Central text extraction for Gemini responses.
    - Used by: segment transcription and summary.

- vertex_gemini.py
  - build_vertex_contents(segment_bytes, mime) -> list
    - Purpose: Build contents payload for Vertex `generate_content`.
    - Used by: segment transcription when Vertex enabled.
  - extract_text_from_vertex_response(resp) -> str
    - Purpose: Normalize Vertex response to text.
    - Used by: segment transcription.

- vertex_langchain.py
  - is_available() -> bool
    - Purpose: Check if LangChain path is available.
    - Used by: segment transcription branch.
  - transcribe_segment_via_langchain(client, model, bytes, mime) -> str
    - Purpose: Alt transcription via LangChain wrapper.
    - Used by: segment transcription when LC is available.

- transcription.py
  - _choose_mime_order(ext_or_mime) -> List[str]
    - Purpose: Decide try-order for mime types.
    - Used by: helpers.
  - transcribe_vertex(raw, ext_or_mime) -> str; transcribe_gemini(raw, ext_or_mime) -> str; transcribe_gemini_raise(...)
    - Purpose: Provider-specific transcription wrappers.
    - Used by: `/test_transcribe` helper and other flows.

---

### static/ui & static/app (JavaScript)

- static/ui/renderers.js
  - renderRecordingPanel(record) [export]
    - Purpose: Build/refresh the recording panel HTML: full-record placeholder, segments table, and summary container.
    - Used by: `static/app/app.js` orchestrator.

- static/ui/services.js
  - getServices(forceNoCacheMs) [export]
    - Purpose: Fetch `/services` with optional cache buster.
  - getServicesCached(ttlMs) [export]
    - Purpose: In-memory TTL cache to reduce repeated requests.

- static/ui/segments.js
  - showPendingCountdown(recordId, segmentMs, isActiveFn, isRecordingFn) [export]
  - prependSegmentRow(record, segIndex, data, startMs, endMs) [export]
  - insertTempSegmentRow(record, clientTs, url, size, startMs, endMs) [export]
  - formatElapsed(deltaMs) [export]
    - Used by: `renderers.js` and app controller during recording.

- static/ui/tabs.js
  - ensureTab, activateTab, setElapsed, finalizeTab [export]
    - Purpose: Manage tab UI for multiple recordings.
    - Used by: `renderers.js` and `app.js`.

- static/ui/format.js
  - bytesToLabel(bytes) [export]
    - Purpose: Human-readable sizes.
    - Used by: renderers/segments.

- static/app/app.js (orchestrator)
  - renderMarkdownInCells(root)
    - Purpose: Client-side markdown rendering helper for `.marked` elements.
    - Used by: initial pass and HTMX swap events.
  - ensureRecordingTab(record) / renderRecordingPanel(record)
    - Purpose: Ensure tab exists and render the panel via UI renderer.
  - startElapsedTimer/stopElapsedTimer
  - startRemuxAsync(record)
  - clearSvcTimeout(recordId, idx, svc) / scheduleSegmentTimeouts(recordId, idx)
  - getMicStream()
  - openSocket() => null (HTTP-only path)
  - runConnCheckOnce/startConnAutoCheck/stopConnAutoCheck
  - prepareNewRecording()
  - recomputeFullAppendFromTranscripts(rec)
  - performFinalizeIfReady()
    - Purpose: On Stop, ensure last segment finished, recompute fullAppend, render panel, and request summary JSON.
  - handleSegmentSaved(data) / handleTranscript(msg) / handleSaved(data)
  - toast(msg)
  - startRotatingSegment()
    - Used by: Recording flow.

---

### Unused/rarely used items

- `server/ws.py`: The current HTTP-only path in `static/app/app.js` stubs out `openSocket()`; WS is not active in this mode. WS utilities in `static/ui/ws*.js` appear unused with the HTTP-only orchestrator, but are kept for the alternate mode.
- The early `index()` in `app.py` is shadowed by the later definition; left for legacy compatibility.

---

### Summary rendering flow (current)

1) On Stop: `performFinalizeIfReady()` recomputes `fullAppend`, renders the panel, and calls `/render/full_row_json` with a compact record.
2) Server aggregates summaries per provider and returns `summary_text` (first non-empty summary or fallback fullAppend).
3) Client injects the string into `#summarytable-<id>` as `.marked` and renders markdown via MarkedJS.
4) If the summary container has content, the full record block is hidden.


