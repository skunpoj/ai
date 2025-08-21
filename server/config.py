"""
server/config.py

Shared configuration constants for audio capture and recognition.
"""
STREAMING_LIMIT = 240000  # 4 minutes
SAMPLE_RATE = 16000
CHUNK_SIZE = int(SAMPLE_RATE / 10) # 100ms
STREAMING_LIMIT_MS = 240000  # 4 minutes
SAMPLE_RATE_HZ = 16000
CHUNK_MS = 250
SEGMENT_MS_DEFAULT = 10000
LANGUAGE_CODE = "en-US"


