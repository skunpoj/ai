"""
server/services/registry.py

Simple in-memory services registry.

- Each service has:
  - key: string identifier (matches frontend column keys and websocket message suffixes)
  - label: human friendly label
  - enabled: whether server should dispatch this provider

This keeps runtime state only; restart resets to defaults.
"""
import os
from typing import Dict, List


Service = Dict[str, object]


_services: Dict[str, Service] = {
    # Order hint: AWS first, Gemini API second, then Google, Vertex
    "aws": {"key": "aws", "label": "AWS Transcribe (beta)", "enabled": os.environ.get("AWS_TRANSCRIBE_ENABLED", "false").lower() in ("1","true","yes")},
    "gemini": {"key": "gemini", "label": "Gemini (API)", "enabled": True},
    "google": {"key": "google", "label": "Google STT", "enabled": False},
    "vertex": {"key": "vertex", "label": "Gemini (Vertex AI)", "enabled": False},
}


def list_services() -> List[Service]:
    # Preserve order defined above
    return [ _services[k] for k in _services.keys() ]


def set_service_enabled(key: str, enabled: bool) -> List[Service]:
    if key in _services:
        _services[key]["enabled"] = bool(enabled)
    return list_services()


def is_enabled(key: str) -> bool:
    svc = _services.get(key)
    return bool(svc and svc.get("enabled"))


