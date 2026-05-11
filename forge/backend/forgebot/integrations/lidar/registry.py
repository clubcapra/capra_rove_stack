"""Lidar device registry.

A device is anything that can be addressed (typically over UDP) and
streamed into the lidar bus. The registry is in-process, in-memory; it
holds the running asyncio tasks for each connected device and surfaces
their status to the API layer.

Lifecycle:
    register(...)   — add a device descriptor (from scan or manual add)
    connect(id)     — kind-specific adapter starts receiving + decoding
                       UDP packets and pushing them to lidar_bus
    disconnect(id)  — adapter cancels its task; descriptor stays
    drop(id)        — disconnects and removes the descriptor

Extending:
    @register_kind("livox_mid360")
    class Mid360Adapter(LidarDeviceAdapter):
        async def run(self, dev): ...
"""

from __future__ import annotations

import asyncio
import logging
import traceback
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Literal

_log = logging.getLogger(__name__)


DeviceStatus = Literal["idle", "connecting", "connected", "error"]


@dataclass
class LidarDevice:
    id: str
    kind: str  # e.g. "livox_mid360"
    ip: str
    name: str = ""
    # Livox SDK2 convention: lidar listens on port X, pushes to host:X+1.
    # For Mid-360: lidar.point=56300, host.point=56301; lidar.cmd=56100,
    # host.cmd=56101 etc. `port_data` here is the HOST listening port for
    # point data. `port_cmd` is the LIDAR cmd port (where we send to).
    port_data: int = 56301
    port_imu: int = 56401
    port_cmd: int = 56100
    serial: str | None = None
    status: DeviceStatus = "idle"
    error: str | None = None
    discovered: bool = False  # True when found by scan, False when user-added
    stream_id: str = ""
    # Live diagnostics. Filled by the adapter as packets flow.
    packets: int = 0
    bytes: int = 0
    last_packet_t_us: int = 0
    bind_addr: str = ""  # populated once UDP bind succeeds, e.g. "0.0.0.0:56300"
    host_ip: str = ""  # the local IP that's reachable from the lidar's subnet

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "ip": self.ip,
            "name": self.name or self.id,
            "port_data": self.port_data,
            "port_imu": self.port_imu,
            "port_cmd": self.port_cmd,
            "serial": self.serial,
            "status": self.status,
            "error": self.error,
            "discovered": self.discovered,
            "stream_id": self.stream_id,
            "packets": self.packets,
            "bytes": self.bytes,
            "last_packet_t_us": self.last_packet_t_us,
            "bind_addr": self.bind_addr,
            "host_ip": self.host_ip,
        }


class LidarDeviceAdapter(ABC):
    """One per kind. The adapter owns the UDP socket(s), decodes
    packets, and pushes binary frames to the lidar bus."""

    @abstractmethod
    async def run(self, device: LidarDevice) -> None: ...

    async def scan(self, timeout_s: float) -> list[LidarDevice]:  # pragma: no cover
        """Optional. Default: no scanning, return empty list."""
        return []


_KINDS: dict[str, LidarDeviceAdapter] = {}


def register_kind(kind: str):
    def deco(cls: type[LidarDeviceAdapter]):
        _KINDS[kind] = cls()
        return cls

    return deco


def get_kind_adapter(kind: str) -> LidarDeviceAdapter | None:
    return _KINDS.get(kind)


def list_kinds() -> list[str]:
    return list(_KINDS.keys())


@dataclass
class _RunningTask:
    task: asyncio.Task
    cancel: Callable[[], None]


class LidarRegistry:
    def __init__(self) -> None:
        self._devices: dict[str, LidarDevice] = {}
        self._tasks: dict[str, _RunningTask] = {}
        self._lock = asyncio.Lock()

    def list(self) -> list[LidarDevice]:
        return list(self._devices.values())

    def get(self, device_id: str) -> LidarDevice | None:
        return self._devices.get(device_id)

    def upsert(self, device: LidarDevice) -> LidarDevice:
        # If we re-discover the same IP+kind, overwrite the descriptor
        # but keep the running task untouched.
        existing = self._devices.get(device.id)
        if existing and existing.status in ("connecting", "connected"):
            device.status = existing.status
            device.error = existing.error
        self._devices[device.id] = device
        return device

    async def connect(self, device_id: str) -> LidarDevice:
        device = self._devices.get(device_id)
        if device is None:
            raise KeyError(device_id)
        if device.status in ("connecting", "connected"):
            return device
        adapter = get_kind_adapter(device.kind)
        if adapter is None:
            device.status = "error"
            device.error = f"no adapter for kind {device.kind!r}"
            return device
        device.status = "connecting"
        device.error = None

        async def runner() -> None:
            try:
                await adapter.run(device)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                # str(e) is sometimes empty (bare Exception subclasses,
                # OSError(errno=0), etc.) so fall back to the type name.
                device.status = "error"
                msg = str(e) or type(e).__name__
                device.error = msg
                _log.warning(
                    "lidar adapter %s crashed: %s\n%s",
                    device.id,
                    msg,
                    traceback.format_exc(),
                )

        task = asyncio.create_task(runner(), name=f"lidar-{device.id}")
        self._tasks[device_id] = _RunningTask(task=task, cancel=task.cancel)
        return device

    async def disconnect(self, device_id: str) -> LidarDevice | None:
        device = self._devices.get(device_id)
        if device is None:
            return None
        running = self._tasks.pop(device_id, None)
        if running is not None:
            running.cancel()
            try:
                await running.task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
                pass
        device.status = "idle"
        device.error = None
        return device

    async def drop(self, device_id: str) -> bool:
        await self.disconnect(device_id)
        return self._devices.pop(device_id, None) is not None

    async def scan(self, kind: str, timeout_s: float) -> list[LidarDevice]:
        adapter = get_kind_adapter(kind)
        if adapter is None:
            return []
        found = await adapter.scan(timeout_s)
        for d in found:
            d.discovered = True
            self.upsert(d)
        return found


_registry: LidarRegistry | None = None


def get_registry() -> LidarRegistry:
    global _registry
    if _registry is None:
        _registry = LidarRegistry()
    return _registry
