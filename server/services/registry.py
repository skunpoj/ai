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
    "google": {"key": "google", "label": "Google STT", "enabled": False},
    "vertex": {"key": "vertex", "label": "Gemini (Vertex AI)", "enabled": True},
    "gemini": {"key": "gemini", "label": "Gemini (API)", "enabled": False},
    # AWS provider can be toggled via env; disabled by default
    "aws": {"key": "aws", "label": "AWS Transcribe (beta)", "enabled": os.environ.get("AWS_TRANSCRIBE_ENABLED", "false").lower() in ("1","true","yes")},
}


def list_services() -> List[Service]:
    return list(_services.values())


def set_service_enabled(key: str, enabled: bool) -> List[Service]:
    if key in _services:
        _services[key]["enabled"] = bool(enabled)
    return list_services()


def is_enabled(key: str) -> bool:
    svc = _services.get(key)
    return bool(svc and svc.get("enabled"))


