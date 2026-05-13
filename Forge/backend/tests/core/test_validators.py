"""Validator rules with valid and invalid inputs."""

from __future__ import annotations

from forgebot.core.model import (
    Entity,
    JointComponent,
    LinkComponent,
    Project,
    new_entity_id,
)
from forgebot.core.model.components.joint import JointLimits
from forgebot.core.model.components.link import Inertial, InertiaTensor
from forgebot.core.validation import has_errors, validate_all
from forgebot.core.validation.kinematic_validator import (
    check_axis_nonzero,
    check_joint_limits_consistent,
)
from forgebot.core.validation.physics_validator import check_mass_nonnegative


def test_valid_project_has_no_errors():
    p = Project()
    a = Entity(id=new_entity_id("link"), name="a")
    a.attach(LinkComponent(inertial=Inertial(mass=1.0, inertia=InertiaTensor(ixx=0.01, iyy=0.01, izz=0.01))))
    p.scene.add(a)
    assert not has_errors(validate_all(p))


def test_negative_mass_is_error():
    p = Project()
    a = Entity(id=new_entity_id("link"), name="a")
    a.attach(LinkComponent(inertial=Inertial(mass=-1.0)))
    p.scene.add(a)
    diags = check_mass_nonnegative(p)
    assert any(d.code == "physics.negative_mass" for d in diags)


def test_bad_joint_limits_is_error():
    p = Project()
    a = Entity(id=new_entity_id("link"), name="a")
    p.scene.add(a)
    b = Entity(id=new_entity_id("link"), name="b")
    p.scene.add(b)
    j = Entity(id=new_entity_id("joint"), name="j")
    j.attach(
        JointComponent(
            type="revolute",
            parent_link=a.id,
            child_link=b.id,
            limits=JointLimits(lower=1.0, upper=-1.0, effort=1.0, velocity=1.0),
        )
    )
    p.scene.add(j, parent=a.id)
    diags = check_joint_limits_consistent(p)
    assert any(d.code == "kinematic.bad_limits" for d in diags)


def test_zero_axis_is_error():
    p = Project()
    a = Entity(id=new_entity_id("link"), name="a")
    p.scene.add(a)
    b = Entity(id=new_entity_id("link"), name="b")
    p.scene.add(b)
    j = Entity(id=new_entity_id("joint"), name="bad_joint")
    j.attach(
        JointComponent(
            type="revolute",
            parent_link=a.id,
            child_link=b.id,
            axis=(0.0, 0.0, 0.0),
        )
    )
    p.scene.add(j, parent=a.id)
    diags = check_axis_nonzero(p)
    assert any(d.code == "kinematic.zero_axis" for d in diags)
