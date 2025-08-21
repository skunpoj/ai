# AI Generated Business Plan Application

## Project Plan

Here is the plan to create the AI-generated business plan application:

1.  **Define core functionality for the AI business plan application.**
2.  **Choose appropriate technologies (frontend, backend, AI model).**
3.  **Set up the project structure and initial files.**
4.  **Implement the user interface for input and displaying generated plans.**
5.  **Develop backend API for handling requests and interacting with the AI model.**
6.  **Integrate an AI model for generating business plans.**
7.  **Implement data storage for user information and generated business plans.**
8.  **Add user authentication and authorization (if necessary).**
9.  **Plan and implement deployment of the application.**
10. **Develop and execute tests for the application.**

## Speech-to-Text Application

This application provides a web interface for transcribing audio to text using Google Cloud Speech-to-Text API.

### Run with Docker

Build and run using the included Dockerfile:

```bash
docker build -t live-transcribe .
docker run -p 5001:5001 \
  -e GOOGLE_APPLICATION_CREDENTIALS_JSON="$(cat /path/to/service_account_key.json)" \
  -e GEMINI_API_KEY="YOUR_GEMINI_API_KEY_IF_USED" \
  live-transcribe
```

Notes:
- The container will write GOOGLE_APPLICATION_CREDENTIALS_JSON to a temp file and configure the Google SDKs automatically.
- Set GEMINI_API_KEY if you want the consumer Gemini API in addition to Vertex.

### Running with Docker

To run the application using Docker, which is recommended for deployment and consistent environments:

1.  **Build the Docker image:**
    Navigate to your project root (where `Dockerfile` is located) and run:
    ```bash
    docker build -t speech-to-text-app .
    ```

2.  **Run the Docker container (Secure Credential Handling - Volume Mounting):**
    This method securely injects your service account key into the container at runtime without baking it into the image.

    *   **Save your JSON key:** Ensure your `service_account_key.json` file is saved in a secure location on your host machine (e.g., `C:\Users\YourUser\keys\service_account_key.json` on Windows, or `/home/youruser/keys/service_account_key.json` on Linux/macOS). **Do not commit this file to your GitHub repository!**

    *   **Run the container:**
        ```bash
        docker run -d \
          -p 8080:8080 \
          -v /path/on/host/to/service_account_key.json:/app/service_account_key.json \
          -e GOOGLE_APPLICATION_CREDENTIALS=/app/service_account_key.json \
          speech-to-text-app
        ```
        *   Replace `/path/on/host/to/service_account_key.json` with the actual absolute path to your `service_account_key.json` file on your host machine.
        *   For Windows paths in PowerShell, use:
            ```powershell
            docker run -d `
              -p 8080:8080 `
              -v "C:\Users\YourUser\keys\service_account_key.json":/app/service_account_key.json `
              -e GOOGLE_APPLICATION_CREDENTIALS=/app/service_account_key.json `
              speech-to-text-app
            ```

### Deployment on Railway (Secure Credential Handling)

When deploying to Railway, you can securely inject your Google Cloud service account JSON key using Railway's environment variables and build commands. This prevents the key from being committed to your repository or baked into your Docker image.

1.  **Create a Railway Environment Variable for the JSON content:**
    *   In your Railway project settings, go to the "Variables" tab.
    *   Add a new variable, for example, named `GOOGLE_APPLICATION_CREDENTIALS_JSON`.
    *   For its value, **paste the entire content of your `service_account_key.json` file as a single string.** Ensure there are no extra spaces or newlines.

2.  **Configure Railway Build Command to create the JSON file:**
    *   In your Railway project settings, go to the "Build" tab.
    *   Modify your build command (or add a pre-build command) to write the content of `GOOGLE_APPLICATION_CREDENTIALS_JSON` to a file within your container's `/app` directory. For example:
        ```bash
        echo $GOOGLE_APPLICATION_CREDENTIALS_JSON > /app/service_account_key.json
        ```
        *   Ensure this command runs *before* your application starts and attempts to use the credentials.

3.  **Set `GOOGLE_APPLICATION_CREDENTIALS` environment variable in Railway:**
    *   In your Railway project settings, under the "Variables" tab, add another environment variable named `GOOGLE_APPLICATION_CREDENTIALS`.
    *   Set its value to the path where you created the JSON file in the previous step: `/app/service_account_key.json`.

### Original Certificate Verification Issue (CERTIFICATE_VERIFY_FAILED)

Initially, this project encountered a `CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate` error when attempting to connect to Google Cloud APIs directly from the local Python environment. This issue is often related to:

*   **Corporate Proxies/Firewalls:** SSL inspection proxies can intercept and re-sign SSL certificates, requiring the client system to trust the proxy's certificate.
*   **Outdated CA Certificates:** The local environment's trusted Certificate Authority (CA) bundles might be outdated.
*   **System Trust Store Issues:** Problems with the operating system's root certificate store.

While attempts were made to update `certifi` and set the `REQUESTS_CA_BUNDLE` environment variable, these did not resolve the issue. The decision was made to shift to a web-based application using `python-fasthtml` and Docker for deployment. In deployed environments (especially cloud platforms), SSL certificate handling is typically managed by load balancers or the platform itself, often circumventing these local certificate issues.

### Architecture (Modular Transcription)

