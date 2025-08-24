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
        # Prompt used to summarize full transcripts per provider
        self.full_summary_prompt: str = (
            "Summarize the following transcription into concise bullet points capturing key points, decisions, and action items. "
            "Avoid filler. Preserve factual content."
        )
        # Translation settings
        self.translation_prompt: str = (
            "Translate the following text into the TARGET language, preserving meaning and names."
        )
        self.translation_lang: str = os.environ.get("TRANSLATION_LANG", "en")
        # Feature flags
        self.enable_summarization: bool = True
        self.enable_translation: bool = False

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

                def short(val: Optional[str], lead: int = 2) -> str:
                    try:
                        if not val:
                            return "***"
                        return (val[:lead] + "***") if len(val) > lead else val
                    except Exception:
                        return "***"

                self.auth_info = {
                    "project_id": short(project_id, 2),
                    # Show only the first 2 chars of the local-part; omit domain entirely (no trailing @)
                    "client_email_masked": short((client_email or '').split('@')[0], 2),
                    "private_key_id_masked": short(private_key_id, 2),
                }
            except Exception:
                self.auth_info = None
            print(f"Google Cloud Speech client initialized successfully using credentials from: {credentials_path}")
        except Exception as e:
            print(f"Error initializing Google Cloud Speech client: {e}")

    def init_gemini_api(self) -> None:
        """Initialize consumer Gemini API model if GEMINI_API_KEY is present."""
        gemini_api_key = os.environ.get("GEMINI_API_KEY")
        # Prefer new google.genai SDK when available; fall back to google.generativeai
        if gemini_api_key:
            # Adapter for google.genai client to match .generate_content([...]) interface used elsewhere
            class _GenaiConsumerAdapter:
                def __init__(self, client, model_name: str):
                    self._client = client
                    self._model = model_name
                def generate_content(self, contents):
                    # Normalize contents into google.genai types when needed
                    if genai_types is not None:
                        normalized = []
                        for part in contents or []:
                            try:
                                if isinstance(part, dict) and "mime_type" in part and "data" in part:
                                    normalized.append(genai_types.Part.from_bytes(data=part["data"], mime_type=part["mime_type"]))
                                elif isinstance(part, dict) and "text" in part:
                                    normalized.append(part["text"])  # plain text
                                else:
                                    normalized.append(part)
                            except Exception:
                                normalized.append(part)
                    else:
                        normalized = contents
                    return self._client.models.generate_content(model=self._model, contents=normalized)

            # Try new SDK first
            if genai_sdk is not None:
                try:
                    client = genai_sdk.Client(api_key=gemini_api_key)
                    # Align with attached gemini.py default model name
                    self.gemini_model = _GenaiConsumerAdapter(client, "gemini-2.5-flash")
                    self.gemini_api_ready = True
                    self.gemini_api_key_masked = (gemini_api_key[:4] + "..." + gemini_api_key[-4:]) if len(gemini_api_key) >= 8 else "***"
                    print("Gemini (google.genai) initialized for parallel transcription.")
                    return
                except Exception as e:
                    print(f"Error initializing Gemini via google.genai: {e}")
                    self.gemini_model = None
                    self.gemini_api_ready = False

            # Fallback to legacy google-generativeai SDK
            if gm is not None:
                try:
                    gm.configure(api_key=gemini_api_key)
                    self.gemini_model = gm.GenerativeModel("gemini-2.5-flash")
                    self.gemini_api_ready = True
                    self.gemini_api_key_masked = (gemini_api_key[:4] + "..." + gemini_api_key[-4:]) if len(gemini_api_key) >= 8 else "***"
                    print("Gemini (google-generativeai) initialized for parallel transcription.")
                except Exception as e:
                    print(f"Error initializing Gemini via google-generativeai: {e}")
                    self.gemini_model = None
                    self.gemini_api_ready = False
            else:
                # Key provided but no supported SDK available
                if genai_sdk is None:
                    print("Neither google.genai nor google-generativeai installed; skipping Gemini parallel transcription.")
        else:
            # No key provided
            print("GEMINI_API_KEY not set; skipping Gemini parallel transcription.")

    def set_gemini_api_key(self, api_key: str) -> bool:
        """Dynamically configure Gemini consumer API with a provided key."""
        # Try new google.genai first
        if genai_sdk is not None:
            try:
                client = genai_sdk.Client(api_key=api_key)
                class _GenaiConsumerAdapter:
                    def __init__(self, client, model_name: str):
                        self._client = client
                        self._model = model_name
                    def generate_content(self, contents):
                        if genai_types is not None:
                            normalized = []
                            for part in contents or []:
                                try:
                                    if isinstance(part, dict) and "mime_type" in part and "data" in part:
                                        normalized.append(genai_types.Part.from_bytes(data=part["data"], mime_type=part["mime_type"]))
                                    elif isinstance(part, dict) and "text" in part:
                                        normalized.append(part["text"])  # plain text
                                    else:
                                        normalized.append(part)
                                except Exception:
                                    normalized.append(part)
                        else:
                            normalized = contents
                        return self._client.models.generate_content(model=self._model, contents=normalized)
                self.gemini_model = _GenaiConsumerAdapter(client, "gemini-2.5-flash")
                self.gemini_api_ready = True
                self.gemini_api_key_masked = (api_key[:4] + "..." + api_key[-4:]) if isinstance(api_key, str) and len(api_key) >= 8 else "***"
                return True
            except Exception as e:
                print(f"Error setting Gemini API key via google.genai: {e}")
                # fall through to legacy
        if gm is not None:
            try:
                gm.configure(api_key=api_key)
                self.gemini_model = gm.GenerativeModel("gemini-2.5-flash")
                self.gemini_api_ready = True
                self.gemini_api_key_masked = (api_key[:4] + "..." + api_key[-4:]) if isinstance(api_key, str) and len(api_key) >= 8 else "***"
                return True
            except Exception as e:
                print(f"Error setting Gemini API key via google-generativeai: {e}")
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


def set_full_summary_prompt(prompt: str) -> None:
    try:
        if isinstance(prompt, str) and prompt.strip():
            app_state.full_summary_prompt = prompt.strip()
    except Exception:
        pass


def set_translation_prompt(prompt: str) -> None:
    try:
        if isinstance(prompt, str) and prompt.strip():
            app_state.translation_prompt = prompt.strip()
    except Exception:
        pass


def set_translation_lang(lang: str) -> None:
    try:
        if isinstance(lang, str) and lang.strip():
            app_state.translation_lang = lang.strip()
    except Exception:
        pass


