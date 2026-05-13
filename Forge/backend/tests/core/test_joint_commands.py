"""ConnectJointCommand: insert a joint between two existing links."""

from __future__ import annotations

from typing import cast

from forgebot.core.commands import CommandStack, ConnectJointCommand
from forgebot.core.model import (
    Entity,
    JointComponent,
    LinkComponent,
    Project,
    new_entity_id,
)


def test_connect_joint_inserts_between_links():
    p = Project()
    base = Entity(id=new_entity_id("link"), name="base")
    base.attach(LinkComponent())
    p.scene.add(base)
    arm = Entity(id=new_entity_id("link"), name="arm")
    arm.attach(LinkComponent())
    p.scene.add(arm)

    stack = CommandStack(p)
    cmd = ConnectJointCommand(
        parent_link_id=base.id,
        child_link_id=arm.id,
        joint_type="revolute",
        axis=(0.0, 0.0, 1.0),
        name="shoulder",
    )
    stack.execute(cmd)

    # Joint exists, named correctly, references the right links.
    joints = [e for e in p.scene.entities.values() if e.has("joint")]
    assert len(joints) == 1
    j_entity = joints[0]
    j = cast(JointComponent, j_entity.get("joint"))
    assert j.parent_link == base.id
    assert j.child_link == arm.id
    assert j.type == "revolute"
    # arm is now a child of the joint, not a root.
    assert p.scene.entities[arm.id].parent == j_entity.id
    assert arm.id not in p.scene.roots
    # joint is a child of base.
    assert j_entity.parent == base.id


def test_connect_joint_undo_restores_topology():
    p = Project()
    base = Entity(id=new_entity_id("link"), name="base")
    p.scene.add(base)
    arm = Entity(id=new_entity_id("link"), name="arm")
    p.scene.add(arm)
    # Both are roots before.
    assert arm.id in p.scene.roots

    stack = CommandStack(p)
    stack.execute(
        ConnectJointCommand(
            parent_link_id=base.id,
            child_link_id=arm.id,
            joint_type="prismatic",
        )
    )
    assert any(e.has("joint") for e in p.scene.entities.values())

    stack.undo()
    # No joints remain.
    assert not any(e.has("joint") for e in p.scene.entities.values())
    # arm is back to being a root.
    assert arm.id in p.scene.roots
    # Both originals still in scene.
    assert base.id in p.scene
    assert arm.id in p.scene
