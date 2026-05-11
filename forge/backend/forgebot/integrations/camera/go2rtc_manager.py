"""go2rtc subprocess manager.

go2rtc (https://github.com/AlexxIT/go2rtc) bridges RTSP → WebRTC for the
browser. It's a single static Go binary; we ship the URL and download
it on first connect so users don't have to do anything manual.

Lifecycle:
    ensure_running()    — install (if missing) + start the subprocess
    add_stream(...)     — POST /api/streams to add an RTSP source by name
    remove_stream(...)  — DELETE /api/streams to remove
    snapshot()          — GET /api/streams for live consumer/byte counts
    shutdown()          — SIGTERM the subprocess (called from app shutdown)

go2rtc API endpoints we use (all on its `--api` listen port, default 1984):
    POST /api/streams?name={n}&src={url}    — add a stream dynamically
    DELETE /api/streams?src={n}             — remove
    GET  /api/streams                       — snapshot of all streams
    GET  /api/ws?src={n}                    — WebRTC signaling (used by frontend)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import shutil
import socket
import stat
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

_log = logging.getLogger(__name__)


# Where we install go2rtc if not already on PATH. We pick a per-user
# location so we don't need root, and keep it stable across runs so we
# only download once.
_INSTALL_DIR = Path.home() / ".local" / "bin"

# Pinned to a known-good release. go2rtc tags follow semver; pinning
# avoids surprise breaking changes.
_GO2RTC_VERSION = "v1.9.7"
_GO2RTC_BASE = (
    f"https://github.com/AlexxIT/go2rtc/releases/download/{_GO2RTC_VERSION}/"
)


def _binary_filename() -> str:
    sysname = platform.system()
    machine = platform.machine().lower()
    if sysname == "Linux":
        if machine in ("x86_64", "amd64"):
            return "go2rtc_linux_amd64"
        if machine in ("aarch64", "arm64"):
            return "go2rtc_linux_arm64"
        if machine.startswith("arm"):
            return "go2rtc_linux_arm"
    if sysname == "Darwin":
        if machine in ("arm64", "aarch64"):
            return "go2rtc_mac_arm64"
        return "go2rtc_mac_amd64"
    if sysname == "Windows":
        return "go2rtc_win64.exe"
    raise RuntimeError(f"no go2rtc build known for {sysname}/{machine}")


def _binary_path() -> Path:
    on_path = shutil.which("go2rtc")
    if on_path:
        return Path(on_path)
    return _INSTALL_DIR / _binary_filename()


def _ensure_installed() -> Path:
    """Return the path to the go2rtc binary, downloading once if needed."""
    p = _binary_path()
    if p.exists() and os.access(p, os.X_OK):
        return p
    _INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    target = _INSTALL_DIR / _binary_filename()
    url = _GO2RTC_BASE + _binary_filename()
    _log.warning("downloading go2rtc %s → %s", _GO2RTC_VERSION, target)
    try:
        with urllib.request.urlopen(url, timeout=60) as resp, open(target, "wb") as f:
            shutil.copyfileobj(resp, f)
    except urllib.error.URLError as e:
        raise RuntimeError(f"go2rtc download failed: {e}") from e
    target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return target


def _free_port(default: int) -> int:
    """Try `default`; fall back to a kernel-picked port if it's in use."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", default))
        s.close()
        return default
    except OSError:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        return port


