"""Livox Mid360 → ForgeBOT lidar bus driver template.

Run on a machine connected to a Mid360 (or two). Forwards points into
the ForgeBOT backend's WebSocket ingest endpoint, which the Simulate /
Map pages subscribe to.

Two paths:
* Real device — needs the openpylivox / livox-sdk2 Python bindings.
  This file shows the call sites; install the SDK separately and uncomment.
* Synthetic generator — no SDK; emits a swept-rotating ring of points so
  the bus and renderer can be exercised end-to-end. Useful as a
  "hardware loop" until the Mid360s are physically wired up.

Usage:
    python -m forgebot.integrations.livox_mid360 \\
        --backend ws://localhost:8420 \\
        --stream-id mid360_front \\
        --mode synthetic

Two simultaneous streams:
    python -m forgebot.integrations.livox_mid360 --stream-id front --mode synthetic &
    python -m forgebot.integrations.livox_mid360 --stream-id back  --mode synthetic &
"""

from __future__ import annotations

import argparse
import asyncio
import math
import time

from websockets.asyncio.client import connect

from ..api.lidar_bus import encode_frame


async def synthetic_loop(
    ws_url: str,
    stream_id: str,
    rate_hz: float,
    points_per_frame: int,
) -> None:
    period = 1.0 / rate_hz
    t = 0.0
    async with connect(ws_url, max_size=8 * 1024 * 1024) as ws:
        while True:
            frame_t = time.time()
            xyzi: list[float] = []
            # Sweeping ring: a horizontal circle at 1.5m radius rotating
            # in z to simulate a scan pattern. Mid360 actually does a
            # non-repeating Lissajous; this is just to see motion.
            base_phase = (t * 2 * math.pi * 0.5) % (2 * math.pi)
            for i in range(points_per_frame):
                u = i / points_per_frame
                ang = u * 2 * math.pi + base_phase
                z = 0.4 * math.sin(ang * 3 + base_phase)
                r = 1.5 + 0.05 * math.sin(ang * 7)
                xyzi.extend([r * math.cos(ang), r * math.sin(ang), z, 0.5])
            t_us = int(frame_t * 1e6)
            await ws.send(encode_frame(stream_id, t_us, xyzi))
            t += period
            elapsed = time.time() - frame_t
            if elapsed < period:
                await asyncio.sleep(period - elapsed)


async def device_loop(ws_url: str, stream_id: str, host_ip: str) -> None:
    """Real Mid360. Uses livox-sdk2 Python bindings (install separately)."""
    raise NotImplementedError(
        "Wire livox-sdk2 here: subscribe to point cloud callback, "
        "convert each batch to a flat [x,y,z,intensity,...] list in metres, "
        "call encode_frame(stream_id, t_us, xyzi), then ws.send(frame). "
        f"host_ip={host_ip}"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="ws://localhost:8420")
    ap.add_argument("--stream-id", required=True)
    ap.add_argument("--mode", choices=["synthetic", "device"], default="synthetic")
    ap.add_argument("--rate-hz", type=float, default=10.0)
    ap.add_argument("--points-per-frame", type=int, default=2000)
    ap.add_argument("--host-ip", default=None, help="(device) Mid360 IP")
    args = ap.parse_args()

    ws_url = f"{args.backend.rstrip('/')}/ws/lidar/ingest/{args.stream_id}"
    if args.mode == "synthetic":
        asyncio.run(
            synthetic_loop(
                ws_url,
                args.stream_id,
                args.rate_hz,
                args.points_per_frame,
            )
        )
    else:
        asyncio.run(device_loop(ws_url, args.stream_id, args.host_ip or "192.168.1.181"))


if __name__ == "__main__":
    main()
