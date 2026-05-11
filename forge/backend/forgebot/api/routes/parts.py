"""Parts: bring external mesh/CAD files into the current project as links.

Each uploaded file becomes one link entity. STEP/IGES files are converted to
GLB server-side via cascadio; STL/OBJ/glTF/PLY pass through unchanged. Every
add is wrapped in an `AddPartCommand` so it's undoable.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile

from ...core.commands import AddPartCommand
from ...io.converters import ConversionError, convert_to_browser_mesh, supported_suffixes
from ..state import get_state

router = APIRouter(prefix="/api/v1/parts", tags=["parts"])


@router.get("/supported-suffixes")
def get_supported_suffixes() -> list[str]:
    return sorted(supported_suffixes())


@router.post("/upload")
async def upload_parts(
    parent_id: str | None = None,
    files: list[UploadFile] = File(...),
) -> dict:
    """Add one link entity per uploaded file.

    `parent_id` (query param): if set, new links are added under that entity;
    otherwise they become new scene roots.
    """
    state = get_state()
    if parent_id is not None and parent_id not in state.project.scene:
        raise HTTPException(status_code=404, detail=f"parent {parent_id} not found")

    added: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for upload in files:
        original_name = upload.filename or "part"
        suffix = Path(original_name).suffix
        stem = Path(original_name).stem or "part"
        try:
            raw = await upload.read()
            mesh_bytes, out_suffix = convert_to_browser_mesh(raw, suffix)
        except ConversionError as e:
            errors.append({"file": original_name, "error": str(e)})
            continue
        except Exception as e:
            errors.append({"file": original_name, "error": f"{type(e).__name__}: {e}"})
            continue

        cmd = AddPartCommand(
            name=stem,
            mesh_bytes=mesh_bytes,
            mesh_suffix=out_suffix,
            stem=stem,
            parent_id=parent_id,
        )
        state.execute(cmd)
        # The command stashes the new entity id during execute().
        new_state = cmd._undo_state or {}
        added.append({
            "file": original_name,
            "entity_id": new_state.get("entity_id"),
            "mesh_stem": new_state.get("stem"),
            "mesh_suffix": out_suffix,
            "size_bytes": len(mesh_bytes),
        })

    return {"added": added, "errors": errors}
