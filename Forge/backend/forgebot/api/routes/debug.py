from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from ..lidar_bus import get_lidar_bus

router = APIRouter(prefix="/api/v1/debug", tags=["debug"])

LOG_PATH = Path("/tmp/forgebot_debug.log")


class DebugLogEntry(BaseModel):
    model_config = ConfigDict(extra="allow")

    tag: str


@router.post("/log")
def log_event(entry: dict[str, Any]) -> dict[str, bool]:
    line = json.dumps({"t": time.time(), **entry}, default=str)
    with LOG_PATH.open("a") as f:
        f.write(line + "\n")
    return {"ok": True}


@router.post("/clear")
def clear_log() -> dict[str, bool]:
    if LOG_PATH.exists():
        LOG_PATH.unlink()
    return {"ok": True}


@router.get("/lidar/stats")
def lidar_stats() -> dict[str, dict[str, int | float]]:
    return get_lidar_bus().stats()
