"""Lidar point-stream bus.

Producers (livox drivers, recorded files, simulators) push binary point
batches to `/ws/lidar/ingest/{stream_id}`. Subscribers (Simulate page,
Map page) listen on `/ws/lidar/sub` and receive every batch tagged with
its stream_id. Stays purely byte-pumping in the hot path — no JSON
parsing, no copies — so a livox mid360 at ~200k pts/sec is comfortable.

Wire format (all little-endian):
    push frame  : [u32 magic=0x504C4E54 'PLNT'][u8 stream_id_len]
                  [stream_id ascii][u64 t_us][u32 n_pts]
                  [f32 × 4 × n_pts]    # x, y, z, intensity (lidar local frame)
    sub frame   : same bytes, forwarded as-is.

Lidar-local frame; the renderer transforms by the bound entity's world
pose so two devices on different mount points compose correctly.
"""

from __future__ import annotations

import asyncio
import struct
from collections import defaultdict
from dataclasses import dataclass

PUSH_MAGIC = 0x504C4E54


@dataclass
class _Subscriber:
    queue: asyncio.Queue[bytes]


class LidarBus:
    def __init__(self, max_queue: int = 8) -> None:
        self._subs: list[_Subscriber] = []
        self._lock = asyncio.Lock()
        self._max_queue = max_queue
        # Most-recent batch per stream so a fresh subscriber can render
        # something within one frame instead of waiting for the next push.
        self._last: dict[str, bytes] = {}
        # Stream stats for diagnostics.
        self._counters: dict[str, dict[str, int | float]] = defaultdict(
            lambda: {"batches": 0, "points": 0, "last_t_us": 0}
        )

    async def subscribe(self) -> _Subscriber:
        sub = _Subscriber(queue=asyncio.Queue(maxsize=self._max_queue))
        async with self._lock:
            self._subs.append(sub)
            for cached in self._last.values():
                try:
                    sub.queue.put_nowait(cached)
                except asyncio.QueueFull:
                    break
        return sub

    async def unsubscribe(self, sub: _Subscriber) -> None:
        async with self._lock:
            if sub in self._subs:
                self._subs.remove(sub)

    async def publish(self, frame: bytes, stream_id: str, n_pts: int, t_us: int) -> None:
        self._last[stream_id] = frame
        c = self._counters[stream_id]
        c["batches"] = int(c["batches"]) + 1
        c["points"] = int(c["points"]) + n_pts
        c["last_t_us"] = t_us
        async with self._lock:
            dead: list[_Subscriber] = []
            for sub in self._subs:
                try:
                    sub.queue.put_nowait(frame)
                except asyncio.QueueFull:
                    # Slow consumer: drop the oldest, keep the newest.
                    try:
                        sub.queue.get_nowait()
                        sub.queue.put_nowait(frame)
                    except (asyncio.QueueEmpty, asyncio.QueueFull):
                        dead.append(sub)
            for d in dead:
                self._subs.remove(d)

    def stats(self) -> dict[str, dict[str, int | float]]:
        return {k: dict(v) for k, v in self._counters.items()}


_bus: LidarBus | None = None


def get_lidar_bus() -> LidarBus:
    global _bus
    if _bus is None:
        _bus = LidarBus()
    return _bus


def encode_frame(stream_id: str, t_us: int, xyzi: list[float]) -> bytes:
    """Pack a frame from a Python list. Drivers in Python can call this;
    a C/C++ driver would write the same layout directly."""
    sid = stream_id.encode("ascii")
    if len(sid) > 255:
        raise ValueError("stream_id too long")
    n_pts = len(xyzi) // 4
    if len(xyzi) != n_pts * 4:
        raise ValueError("xyzi must be 4*n floats: x, y, z, intensity")
    header = struct.pack(
        f"<IB{len(sid)}sQI", PUSH_MAGIC, len(sid), sid, t_us, n_pts
    )
    body = struct.pack(f"<{len(xyzi)}f", *xyzi)
    return header + body


def parse_header(frame: bytes) -> tuple[str, int, int]:
    """Returns (stream_id, t_us, n_pts). Raises ValueError on bad magic."""
    magic, sid_len = struct.unpack_from("<IB", frame, 0)
    if magic != PUSH_MAGIC:
        raise ValueError(f"bad magic {magic:08x}")
    sid_end = 5 + sid_len
    sid = frame[5:sid_end].decode("ascii")
    t_us, n_pts = struct.unpack_from("<QI", frame, sid_end)
    return sid, t_us, n_pts
