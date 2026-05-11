"""Entity routes: create, delete, attach/detach/update components."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...core.commands import (
    AddEntityCommand,
    AttachComponentCommand,
    DetachComponentCommand,
    RemoveEntityCommand,
    RemoveEntityKeepChildrenCommand,
    UpdateComponentCommand,
)
from ...core.model import Entity, new_entity_id
from ...core.model.components import parse_component
from ..schemas import (
    AttachComponentRequest,
    CreateEntityRequest,
    CreateEntityResponse,
    UpdateComponentRequest,
)
from ..state import get_state

router = APIRouter(prefix="/api/v1/entities", tags=["entities"])


@router.post("", response_model=CreateEntityResponse)
def create_entity(body: CreateEntityRequest) -> CreateEntityResponse:
    state = get_state()
    if body.parent is not None and body.parent not in state.project.scene:
        raise HTTPException(status_code=404, detail=f"parent {body.parent} not found")
    eid = new_entity_id(body.entity_type)
    entity = Entity(id=eid, name=body.name)
    for key, payload in body.components.items():
        try:
            entity.attach(parse_component(key, payload))
        except (KeyError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    state.execute(AddEntityCommand(entity, parent=body.parent))
    return CreateEntityResponse(id=eid)


@router.delete("/{entity_id}")
def delete_entity(entity_id: str, subtree: bool = False) -> dict:
    """Delete an entity.

    Default (`subtree=false`): reparent children to the entity's grandparent
    (preserving each child's world pose) and remove only the entity. Useful
    for "remove this joint but keep both links it connected".

    `subtree=true`: also remove every descendant of the entity.
    """
    state = get_state()
    if entity_id not in state.project.scene:
        raise HTTPException(status_code=404, detail=f"entity {entity_id} not found")
    if subtree:
        state.execute(RemoveEntityCommand(entity_id))
    else:
        state.execute(RemoveEntityKeepChildrenCommand(entity_id))
    return {"ok": True}


@router.put("/{entity_id}/components/{key}")
def attach_component(entity_id: str, key: str, body: AttachComponentRequest) -> dict:
    state = get_state()
    if entity_id not in state.project.scene:
        raise HTTPException(status_code=404, detail=f"entity {entity_id} not found")
    try:
        component = parse_component(key, body.data)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    state.execute(AttachComponentCommand(entity_id, component))
    return {"ok": True}


@router.delete("/{entity_id}/components/{key}")
def detach_component(entity_id: str, key: str) -> dict:
    state = get_state()
    if entity_id not in state.project.scene:
        raise HTTPException(status_code=404, detail=f"entity {entity_id} not found")
    state.execute(DetachComponentCommand(entity_id, key))
    return {"ok": True}


@router.patch("/{entity_id}/components/{key}")
def update_component(entity_id: str, key: str, body: UpdateComponentRequest) -> dict:
    state = get_state()
    e = state.project.scene.get(entity_id)
    if e is None:
        raise HTTPException(status_code=404, detail=f"entity {entity_id} not found")
    if key not in e.components:
        raise HTTPException(status_code=404, detail=f"entity has no '{key}' component")
    state.execute(UpdateComponentCommand(entity_id, key, body.updates))
    if key == "link" and ("collisions" in body.updates or "visuals" in body.updates):
        # The cached collision BVHs are now stale for this entity — drop
        # everything so the next /validation/collisions call rebuilds.
        from ...core.validation import clear_collision_cache
        clear_collision_cache()
    return {"ok": True}
