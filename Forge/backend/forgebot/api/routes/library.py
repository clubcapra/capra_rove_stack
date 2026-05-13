"""Library: curated catalog of pre-defined assets (Robotiq, Mid-360, ...).

GET    /api/v1/library                  → list (effective) catalog entries
POST   /api/v1/library                   → add a user-defined entry
DELETE /api/v1/library/{id}              → hide a built-in or remove a user entry
POST   /api/v1/library/{id}/load         → load asset, optionally merge into
                                            current project (default) or replace
"""

from __future__ import annotations

import re
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, Field

from ...core.commands import MergeSubprojectCommand
from ...io.library.catalog import AssetCategory, AssetEntry
from ...io.library.loaders import LOADERS, LoaderError, library_assets_root, load_asset
from ...io.library.storage import (
    add_entry,
    effective_library,
    find_effective_entry,
    remove_entry,
)
from ..state import get_state

router = APIRouter(prefix="/api/v1/library", tags=["library"])

# Filenames the upload endpoint accepts as 3D models. Anything else is
# rejected up front so cascadio / mesh loaders never see junk.
_ALLOWED_SUFFIXES = {".stl", ".obj", ".glb", ".gltf", ".ply", ".step", ".stp", ".iges", ".igs", ".dae"}
_SLUG_RE = re.compile(r"[^a-z0-9_]+")


def _slugify(s: str) -> str:
    s = s.strip().lower().replace(" ", "_")
    return _SLUG_RE.sub("", s) or "asset"


class LibraryEntryIn(BaseModel):
    """Input shape for POST /api/v1/library."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    description: str = ""
    category: AssetCategory = "misc"
    formats: list[str] = Field(default_factory=list)
    loader_id: str
    source_url: str | None = None
    source_label: str | None = None
    supported: bool = True
    unsupported_reason: str | None = None
    tags: list[str] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)


@router.get("")
def list_library() -> list[dict]:
    """Built-in catalog with user overrides applied: removed entries hidden,
    user-added entries appended."""
    return [asdict(e) for e in effective_library()]


@router.get("/loaders")
def list_loaders() -> list[str]:
    """Loader strategy ids available to user-added entries. The Library
    panel uses this to populate its dropdown."""
    return list(LOADERS.keys())


@router.post("/upload", status_code=201)
async def upload_library_entry(
    file: UploadFile = File(...),
    name: str = Form(...),
    category: AssetCategory = Form("misc"),
    description: str = Form(""),
    tags: str = Form(""),
) -> dict:
    """Upload a 3D model file and register it as a library entry.

    File goes to `~/.forgebot/library_assets/<id>/<filename>`. The entry
    uses the `local_file` loader so future loads read from disk. The id
    is derived from the entry name (slugified). If a different entry
    already uses that id, we suffix with a counter."""
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported format {suffix!r}; expected one of {sorted(_ALLOWED_SUFFIXES)}",
        )
    base_id = _slugify(name)
    asset_id = base_id
    i = 2
    while find_effective_entry(asset_id) is not None:
        asset_id = f"{base_id}_{i}"
        i += 1
    target_dir = library_assets_root() / asset_id
    target_dir.mkdir(parents=True, exist_ok=True)
    safe_name = Path(file.filename or f"{asset_id}{suffix}").name
    target_path = target_dir / safe_name
    target_path.write_bytes(await file.read())
    parsed_tags = [t.strip() for t in tags.split(",") if t.strip()]
    try:
        added = add_entry(
            AssetEntry(
                id=asset_id,
                name=name,
                description=description,
                category=category,
                formats=[suffix.lstrip(".")],
                loader_id="local_file",
                source_url=None,
                source_label=f"local · {safe_name}",
                tags=parsed_tags,
                metadata={"local_path": str(target_path.relative_to(library_assets_root()))},
            )
        )
    except ValueError as e:
        # Cleanup the file we just wrote so we don't leave orphans.
        try:
            target_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(status_code=409, detail=str(e)) from e
    return asdict(added)


@router.post("", status_code=201)
def add_library_entry(body: LibraryEntryIn) -> dict:
    if body.loader_id not in LOADERS:
        raise HTTPException(
            status_code=400,
            detail=f"unknown loader_id {body.loader_id!r}; must be one of {list(LOADERS.keys())}",
        )
    try:
        added = add_entry(AssetEntry(**body.model_dump()))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return asdict(added)


@router.delete("/{asset_id}")
def delete_library_entry(asset_id: str, drop_files: bool = False) -> dict:
    """Hide a built-in or remove a user-added entry. With `drop_files=true`,
    also delete the entry's `library_assets/<id>/` cache directory."""
    entry = find_effective_entry(asset_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"asset {asset_id!r} not found")
    changed = remove_entry(asset_id)
    files_removed = 0
    if drop_files:
        cache_dir = library_assets_root() / asset_id
        if cache_dir.is_dir():
            for f in cache_dir.iterdir():
                try:
                    f.unlink()
                    files_removed += 1
                except OSError:
                    pass
            try:
                cache_dir.rmdir()
            except OSError:
                pass
    return {
        "ok": True,
        "asset_id": asset_id,
        "changed": changed,
        "files_removed": files_removed,
    }


@router.get("/{asset_id}")
def get_library_entry(asset_id: str) -> dict:
    entry = find_effective_entry(asset_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"asset {asset_id!r} not found")
    return asdict(entry)


@router.post("/{asset_id}/load")
def load_library_entry(
    asset_id: str,
    mode: str = Query("merge", pattern="^(merge|replace)$"),
    parent_id: str | None = Query(None),
) -> dict:
    entry = find_effective_entry(asset_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"asset {asset_id!r} not found")

    try:
        loaded = load_asset(entry)
    except LoaderError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": str(e),
                "diagnostics": [
                    {"severity": d.severity.value, "code": d.code, "message": d.message}
                    for d in e.diagnostics
                ],
            },
        ) from e

    state = get_state()
    if mode == "replace":
        state.replace_project(loaded.project)
        return {
            "ok": True,
            "mode": "replace",
            "diagnostics": [
                {"severity": d.severity.value, "code": d.code, "message": d.message}
                for d in loaded.diagnostics
            ],
        }

    # mode == "merge"
    if parent_id is not None and parent_id not in state.project.scene:
        raise HTTPException(status_code=404, detail=f"parent {parent_id!r} not found")
    cmd = MergeSubprojectCommand(loaded.project, parent_id=parent_id)
    state.execute(cmd)
    new_root_ids = (cmd._undo_state or {}).get("new_roots", [])
    return {
        "ok": True,
        "mode": "merge",
        "new_root_ids": new_root_ids,
        "diagnostics": [
            {"severity": d.severity.value, "code": d.code, "message": d.message}
            for d in loaded.diagnostics
        ],
    }
