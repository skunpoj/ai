"""
server/sse_bus.py

Simple in-memory SSE bus for broadcasting UI events to all connected clients.
Not multi-tenant secure; sufficient for single-app instance.
"""
import asyncio
import json
from typing import AsyncIterator, List


_subscribers: List[asyncio.Queue] = []
_lock = asyncio.Lock()


async def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    async with _lock:
        _subscribers.append(q)
    return q


async def unsubscribe(q: asyncio.Queue) -> None:
    async with _lock:
        try:
            _subscribers.remove(q)
        except ValueError:
            pass


async def publish(message: dict) -> None:
    data = json.dumps(message)
    async with _lock:
        for q in list(_subscribers):
            try:
                q.put_nowait(data)
            except Exception:
                continue


async def stream() -> AsyncIterator[bytes]:
    q = await subscribe()
    try:
        while True:
            try:
                data = await q.get()
            except asyncio.CancelledError:
                break
            # If payload has a 'type', emit a named SSE event for easier client routing
            try:
                obj = json.loads(data)
                ev = obj.get("type") if isinstance(obj, dict) else None
            except Exception:
                ev = None
            if ev and isinstance(ev, str):
                yield f"event: {ev}\n".encode("utf-8")
            yield f"data: {data}\n\n".encode("utf-8")
    finally:
        await unsubscribe(q)


