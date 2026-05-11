"""Livox Mid-360 UDP adapter.

The Mid-360 (firmware ≥1.x, Livox-SDK2) emits binary point cloud
packets over UDP without needing the proprietary control SDK as long
as the device is configured (via Livox Viewer or a one-shot config
push) to send to our host's IP. This adapter:

* Listens on `device.port_data` for point packets, parses them, and
  pushes binary frames into the in-process lidar bus tagged with the
  device's `stream_id`.
* Listens on broadcast 56000 during a scan, parses Mid-360 push-msg
  device-info packets, and reports the responding IPs as `LidarDevice`s.

Packet format we accept (Cartesian Coordinate Type 1, the most common
mode):

    LIVOX_HEADER          (24 bytes — version, length, time_interval, dot_num, ...)
    POINT × dot_num       each point = i32 x_mm, i32 y_mm, i32 z_mm, u8 reflectivity, u8 tag

Other point types (spherical, dual-return, IMU) are skipped quietly.
"""

from __future__ import annotations

import asyncio
import socket
import struct
import time

from ...api.lidar_bus import encode_frame, get_lidar_bus
from .registry import LidarDevice, LidarDeviceAdapter, register_kind

# Livox SDK2 broadcast port — Mid-360s announce themselves here.
_BROADCAST_PORT = 56000

# Header for LivoxLidarEthernetPacket — verified against
# include/livox_lidar_def.h in the SDK source. Total 36 bytes:
#   version u8, length u16, time_interval u16, dot_num u16,
#   udp_cnt u16, frame_cnt u8, data_type u8, time_type u8,
#   rsvd[12], crc32 u32, timestamp[8]
_POINT_PACKET_HEADER = struct.Struct("<BHHHHBBB12sI8s")
assert _POINT_PACKET_HEADER.size == 36, _POINT_PACKET_HEADER.size

# Cartesian-High (data_type=1): int32 x_mm, y_mm, z_mm + u8 refl + u8 tag
_POINT_HIGH = struct.Struct("<iiiBB")  # 14 bytes
# Cartesian-Low (data_type=2):  int16 x_cm, y_cm, z_cm + u8 refl + u8 tag
_POINT_LOW = struct.Struct("<hhhBB")   # 8 bytes

_DATA_TYPE_HIGH = 0x01
_DATA_TYPE_LOW = 0x02