- app.py: boots the app, loads credentials (via `utils/credentials.py`), initializes provider state (`server/state.py`), and wires routes and WebSocket.
- server/config.py: constants (CHUNK_MS, SEGMENT_MS_DEFAULT, language, etc.).
- server/state.py: initializes and stores provider clients (Google STT, Gemini API, Vertex) with masked auth info for UI. Uses google.genai (preferred) for Gemini API if present, otherwise falls back to google-generativeai. Default model: `gemini-2.5-flash`.
- server/routes.py: builds the index page; exposes `GET /services` for dynamic columns.
- server/ws.py: handles WebSocket for audio segments, full upload, and dispatches to enabled providers.
- server/services/
  - google_stt.py: Google per-segment recognition helper
  - vertex_gemini.py: Vertex helpers (build contents, extract text)
  - gemini_api.py: Gemini API text extraction
  - aws_transcribe.py: AWS Transcribe scaffold (S3/streaming to be implemented)
  - registry.py: runtime registry; toggle services via `POST /services {key, enabled}`
- static/
  - main.js: orchestrator; delegates to modular UI helpers
  - audio/pcm-worklet.js: AudioWorkletNode processor for PCM16 capture
  - ui/services.js: fetches `/services` with small TTL cache
  - ui/ws.js: WebSocket utilities and ensureOpenSocket helper
  - ui/segments.js: segment UI helpers (pending countdown, prepend row, elapsed formatter, HTMX refresh)
  - ui/recording.js: recording control helpers (start/stop button states)
  - ui/format.js, ui/tabs.js: small utilities

### Settings

The index page includes a "Settings" modal with:
- Segment length selection (5s–300s)
- Provider toggles (Google STT, Gemini Vertex, Gemini API, AWS beta)
- Gemini API key input with Apply button
These call `POST /services` and `/gemini_api_key` and the UI re-renders columns dynamically.

### Frontend lint/format (optional)

If you want linting/formatting, add the following files and run with npm:

1. package.json
```json
{
  "name": "transcription-ui",
  "private": true,
  "devDependencies": {
    "eslint": "^9.9.0",
    "eslint-config-prettier": "^9.1.0",
    "prettier": "^3.3.3"
  },
  "scripts": {
    "lint": "eslint \"static/**/*.js\"",
    "format": "prettier --write \"static/**/*.js\""
  }
}
```

2. .eslintrc.json
```json
{
  "env": { "browser": true, "es2022": true },
  "extends": ["eslint:recommended", "prettier"],
  "parserOptions": { "ecmaVersion": 2022, "sourceType": "module" },
  "rules": {}
}
```

3. .prettierrc
```json
{
  "singleQuote": true,
  "semi": true
}
```

### Adding a provider

1. Server:
   - Implement per-segment recognition helper under `server/services/`.
   - Register provider in `server/services/registry.py` (key, label, enabled).
   - Dispatch in `server/ws.py` when enabled in registry.
2. Frontend:
   - No change needed for columns; the UI reads `/services` and renders accordingly.

### Vertex AI Gemini with Service Accounts (Optional, Parallel Transcription)

To run Gemini using your service account (no API key), enable the Vertex AI SDK mode:

1. Ensure `google-cloud-aiplatform` is installed (already in `requirements.txt`).
2. Set environment variables:
   - Windows (PowerShell):
     ```powershell
     $env:GOOGLE_CLOUD_PROJECT="your_gcp_project_id"
     $env:GOOGLE_CLOUD_LOCATION="us-central1"
     $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\service_account_key.json"
     ```
   - Linux/macOS:
     ```bash
     export GOOGLE_CLOUD_PROJECT="your_gcp_project_id"
     export GOOGLE_CLOUD_LOCATION="us-central1"
     export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service_account_key.json"
     ```

With these set, the backend will use Vertex AI Gemini via the Google GenAI SDK. LangChain is also supported via `langchain-google-vertexai` where applicable, but audio transcription currently goes through the SDK's `models.generate_content` path for reliability.

### UI behavior (Segments)

- New segment appears at the top (descending order). Previous segments remain visible below.
- A temporary "Recording for X seconds…" row is shown during segment capture and replaced by the new row when saved.
- Start/End display elapsed time from recording start (m:ss), not wall time.
- Download link uses an icon (📥) and shows file size.

### Provider troubleshooting and setup

Google Cloud Speech-to-Text
- Ensure `GOOGLE_APPLICATION_CREDENTIALS_JSON` is set to the full JSON content of the service account key (the app writes it to a temp file).
- Confirm project and key are valid; UI logs masked auth status to console.

Gemini (API)
- Set `GEMINI_API_KEY` to enable the consumer Gemini API model.
- The app prefers the new `google.genai` SDK; if unavailable it falls back to `google-generativeai`.
- If not set, the app skips Gemini API, and only Vertex/Google run.

Vertex Gemini
- Set `GOOGLE_CLOUD_PROJECT` and optionally `GOOGLE_CLOUD_LOCATION` (defaults to `us-central1`).
- Requires service account with Vertex permissions; the project id is inferred from the service account if not set.
- The app dispatches per-segment transcription when Vertex is enabled in Settings.

AWS Transcribe (planned)
- Set `AWS_TRANSCRIBE_ENABLED=true` to show the AWS column (scaffold only).
- For full integration: configure S3 bucket and IAM, then implement segment upload + StartTranscriptionJob or streaming in `server/services/aws_transcribe.py` and dispatch in `server/ws.py` (already scaffolded).
