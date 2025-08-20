"""
Archived legacy inline websocket logic originally kept inside app.py.
Preserved strictly for future reference. Not imported or executed.
"""
import os
import base64
import json
import queue
import time
import asyncio
from starlette.websockets import WebSocket, WebSocketDisconnect
from google.cloud import speech


def get_current_time() -> int:
    return int(round(time.time() * 1000))


async def legacy_ws_handler(websocket: WebSocket, global_speech_client, global_streaming_config, global_auth_info):
    requests_q = queue.Queue()
    pcm_requests_q = queue.Queue()

    recordings_dir = os.path.join("static", "recordings")
    os.makedirs(recordings_dir, exist_ok=True)
    session_ts = get_current_time()
    server_filename = f"recording_{session_ts}.webm"
    server_filepath = os.path.join(recordings_dir, server_filename)
    server_file = open(server_filepath, "ab")

    session_chunks_dir = os.path.join(recordings_dir, f"session_{session_ts}")
    os.makedirs(session_chunks_dir, exist_ok=True)
    chunk_index = 0
    session_segments_dir = os.path.join(recordings_dir, f"session_{session_ts}")
    os.makedirs(session_segments_dir, exist_ok=True)
    segment_index = 0

    async def receive_from_frontend():
        nonlocal chunk_index, segment_index
        try:
            transcribe_enabled = False
            stream_started = False
            stream_task = None
            while True:
                try:
                    message = await websocket.receive_json()
                    mtype = message.get("type")
                except WebSocketDisconnect:
                    break
                except Exception:
                    break

                if mtype == "hello":
                    await websocket.send_json({"type": "ready"})
                    continue
                if mtype == "ping":
                    await websocket.send_json({"type": "pong", "ts": get_current_time()})
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
                            "ready": bool(global_speech_client and global_streaming_config),
                            "info": global_auth_info or {}
                        })
                        await websocket.send_json({"type": "status", "message": "Transcribing... awaiting results"})
                    continue

                if mtype == "full_upload" and message.get("audio"):
                    try:
                        decoded_full = base64.b64decode(message.get("audio"))
                        try:
                            if not server_file.closed:
                                server_file.close()
                        except Exception:
                            pass
                        with open(server_filepath, "wb") as sf:
                            sf.write(decoded_full)
                        saved_url = f"/static/recordings/{server_filename}"
                        await websocket.send_json({"type": "saved", "url": saved_url, "size": len(decoded_full)})
                    except Exception:
                        pass
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
                    except Exception:
                        pass
                    break

                audio_data_b64 = message.get("audio")
                pcm_b64 = message.get("pcm16")
                if mtype == "segment" and audio_data_b64:
                    try:
                        seg_bytes = base64.b64decode(audio_data_b64)
                        client_mime = (message.get("mime") or "").lower()
                        seg_ext = "ogg" if ("ogg" in client_mime) else "webm"
                        seg_path = os.path.join(session_segments_dir, f"segment_{segment_index}.{seg_ext}")
                        with open(seg_path, "wb") as sf:
                            sf.write(seg_bytes)
                        seg_url = f"/static/recordings/session_{session_ts}/segment_{segment_index}.{seg_ext}"
                        client_id = message.get("id")
                        client_ts = message.get("ts") or get_current_time()
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
                        segment_index += 1
                    except Exception:
                        pass
                    continue

                if audio_data_b64:
                    try:
                        decoded_chunk = base64.b64decode(audio_data_b64)
                        server_file.write(decoded_chunk); server_file.flush()
                    except Exception:
                        pass
                elif pcm_b64 and transcribe_enabled and global_speech_client and global_streaming_config:
                    try:
                        raw = base64.b64decode(pcm_b64)
                        pcm_requests_q.put(raw)
                    except Exception:
                        pass
                else:
                    await websocket.send_json({"type": "ack"})
        finally:
            try:
                if not server_file.closed:
                    server_file.close()
            except Exception:
                pass

    await receive_from_frontend()


