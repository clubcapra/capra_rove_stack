"""Named project storage in `~/.forgebot/projects/`.

Lets the frontend home screen list recent projects, open one, save the
in-memory project under a name, and delete saved projects.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ...io.serializer import load as load_forgebot
from ...io.serializer import save as save_forgebot
from ..state import get_state

router = APIRouter(prefix="/api/v1/projects", tags=["projects"])


def _projects_dir() -> Path:
    p = Path.home() / ".forgebot" / "projects"
    p.mkdir(parents=True, exist_ok=True)
    return p


_SAFE_NAME = re.compile(r"^[A-Za-z0-9._\- ]+$")


def _safe_name(name: str) -> str:
    """Reject path-traversal / hidden file shenanigans up front."""
    name = name.strip()
    if not name or name in (".", ".."):
        raise HTTPException(status_code=400, detail="invalid project name")
    if not _SAFE_NAME.match(name):
        raise HTTPException(
            status_code=400,
            detail="project name may only contain letters, digits, space, dot, dash, underscore",
        )
    return name


class ProjectMeta(BaseModel):
    name: str
    path: str
    size_bytes: int
    modified: float  # POSIX timestamp


@router.get("", response_model=list[ProjectMeta])
def list_projects() -> list[ProjectMeta]:
    out: list[ProjectMeta] = []
    for p in sorted(_projects_dir().glob("*.forgebot")):
        st = p.stat()
        out.append(
            ProjectMeta(
                name=p.stem,
                path=str(p),
                size_bytes=st.st_size,
                modified=st.st_mtime,
            )
        )
    out.sort(key=lambda m: m.modified, reverse=True)
    return out


@router.post("/{name}/save")
def save_named(name: str) -> dict:
    name = _safe_name(name)
    state = get_state()
    target = _projects_dir() / f"{name}.forgebot"
    state.project.manifest.metadata.name = name
    save_forgebot(state.project, target)
    return {"ok": True, "name": name, "path": str(target)}


@router.post("/{name}/open")
def open_named(name: str) -> dict:
    name = _safe_name(name)
    target = _projects_dir() / f"{name}.forgebot"
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"no saved project named {name!r}")
    project = load_forgebot(target)
    get_state().replace_project(project)
    return {"ok": True, "name": name}


@router.delete("/{name}")
def delete_named(name: str) -> dict:
    name = _safe_name(name)
    target = _projects_dir() / f"{name}.forgebot"
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"no saved project named {name!r}")
    target.unlink()
    return {"ok": True, "name": name}


@router.post("/new")
def new_project() -> dict:
    """Reset the in-memory project to an empty one (untitled)."""
    state = get_state()
    from ...core.model import Project
    state.replace_project(Project())
    return {"ok": True}