class Go2rtcManager:
    """One subprocess per backend. Spun up lazily on first camera connect."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen[bytes] | None = None
        self._api_port = 0  # populated when we start
        self._webrtc_port = 0
        self._config_path: Path | None = None
        self._lock = asyncio.Lock()

    @property
    def api_port(self) -> int:
        return self._api_port

    @property
    def webrtc_port(self) -> int:
        return self._webrtc_port

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    async def ensure_running(self) -> None:
        async with self._lock:
            if self.running:
                return
            await asyncio.to_thread(self._start_blocking)

    def _start_blocking(self) -> None:
        binary = _ensure_installed()
        # Pick free ports. go2rtc defaults: api 1984, webrtc 8555, but
        # we don't want to fail if something else is already there.
        self._api_port = _free_port(1984)
        self._webrtc_port = _free_port(8555)
        cfg_dir = Path.home() / ".cache" / "forgebot" / "go2rtc"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        self._config_path = cfg_dir / "go2rtc.yaml"
        # Initial config: api/webrtc only, no `streams:` key — go2rtc
        # 1.9.7's PUT /api/streams handler chokes on an inline empty map
        # ("streams: {}") with `yaml: line 5: did not find expected key`
        # when it tries to merge the new entry. Omitting the key lets
        # go2rtc create a proper block mapping on first add.
        self._config_path.write_text(
            f"api:\n"
            f"  listen: \"127.0.0.1:{self._api_port}\"\n"
            f"webrtc:\n"
            f"  listen: \":{self._webrtc_port}\"\n",
            encoding="utf-8",
        )
        _log.warning(
            "starting go2rtc: api=127.0.0.1:%d webrtc=:%d binary=%s",
            self._api_port, self._webrtc_port, binary,
        )
        self._proc = subprocess.Popen(
            [str(binary), "-config", str(self._config_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        # Wait briefly for the API to be ready so the first add_stream
        # call doesn't race the port being open.
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{self._api_port}/api", timeout=0.5
                ) as r:
                    if r.status == 200:
                        return
            except (urllib.error.URLError, OSError):
                time.sleep(0.1)
        _log.warning("go2rtc API didn't come up within 5s; continuing anyway")

    async def shutdown(self) -> None:
        async with self._lock:
            if not self._proc:
                return
            self._proc.terminate()
            try:
                await asyncio.to_thread(self._proc.wait, 3)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None

    # ---- stream management via the go2rtc HTTP API ----

    async def add_stream(self, name: str, rtsp_url: str) -> None:
        """Register an RTSP camera with go2rtc.

        We use the raw RTSP URL as the source. go2rtc's MJPEG endpoint
        (/api/stream.mjpeg?src=...) decodes whatever codec the camera
        produces (H264, H265, MJPEG) via its built-in ffmpeg pipe and
        re-encodes to JPEG for HTTP delivery.

        We *don't* use WebRTC for the frontend because codec negotiation
        was a minefield: H265 cameras need transcoding; H264 doesn't
        work in Firefox on Linux without the OpenH264 plugin; VP8
        transcoding is broken in current go2rtc (passes "vp8" as the
        ffmpeg muxer name and ffmpeg has no vp8 muxer). MJPEG is the
        ugly-but-reliable path: same latency as VP8 (~200-400 ms on
        LAN), works in every browser via <img>, no SDP/ICE.
        """
        await self.ensure_running()
        try:
            await asyncio.to_thread(
                self._http_call,
                "DELETE",
                f"http://127.0.0.1:{self._api_port}/api/streams?"
                + urllib.parse.urlencode({"src": name}),
            )
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
        # `ffmpeg:rtsp://...#video=mjpeg` produces an explicit ffmpeg
        # decode + JPEG re-encode pipeline that go2rtc's MJPEG endpoint
        # can serve directly to <img> in the browser. Confirmed via
        # smoke test: ~107 KB / 3 s for a 4K H265 source = healthy.
        # Without `#video=mjpeg`, the MJPEG endpoint blocks because
        # go2rtc has no JPEG-encoded frames to forward.
        src = f"ffmpeg:{rtsp_url}#video=mjpeg"
        params = urllib.parse.urlencode({"name": name, "src": src})
        url = f"http://127.0.0.1:{self._api_port}/api/streams?{params}"
        await asyncio.to_thread(self._http_call, "PUT", url)

    async def remove_stream(self, name: str) -> None:
        if not self.running:
            return
        params = urllib.parse.urlencode({"src": name})
        url = f"http://127.0.0.1:{self._api_port}/api/streams?{params}"
        try:
            await asyncio.to_thread(self._http_call, "DELETE", url)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise

    async def snapshot(self) -> dict:
        """GET /api/streams — returns a dict keyed by stream name. Used
        for the device-list bytes/consumers counters."""
        if not self.running:
            return {}
        url = f"http://127.0.0.1:{self._api_port}/api/streams"
        try:
            data = await asyncio.to_thread(self._http_call, "GET", url)
            return json.loads(data) if data else {}
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            return {}

    @staticmethod
    def _http_call(method: str, url: str) -> bytes:
        req = urllib.request.Request(url, method=method)
        with urllib.request.urlopen(req, timeout=2.0) as r:
            return r.read()


_manager: Go2rtcManager | None = None


def get_manager() -> Go2rtcManager:
    global _manager
    if _manager is None:
        _manager = Go2rtcManager()
    return _manager
