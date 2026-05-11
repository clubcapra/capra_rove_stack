"""RemoveEntityKeepChildrenCommand: deleting a joint should keep both links."""

from __future__ import annotations

from typing import cast

from forgebot.core.commands import (
    CommandStack,
    ConnectJointCommand,
    RemoveEntityKeepChildrenCommand,
)
from forgebot.core.kinematics import world_transforms
from forgebot.core.model import (
    Entity,
    LinkComponent,
    Project,
    TransformComponent,
    new_entity_id,
)


def _two_link_project_at(parent_pos, child_pos):
    p = Project()
    parent = Entity(id=new_entity_id("link"), name="parent")
    parent.attach(TransformComponent(position=parent_pos))
    parent.attach(LinkComponent())
    p.scene.add(parent)
    child = Entity(id=new_entity_id("link"), name="child")
    child.attach(TransformComponent(position=child_pos))
    child.attach(LinkComponent())
    p.scene.add(child)
    return p, parent.id, child.id


def test_remove_joint_keeps_both_links():
    p, parent_id, child_id = _two_link_project_at((0.0, 0.0, 0.0), (1.0, 0.0, 0.0))
    stack = CommandStack(p)
    stack.execute(
        ConnectJointCommand(
            parent_link_id=parent_id,
            child_link_id=child_id,
            joint_type="revolute",
            position=(0.5, 0.0, 0.0),
        )
    )
    joint_id = next(e.id for e in p.scene.entities.values() if e.has("joint"))

    # World transform of child before joint deletion (used to verify
    # world-pose preservation).
    child_world_before = world_transforms(p)[child_id].copy()

    stack.execute(RemoveEntityKeepChildrenCommand(joint_id))

    assert joint_id not in p.scene
    assert parent_id in p.scene
    assert child_id in p.scene
    # Child is now a direct child of parent (or a root).
    new_parent = p.scene.entities[child_id].parent
    assert new_parent in (parent_id, None)
    # World pose of child unchanged.
    child_world_after = world_transforms(p)[child_id]
    assert (
        abs(child_world_after[0, 3] - child_world_before[0, 3]) < 1e-6
        and abs(child_world_after[1, 3] - child_world_before[1, 3]) < 1e-6
        and abs(child_world_after[2, 3] - child_world_before[2, 3]) < 1e-6
    )


def test_remove_joint_undo_restores_topology():
    p, parent_id, child_id = _two_link_project_at((0.0, 0.0, 0.0), (1.0, 0.0, 0.0))
    stack = CommandStack(p)
    stack.execute(
        ConnectJointCommand(
            parent_link_id=parent_id,
            child_link_id=child_id,
            joint_type="revolute",
            position=(0.5, 0.0, 0.0),
        )
    )
    joint_id = next(e.id for e in p.scene.entities.values() if e.has("joint"))

    child_local_before = cast(
        TransformComponent, p.scene.entities[child_id].get("transform")
    ).model_dump(exclude_none=True)

    stack.execute(RemoveEntityKeepChildrenCommand(joint_id))
    stack.undo()

    # Joint is back, child is back under it with its original local transform.
    assert joint_id in p.scene
    assert p.scene.entities[child_id].parent == joint_id
    child_local_after = cast(
        TransformComponent, p.scene.entities[child_id].get("transform")
    ).model_dump(exclude_none=True)
    assert child_local_after["position"] == child_local_before["position"]
    assert child_local_after["rotation"] == child_local_before["rotation"]


def test_remove_link_keeps_grandchildren():
    """Delete a middle link; its child link should now sit under the grandparent."""
    p = Project()
    grand = Entity(id=new_entity_id("link"), name="grand")
    grand.attach(TransformComponent())
    grand.attach(LinkComponent())
    p.scene.add(grand)
    mid = Entity(id=new_entity_id("link"), name="mid")
    mid.attach(TransformComponent(position=(1.0, 0.0, 0.0)))
    mid.attach(LinkComponent())
    p.scene.add(mid, parent=grand.id)
    leaf = Entity(id=new_entity_id("link"), name="leaf")
    leaf.attach(TransformComponent(position=(0.0, 1.0, 0.0)))
    leaf.attach(LinkComponent())
    p.scene.add(leaf, parent=mid.id)

    leaf_world_before = world_transforms(p)[leaf.id].copy()

    stack = CommandStack(p)
    stack.execute(RemoveEntityKeepChildrenCommand(mid.id))

    assert mid.id not in p.scene
    assert leaf.id in p.scene
    assert p.scene.entities[leaf.id].parent == grand.id
    leaf_world_after = world_transforms(p)[leaf.id]
    for i in range(3):
        assert abs(leaf_world_after[i, 3] - leaf_world_before[i, 3]) < 1e-6
