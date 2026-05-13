"""Wire-format Pydantic models for the API.

These mirror the core models but are simpler (e.g. the scene response
is the canonical TOML-shaped dict; the entity write request is loose
to allow partial updates).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class CreateEntityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = ""
    entity_type: str = "misc"
    parent: str | None = None
    components: dict[str, dict[str, Any]] = Field(default_factory=dict)


class CreateEntityResponse(BaseModel):
    id: str


class UpdateComponentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    updates: dict[str, Any]


class AttachComponentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: dict[str, Any] = Field(default_factory=dict)


class ReparentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    new_parent: str | None = None


class FKRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    joint_values: dict[str, float] = Field(default_factory=dict)


class FKResponse(BaseModel):
    transforms: dict[str, list[list[float]]]


class DiagnosticOut(BaseModel):
    severity: str
    code: str
    message: str
    entity_id: str | None = None


class ProjectSummary(BaseModel):
    name: str
    entity_count: int
    link_count: int
    joint_count: int
    material_count: int
    roots: list[str]
