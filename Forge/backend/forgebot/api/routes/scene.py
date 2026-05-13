"""Scene-tree routes: read the entire scene, reparent, connect joints."""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ...core.commands import ConnectJointCommand, ReparentCommand
from ...core.kinematics import world_transforms
from ..schemas import ReparentRequest
from ..state import get_state

router = APIRouter(prefix="/api/v1/scene", tags=["scene"])


@router.get("")
def get_scene() -> dict:
    """Return the canonical TOML-shaped scene dict."""
    state = get_state()
    return state.project.scene.to_toml_dict()


@router.get("/roots")
def get_roots() -> dict:
    return {"roots": list(get_state().project.scene.roots)}


@router.get("/entity/{entity_id}")
def get_entity(entity_id: str) -> dict:
    e = get_state().project.scene.get(entity_id)
    if e is None:
        raise HTTPException(status_code=404, detail=f"entity {entity_id} not found")
    return e.to_toml_dict() | {"id": entity_id}


@router.post("/reparent/{entity_id}")
def reparent_entity(entity_id: str, body: ReparentRequest) -> dict:
    state = get_state()
    if entity_id not in state.project.scene:
        raise HTTPException(status_code=404, detail=f"entity {entity_id} not found")
    if body.new_parent is not None and body.new_parent not in state.project.scene:
        raise HTTPException(status_code=404, detail=f"new parent {body.new_parent} not found")
    state.execute(ReparentCommand(entity_id, body.new_parent))
    return {"ok": True}


class ConnectJointRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parent_link: str
    child_link: str
    joint_type: str = "revolute"
    # Local-space axis/position (the canonical fields). Override by
    # axis_world / position_world if those are provided.
    axis: tuple[float, float, float] = (0.0, 0.0, 1.0)
    position: tuple[float, float, float] = (0.0, 0.0, 0.0)
    # World-space inputs from the 3D mate-pick UI; the server converts to
    # parent-local using FK. Either both are set or both are omitted.
    axis_world: tuple[float, float, float] | None = None
    position_world: tuple[float, float, float] | None = None

    name: str | None = None
    limits: tuple[float, float] | None = Field(default=(-3.14159, 3.14159))
    preserve_child_world_pose: bool = True


@router.post("/connect")
def connect_joint(body: ConnectJointRequest) -> dict:
    """Insert a new joint entity between two link entities."""
    state = get_state()
    if body.parent_link not in state.project.scene:
        raise HTTPException(status_code=404, detail=f"parent_link {body.parent_link!r} not found")
    if body.child_link not in state.project.scene:
        raise HTTPException(status_code=404, detail=f"child_link {body.child_link!r} not found")
    if body.parent_link == body.child_link:
        raise HTTPException(status_code=400, detail="parent_link and child_link must differ")

    axis = body.axis
    position = body.position
    # World-space inputs from the mate-pick UI: convert to the parent's local
    # frame via FK.
    if body.axis_world is not None and body.position_world is not None:
        world = world_transforms(state.project)
        parent_world = world.get(body.parent_link)
        if parent_world is None:
            raise HTTPException(
                status_code=400,
                detail=f"could not compute world transform for {body.parent_link}",
            )
        parent_inv = np.linalg.inv(parent_world)
        # Position: full transform.
        pw = np.array([*body.position_world, 1.0])
        pl = parent_inv @ pw
        position = (float(pl[0]), float(pl[1]), float(pl[2]))
        # Axis: rotation only (drop translation), then renormalize.
        aw = np.array([*body.axis_world, 0.0])
        al = parent_inv @ aw
        n = float(np.linalg.norm(al[:3])) or 1.0
        axis = (float(al[0] / n), float(al[1] / n), float(al[2] / n))

    cmd = ConnectJointCommand(
        parent_link_id=body.parent_link,
        child_link_id=body.child_link,
        joint_type=body.joint_type,
        axis=axis,
        name=body.name,
        position=position,
        limits=body.limits,
        preserve_child_world_pose=body.preserve_child_world_pose,
    )
    state.execute(cmd)
    joint_id = (cmd._undo_state or {}).get("joint_id")
    return {"ok": True, "joint_id": joint_id}
