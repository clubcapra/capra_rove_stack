"""IKEngineExporter: home-pose bake + validation behavior.

Covers the export-time bake that makes the engine's q=0 == project home:
chain.json's pre_xform absorbs the home rotation, the exported URDF's
joint <origin> absorbs the same rotation, and rest_pose is zeroed and
filtered to chain joints.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from math import pi
from pathlib import Path

import numpy as np

from forgebot.core.kinematics.transforms import joint_offset_transform
from forgebot.core.model import (
    Entity,
    JointComponent,
    JointLimits,
    LinkComponent,
    Project,
    TransformComponent,
    new_entity_id,
)
from forgebot.io.exporters import IKEngineExporter
from forgebot.io.exporters.base import ExportOptions


def _two_revolute_chain(
    j1_offset_rpy: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> tuple[Project, str, str, str, str]:
    """base → j1 → mid → j2 → tip, both joints revolute about Z."""
    p = Project()
    base = Entity(id=new_entity_id("link"), name="base")
    base.attach(TransformComponent())
    base.attach(LinkComponent())
    p.scene.add(base)

    j1 = Entity(id=new_entity_id("joint"), name="j1")
    j1.attach(TransformComponent(position=(0.0, 0.0, 0.0)))
    j1.attach(
        JointComponent(
            type="revolute",
            axis=(0.0, 0.0, 1.0),
            parent_link=base.id,
            child_link="",
            limits=JointLimits(lower=-pi, upper=pi, effort=1.0, velocity=1.0),
        )
    )
    p.scene.add(j1, parent=base.id)

    mid = Entity(id=new_entity_id("link"), name="mid")
    mid.attach(TransformComponent(position=(1.0, 0.0, 0.0)))
    mid.attach(LinkComponent())
    p.scene.add(mid, parent=j1.id)

    j2 = Entity(id=new_entity_id("joint"), name="j2")
    j2.attach(TransformComponent())
    j2.attach(
        JointComponent(
            type="revolute",
            axis=(0.0, 0.0, 1.0),
            parent_link=mid.id,
            child_link="",
        )
    )
    p.scene.add(j2, parent=mid.id)

    tip = Entity(id=new_entity_id("link"), name="tip")
    tip.attach(TransformComponent(position=(1.0, 0.0, 0.0)))
    tip.attach(LinkComponent())
    p.scene.add(tip, parent=j2.id)

    j1.get("joint").child_link = mid.id
    j2.get("joint").child_link = tip.id
    return p, base.id, j1.id, j2.id, tip.id


def test_incomplete_home_pose_errors(tmp_path: Path):
    p, base_id, j1_id, j2_id, tip_id = _two_revolute_chain()
    p.home_pose = {j1_id: pi / 2}  # j2 missing on purpose

    out = tmp_path / "engine"
    result = IKEngineExporter().export(
        p, out, options=ExportOptions(extras={"base": base_id, "tip": tip_id})
    )
    errors = [d for d in result.diagnostics if d.is_error]
    assert errors, "expected ERROR diagnostic for missing chain joint in home_pose"
    assert any("incomplete_home_pose" in d.code for d in errors)
    # Bail-out is fail-closed: do not write engine files.
    assert not (out / "data" / "chain.json").exists()


def test_chain_pre_xform_bakes_home_rotation(tmp_path: Path):
    p, base_id, j1_id, j2_id, tip_id = _two_revolute_chain()
    p.home_pose = {j1_id: pi / 2, j2_id: 0.0}

    out = tmp_path / "engine"
    result = IKEngineExporter().export(
        p, out, options=ExportOptions(extras={"base": base_id, "tip": tip_id})
    )
    assert not any(d.is_error for d in result.diagnostics)

    chain = json.loads((out / "data" / "chain.json").read_text())
    j1_data = next(j for j in chain["joints"] if j["id"] == j1_id)
    j2_data = next(j for j in chain["joints"] if j["id"] == j2_id)

    # j1's pre_xform should equal the static parent→joint xform composed
    # with R(z, π/2). Reconstruct: identity (j1's TransformComponent is
    # identity) @ R(z, π/2).
    expected_j1 = joint_offset_transform("revolute", (0.0, 0.0, 1.0), pi / 2)
    assert np.allclose(np.asarray(j1_data["pre_xform"]), expected_j1, atol=1e-9)

    # j2 has home=0, no bake — its pre_xform stays at the joint's static
    # local transform (identity).
    assert np.allclose(np.asarray(j2_data["pre_xform"]), np.eye(4), atol=1e-9)


def test_urdf_origin_bakes_home_rotation(tmp_path: Path):
    p, base_id, j1_id, j2_id, tip_id = _two_revolute_chain()
    p.home_pose = {j1_id: pi / 2, j2_id: 0.0}

    out = tmp_path / "engine"
    IKEngineExporter().export(
        p, out, options=ExportOptions(extras={"base": base_id, "tip": tip_id})
    )

    tree = ET.parse(out / "data" / "robot.urdf")
    joints = {j.get("name"): j for j in tree.iter("joint")}
    # j1's URDF origin should encode a yaw of π/2 (Z-axis rotation).
    origin = joints["j1"].find("origin")
    assert origin is not None, "j1 must have an <origin> after bake"
    rpy = [float(x) for x in origin.get("rpy", "0 0 0").split()]
    assert abs(rpy[2] - pi / 2) < 1e-6, f"yaw expected π/2, got {rpy[2]}"
    # j1's origin xyz unchanged (revolute bake is rotation-only).
    xyz = [float(x) for x in origin.get("xyz", "0 0 0").split()]
    assert all(abs(v) < 1e-9 for v in xyz)


def test_rest_pose_zeroed_and_filtered(tmp_path: Path):
    p, base_id, j1_id, j2_id, tip_id = _two_revolute_chain()
    p.home_pose = {
        j1_id: pi / 2,
        j2_id: 1.0,
        "ent_joint_NOTACHAIN": 42.0,  # stray non-chain entry
    }

    out = tmp_path / "engine"
    IKEngineExporter().export(
        p, out, options=ExportOptions(extras={"base": base_id, "tip": tip_id})
    )

    profile = json.loads((out / "data" / "ik_profile.json").read_text())
    rest = profile["rest_pose"]
    assert set(rest.keys()) == {j1_id, j2_id}, "stray non-chain id must be dropped"
    assert all(v == 0.0 for v in rest.values()), "rest_pose must be zeroed after bake"


def test_inverted_joint_bakes_with_sign(tmp_path: Path):
    p, base_id, j1_id, j2_id, tip_id = _two_revolute_chain()
    p.home_pose = {j1_id: pi / 2, j2_id: 0.0}
    p.scene.entities[j1_id].get("joint").inverted = True

    out = tmp_path / "engine"
    IKEngineExporter().export(
        p, out, options=ExportOptions(extras={"base": base_id, "tip": tip_id})
    )

    chain = json.loads((out / "data" / "chain.json").read_text())
    j1_data = next(j for j in chain["joints"] if j["id"] == j1_id)
    # Inverted joint: bake = home * sign = π/2 * -1 = -π/2.
    expected = joint_offset_transform("revolute", (0.0, 0.0, 1.0), -pi / 2)
    assert np.allclose(np.asarray(j1_data["pre_xform"]), expected, atol=1e-9)
