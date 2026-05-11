"""Project-level routes: summary, save, load, undo/redo."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import cast

from fastapi import APIRouter, HTTPException, UploadFile

from ...core.model import JointComponent, LinkComponent
from ...io.serializer import load as load_forgebot
from ...io.serializer import save as save_forgebot
from ..schemas import ProjectSummary
from ..state import get_state

router = APIRouter(prefix="/api/v1/project", tags=["project"])


@router.get("/summary", response_model=ProjectSummary)
def get_summary() -> ProjectSummary:
    state = get_state()
    p = state.project
    n_links = sum(1 for e in p.scene.entities.values() if e.has("link"))
    n_joints = sum(1 for e in p.scene.entities.values() if e.has("joint"))
    return ProjectSummary(
        name=p.manifest.metadata.name,
        entity_count=len(p.scene.entities),
        link_count=n_links,
        joint_count=n_joints,
        material_count=len(p.assets.materials),
        roots=list(p.scene.roots),
    )


@router.post("/upload")
async def upload_project(file: UploadFile) -> dict:
    """Upload a `.forgebot` archive; replace the in-memory project."""
    state = get_state()
    suffix = Path(file.filename or "uploaded.forgebot").suffix or ".forgebot"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)
    try:
        project = load_forgebot(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)
    state.replace_project(project)
    return {"ok": True, "name": project.manifest.metadata.name}


@router.post("/save")
def save_project_to_disk(path: str) -> dict:
    """Save the in-memory project to a server-side path. (For local-only use.)"""
    p = Path(path)
    save_forgebot(get_state().project, p)
    return {"ok": True, "path": str(p)}


@router.post("/undo")
def undo() -> dict:
    state = get_state()
    cmd = state.stack.undo()
    if cmd is None:
        return {"ok": False, "reason": "nothing to undo"}
    state.events.publish("project.undo", description=cmd.description)
    return {"ok": True, "description": cmd.description}


@router.post("/redo")
def redo() -> dict:
    state = get_state()
    cmd = state.stack.redo()
    if cmd is None:
        return {"ok": False, "reason": "nothing to redo"}
    state.events.publish("project.redo", description=cmd.description)
    return {"ok": True, "description": cmd.description}


@router.get("/history")
def history() -> dict:
    state = get_state()
    return {
        "undo": state.stack.history(),
        "can_undo": state.stack.can_undo(),
        "can_redo": state.stack.can_redo(),
    }


@router.get("/home-pose")
def get_home_pose() -> dict[str, float]:
    """Return the project's saved home-pose joint values (slider-space)."""
    return dict(get_state().project.home_pose)


@router.put("/home-pose")
def set_home_pose(body: dict) -> dict:
    """Replace the project's home-pose. Pass a {joint_id: value} dict.

    The supplied dict is completed server-side: every movable joint
    entity in the project gets an entry, defaulting to 0.0 when the
    client didn't include it. The frontend's `jointValues` store is
    sparse (untouched sliders aren't keyed), so "set current as home"
    would otherwise produce a partial home_pose and IKEngineExporter
    would reject it as incomplete.
    """
    state = get_state()
    project = state.project
    pose: dict[str, float] = {}
    for k, v in (body.get("home_pose") or {}).items():
        try:
            pose[str(k)] = float(v)
        except (TypeError, ValueError):
            continue
    for eid, ent in project.scene.entities.items():
        j = ent.get("joint")
        if j is None or j.type not in ("revolute", "continuous", "prismatic"):
            continue
        pose.setdefault(eid, 0.0)
    project.home_pose = pose
    state.events.publish("project.home_pose_changed", count=len(pose))
    return {"ok": True, "count": len(pose)}
