"""
server/services/google_stt.py

Async per-segment recognizer for Google STT.
We prefer WEBM_OPUS or OGG_OPUS to match the browser segment container.
"""
import asyncio
from typing import Optional
from google.cloud import speech

async def recognize_segment(client: speech.SpeechClient, segment_bytes: bytes, mime_ext: str, language_code: str = "en-US") -> str:
    loop = asyncio.get_running_loop()

    def do_recognize_webm():
        cfg = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
            language_code=language_code,
            sample_rate_hertz=48000,
        )
        audio = speech.RecognitionAudio(content=segment_bytes)
        return client.recognize(config=cfg, audio=audio)

    def do_recognize_ogg():
        cfg = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.OGG_OPUS,
            language_code=language_code,
            sample_rate_hertz=48000,
        )
        audio = speech.RecognitionAudio(content=segment_bytes)
        return client.recognize(config=cfg, audio=audio)

    if mime_ext == "ogg":
        resp = await loop.run_in_executor(None, do_recognize_ogg)
    else:
        resp = await loop.run_in_executor(None, do_recognize_webm)
    transcript_text = ""
    if resp.results and resp.results[0].alternatives:
        transcript_text = resp.results[0].alternatives[0].transcript or ""
    if not transcript_text:
        try:
            resp2 = await loop.run_in_executor(None, do_recognize_ogg)
            if resp2.results and resp2.results[0].alternatives:
                transcript_text = resp2.results[0].alternatives[0].transcript or ""
        except Exception:
            pass
    return transcript_text


