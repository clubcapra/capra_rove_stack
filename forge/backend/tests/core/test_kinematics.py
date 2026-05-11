"""Forward kinematics: simple 2-link chain with one revolute joint."""

from __future__ import annotations

from math import pi

import numpy as np

from forgebot.core.kinematics import extract_chain, world_transforms
from forgebot.core.model import (
    Entity,
    JointComponent,
    LinkComponent,
    Project,
    TransformComponent,
    new_entity_id,
)
from forgebot.io.importers import URDFImporter


def test_world_transforms_identity_for_zero_joint():
    p = Project()
    a = Entity(id=new_entity_id("link"), name="a")
    a.attach(TransformComponent())
    a.attach(LinkComponent())
    p.scene.add(a)

    j = Entity(id=new_entity_id("joint"), name="j")
    j.attach(TransformComponent(position=(0.0, 0.0, 1.0)))
    j.attach(JointComponent(type="revolute", parent_link=a.id, child_link="x"))
    p.scene.add(j, parent=a.id)

    b = Entity(id=new_entity_id("link"), name="b")
    b.attach(TransformComponent(position=(0.5, 0.0, 0.0)))
    b.attach(LinkComponent())
    p.scene.add(b, parent=j.id)

    tfs = world_transforms(p)
    # b should be at (0.5, 0, 1.0) when joint angle is 0.
    assert np.allclose(tfs[b.id][:3, 3], [0.5, 0.0, 1.0], atol=1e-9)


def test_world_transforms_revolute_rotates_child():
    p = Project()
    a = Entity(id=new_entity_id("link"), name="a")
    a.attach(TransformComponent())
    p.scene.add(a)
    j = Entity(id=new_entity_id("joint"), name="j")
    j.attach(TransformComponent())
    j.attach(JointComponent(type="revolute", axis=(0.0, 0.0, 1.0), parent_link=a.id, child_link="x"))
    p.scene.add(j, parent=a.id)
    b = Entity(id=new_entity_id("link"), name="b")
    b.attach(TransformComponent(position=(1.0, 0.0, 0.0)))
    p.scene.add(b, parent=j.id)

    # Rotate by pi/2 about z: (1, 0, 0) -> (0, 1, 0)
    tfs = world_transforms(p, joint_values={j.id: pi / 2})
    assert np.allclose(tfs[b.id][:3, 3], [0.0, 1.0, 0.0], atol=1e-9)


def test_extract_chain_from_urdf(simple_arm_urdf):
    importer = URDFImporter()
    project = importer.import_file(simple_arm_urdf).project

    base = project.scene.find_by_name("base_link")
    tip = project.scene.find_by_name("end_effector")
    assert base is not None and tip is not None

    chain = extract_chain(project, base.id, tip.id)
    joint_names = [project.scene.entities[jid].name for jid in chain.joints]
    assert joint_names == ["shoulder_pan", "elbow", "tool_mount"]
