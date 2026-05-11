"""Scene operations: add, remove, reparent, traversal."""

from __future__ import annotations

from forgebot.core.model import (
    Entity,
    JointComponent,
    LinkComponent,
    Scene,
    new_entity_id,
)


def test_add_and_lookup():
    scene = Scene()
    e = Entity(id=new_entity_id("link"), name="base")
    e.attach(LinkComponent())
    scene.add(e)
    assert e.id in scene
    assert scene.get(e.id) is e
    assert e.id in scene.roots


def test_parent_child_links():
    scene = Scene()
    parent = Entity(id=new_entity_id("link"), name="p")
    scene.add(parent)
    child = Entity(id=new_entity_id("link"), name="c")
    scene.add(child, parent=parent.id)
    assert child.parent == parent.id
    assert child.id in parent.children
    assert child.id not in scene.roots


def test_remove_recursive():
    scene = Scene()
    a = Entity(id=new_entity_id("link"), name="a")
    scene.add(a)
    b = Entity(id=new_entity_id("link"), name="b")
    scene.add(b, parent=a.id)
    c = Entity(id=new_entity_id("link"), name="c")
    scene.add(c, parent=b.id)
    scene.remove(a.id)
    assert a.id not in scene
    assert b.id not in scene
    assert c.id not in scene


def test_reparent_keeps_invariants():
    scene = Scene()
    a = Entity(id=new_entity_id("link"), name="a")
    b = Entity(id=new_entity_id("link"), name="b")
    c = Entity(id=new_entity_id("link"), name="c")
    scene.add(a)
    scene.add(b, parent=a.id)
    scene.add(c)
    scene.reparent(b.id, c.id)
    assert b.id in c.children
    assert b.id not in a.children
    assert b.parent == c.id


def test_iter_dfs_yields_each_entity_once():
    scene = Scene()
    a = Entity(id=new_entity_id("link"), name="a")
    b = Entity(id=new_entity_id("link"), name="b")
    c = Entity(id=new_entity_id("link"), name="c")
    scene.add(a)
    scene.add(b, parent=a.id)
    scene.add(c, parent=b.id)
    seen = [e.id for e in scene.iter_dfs()]
    assert seen == [a.id, b.id, c.id]


def test_toml_dict_roundtrip():
    scene = Scene()
    a = Entity(id=new_entity_id("link"), name="root")
    a.attach(LinkComponent())
    scene.add(a)
    j = Entity(id=new_entity_id("joint"), name="j1")
    j.attach(JointComponent(type="revolute", parent_link=a.id, child_link="will_fix"))
    scene.add(j, parent=a.id)
    raw = scene.to_toml_dict()
    restored = Scene.from_toml_dict(raw)
    assert set(restored.entities) == set(scene.entities)
    assert restored.entities[a.id].name == "root"
    assert restored.entities[j.id].components["joint"].type == "revolute"
