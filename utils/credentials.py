"""
utils/credentials.py

Ensures Google service account JSON is written to a temp file and
GOOGLE_APPLICATION_CREDENTIALS is set accordingly.
"""
import os
import tempfile
import json
from typing import Optional, Dict, Any

try:
    from dotenv import load_dotenv
except Exception:
    # If dotenv isn't installed, proceed without it; env may already be set
    def load_dotenv() -> None:  # type: ignore
        return


def ensure_google_credentials_from_env(env_var: str = "GOOGLE_APPLICATION_CREDENTIALS_JSON") -> Optional[Dict[str, Any]]:
    """
    Ensures Google service account credentials are available via a JSON file by
    reading the JSON from an environment variable and writing it to a temporary file.

    Returns a dict with keys: { 'path': str, 'info': { project_id, client_email_masked, private_key_id_masked } }
    or None if the env var isn't set or writing fails.
    """
    load_dotenv()
    credentials_json = os.environ.get(env_var)
    if not credentials_json:
        print(f"{env_var} environment variable not found.")
        return None
    try:
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, 'w') as tmp:
            tmp.write(credentials_json)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = path

        info: Dict[str, str] = {}
        try:
            creds = json.loads(credentials_json)
            client_email = creds.get("client_email")
            private_key_id = creds.get("private_key_id")
            project_id = creds.get("project_id")
            def mask(val: Optional[str]) -> str:
                if not val or len(val) < 8:
                    return "***"
                return f"{val[:4]}...{val[-4:]}"
            info = {
                "project_id": project_id or "",
                "client_email_masked": (client_email[:3] + "...@" + client_email.split("@")[-1]) if client_email and "@" in client_email else "***",
                "private_key_id_masked": mask(private_key_id)
            }
        except Exception:
            info = {}

        print(f"Google Cloud credentials written to temporary file: {path}")
        return {"path": path, "info": info}
    except Exception as e:
        print(f"Error writing Google Cloud credentials to temporary file: {e}")
        return None


