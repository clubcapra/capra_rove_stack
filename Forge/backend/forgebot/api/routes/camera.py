"""Camera device management — RTSP add, connect (register with go2rtc),
list, drop. The frontend talks WebRTC directly to go2rtc on its API
port, so all this layer does is bookkeeping + spawning the bridge."""

from __future__ import annotations

import logging
import re
import time

import urllib.error
import urllib.parse
import urllib.request

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ...integrations.camera.go2rtc_manager import get_manager
from ...integrations.camera.registry import CameraDevice, get_registry

router = APIRouter(prefix="/api/v1/cameras", tags=["cameras"])

_log = logging.getLogger(__name__)
_SLUG_RE = re.compile(r"[^a-z0-9_]+")


def _slug(s: str) -> str:
    return _SLUG_RE.sub("_", s.lower()).strip("_") or "cam"


def _id_from_url(url: str, name: str | None) -> str:
    if name:
        return f"cam_{_slug(name)}"
    # Fall back to host:port from the URL.
    m = re.search(r"://(?:[^@]*@)?([^/:]+)(?::(\d+))?", url)
    if m:
        host = m.group(1)
        port = m.group(2) or ""
        suffix = f"{host}_{port}" if port else host
        return f"cam_{_slug(suffix)}"
    return f"cam_{int(time.time())}"


@router.get("/devices")
async def list_devices() -> list[dict]:
    """Snapshot of the registry, refreshed with go2rtc's live counters
    so the UI can show consumer counts and bytes-received without a
    second round-trip."""
    reg = get_registry()
    mgr = get_manager()
    snap = await mgr.snapshot() if mgr.running else {}
    out: list[dict] = []
    for d in reg.list():
        info = snap.get(d.stream_id) or snap.get(d.id)
        if isinstance(info, dict):
            try:
                # go2rtc reports `consumers` as a number, plus a list of
                # producers with `recv` (bytes received). Sum across.
                producers = info.get("producers") or []
                d.bytes_recv = sum(
                    int(p.get("recv", 0) or 0) for p in producers
                )
                d.consumers = int(info.get("consumers", 0) or 0)
                # Any producer activity = healthy stream.
                if producers:
                    d.last_seen_us = int(time.time() * 1_000_000)
            except (TypeError, ValueError):
                pass
        out.append(d.to_dict())
    return out


class AddDeviceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rtsp_url: str = Field(..., description="rtsp://[user:pass@]host[:port]/path")
    name: str | None = None


@router.post("/devices", status_code=201)
def add_device(body: AddDeviceRequest) -> dict:
    if not body.rtsp_url.startswith(("rtsp://", "rtsps://", "http://", "https://")):
        raise HTTPException(status_code=400, detail="URL must start with rtsp:// or rtsps://")
    reg = get_registry()
    device_id = _id_from_url(body.rtsp_url, body.name)
    if reg.get(device_id):
        raise HTTPException(
            status_code=409,
            detail=f"camera {device_id!r} already registered (rename to add a second)",
        )
    dev = CameraDevice(
        id=device_id,
        name=body.name or device_id,
        rtsp_url=body.rtsp_url,
        stream_id=device_id,
    )
    reg.add(dev)
    return dev.to_dict()


@router.delete("/devices/{device_id}")
async def delete_device(device_id: str) -> dict:
    reg = get_registry()
    dev = reg.get(device_id)
    if dev is None:
        raise HTTPException(status_code=404, detail=device_id)
    if dev.status == "connected":
        try:
            await get_manager().remove_stream(dev.stream_id)
        except Exception as e:  # noqa: BLE001
            _log.warning("go2rtc remove_stream failed for %s: %s", device_id, e)
    reg.remove(device_id)
    return {"ok": True}


@router.post("/devices/{device_id}/connect")
async def connect_device(device_id: str) -> dict:
    reg = get_registry()
    dev = reg.get(device_id)
    if dev is None:
        raise HTTPException(status_code=404, detail=device_id)
    if dev.status == "connected":
        return dev.to_dict()
    reg.set_status(device_id, "connecting")
    try:
        mgr = get_manager()
        await mgr.add_stream(dev.stream_id, dev.rtsp_url)
    except Exception as e:  # noqa: BLE001
        msg = str(e) or type(e).__name__
        reg.set_status(device_id, "error", error=msg)
        _log.warning("camera %s connect failed: %s", device_id, msg)
        raise HTTPException(status_code=502, detail=msg) from e
    reg.set_status(device_id, "connected")
    return dev.to_dict()


