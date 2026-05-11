"""Event bus: Observer pattern for scene change notifications.

Anything that mutates the project (commands, imports) publishes an event
to the bus. WebSocket connections subscribe and forward to clients.

Events are plain dicts so they JSON-serialize directly.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Event:
    type: str
    payload: dict[str, Any]


class EventBus:
    """Fan-out pubsub. Each subscriber gets its own asyncio.Queue."""

    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue[Event]] = []

    def publish(self, event_type: str, **payload: Any) -> None:
        evt = Event(type=event_type, payload=payload)
        # Best-effort: drop on slow consumers rather than blocking.
        for q in list(self._subscribers):
            try:
                q.put_nowait(evt)
            except asyncio.QueueFull:
                pass

    async def subscribe(self) -> AsyncIterator[Event]:
        q: asyncio.Queue[Event] = asyncio.Queue(maxsize=256)
        self._subscribers.append(q)
        try:
            while True:
                yield await q.get()
        finally:
            if q in self._subscribers:
                self._subscribers.remove(q)
