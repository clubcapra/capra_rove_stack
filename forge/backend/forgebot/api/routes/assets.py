"""Asset routes: stream mesh and texture binaries to the frontend +
list, count usage, and delete assets from the active project."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ...core.model import Project
from ..state import get_state

router = APIRouter(prefix="/api/v1/assets", tags=["assets"])


def _mesh_usage(project: Project) -> dict[str, list[str]]:
    """Return {mesh_stem: [entity_id, ...]} for every mesh referenced by
    a link's visual or collision geometry. Empty list = unused."""
    usage: dict[str, list[str]] = {}
    for eid, ent in project.scene.entities.items():
        link = ent.components.get("link")
        if link is None:
            continue
        for geom in (*getattr(link, "visuals", []), *getattr(link, "collisions", [])):
            stem = getattr(geom, "mesh", None)
            if stem:
                usage.setdefault(stem, []).append(eid)
    return usage


_MESH_MIME: dict[str, str] = {
    ".stl": "model/stl",
    ".obj": "model/obj",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".dae": "model/vnd.collada+xml",
    ".ply": "application/octet-stream",
}


@router.get("/meshes")
def list_meshes() -> dict:
    """{stem: {suffix, size_bytes, usage: [entity_id, ...]}} for every mesh."""
    state = get_state()
    usage = _mesh_usage(state.project)
    return {
        stem: {
            "suffix": asset.suffix,
            "size_bytes": len(asset.data),
            "usage": usage.get(stem, []),
        }
        for stem, asset in state.project.assets.mesh_data.items()
    }


@router.delete("/mesh/{stem}")
def delete_mesh(stem: str, force: bool = False) -> dict:
    """Remove a mesh asset from the project. By default, refuses if the
    mesh is referenced by any link's visual or collision; pass
    `?force=true` to drop those references along with the asset."""
    state = get_state()
    if stem not in state.project.assets.mesh_data:
        raise HTTPException(status_code=404, detail=f"mesh {stem!r} not found")
    refs = _mesh_usage(state.project).get(stem, [])
    if refs and not force:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "in_use",
                "message": f"mesh {stem!r} referenced by {len(refs)} entity(s); pass force=true to drop refs",
                "entities": refs,
            },
        )
    if refs and force:
        for eid in refs:
            link = state.project.scene.entities[eid].components.get("link")
            if link is None:
                continue
            link.visuals = [g for g in link.visuals if g.mesh != stem]
            link.collisions = [g for g in link.collisions if g.mesh != stem]
    state.project.assets.mesh_data.pop(stem, None)
    state.project.assets.mesh_files.pop(stem, None)
    state.project.touch()
    return {"ok": True, "stem": stem, "removed_refs": len(refs) if force else 0}


@router.post("/meshes/prune")
def prune_unused_meshes() -> dict:
    """Drop every mesh asset not referenced by any link. Returns the
    list of removed stems and total bytes freed."""
    state = get_state()
    usage = _mesh_usage(state.project)
    removed: list[str] = []
    freed = 0
    for stem in list(state.project.assets.mesh_data.keys()):
        if not usage.get(stem):
            asset = state.project.assets.mesh_data.pop(stem)
            state.project.assets.mesh_files.pop(stem, None)
            removed.append(stem)
            freed += len(asset.data)
    if removed:
        state.project.touch()
    return {"ok": True, "removed": removed, "bytes_freed": freed}


@router.get("/mesh/{stem}")
def get_mesh(stem: str) -> Response:
    state = get_state()
    asset = state.project.assets.mesh_data.get(stem)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"mesh {stem!r} not found")
    media_type = _MESH_MIME.get(asset.suffix, "application/octet-stream")
    return Response(
        content=asset.data,
        media_type=media_type,
        headers={
            "content-disposition": f'inline; filename="{stem}{asset.suffix}"',
            "cache-control": "public, max-age=300",
        },
    )


@router.get("/textures")
def list_textures() -> dict:
    state = get_state()
    return {
        stem: {"suffix": asset.suffix, "size_bytes": len(asset.data)}
        for stem, asset in state.project.assets.texture_data.items()
    }


@router.delete("/texture/{stem}")
def delete_texture(stem: str) -> dict:
    state = get_state()
    if stem not in state.project.assets.texture_data:
        raise HTTPException(status_code=404, detail=f"texture {stem!r} not found")
    state.project.assets.texture_data.pop(stem, None)
    state.project.assets.texture_files.pop(stem, None)
    state.project.touch()
    return {"ok": True, "stem": stem}


@router.get("/texture/{stem}")
def get_texture(stem: str) -> Response:
    state = get_state()
    asset = state.project.assets.texture_data.get(stem)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"texture {stem!r} not found")
    return Response(content=asset.data, media_type="application/octet-stream")
