"""Camera device registry.

Mirrors the lidar registry shape so the Simulate panel can use the same
discover/add/connect/bind UX. Differences from lidar:

  * No async per-device task — go2rtc owns the RTSP→WebRTC bridge as a
    single subprocess. The registry just tracks descriptors and tells
    the manager when to add/remove streams.
  * No network discovery — RTSP cameras don't broadcast. Devices are
    added by URL.
  * Connect = register with go2rtc; disconnect = unregister. Live
    diagnostics (frame rate, bytes) come from go2rtc's API, not us.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Literal

_log = logging.getLogger(__name__)


DeviceStatus = Literal["idle", "connecting", "connected", "error"]


@dataclass
class CameraDevice:
    id: str
    name: str
    # Full RTSP URL with embedded creds, e.g. rtsp://user:pass@192.168.2.30:554/...
    # Stored as-is; go2rtc parses it.
    rtsp_url: str
    # Frontend stream id — also used as the go2rtc stream name (so the
    # browser can request /api/ws?src={stream_id}).
    stream_id: str = ""
    # Optional metadata. Probed once on connect (ffprobe) and cached.
    image_width: int = 0
    image_height: int = 0
    codec: str = ""

    status: DeviceStatus = "idle"
    error: str | None = None

    # Live counters from go2rtc's /api/streams. Refreshed by the manager.
    bytes_recv: int = 0
    consumers: int = 0  # how many WebRTC peers currently watching
    last_seen_us: int = 0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name or self.id,
            "rtsp_url": _redact(self.rtsp_url),
            "stream_id": self.stream_id or self.id,
            "image_width": self.image_width,
            "image_height": self.image_height,
            "codec": self.codec,
            "status": self.status,
            "error": self.error,
            "bytes_recv": self.bytes_recv,
            "consumers": self.consumers,
            "last_seen_us": self.last_seen_us,
        }


def _redact(url: str) -> str:
    """Mask the password in an RTSP URL before sending to the frontend.
    Keeps `rtsp://user:***@host:port/path` shape so the user can still
    confirm at a glance which device they're looking at."""
    try:
        scheme, rest = url.split("://", 1)
    except ValueError:
        return url
    if "@" not in rest:
        return url
    creds, host = rest.split("@", 1)
    if ":" in creds:
        user, _pw = creds.split(":", 1)
        creds = f"{user}:***"
    return f"{scheme}://{creds}@{host}"


class CameraRegistry:
    def __init__(self) -> None:
        self._devices: dict[str, CameraDevice] = {}

    def list(self) -> list[CameraDevice]:
        return list(self._devices.values())

    def get(self, device_id: str) -> CameraDevice | None:
        return self._devices.get(device_id)

    def add(self, device: CameraDevice) -> CameraDevice:
        if device.id in self._devices:
            raise ValueError(f"camera {device.id!r} already registered")
        if not device.stream_id:
            device.stream_id = device.id
        self._devices[device.id] = device
        return device

    def remove(self, device_id: str) -> bool:
        return self._devices.pop(device_id, None) is not None

    def set_status(
        self,
        device_id: str,
        status: DeviceStatus,
        error: str | None = None,
    ) -> None:
        d = self._devices.get(device_id)
        if d is not None:
            d.status = status
            d.error = error


_registry: CameraRegistry | None = None


def get_registry() -> CameraRegistry:
    global _registry
    if _registry is None:
        _registry = CameraRegistry()
    return _registry