@router.post("/devices/{device_id}/disconnect")
async def disconnect_device(device_id: str) -> dict:
    reg = get_registry()
    dev = reg.get(device_id)
    if dev is None:
        raise HTTPException(status_code=404, detail=device_id)
    try:
        await get_manager().remove_stream(dev.stream_id)
    except Exception as e:  # noqa: BLE001
        _log.warning("go2rtc remove_stream failed for %s: %s", device_id, e)
    reg.set_status(device_id, "idle", error=None)
    dev.bytes_recv = 0
    dev.consumers = 0
    return dev.to_dict()


@router.get("/runtime")
def runtime_info() -> dict:
    """Expose go2rtc port info — used by the frontend mostly for
    diagnostics. WebRTC signaling itself is proxied through this app
    so the browser only ever has to know about /api/v1/cameras/...."""
    mgr = get_manager()
    return {
        "running": mgr.running,
        "api_port": mgr.api_port,
        "webrtc_port": mgr.webrtc_port,
    }


@router.get("/stream/{stream_id}.mjpeg")
async def stream_mjpeg(stream_id: str) -> StreamingResponse:
    """Proxy go2rtc's `/api/stream.mjpeg?src=...` MJPEG endpoint.

    The browser plays this directly via `<img src="...">` (multipart
    MJPEG auto-refreshes the image as new JPEGs arrive). go2rtc handles
    decode + JPEG re-encode internally — works regardless of the source
    camera's video codec (H264, H265, MJPEG).

    StreamingResponse holds the upstream connection open and forwards
    chunks as they arrive. The httpx context is closed only when the
    generator finishes (client disconnect or upstream end-of-stream).
    """
    mgr = get_manager()
    if not mgr.running:
        raise HTTPException(
            status_code=503,
            detail="go2rtc is not running — connect a camera first",
        )
    upstream = (
        f"http://127.0.0.1:{mgr.api_port}/api/stream.mjpeg?"
        f"{urllib.parse.urlencode({'src': stream_id})}"
    )

    async def gen():
        async with httpx.AsyncClient(timeout=None) as client:
            try:
                async with client.stream("GET", upstream) as r:
                    if r.status_code != 200:
                        return
                    # 64 KB chunks: large enough that a typical 1080p
                    # JPEG (50-200 KB) fits in 1-3 chunks, low enough
                    # that latency stays well under 100 ms per frame.
                    async for chunk in r.aiter_bytes(chunk_size=65536):
                        yield chunk
            except (httpx.RemoteProtocolError, httpx.ReadError):
                # Client disconnected or upstream closed — fine, just
                # let the generator finish.
                return

    # Probe upstream once to grab its content-type (multipart boundary).
    try:
        async with httpx.AsyncClient(timeout=2.0) as probe:
            head = await probe.head(upstream)
            ct = head.headers.get(
                "content-type", "multipart/x-mixed-replace; boundary=frame"
            )
    except httpx.HTTPError:
        ct = "multipart/x-mixed-replace; boundary=frame"

    return StreamingResponse(gen(), media_type=ct)


@router.post("/webrtc/{stream_id}")
async def webrtc_offer(stream_id: str, request: Request) -> Response:
    """WHEP-style WebRTC handshake: POST an SDP offer, get the SDP
    answer back. We forward the body to go2rtc's /api/webrtc endpoint
    on its dynamic API port so the browser only needs to know about
    /api/v1/cameras/webrtc/{stream}.

    The actual media still flows directly between the browser and
    go2rtc's WebRTC port (UDP) — only the signaling round-trip goes
    through here."""
    mgr = get_manager()
    if not mgr.running:
        raise HTTPException(
            status_code=503,
            detail="go2rtc is not running — connect a camera first",
        )
    body = await request.body()
    params = urllib.parse.urlencode({"src": stream_id})
    url = f"http://127.0.0.1:{mgr.api_port}/api/webrtc?{params}"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": request.headers.get(
            "content-type", "application/sdp"
        )},
    )
    try:
        with urllib.request.urlopen(req, timeout=5.0) as r:
            answer = r.read()
            ct = r.headers.get("content-type", "application/sdp")
            return Response(content=answer, media_type=ct)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            detail = str(e)
        raise HTTPException(status_code=e.code, detail=detail) from e
    except urllib.error.URLError as e:
        raise HTTPException(
            status_code=502, detail=f"go2rtc unreachable: {e}"
        ) from e