@register_kind("livox_mid360")
class Mid360Adapter(LidarDeviceAdapter):
    async def scan(self, timeout_s: float) -> list[LidarDevice]:
        """Listen for Mid-360 broadcast announcements. Each device sends
        a small UDP packet to port 56000 with its IP+serial; we collect
        every distinct (ip, serial) tuple seen during `timeout_s`."""
        loop = asyncio.get_running_loop()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", _BROADCAST_PORT))
        except OSError:
            sock.close()
            return []
        sock.setblocking(False)

        seen: dict[str, LidarDevice] = {}
        deadline = loop.time() + timeout_s
        while loop.time() < deadline:
            try:
                remaining = deadline - loop.time()
                data, addr = await asyncio.wait_for(
                    loop.sock_recvfrom(sock, 2048), timeout=remaining
                )
            except (asyncio.TimeoutError, OSError):
                break
            ip = addr[0]
            # Best-effort serial extraction. Mid-360 push msg carries
            # "broadcast_code" — 16 ASCII bytes near the start. Fall
            # back to "<ip>" if unparseable.
            serial = _extract_broadcast_code(data)
            key = serial or ip
            if key in seen:
                continue
            seen[key] = LidarDevice(
                id=f"mid360_{key.lower()}",
                kind="livox_mid360",
                ip=ip,
                name=f"Mid360 {serial or ip}",
                serial=serial,
                stream_id=f"mid360_{key.lower()}",
            )
        sock.close()
        return list(seen.values())

    async def run(self, device: LidarDevice) -> None:
        """Open a UDP socket on the device's data port and forward every
        parsed Cartesian frame into the lidar bus.

        The Mid-360 doesn't push data to arbitrary listeners — it has
        to be told *where* to send (via Livox Viewer or our `Push start`
        SDK2 command). We bind via `create_datagram_endpoint` so packets
        arrive through a Protocol callback (the lower-level
        `loop.sock_recvfrom` raises NotImplementedError on uvicorn's
        event loop).
        """
        if not device.stream_id:
            device.stream_id = device.id
        device.packets = 0
        device.bytes = 0
        device.last_packet_t_us = 0
        device.bind_addr = ""
        device.host_ip = _local_ip_for(device.ip)

        loop = asyncio.get_running_loop()
        bus = get_lidar_bus()
        # The Protocol pushes packets onto a queue the run() loop drains
        # in async-land; keeps publish() awaitable without blocking the
        # datagram callback.
        queue: asyncio.Queue[tuple[bytes, tuple[str, int]]] = asyncio.Queue(
            maxsize=512
        )

        class _Protocol(asyncio.DatagramProtocol):
            def datagram_received(self, data: bytes, addr) -> None:  # type: ignore[no-untyped-def]
                try:
                    queue.put_nowait((data, addr))
                except asyncio.QueueFull:
                    # Bus subscriber lagging — drop the oldest sample.
                    try:
                        queue.get_nowait()
                        queue.put_nowait((data, addr))
                    except (asyncio.QueueEmpty, asyncio.QueueFull):
                        pass

            def error_received(self, exc: Exception) -> None:
                _silent_log(f"udp recv error: {exc}")

        try:
            transport, _protocol = await loop.create_datagram_endpoint(
                _Protocol,
                local_addr=("0.0.0.0", device.port_data),
                reuse_port=False,
            )
        except OSError as e:
            device.status = "error"
            device.error = (
                f"UDP bind on port {device.port_data} failed: {e}. "
                f"Is another process already listening?"
            )
            return

        device.bind_addr = f"0.0.0.0:{device.port_data}"
        device.status = "connected"
        device.error = None
        try:
            while True:
                data, addr = await queue.get()
                if addr[0] != device.ip:
                    continue
                device.packets += 1
                device.bytes += len(data)
                pts = _parse_cartesian_packet(data)
                if not pts:
                    continue
                t_us = int(time.time() * 1e6)
                device.last_packet_t_us = t_us
                frame = encode_frame(device.stream_id, t_us, pts)
                await bus.publish(frame, device.stream_id, len(pts) // 4, t_us)
        except asyncio.CancelledError:
            raise
        finally:
            transport.close()


def _silent_log(msg: str) -> None:  # used by datagram protocol callbacks
    import logging
    logging.getLogger("forgebot.lidar.mid360").debug(msg)


def _local_ip_for(remote_ip: str) -> str:
    """Best-effort local-IP-on-the-route-to-remote_ip. We don't actually
    send anything — UDP connect() just picks the routing interface and
    its address, no packet on the wire. Falls back to '' on error."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((remote_ip, 1))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except OSError:
        return ""


# ---- Livox SDK2 control protocol ----
#
# Verified against Livox-SDK2 source (sdk_core/comm/sdk_protocol.h,
# command_handler/build_request.cpp). The protocol the official driver
# uses to talk to a Mid-360 is:
#
# Frame (24-byte header + body):
#   uint8  sof          = 0xAA
#   uint8  version      = 0
#   uint16 length       = 24 + len(body)
#   uint32 seq_num
#   uint16 cmd_id       = 0x0100 (LidarWorkModeControl, multi-purpose)
#   uint8  cmd_type     = 0 (kCommandTypeCmd)
#   uint8  sender_type  = 0 (kHostSend)
#   char   rsvd[6]      = 0
#   uint16 crc16        = CRC-16/CCITT-FALSE (init 0xFFFF) over bytes 0..17
#   uint32 crc32        = standard CRC32 (zlib) over body[]
#   uint8  data[len]
#
# Body for SetWorkMode (1 KV):
#   uint16 key_num=1, uint16 pad=0
#   {uint16 key=0x001A (kKeyWorkMode), uint16 length=1, uint8 value=0x01 (kLivoxLidarNormal)}
#
# Body for "configure host IP/ports" (3 KVs — same cmd_id):
#   uint16 key_num=3, uint16 pad=0
#   3 × {uint16 key, uint16 length=8, HostIpInfoValue}
#   where HostIpInfoValue = uint8 ip[4] + uint16 host_port + uint16 lidar_port
#   keys: 0x0005 = state info, 0x0006 = point data, 0x0007 = IMU data
#
# Lidar default ports (Mid-360):
#   cmd 56100, push_msg 56200, point 56300, imu 56400, log 56500
# Host typically listens on lidar_port + 1.

import zlib

_LIVOX_CMD_WORK_MODE_CONTROL = 0x0100  # also used for cfg updates

# TLV keys (livox_lidar_def.h)
_KEY_STATE_INFO_HOST = 0x0005
_KEY_POINT_DATA_HOST = 0x0006
_KEY_IMU_DATA_HOST = 0x0007
_KEY_WORK_MODE = 0x001A

# Lidar source ports (the lidar's listening ports — what it sends FROM)
_LIDAR_PUSH_MSG_PORT = 56200
_LIDAR_POINT_DATA_PORT = 56300
_LIDAR_IMU_DATA_PORT = 56400

_WORK_MODE_NORMAL = 0x01


def _crc16_ccitt_false(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def _build_command_frame(cmd_id: int, body: bytes, seq: int) -> bytes:
    """Pack a Livox SDK2 cmd frame. Header layout matches SdkPacket
    in livox-sdk2/sdk_core/comm/sdk_protocol.h."""
    total_length = 24 + len(body)
    # Header bytes 0..17 (everything before crc16).
    pre_crc16 = struct.pack(
        "<BBHIHBB6s",
        0xAA,            # sof
        0,               # version
        total_length,    # length
        seq,             # seq_num (u32)
        cmd_id,          # cmd_id
        0,               # cmd_type = kCommandTypeCmd
        0,               # sender_type = kHostSend
        b"\x00" * 6,     # rsvd[6]
    )
    assert len(pre_crc16) == 18
    crc16 = _crc16_ccitt_false(pre_crc16)
    crc32 = zlib.crc32(body) & 0xFFFFFFFF
    header = pre_crc16 + struct.pack("<HI", crc16, crc32)
    return header + body


def _host_ip_info(host_ip: str, host_port: int, lidar_port: int) -> bytes:
    """8-byte HostIpInfoValue: ip[4] + host_port + lidar_port (LE)."""
    octets = bytes(int(p) for p in host_ip.split("."))
    if len(octets) != 4:
        raise ValueError(f"bad host IP {host_ip!r}")
    return octets + struct.pack("<HH", host_port, lidar_port)


def _build_host_cfg_body(host_ip: str, point_port: int, imu_port: int, push_msg_port: int) -> bytes:
    """3-KV body that configures all host destinations on the lidar."""
    parts: list[bytes] = []
    parts.append(struct.pack("<HH", 3, 0))  # key_num=3, pad=0
    for key, host_port, lidar_port in (
        (_KEY_STATE_INFO_HOST, push_msg_port, _LIDAR_PUSH_MSG_PORT),
        (_KEY_POINT_DATA_HOST, point_port, _LIDAR_POINT_DATA_PORT),
        (_KEY_IMU_DATA_HOST, imu_port, _LIDAR_IMU_DATA_PORT),
    ):
        value = _host_ip_info(host_ip, host_port, lidar_port)
        parts.append(struct.pack("<HH", key, len(value)) + value)
    return b"".join(parts)


def _build_work_mode_body(mode: int) -> bytes:
    """Single-KV body that switches work mode (0x01 = NORMAL)."""
    return struct.pack("<HHHHB", 1, 0, _KEY_WORK_MODE, 1, mode)


def push_start_command(
    device: LidarDevice, override_host_ip: str | None = None
) -> tuple[bool, str]:
    """Configure the Mid-360's host destinations and switch it to NORMAL
    work mode. Two cmd packets sent to lidar:cmd_port (56100):

      1. cmd 0x0100 with 3-KV body — sets the host IP and the
         host_port for state/point/IMU streams. Lidar starts pushing.
      2. cmd 0x0100 with 1-KV body — kKeyWorkMode = 0x01 (NORMAL).

    Best-effort: we don't parse acks. If Livox Viewer already configured
    the device, this is unnecessary."""
    host_ip = override_host_ip or _local_ip_for(device.ip) or device.host_ip
    if not host_ip:
        return False, "could not determine local IP route to lidar"

    # Host listens on `port_data` for points; assume IMU and push_msg
    # follow the standard offsets (lidar port + 1) unless the device
    # was explicitly configured otherwise. The SDK2 driver expects all
    # three to be set together; missing ones leave the lidar idle.
    point_port = device.port_data
    imu_port = device.port_imu
    push_msg_port = point_port - 100 + 1  # 56301 - 100 + 1 = 56202; handles both 56301 and custom offsets
    # Cleaner: derive push_msg_port as `lidar push_msg + 1` if user
    # didn't override. The user-facing config uses 56201 for push_msg.
    push_msg_port = _LIDAR_PUSH_MSG_PORT + 1  # 56201

    cfg_body = _build_host_cfg_body(host_ip, point_port, imu_port, push_msg_port)
    mode_body = _build_work_mode_body(_WORK_MODE_NORMAL)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(0.5)
    try:
        sock.sendto(
            _build_command_frame(_LIVOX_CMD_WORK_MODE_CONTROL, cfg_body, seq=1),
            (device.ip, device.port_cmd),
        )
        sock.sendto(
            _build_command_frame(_LIVOX_CMD_WORK_MODE_CONTROL, mode_body, seq=2),
            (device.ip, device.port_cmd),
        )
    except OSError as e:
        sock.close()
        return False, f"send failed: {e}"
    sock.close()
    return (
        True,
        f"sent host-cfg + WorkMode→NORMAL to {device.ip}:{device.port_cmd} "
        f"(host={host_ip}, point={point_port}, imu={imu_port}, push_msg={push_msg_port})",
    )


def _extract_broadcast_code(data: bytes) -> str | None:
    """Mid-360 push msgs carry an ASCII broadcast_code. We scan for the
    first 16-byte run of printable ASCII; good enough to disambiguate
    multiple devices on the same network."""
    run_start = -1
    for i, b in enumerate(data):
        if 0x30 <= b <= 0x7A:  # rough printable
            if run_start < 0:
                run_start = i
            if i - run_start >= 15:
                return data[run_start : run_start + 16].decode("ascii", errors="ignore").strip()
        else:
            run_start = -1
    return None


def _parse_cartesian_packet(buf: bytes) -> list[float]:
    """Decode a LivoxLidarEthernetPacket carrying Cartesian-High (type 1)
    or Cartesian-Low (type 2) points into a flat [x_m, y_m, z_m, intensity,
    ...] list. Returns [] for IMU/spherical/unknown packets."""
    if len(buf) < _POINT_PACKET_HEADER.size:
        return []
    try:
        (
            _version,
            _length,
            _time_interval,
            dot_num,
            _udp_cnt,
            _frame_cnt,
            data_type,
            _time_type,
            _rsvd,
            _crc32,
            _timestamp,
        ) = _POINT_PACKET_HEADER.unpack_from(buf, 0)
    except struct.error:
        return []

    start = _POINT_PACKET_HEADER.size  # 36
    if data_type == _DATA_TYPE_HIGH:
        rec = _POINT_HIGH
        scale = 1.0 / 1000.0  # mm → m
    elif data_type == _DATA_TYPE_LOW:
        rec = _POINT_LOW
        scale = 1.0 / 100.0   # cm → m
    else:
        return []

    available = (len(buf) - start) // rec.size
    n = min(dot_num, available)
    if n <= 0:
        return []
    out: list[float] = []
    for i in range(n):
        x, y, z, refl, _tag = rec.unpack_from(buf, start + i * rec.size)
        out.extend((x * scale, y * scale, z * scale, refl / 255.0))
    return out
