"""Validation routes: run all validators on the current project."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ...core.validation import check_collisions, validate_all
from ..schemas import DiagnosticOut
from ..state import get_state

router = APIRouter(prefix="/api/v1/validation", tags=["validation"])


@router.get("", response_model=list[DiagnosticOut])
def run_validation() -> list[DiagnosticOut]:
    diags = validate_all(get_state().project)
    return [
        DiagnosticOut(
            severity=d.severity.value,
            code=d.code,
            message=d.message,
            entity_id=d.entity_id,
        )
        for d in diags
    ]


class CollisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    joint_values: dict[str, float] = Field(default_factory=dict)
    skip_adjacent: bool = True


class CollisionPairOut(BaseModel):
    a: str
    b: str
    distance: float
    penetration: float


@router.post("/collisions", response_model=list[CollisionPairOut])
def run_collision_check(body: CollisionRequest) -> list[CollisionPairOut]:
    """Coarse bounding-sphere collision check across all link pairs.

    Returns the (a, b) pairs whose world bounding spheres overlap, sorted
    by penetration depth descending. Skips parent/child + joint-adjacent
    pairs by default.
    """
    pairs = check_collisions(
        get_state().project,
        joint_values=body.joint_values,
        skip_adjacent=body.skip_adjacent,
    )
    pairs.sort(key=lambda p: p.penetration, reverse=True)
    return [
        CollisionPairOut(a=p.a, b=p.b, distance=p.distance, penetration=p.penetration)
        for p in pairs
    ]
