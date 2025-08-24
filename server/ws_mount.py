from starlette.applications import Starlette
from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocket

from server.ws import ws_handler


async def ws_endpoint(websocket: WebSocket):
    # Explicitly accept the connection here to avoid implicit-accept race
    await websocket.accept()
    await ws_handler(websocket)


star_ws_app = Starlette(routes=[WebSocketRoute('/', ws_endpoint)])


