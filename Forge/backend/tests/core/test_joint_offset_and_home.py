"""Joint calibration offset (slider→FK) and home-pose serialization."""

from __future__ import annotations

import tempfile
from math import pi
from pathlib import Path

import numpy as np

from forgebot.core.kinematics import solve_position_ik, world_transforms
from forgebot.core.model import (
    Entity,
    JointComponent,
    LinkComponent,
    Project,
    TransformComponent,
    new_entity_id,
)
from forgebot.io.serializer.forgebot_file import load, save


def _two_link_revolute(joint_offset: float = 0.0) -> tuple[Project, Entity, Entity, Entity]:
    p = Project()
    a = Entity(id=new_entity_id("link"), name="a")
    a.attach(TransformComponent())
    a.attach(LinkComponent())
    p.scene.add(a)

    j = Entity(id=new_entity_id("joint"), name="j")
    j.attach(TransformComponent())
    j.attach(
        JointComponent(
            type="revolute",
            axis=(0.0, 0.0, 1.0),
            parent_link=a.id,
            child_link="",
            offset=joint_offset,
        )
    )
    p.scene.add(j, parent=a.id)

    b = Entity(id=new_entity_id("link"), name="b")
    b.attach(TransformComponent(position=(1.0, 0.0, 0.0)))
    b.attach(LinkComponent())
    p.scene.add(b, parent=j.id)
    return p, a, j, b


def test_joint_offset_shifts_zero_pose():
    """Setting offset=π/2 means slider value 0 ⇒ joint physically at 90°."""
    p, _, j, b = _two_link_revolute(joint_offset=pi / 2)
    tfs = world_transforms(p, joint_values={})  # slider = 0
    # Without offset, b would be at (1, 0, 0). With +π/2 offset around z,
    # the +x arm rotates to +y.
    assert np.allclose(tfs[b.id][:3, 3], [0.0, 1.0, 0.0], atol=1e-9)


def test_joint_offset_composes_with_slider():
    p, _, j, b = _two_link_revolute(joint_offset=pi / 2)
    # Slider = -π/2 cancels the offset; b returns to (1, 0, 0).
    tfs = world_transforms(p, joint_values={j.id: -pi / 2})
    assert np.allclose(tfs[b.id][:3, 3], [1.0, 0.0, 0.0], atol=1e-9)


def test_home_pose_roundtrip_through_forgebot_file():
    p, _, j, _ = _two_link_revolute()
    p.home_pose = {j.id: 0.42}
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "test.forgebot"
        save(p, out)
        loaded = load(out)
    assert loaded.home_pose == {j.id: 0.42}


def test_rest_pose_pulls_redundant_dofs_in_ik():
    """4-joint planar arm with position-only IK has 2 redundant DOFs.

    Without rest_pose, the solver leaves the redundant joints wherever
    they happen to land. With rest_pose set, the null-space projection
    should pull a chosen joint toward its rest value while keeping the
    tip on target.
    """
    p = Project()
    base = Entity(id=new_entity_id("link"), name="base")
    base.attach(TransformComponent())
    base.attach(LinkComponent())
    p.scene.add(base)

    parent_id = base.id
    joint_ids: list[str] = []
    for i in range(4):
        j = Entity(id=new_entity_id("joint"), name=f"j{i}")
        j.attach(TransformComponent())
        j.attach(JointComponent(type="revolute", axis=(0.0, 0.0, 1.0), parent_link=parent_id, child_link=""))
        p.scene.add(j, parent=parent_id)
        link = Entity(id=new_entity_id("link"), name=f"L{i}")
        link.attach(TransformComponent(position=(0.5, 0.0, 0.0)))
        link.attach(LinkComponent())
        p.scene.add(link, parent=j.id)
        joint_ids.append(j.id)
        parent_id = link.id
    tip_id = parent_id

    seed = {jid: 0.05 for jid in joint_ids}
    target = (1.0, 0.4, 0.0)

    res_bias = solve_position_ik(
        p,
        base=base.id,
        tip=tip_id,
        target_world=target,
        initial_joint_values=seed,
        rest_pose={joint_ids[0]: 1.0, joint_ids[1]: 0.0, joint_ids[2]: 0.0, joint_ids[3]: 0.0},
        rest_pose_gain=0.2,
        max_iter=600,
        tol=1e-5,
    )
    res_plain = solve_position_ik(
        p,
        base=base.id,
        tip=tip_id,
        target_world=target,
        initial_joint_values=seed,
        max_iter=400,
        tol=1e-5,
    )
    # Both must reach the position task to within 2 cm.
    for r in (res_bias, res_plain):
        tfs = world_transforms(p, r.joint_values)
        assert np.linalg.norm(tfs[tip_id][:3, 3] - np.array(target)) < 2e-2
    # The biased run pushes j0 toward 1.0; the plain run doesn't.
    # (Magnitude depends on the joint-space weighting; direction is
    # what matters here.)
    assert res_bias.joint_values[joint_ids[0]] > res_plain.joint_values[joint_ids[0]] + 0.03
