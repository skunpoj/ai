"""
server/state.py

Provides a single source of truth for provider clients and authentication info.
All initialization occurs here to avoid duplicate global setup across modules.
"""
import os
import json
from typing import Optional, Dict, Any

from google.cloud import speech

try:
    import google.generativeai as gm
except Exception:
    gm = None

try:
    from google import genai as genai_sdk
    from google.genai import types as genai_types
except Exception:
    genai_sdk = None
    genai_types = None

from utils.credentials import ensure_google_credentials_from_env
from server.config import SAMPLE_RATE_HZ, LANGUAGE_CODE


class AppState:
    """Holds initialized provider clients and masked authentication info.

    Attributes:
        speech_client: Google Cloud Speech client for streaming/recognition.
        recognition_config: Base RecognitionConfig for LINEAR16 streaming.
        streaming_config: StreamingRecognitionConfig for LINEAR16 streaming.
        auth_info: Masked auth details (project id, client email, key id) for UI.
        gemini_model: Consumer Gemini API model instance, if configured.
        vertex_client: Vertex GenAI SDK client, if configured.
        vertex_model_name: Vertex model name to use.
    """

    def __init__(self) -> None:
        self.speech_client: Optional[speech.SpeechClient] = None
        self.recognition_config: Optional[speech.RecognitionConfig] = None
        self.streaming_config: Optional[speech.StreamingRecognitionConfig] = None
        self.auth_info: Optional[Dict[str, Any]] = None

        self.gemini_model: Optional[object] = None
        self.gemini_api_ready: bool = False
        self.gemini_api_key_masked: str = ""
        self.vertex_client: Optional[object] = None
        self.vertex_model_name: str = os.environ.get("VERTEX_GEMINI_MODEL", "gemini-2.5-flash")

    def init_google_speech(self) -> None:
        """Initialize Google STT client and masked auth info from env JSON."""
        _ = ensure_google_credentials_from_env()
        credentials_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if not (credentials_path and os.path.exists(credentials_path)):
            print("Google Cloud credentials file not found or path not set.")
            return
        try:
            with open(credentials_path, 'r') as f:
                creds_content = f.read()
                json.loads(creds_content)
            self.speech_client = speech.SpeechClient()
            self.recognition_config = speech.RecognitionConfig(
                encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=SAMPLE_RATE_HZ,
                language_code=LANGUAGE_CODE,
            )
            self.streaming_config = speech.StreamingRecognitionConfig(
                config=self.recognition_config, interim_results=True
            )
            try:
                creds_json = json.loads(creds_content)
                client_email = creds_json.get("client_email")
                private_key_id = creds_json.get("private_key_id")
                project_id = creds_json.get("project_id")

                def mask(val: Optional[str]) -> str:
                    if not val or len(val) < 8:
                        return "***"
                    return f"{val[:4]}...{val[-4:]}"

                self.auth_info = {
                    "project_id": project_id or "",
                    "client_email_masked": (client_email[:3] + "...@" + client_email.split("@")[-1]) if client_email and "@" in client_email else "***",
                    "private_key_id_masked": mask(private_key_id),
                }
            except Exception:
                self.auth_info = None
            print(f"Google Cloud Speech client initialized successfully using credentials from: {credentials_path}")
        except Exception as e:
            print(f"Error initializing Google Cloud Speech client: {e}")

    def init_gemini_api(self) -> None:
        """Initialize consumer Gemini API model if GEMINI_API_KEY is present."""
        gemini_api_key = os.environ.get("GEMINI_API_KEY")
        if gemini_api_key and gm is not None:
            try:
                gm.configure(api_key=gemini_api_key)
                self.gemini_model = gm.GenerativeModel("gemini-1.5-flash")
                self.gemini_api_ready = True
                self.gemini_api_key_masked = (gemini_api_key[:4] + "..." + gemini_api_key[-4:]) if len(gemini_api_key) >= 8 else "***"
                print("Gemini model initialized for parallel transcription.")
            except Exception as e:
                print(f"Error initializing Gemini: {e}")
                self.gemini_model = None
                self.gemini_api_ready = False
        else:
            if not gemini_api_key:
                print("GEMINI_API_KEY not set; skipping Gemini parallel transcription.")
            if gm is None:
                print("google-generativeai not installed; skipping Gemini parallel transcription.")

    def set_gemini_api_key(self, api_key: str) -> bool:
        """Dynamically configure Gemini consumer API with a provided key."""
        if gm is None:
            self.gemini_model = None
            self.gemini_api_ready = False
            self.gemini_api_key_masked = ""
            return False
        try:
            gm.configure(api_key=api_key)
            self.gemini_model = gm.GenerativeModel("gemini-1.5-flash")
            self.gemini_api_ready = True
            self.gemini_api_key_masked = (api_key[:4] + "..." + api_key[-4:]) if isinstance(api_key, str) and len(api_key) >= 8 else "***"
            return True
        except Exception as e:
            print(f"Error setting Gemini API key: {e}")
            self.gemini_model = None
            self.gemini_api_ready = False
            self.gemini_api_key_masked = ""
            return False

    def init_vertex(self) -> None:
        """Initialize Vertex GenAI SDK client using service account."""
        vertex_project = os.environ.get("GOOGLE_CLOUD_PROJECT")
        if not vertex_project and self.auth_info and self.auth_info.get("project_id"):
            vertex_project = str(self.auth_info.get("project_id"))
        vertex_location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")

        if genai_sdk is not None and vertex_project:
            try:
                self.vertex_client = genai_sdk.Client(vertexai=True, project=vertex_project, location=vertex_location)
                print(f"Google Gen AI SDK (Vertex backend) initialized for project={vertex_project} location={vertex_location}.")
            except Exception as e:
                print(f"Error initializing Google Gen AI SDK (Vertex backend): {e}")
                self.vertex_client = None
        else:
            if genai_sdk is None:
                print("google-genai SDK not installed; skipping Vertex AI Gemini.")
            elif not vertex_project:
                print("GOOGLE_CLOUD_PROJECT not set and could not infer; skipping Vertex AI Gemini.")

app_state = AppState()


