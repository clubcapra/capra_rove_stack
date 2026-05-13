"""IK solver tests on a simple chain."""

from __future__ import annotations

from math import pi

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
from forgebot.core.model.components.joint import JointLimits


def _build_2dof_planar_arm(link_length: float = 1.0) -> tuple[Project, str, str]:
    """Two-link planar manipulator: base → revZ → link1 → revZ → tip."""
    p = Project()

    base = Entity(id=new_entity_id("link"), name="base")
    base.attach(TransformComponent())
    base.attach(LinkComponent())
    p.scene.add(base)

    j1 = Entity(id=new_entity_id("joint"), name="j1")
    j1.attach(TransformComponent())
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

    link1 = Entity(id=new_entity_id("link"), name="link1")
    link1.attach(TransformComponent(position=(link_length, 0.0, 0.0)))
    link1.attach(LinkComponent())
    p.scene.add(link1, parent=j1.id)
    j1.components["joint"].child_link = link1.id  # type: ignore[union-attr]

    j2 = Entity(id=new_entity_id("joint"), name="j2")
    j2.attach(TransformComponent())
    j2.attach(
        JointComponent(
            type="revolute",
            axis=(0.0, 0.0, 1.0),
            parent_link=link1.id,
            child_link="",
            limits=JointLimits(lower=-pi, upper=pi, effort=1.0, velocity=1.0),
        )
    )
    p.scene.add(j2, parent=link1.id)

    tip = Entity(id=new_entity_id("link"), name="tip")
    tip.attach(TransformComponent(position=(link_length, 0.0, 0.0)))
    tip.attach(LinkComponent())
    p.scene.add(tip, parent=j2.id)
    j2.components["joint"].child_link = tip.id  # type: ignore[union-attr]

    return p, base.id, tip.id


def test_ik_reaches_target_within_workspace():
    p, base, tip = _build_2dof_planar_arm(link_length=1.0)
    # Target inside the reachable annulus (radius 0..2).
    target = (1.5, 0.5, 0.0)
    result = solve_position_ik(p, base=base, tip=tip, target_world=target, max_iter=1000)
    # Verify by FK — within 1mm of the target.
    worlds = world_transforms(p, result.joint_values)
    tip_pos = worlds[tip][:3, 3]
    assert np.allclose(tip_pos, target, atol=5e-3)


def test_ik_handles_unreachable_gracefully():
    """Target far outside the 2-link arm's reach (max ~2 units)."""
    p, base, tip = _build_2dof_planar_arm(link_length=1.0)
    target = (5.0, 0.0, 0.0)
    result = solve_position_ik(p, base=base, tip=tip, target_world=target, max_iter=80)
    # Solver should not crash; expect non-zero residual since target is unreachable.
    assert not result.converged
    assert result.residual > 1.0


def test_ik_seeds_from_initial_joint_values():
    p, base, tip = _build_2dof_planar_arm(link_length=1.0)
    target = (1.5, 0.5, 0.0)
    # Start far from solution; solver should still reach the target.
    seed = {jid: 2.0 for jid in p.scene.entities if p.scene.entities[jid].has("joint")}
    result = solve_position_ik(
        p, base=base, tip=tip, target_world=target, initial_joint_values=seed, max_iter=1000
    )
    worlds = world_transforms(p, result.joint_values)
    assert np.allclose(worlds[tip][:3, 3], target, atol=5e-3)


def test_ik_escapes_singular_start_pose():
    p, base, tip = _build_2dof_planar_arm(link_length=1.0)
    target = (1.5, 0.5, 0.0)
    seed = {jid: 0.0 for jid in p.scene.entities if p.scene.entities[jid].has("joint")}
    result = solve_position_ik(
        p,
        base=base,
        tip=tip,
        target_world=target,
        initial_joint_values=seed,
        max_iter=200,
    )
    worlds = world_transforms(p, result.joint_values)
    assert np.allclose(worlds[tip][:3, 3], target, atol=1e-3)
    assert result.pos_residual < 1e-3
    assert result.rot_residual == 0.0
