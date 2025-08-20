"""
server/services/aws_transcribe.py

AWS Transcribe per-segment helper (planned).

Approaches:
- Streaming Transcribe via AWS WebSocket (convert audio to PCM or supported format)
- Batch Transcribe: upload segment to S3 and call StartTranscriptionJob with the S3 URI

For now, this is a minimal scaffold to preserve wiring and UI columns.
"""
from typing import Optional

try:
    import boto3
except Exception:
    boto3 = None


def is_available() -> bool:
    return boto3 is not None


def recognize_segment_placeholder(segment_bytes: bytes, media_format: str = "webm", language_code: str = "en-US") -> str:
    """
    Placeholder: AWS Transcribe requires files accessible via S3 or streaming.
    To integrate properly: upload `segment_bytes` to S3, then call
    `start_transcription_job` and poll `get_transcription_job`.

    Returns an empty string for now to avoid blocking.
    """
    return ""


