import os
from dotenv import load_dotenv
from fasthtml.common import *
from starlette.websockets import WebSocket, WebSocketDisconnect # Explicitly import WebSocket classes from starlette

# Transcription is now controlled at runtime via Start/Stop Transcribe
ENABLE_GOOGLE_SPEECH = True

# Load .env before reading any credential env vars
load_dotenv()

import sys
from pathlib import Path
# Ensure project root is on sys.path so 'utils' and 'server' are importable in all environments
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

try:
    from utils.credentials import ensure_google_credentials_from_env
except Exception:
    # Fallback: inline minimal helper if utils package isn't available in the runtime image
    import tempfile, json as _json
    def ensure_google_credentials_from_env(env_var: str = "GOOGLE_APPLICATION_CREDENTIALS_JSON"):
        creds = os.environ.get(env_var)
        if not creds:
            print(f"{env_var} not set; proceeding without writing credentials file.")
            return None
    try:
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, 'w') as tmp:
                tmp.write(creds)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = path
            # Build masked info for UI logging
            try:
                data = _json.loads(creds)
                client_email = data.get("client_email", "")
                private_key_id = data.get("private_key_id", "")
                project_id = data.get("project_id", "")
                def mask(v: str) -> str:
                    return (v[:4] + "..." + v[-4:]) if isinstance(v, str) and len(v) >= 8 else "***"
                info = {
                    "project_id": project_id or "",
                    "client_email_masked": (client_email[:3] + "...@" + client_email.split("@")[-1]) if (client_email and "@" in client_email) else "***",
                    "private_key_id_masked": mask(private_key_id)
                }
            except Exception:
                info = {}
        print(f"Google Cloud credentials written to temporary file: {path}")
            return {"path": path, "info": info}
    except Exception as e:
        print(f"Error writing Google Cloud credentials to temporary file: {e}")
            return None
from server.config import CHUNK_MS, SEGMENT_MS_DEFAULT
from server.state import app_state
from server.routes import build_index
from server.ws import ws_handler
from server.services.registry import list_services as registry_list, set_service_enabled
from typing import Any, List, Dict

# --- Credentials Handling (START) ---
cred = ensure_google_credentials_from_env()
# --- Credentials Handling (END) ---

# Audio recording parameters (moved to config for reuse)
SEGMENT_MS = SEGMENT_MS_DEFAULT

app, rt = fast_app(exts='ws') # Ensure 'exts='ws'' is present
app.static_route_exts(prefix="/static", static_path="static") # Configure static files serving

print(f"Current working directory: {os.getcwd()}")
print(f"Absolute path to static directory: {os.path.abspath('static')}")

# Initialize shared clients/state for modular services (Google STT, Gemini API, Vertex)
try:
    app_state.init_google_speech()
    app_state.init_gemini_api()
    app_state.init_vertex()
except Exception as e:
    print(f"Error initializing app_state: {e}")

"""
app.py: Application bootstrap
- Loads environment and credentials
- Initializes shared state (Google STT, Gemini API, Vertex) via server/state.py
- Wires HTTP routes and WebSocket endpoint

All provider client initializations occur in server/state.py to avoid multiple
sources of truth and to simplify testing and future maintenance.
"""

@rt("/")
def index() -> Any:
    """Render the index page via server/routes.build_index()."""
    return build_index()

@rt("/services")
def list_services() -> List[Dict[str, Any]]:
    """Return JSON array of service descriptors for dynamic frontend columns."""
    return registry_list()

@rt("/services", methods=["POST"])
def update_service(req: Any) -> List[Dict[str, Any]]:
    """Enable/disable services dynamically at runtime.

    Request JSON body:
      { key: string, enabled: boolean }

    Returns updated list of services.
    """
    try:
        data = req.json()
        key = data.get("key")
        enabled = bool(data.get("enabled", True))
        return set_service_enabled(key, enabled)
    except Exception:
        return registry_list()


@app.ws("/ws_stream") # Dedicated WebSocket endpoint for audio streaming
async def ws_test(websocket: WebSocket):
    print("Backend: ENTERED /ws_stream function (audio streaming).") # CRITICAL TEST LOG
    try:
        await ws_handler(websocket)
    except Exception as e:
        print(f"Error in ws_handler: {e}")

serve()

