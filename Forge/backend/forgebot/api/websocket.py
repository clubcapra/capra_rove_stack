"""WebSocket endpoints: events bus + lidar point streams.

* `/ws/events`              — JSON event broadcast.
* `/ws/lidar/ingest/{sid}`  — binary push from a lidar driver.
* `/ws/lidar/sub`           — binary subscriber (Simulate / Map pages).

Lidar protocol is documented in `lidar_bus.py`. Hot path is byte-pumping
only; we never decode point data on the server.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .lidar_bus import get_lidar_bus, parse_header
from .state import get_state

router = APIRouter()


@router.websocket("/ws/events")
async def events_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    state = get_state()
    try:
        async for event in state.events.subscribe():
            await websocket.send_json({"type": event.type, "payload": event.payload})
    except WebSocketDisconnect:
        return
    except asyncio.CancelledError:
        return


@router.websocket("/ws/lidar/ingest/{stream_id}")
async def lidar_ingest(websocket: WebSocket, stream_id: str) -> None:
    """Driver pushes binary frames; we forward to all subscribers.

    Header sid must match the URL `stream_id` (sanity check). Bad frames
    close the socket so misconfigured drivers fail fast.
    """
    await websocket.accept()
    bus = get_lidar_bus()
    try:
        while True:
            frame = await websocket.receive_bytes()
            try:
                sid, t_us, n_pts = parse_header(frame)
            except (ValueError, IndexError) as e:
                await websocket.close(code=1003, reason=f"bad frame: {e}")
                return
            if sid != stream_id:
                await websocket.close(
                    code=1008, reason=f"sid mismatch {sid!r} vs {stream_id!r}"
                )
                return
            await bus.publish(frame, sid, n_pts, t_us)
    except WebSocketDisconnect:
        return
    except asyncio.CancelledError:
        return


@router.websocket("/ws/lidar/sub")
async def lidar_sub(websocket: WebSocket) -> None:
    await websocket.accept()
    bus = get_lidar_bus()
    sub = await bus.subscribe()
    try:
        while True:
            frame = await sub.queue.get()
            await websocket.send_bytes(frame)
    except WebSocketDisconnect:
        return
    except asyncio.CancelledError:
        return
    finally:
        await bus.unsubscribe(sub)
