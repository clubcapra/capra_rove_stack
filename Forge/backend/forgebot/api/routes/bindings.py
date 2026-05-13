"""Bindings: GET/PUT the active project's binding manifest.

The Bindings panel in the editor reads/writes via these. Live runtime
(Simulate, Map, robot) consumes the same in-memory `project.bindings`.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from ...core.model import Bindings
from ..state import get_state

router = APIRouter(prefix="/api/v1/bindings", tags=["bindings"])


class BindingsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bindings: Bindings


@router.get("", response_model=BindingsResponse)
def get_bindings() -> BindingsResponse:
    return BindingsResponse(bindings=get_state().project.bindings)


@router.put("", response_model=BindingsResponse)
def put_bindings(body: BindingsResponse) -> BindingsResponse:
    project = get_state().project
    try:
        project.bindings = body.bindings
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return BindingsResponse(bindings=project.bindings)
