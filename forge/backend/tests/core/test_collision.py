"""Bounding-sphere collision detection tests."""

from __future__ import annotations

from forgebot.core.model import (
    Entity,
    LinkComponent,
    Project,
    TransformComponent,
    new_entity_id,
)
from forgebot.core.model.components.link import Geometry
from forgebot.core.validation import check_collisions, clear_collision_cache


def _box_link(name: str, position: tuple[float, float, float], half: float):
    e = Entity(id=new_entity_id("link"), name=name)
    e.attach(TransformComponent(position=position))
    e.attach(
        LinkComponent(
            collisions=[
                Geometry(primitive="box", primitive_params={"x": 2 * half, "y": 2 * half, "z": 2 * half})
            ]
        )
    )
    return e


def test_collision_detected_when_overlapping():
    clear_collision_cache()
    p = Project()
    a = _box_link("a", (0.0, 0.0, 0.0), half=0.5)
    b = _box_link("b", (0.3, 0.0, 0.0), half=0.5)  # overlaps with a
    p.scene.add(a)
    p.scene.add(b)
    pairs = check_collisions(p)
    assert len(pairs) == 1
    assert {pairs[0].a, pairs[0].b} == {a.id, b.id}


def test_no_collision_when_separated():
    clear_collision_cache()
    p = Project()
    a = _box_link("a", (0.0, 0.0, 0.0), half=0.5)
    b = _box_link("b", (5.0, 0.0, 0.0), half=0.5)
    p.scene.add(a)
    p.scene.add(b)
    pairs = check_collisions(p)
    assert pairs == []


def test_adjacent_pair_skipped():
    """Parent and child links overlap by design (joint at the boundary).
    The default behavior is to skip them."""
    clear_collision_cache()
    p = Project()
    a = _box_link("a", (0.0, 0.0, 0.0), half=0.5)
    b = _box_link("b", (0.0, 0.0, 0.5), half=0.5)
    p.scene.add(a)
    p.scene.add(b, parent=a.id)
    pairs = check_collisions(p)
    assert pairs == []
    pairs_with_adj = check_collisions(p, skip_adjacent=False)
    assert len(pairs_with_adj) == 1


def test_collision_changes_with_joint_value():
    """A revolute joint rotation can move two boxes from clear to colliding."""
    from forgebot.core.model import JointComponent
    from forgebot.core.model.components.joint import JointLimits

    clear_collision_cache()
    p = Project()
    base = _box_link("base", (0.0, 0.0, 0.0), half=0.1)
    p.scene.add(base)
    j = Entity(id=new_entity_id("joint"), name="j")
    j.attach(TransformComponent())
    j.attach(
        JointComponent(
            type="revolute",
            axis=(0.0, 0.0, 1.0),
            parent_link=base.id,
            child_link="",
            limits=JointLimits(lower=-3.14, upper=3.14, effort=1.0, velocity=1.0),
        )
    )
    p.scene.add(j, parent=base.id)
    arm = _box_link("arm", (1.0, 0.0, 0.0), half=0.2)  # 1m out along +X
    p.scene.add(arm, parent=j.id)
    j.components["joint"].child_link = arm.id  # type: ignore[union-attr]

    obstacle = _box_link("obstacle", (0.0, 1.0, 0.0), half=0.2)  # at +Y
    p.scene.add(obstacle)

    # Joint at 0: arm sticks +X, no collision with obstacle at +Y.
    pairs_at_0 = check_collisions(p, joint_values={j.id: 0.0})
    assert all(obstacle.id not in (p.a, p.b) for p in pairs_at_0)

    # Joint at pi/2: arm rotates to +Y, now near obstacle.
    import math
    pairs_at_90 = check_collisions(p, joint_values={j.id: math.pi / 2})
    found = any({obstacle.id, arm.id} == {p.a, p.b} for p in pairs_at_90)
    assert found, f"expected arm/obstacle collision, got {pairs_at_90}"
