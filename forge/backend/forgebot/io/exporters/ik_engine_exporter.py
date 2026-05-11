"""IKEngineExporter — bundles a runnable UDP-serving IK engine.

Output layout (under `output_path` directory):

    <output>/
    ├── README.md
    ├── requirements.txt
    ├── run.py
    ├── engine/                      ← copied verbatim from _ik_engine_template
    │   ├── __init__.py
    │   ├── server.py
    │   ├── ik.py
    │   ├── proto.py
    │   └── messages.proto
    └── data/
        ├── chain.json               ← generated per export (chain we picked)
        ├── ik_profile.json          ← project.ik_profiles[base] + velocity hints
        ├── robot.urdf               ← URDFExporter writes here
        ├── meshes/                  ← URDF assets
        └── textures/                ← URDF assets

The exporter takes a `(base, tip)` pair via `ExportOptions.extras`:
    options.extras = {"base": "<entity_id>", "tip": "<entity_id>"}

Both must be entity IDs in the project. The chain serializer mirrors
the math the editor's FK + IK does so the deployed engine is
bit-identical to what the user trained against.
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import cast

import numpy as np

from ...core.kinematics.chain import extract_chain
from ...core.kinematics.transforms import from_position_quat, identity
from ...core.model import (
    JointComponent,
    LinkComponent,
    Project,
    TransformComponent,
)
from ...core.validation.rules import Diagnostic, Severity
from .base import BaseExporter, ExportOptions, ExportResult
from .urdf_exporter import URDFExporter

_log = logging.getLogger(__name__)

_TEMPLATE_DIR = Path(__file__).resolve().parent / "_ik_engine_template"


class IKEngineExporter(BaseExporter):
    def supported_formats(self) -> list[str]:
        return ["ik_engine"]

    def validate_before_export(self, project: Project) -> list[Diagnostic]:
        diags: list[Diagnostic] = []
        if not project.ik_profiles:
            diags.append(
                Diagnostic(
                    severity=Severity.WARNING,
                    code="ik_engine.no_profiles",
                    message=(
                        "No IK profiles tuned. Engine will use defaults — "
                        "run Pose ▸ Train IK… on the chain you're exporting "
                        "for tracking-quality control."
                    ),
                )
            )
        return diags

    def export(
        self,
        project: Project,
        output_path: Path,
        options: ExportOptions | None = None,
    ) -> ExportResult:
        opts = options or ExportOptions()
        base = cast(str | None, opts.extras.get("base") if opts.extras else None)
        tip = cast(str | None, opts.extras.get("tip") if opts.extras else None)
        if not base or not tip:
            raise ValueError(
                "IKEngineExporter requires options.extras['base'] and "
                "options.extras['tip'] (entity IDs of chain endpoints)."
            )

        output_path = Path(output_path)
        output_path.mkdir(parents=True, exist_ok=True)
        diagnostics: list[Diagnostic] = []

        # 1. Copy the engine template (run.py, engine/*, requirements, README).
        for src in _TEMPLATE_DIR.iterdir():
            dst = output_path / src.name
            if src.is_dir():
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
        # Strip any __pycache__ that snuck in.
        for cache in output_path.rglob("__pycache__"):
            shutil.rmtree(cache, ignore_errors=True)

        data_dir = output_path / "data"
        data_dir.mkdir(exist_ok=True)

        # 2. Build chain.json by walking the project chain.
        chain_data, chain_diags = _serialize_chain(project, base, tip)
        diagnostics.extend(chain_diags)
        (data_dir / "chain.json").write_text(json.dumps(chain_data, indent=2))

        # 3. Profile JSON, with velocity-scaling defaults appended.
        profile_data = _serialize_profile(project, base)
        (data_dir / "ik_profile.json").write_text(
            json.dumps(profile_data, indent=2)
        )

        # 4. URDF + meshes/textures via the existing URDFExporter, into data/.
        try:
            urdf_path = data_dir / "robot.urdf"
            urdf_result = URDFExporter().export(project, urdf_path, options=None)
            diagnostics.extend(urdf_result.diagnostics)
        except Exception as e:  # noqa: BLE001
            diagnostics.append(
                Diagnostic(
                    severity=Severity.WARNING,
                    code="ik_engine.urdf_failed",
                    message=f"URDF export failed (engine still works without it): {e}",
                )
            )

        # 5. Manifest so we can identify exports later.
        project_name = ""
        try:
            project_name = (
                project.manifest.metadata.name
                if project.manifest and project.manifest.metadata
                else ""
            )
        except AttributeError:
            project_name = ""
        manifest = {
            "kind": "forgebot.ik_engine",
            "version": 1,
            "project": project_name,
            "base": base,
            "tip": tip,
            "movable_joints": len(chain_data["joints"]),
            "exported_at": _utc_now_iso(),
        }
        (data_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

        return ExportResult(output_path=output_path, diagnostics=diagnostics)


# ---- chain & profile serialization ----

def _serialize_chain(
    project: Project, base: str, tip: str
) -> tuple[dict, list[Diagnostic]]:
    diags: list[Diagnostic] = []
    chain = extract_chain(project, base, tip)
    scene = project.scene

    # We need the static parent→joint and joint→child transforms split
    # the same way the editor's FK does, so the engine produces the same
    # poses. The walk:
    #   - For a joint entity J between L_parent and L_child:
    #       pre_xform = transform(J)            (parent local-to-joint)
    #       post_xform = transform(L_child)     (joint local-to-child link)
    # Both are the *static* part of `world_transforms()`, with the
    # joint's actuation in between.

    movable_joints: list[dict] = []
    # Iterate joint entities in chain order.
    for jid in chain.joints:
        j_ent = scene.entities.get(jid)
        if j_ent is None:
            diags.append(
                Diagnostic(
                    severity=Severity.WARNING,
                    code="ik_engine.missing_joint",
                    message=f"chain references missing joint entity {jid!r}",
                )
            )
            continue
        joint = cast(JointComponent | None, j_ent.get("joint"))
        if joint is None:
            continue
        if joint.type not in ("revolute", "continuous", "prismatic", "fixed"):
            diags.append(
                Diagnostic(
                    severity=Severity.WARNING,
                    code="ik_engine.unsupported_joint",
                    message=(
                        f"joint {j_ent.name or jid} has type {joint.type!r}; "
                        "the exported engine treats it as fixed"
                    ),
                )
            )
        pre = _local_xform(j_ent)
        # The child link is the joint's child_link entity, or — in our
        # nested-entity convention — the first child of the joint in the
        # scene tree. Our model tags joint.child_link explicitly.
        child_id = joint.child_link or (
            j_ent.children[0] if j_ent.children else ""
        )
        child_ent = scene.entities.get(child_id) if child_id else None
        post = _local_xform(child_ent) if child_ent else identity()

        lim_lower = lim_upper = 0.0
        lim_velocity = 1.0
        if joint.limits is not None:
            lim_lower = float(joint.limits.lower)
            lim_upper = float(joint.limits.upper)
            lim_velocity = float(joint.limits.velocity) or 1.0

        movable_joints.append(
            {
                "id": jid,
                "name": j_ent.name or jid,
                "type": joint.type,
                "axis": list(joint.axis),
                "lower": lim_lower,
                "upper": lim_upper,
                "velocity": lim_velocity,
                # `inverted` tells the morpher whether to negate the
                # velocity the engine emits before sending to the real
                # arm. The engine itself also applies this sign in its
                # own FK / Jacobian so the editor and engine agree.
                "inverted": bool(getattr(joint, "inverted", False)),
                "pre_xform": pre.tolist(),
                "post_xform": post.tolist(),
            }
        )

    # Tip offset: the editor lets you specify a tool-center-point offset
    # on the IK profile. We don't have that as a first-class field today;
    # default to identity. Future tcp_offset support: pull from profile.
    tip_offset = identity()

    return (
        {
            "base": base,
            "tip": tip,
            "tip_offset": tip_offset.tolist(),
            "joints": movable_joints,
        },
        diags,
    )


def _serialize_profile(project: Project, base: str) -> dict:
    """Pull the project's IKProfile for `base`, plus engine-side defaults."""
    profile = project.ik_profiles.get(base) if project.ik_profiles else None
    out: dict[str, object] = {
        "mode": "pose_locked",
        "damping": 0.05,
        "rest_pose_gain": 0.3,
        "max_iter": 60,
        "orientation_weight": 5.0,
        "joint_weight_strength": 0.0,
        "max_dq_step": 0.05,
        "max_pos_step": 0.05,
        "max_total_dq_step": 0.10,
        "orientation_secondary_gain": 0.5,
        # Velocity scaling for the [-1, 1] normalized twist input. These
        # are deployment-specific (the editor doesn't know your hardware
        # speed envelope) — a sensible default; tune in ik_profile.json
        # on the deployed engine.
        "max_lin_vel": 0.25,
        "max_ang_vel": 1.0,
        "rest_pose": dict(project.home_pose) if project.home_pose else {},
    }
    if profile is not None:
        # Override defaults with the editor-tuned values.
        for k in (
            "mode",
            "damping",
            "rest_pose_gain",
            "max_iter",
            "orientation_weight",
            "joint_weight_strength",
            "max_dq_step",
            "max_pos_step",
            "max_total_dq_step",
            "orientation_secondary_gain",
        ):
            v = getattr(profile, k, None)
            if v is not None:
                out[k] = v
    return out


def _local_xform(entity) -> np.ndarray:
    if entity is None:
        return identity()
    t = cast(TransformComponent | None, entity.get("transform"))
    if t is None:
        return identity()
    return from_position_quat(t.position, t.rotation)


def _utc_now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
