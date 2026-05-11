"""Command pattern: every command must execute() then undo() to a clean state."""

from __future__ import annotations

from typing import cast

from forgebot.core.commands import (
    AddEntityCommand,
    AttachComponentCommand,
    CommandStack,
    DetachComponentCommand,
    MoveEntityCommand,
    RemoveEntityCommand,
    ReparentCommand,
    UpdateComponentCommand,
)
from forgebot.core.model import (
    Entity,
    JointComponent,
    LinkComponent,
    Project,
    TransformComponent,
    new_entity_id,
)


def _fresh_project_with_chain() -> tuple[Project, str, str, str]:
    p = Project()
    a = Entity(id=new_entity_id("link"), name="a")
    a.attach(LinkComponent())
    p.scene.add(a)
    j = Entity(id=new_entity_id("joint"), name="j")
    j.attach(TransformComponent())
    j.attach(JointComponent(type="revolute", parent_link=a.id, child_link=""))
    p.scene.add(j, parent=a.id)
    b = Entity(id=new_entity_id("link"), name="b")
    b.attach(LinkComponent())
    p.scene.add(b, parent=j.id)
    return p, a.id, j.id, b.id


def test_add_entity_undo_redo():
    p = Project()
    stack = CommandStack(p)
    e = Entity(id=new_entity_id("link"), name="x")
    e.attach(LinkComponent())
    stack.execute(AddEntityCommand(e))
    assert e.id in p.scene
    stack.undo()
    assert e.id not in p.scene
    stack.redo()
    assert e.id in p.scene


def test_remove_entity_restores_subtree():
    p, a_id, j_id, b_id = _fresh_project_with_chain()
    stack = CommandStack(p)
    stack.execute(RemoveEntityCommand(j_id))
    assert j_id not in p.scene
    assert b_id not in p.scene  # descendant gone
    stack.undo()
    assert j_id in p.scene
    assert b_id in p.scene
    # Parent linkage must be restored.
    assert p.scene.entities[j_id].parent == a_id
    assert j_id in p.scene.entities[a_id].children
    assert b_id in p.scene.entities[j_id].children


def test_reparent_undo_restores_old_parent():
    p, a_id, j_id, b_id = _fresh_project_with_chain()
    stack = CommandStack(p)
    stack.execute(ReparentCommand(b_id, a_id))
    assert p.scene.entities[b_id].parent == a_id
    stack.undo()
    assert p.scene.entities[b_id].parent == j_id


def test_move_entity_round_trip():
    p, a_id, j_id, _ = _fresh_project_with_chain()
    stack = CommandStack(p)
    stack.execute(MoveEntityCommand(j_id, (1.0, 2.0, 3.0)))
    t = cast(TransformComponent, p.scene.entities[j_id].get("transform"))
    assert t.position == (1.0, 2.0, 3.0)
    stack.undo()
    t = cast(TransformComponent, p.scene.entities[j_id].get("transform"))
    assert t.position == (0.0, 0.0, 0.0)


def test_attach_detach_component_undo():
    p, a_id, _, _ = _fresh_project_with_chain()
    stack = CommandStack(p)
    new_link = LinkComponent()
    new_link.inertial.mass = 99.0
    stack.execute(AttachComponentCommand(a_id, new_link))
    link = cast(LinkComponent, p.scene.entities[a_id].get("link"))
    assert link.inertial.mass == 99.0
    stack.undo()
    link = cast(LinkComponent, p.scene.entities[a_id].get("link"))
    assert link.inertial.mass == 0.0  # back to default

    stack.execute(DetachComponentCommand(a_id, "link"))
    assert not p.scene.entities[a_id].has("link")
    stack.undo()
    assert p.scene.entities[a_id].has("link")


def test_update_component_partial_undo():
    p, _, j_id, _ = _fresh_project_with_chain()
    stack = CommandStack(p)
    stack.execute(UpdateComponentCommand(j_id, "joint", {"axis": (1.0, 0.0, 0.0)}))
    j = cast(JointComponent, p.scene.entities[j_id].get("joint"))
    assert j.axis == (1.0, 0.0, 0.0)
    stack.undo()
    j = cast(JointComponent, p.scene.entities[j_id].get("joint"))
    assert j.axis == (0.0, 0.0, 1.0)


def test_history_clears_redo_on_new_execute():
    p, _, j_id, _ = _fresh_project_with_chain()
    stack = CommandStack(p)
    stack.execute(MoveEntityCommand(j_id, (1.0, 0.0, 0.0)))
    stack.undo()
    assert stack.can_redo()
    stack.execute(MoveEntityCommand(j_id, (2.0, 0.0, 0.0)))
    assert not stack.can_redo()
