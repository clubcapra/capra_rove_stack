"""Lidar device management — discover, manually add, connect, drop.

Connected devices stream point packets directly into the in-process
lidar bus, which the Simulate / Map pages already subscribe to.
"""

from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

# Side-effect import: registers the Mid360 adapter on the kind registry.
from ...integrations.lidar import livox_mid360
from ...integrations.lidar.registry import (
    LidarDevice,
    get_registry,
)
from ...integrations.lidar.registry import list_kinds as _list_kinds

router = APIRouter(prefix="/api/v1/lidar", tags=["lidar"])

_SLUG_RE = re.compile(r"[^a-z0-9_]+")


def _slug(s: str) -> str:
    return _SLUG_RE.sub("_", s.lower()).strip("_") or "lidar"


@router.get("/kinds")
def list_lidar_kinds() -> list[str]:
    """Lidar adapter kinds the backend knows how to talk to. Drives
    the type-select dropdown in the BindingsPanel."""
    return _list_kinds()


@router.get("/devices")
def list_devices() -> list[dict]:
    return [d.to_dict() for d in get_registry().list()]


class ScanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = "livox_mid360"
    timeout_s: float = 3.0


@router.post("/scan")
async def scan(body: ScanRequest) -> list[dict]:
    """Run a network discovery scan for one device kind. Mid-360 listens
    for UDP broadcasts on port 56000 — bind succeeds only if nothing
    else is using that port (some systems may refuse without privileges).
    Returns every device found; same device can come back from multiple
    scans, the registry deduplicates by id."""
    reg = get_registry()
    found = await reg.scan(body.kind, body.timeout_s)
    return [d.to_dict() for d in found]


class AddDeviceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = "livox_mid360"
    ip: str
    name: str | None = None
    port_data: int | None = None
    port_imu: int | None = None
    port_cmd: int | None = None
    serial: str | None = None
    stream_id: str | None = None


@router.post("/devices", status_code=201)
def add_device(body: AddDeviceRequest) -> dict:
    """Manually register a device by IP. Use when scan can't find it
    (different subnet, multicast blocked, etc.). Default ports follow
    the Livox SDK2 host-side convention: host listens on lidar's
    push-target port, which is `lidar_listen_port + 1` (Mid-360 →
    host listens 56301 for points, 56401 for IMU)."""
    reg = get_registry()
    device_id = f"{body.kind}_{_slug(body.ip)}"
    if reg.get(device_id):
        raise HTTPException(
            status_code=409, detail=f"device {device_id!r} already registered"
        )
    dev = LidarDevice(
        id=device_id,
        kind=body.kind,
        ip=body.ip,
        name=body.name or f"{body.kind} {body.ip}",
        port_data=body.port_data or 56301,
        port_imu=body.port_imu or 56401,
        port_cmd=body.port_cmd or 56100,
        serial=body.serial,
        stream_id=body.stream_id or device_id,
        discovered=False,
    )
    reg.upsert(dev)
    return dev.to_dict()


@router.delete("/devices/{device_id}")
async def delete_device(device_id: str) -> dict:
    ok = await get_registry().drop(device_id)
    if not ok:
        raise HTTPException(status_code=404, detail=device_id)
    return {"ok": True}


@router.post("/devices/{device_id}/connect")
async def connect_device(device_id: str) -> dict:
    reg = get_registry()
    if reg.get(device_id) is None:
        raise HTTPException(status_code=404, detail=device_id)
    dev = await reg.connect(device_id)
    return dev.to_dict()


@router.post("/devices/{device_id}/disconnect")
async def disconnect_device(device_id: str) -> dict:
    reg = get_registry()
    if reg.get(device_id) is None:
        raise HTTPException(status_code=404, detail=device_id)
    dev = await reg.disconnect(device_id)
    if dev is None:
        raise HTTPException(status_code=404, detail=device_id)
    return dev.to_dict()


class ConfigureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    host_ip: str | None = None  # override the auto-detected host IP


@router.post("/devices/{device_id}/configure")
def configure_device(
    device_id: str, body: ConfigureRequest = ConfigureRequest()
) -> dict:
    """Send a Livox SDK2 control command sequence to the Mid-360,
    telling it to push points to (host_ip, port_data) and enter NORMAL
    work mode. `host_ip` is optional — falls back to auto-detection
    via the route to the lidar. Override when the auto-detect picks
    the wrong interface (Docker bridge etc.)."""
    reg = get_registry()
    dev = reg.get(device_id)
    if dev is None:
        raise HTTPException(status_code=404, detail=device_id)
    if dev.kind != "livox_mid360":
        raise HTTPException(
            status_code=400,
            detail=f"configure not implemented for kind {dev.kind!r}",
        )
    ok, msg = livox_mid360.push_start_command(dev, override_host_ip=body.host_ip)
    if ok and body.host_ip:
        # Reflect what we told the lidar so the UI shows the same value.
        dev.host_ip = body.host_ip
    return {"ok": ok, "message": msg, "device": dev.to_dict()}
