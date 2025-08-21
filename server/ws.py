import os
from pathlib import Path
import base64
import asyncio
import json
import queue
import time
from typing import Optional

from starlette.websockets import WebSocket, WebSocketDisconnect
from google.cloud import speech

from server.state import app_state
from server.config import SAMPLE_RATE_HZ
from server.services.google_stt import recognize_segment as recognize_google_segment
from server.services.vertex_gemini import build_vertex_contents, extract_text_from_vertex_response
from server.services.vertex_langchain import is_available as lc_vertex_available, transcribe_segment_via_langchain
from server.services.gemini_api import extract_text_from_gemini_response
from server.services.registry import is_enabled as service_enabled
from server.services import aws_transcribe


def now_ms() -> int:
    return int(round(time.time() * 1000))


async def ws_handler(websocket: WebSocket) -> None:
    requests_q = queue.Queue()
    pcm_requests_q = queue.Queue()

    # Use absolute static path relative to project root to ensure served path matches saved path
    _ROOT = Path(__file__).resolve().parents[1]
    recordings_dir = os.path.join(str(_ROOT), "static", "recordings")
    os.makedirs(recordings_dir, exist_ok=True)
    session_ts = now_ms()
    server_ext = "webm"  # will adjust to 'ogg' if client reports OGG
    server_filename = f"recording_{session_ts}.{server_ext}"
    server_filepath = os.path.join(recordings_dir, server_filename)
    server_file = open(server_filepath, "ab")

    session_dir = os.path.join(recordings_dir, f"session_{session_ts}")
    os.makedirs(session_dir, exist_ok=True)
    segment_index = 0

    async def receive_from_frontend() -> None:
        nonlocal segment_index
        try:
            transcribe_enabled = False
            while True:
                try:
                    message = await websocket.receive_json()
                    mtype = message.get("type") if isinstance(message, dict) else None
                except WebSocketDisconnect:
                    break
                except Exception as e:
                    print(f"WS error receive_json: {e}")
                    break

                if mtype == "hello":
                    await websocket.send_json({"type": "ready"})
                    continue
                if mtype == "ping":
                    await websocket.send_json({"type": "pong", "ts": now_ms()})
                    continue
                if mtype == "ping_start":
                    await websocket.send_json({"type": "ack", "what": "start"})
                    continue
                if mtype == "ping_stop":
                    await websocket.send_json({"type": "ack", "what": "stop"})
                    continue
                if mtype == "transcribe":
                    transcribe_enabled = bool(message.get("enabled", False))
                    await websocket.send_json({"type": "ack", "what": "transcribe", "enabled": transcribe_enabled})
                    if transcribe_enabled:
                        await websocket.send_json({
                            "type": "auth",
                            "ready": bool(app_state.speech_client and app_state.streaming_config),
                            "info": app_state.auth_info or {}
                        })
                        await websocket.send_json({"type": "status", "message": "Transcribing... awaiting results"})
                    continue
                if mtype == "full_upload" and message.get("audio"):
                    try:
                        decoded_full = base64.b64decode(message.get("audio"))
                        # Choose extension based on client-declared mime type
                        try:
                            client_mime = (message.get("mime") or "").lower()
                            new_ext = "ogg" if ("ogg" in client_mime) else "webm"
                        except Exception:
                            new_ext = "webm"
                        # If ext changes, update filename/filepath before writing
                        nonlocal server_ext, server_filename, server_filepath
                        if new_ext != server_ext:
                            server_ext = new_ext
                            server_filename = f"recording_{session_ts}.{server_ext}"
                            server_filepath = os.path.join(recordings_dir, server_filename)
                        try:
                            if not server_file.closed:
                                server_file.close()
                        except Exception:
                            pass
                        with open(server_filepath, "wb") as sf:
                            sf.write(decoded_full)
                        saved_url = f"/static/recordings/{server_filename}"
                        await websocket.send_json({"type": "saved", "url": saved_url, "size": len(decoded_full)})
                    except Exception as e:
                        print(f"WS error full_upload: {e}")
                    continue
                if "end_stream" in message and message["end_stream"]:
                    try:
                        if not server_file.closed:
                            server_file.flush(); server_file.close()
                        saved_url = f"/static/recordings/{server_filename}"
                        size_bytes = 0
                        try:
                            size_bytes = os.path.getsize(server_filepath)
                        except Exception:
                            pass
                        await websocket.send_json({"type": "saved", "url": saved_url, "size": size_bytes})
                    except Exception as e:
                        print(f"WS error end_stream save: {e}")
                    break

                audio_data_b64 = message.get("audio")
                pcm_b64 = message.get("pcm16")
                if mtype == "segment" and audio_data_b64:
                    try:
                        seg_bytes = base64.b64decode(audio_data_b64)
                        client_mime = (message.get("mime") or "").lower()
                        seg_ext = "ogg" if ("ogg" in client_mime) else "webm"
                        seg_path = os.path.join(session_dir, f"segment_{segment_index}.{seg_ext}")
                        with open(seg_path, "wb") as sf:
                            sf.write(seg_bytes)
                        seg_url = f"/static/recordings/session_{session_ts}/segment_{segment_index}.{seg_ext}"
                        client_id = message.get("id")
                        client_ts = message.get("ts") or now_ms()
                        await websocket.send_json({
                            "type": "segment_saved",
                            "idx": segment_index,
                            "url": seg_url,
                            "id": client_id,
                            "ts": client_ts,
                            "status": "ws_ok",
                            "ext": seg_ext,
                            "mime": client_mime,
                            "size": len(seg_bytes)
                        })
                        # Dispatch Google STT per-segment
                        if transcribe_enabled and service_enabled("google") and app_state.speech_client is not None:
                            async def do_google(idx: int, b: bytes, ext: str):
                                try:
                                    text = await recognize_google_segment(app_state.speech_client, b, ext)
                                    await websocket.send_json({"type": "segment_transcript_google", "idx": idx, "transcript": text, "id": client_id, "ts": client_ts})
                                    await websocket.send_json({"type": "segment_transcript", "idx": idx, "transcript": text, "id": client_id, "ts": client_ts})
                                except Exception as e:
                                    print(f"WS error google segment: {e}")
                            asyncio.create_task(do_google(segment_index, seg_bytes, seg_ext))
                        # Dispatch Vertex per-segment if available
                        if transcribe_enabled and service_enabled("vertex") and app_state.vertex_client is not None:
                            async def do_vertex(idx: int, b: bytes, ext: str):
                                try:
                                    order = ["audio/ogg", "audio/webm"] if ext == "ogg" else ["audio/webm", "audio/ogg"]
                                    text = ""
                                    if lc_vertex_available():
                                        for mt in order:
                                            text = transcribe_segment_via_langchain(app_state.vertex_client, app_state.vertex_model_name, b, mt)
                                            if text:
                                                break
                                    else:
                                        resp = None
                                        last_exc = None
                                        for mt in order:
                                            try:
                                                resp = app_state.vertex_client.models.generate_content(
                                                    model=app_state.vertex_model_name,
                                                    contents=build_vertex_contents(b, mt)
                                                )
                                                break
                                            except Exception as ie:
                                                last_exc = ie
                                                continue
                                        if resp is None and last_exc:
                                            raise last_exc
                                        text = extract_text_from_vertex_response(resp)
                                    await websocket.send_json({"type": "segment_transcript_vertex", "idx": idx, "transcript": text, "id": client_id, "ts": client_ts})
                                except Exception as e:
                                    print(f"WS error vertex segment: {e}")
                            asyncio.create_task(do_vertex(segment_index, seg_bytes, seg_ext))
                        # Dispatch Gemini API per-segment if available
                        if transcribe_enabled and service_enabled("gemini") and app_state.gemini_model is not None:
                            async def do_gemini(idx: int, b: bytes, ext: str):
                                try:
                                    order = ["audio/ogg", "audio/webm"] if ext == "ogg" else ["audio/webm", "audio/ogg"]
                                    resp = None
                                    last_exc = None
                                    for mt in order:
                                        try:
                                            resp = app_state.gemini_model.generate_content([
                                                {"text": "Transcribe the spoken audio to plain text. Return only the transcript."},
                                                {"mime_type": mt, "data": b}
                                            ])
                                            break
                                        except Exception as ie:
                                            last_exc = ie
                                            continue
                                    if resp is None and last_exc:
                                        raise last_exc
                                    text = extract_text_from_gemini_response(resp)
                                    await websocket.send_json({"type": "segment_transcript_gemini", "idx": idx, "transcript": text, "id": client_id, "ts": client_ts})
                                except Exception as e:
                                    print(f"WS error gemini segment: {e}")
                            asyncio.create_task(do_gemini(segment_index, seg_bytes, seg_ext))

                        # Dispatch AWS Transcribe (placeholder) if enabled and available
                        if transcribe_enabled and service_enabled("aws") and aws_transcribe.is_available():
                            async def do_aws(idx: int, b: bytes, ext: str):
                                try:
                                    # Placeholder returns empty string; can be expanded to S3+job flow
                                    text = aws_transcribe.recognize_segment_placeholder(b, media_format=("ogg" if ext=="ogg" else "webm"))
                                    await websocket.send_json({"type": "segment_transcript_aws", "idx": idx, "transcript": text, "id": client_id, "ts": client_ts})
                                except Exception as e:
                                    print(f"WS error aws segment: {e}")
                            asyncio.create_task(do_aws(segment_index, seg_bytes, seg_ext))
                        segment_index += 1
                    except Exception as e:
                        print(f"WS error segment save: {e}")
                    continue

                if audio_data_b64:
                    try:
                        decoded_chunk = base64.b64decode(audio_data_b64)
                        server_file.write(decoded_chunk); server_file.flush()
                    except Exception as e:
                        print(f"WS error writing chunk: {e}")
                elif pcm_b64 and transcribe_enabled and app_state.speech_client and app_state.streaming_config:
                    try:
                        raw = base64.b64decode(pcm_b64)
                        pcm_requests_q.put(raw)
                    except Exception as e:
                        print(f"WS error pcm16: {e}")
                else:
                    await websocket.send_json({"type": "ack"})
        finally:
            try:
                if not server_file.closed:
                    server_file.close()
            except Exception:
                pass

    await receive_from_frontend()


