"""Asset library catalog: declarative list of pre-defined assets.

Each entry pairs metadata (name, category, source) with a loader strategy
key. Loaders live in `loaders.py` and are dispatched by `loader_id`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


AssetCategory = Literal[
    "robot",
    "gripper",
    "sensor",
    "actuator",
    "tool",
    "fixture",
    "conveyor",
    "controller",
    "misc",
]


@dataclass
class AssetEntry:
    id: str
    name: str
    description: str
    category: AssetCategory
    formats: list[str]                        # ["urdf", "stl", "step", ...]
    loader_id: str                             # which loader handles this entry
    source_url: str | None = None              # reference URL (for credit/UI link)
    source_label: str | None = None            # short label, e.g. "ros-industrial"
    supported: bool = True                      # if False, UI shows an "unsupported" badge
    unsupported_reason: str | None = None
    tags: list[str] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)


LIBRARY: list[AssetEntry] = [
    AssetEntry(
        id="robotiq_2f_140",
        name="Robotiq 2F-140 Gripper",
        description=(
            "2-finger 140 mm parallel-jaw gripper. Visualization-only assembly "
            "from the ROS-Industrial robotiq package. Meshes are cached locally "
            "under ~/.forgebot/library_assets/robotiq_2f_140/; if missing, the "
            "loader downloads them from the upstream URL and caches them."
        ),
        category="gripper",
        formats=["stl"],
        loader_id="robotiq_2f_140",
        source_url=(
            "https://github.com/ros-industrial-attic/robotiq/tree/kinetic-devel/"
            "robotiq_2f_140_gripper_visualization"
        ),
        source_label="local · ros-industrial",
        tags=["gripper", "parallel", "robotiq", "140mm"],
    ),
    AssetEntry(
        id="dji_mid360",
        name="DJI Livox Mid-360 LiDAR",
        description=(
            "360° dome 3D LiDAR — DJI/Livox. STEP (.stp) cached locally under "
            "~/.forgebot/library_assets/dji_mid360/; tessellated to GLB via "
            "cascadio (OpenCascade). Falls back to DJI's CDN on cache miss."
        ),
        category="sensor",
        formats=["step"],
        loader_id="remote_step",
        source_url="https://terra-1-g.djicdn.com/65c028cd298f4669a7f0e40e50ba1131/Mid360/mid-360-asm.stp",
        source_label="local · dji.com",
        tags=["lidar", "sensor", "dji", "livox"],
    ),
]


def find_entry(asset_id: str) -> AssetEntry | None:
    for e in LIBRARY:
        if e.id == asset_id:
            return e
    return None
