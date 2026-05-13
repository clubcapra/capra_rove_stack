"""Component round-trip: model -> dict -> TOML string -> dict -> model."""

from __future__ import annotations

import tomllib

from forgebot.core.model.components import (
    JointComponent,
    LinkComponent,
    TransformComponent,
    parse_component,
)
from forgebot.core.model.components.joint import JointDynamics, JointLimits
from forgebot.core.model.components.link import Geometry, Inertial, InertiaTensor
from forgebot.io.serializer import toml_codec


def _roundtrip(comp_key: str, comp):
    raw = comp.model_dump(exclude_none=True)
    toml_text = toml_codec.dumps({comp_key: raw})
    reloaded = tomllib.loads(toml_text)[comp_key]
    return parse_component(comp_key, reloaded)


def test_transform_roundtrip():
    t = TransformComponent(position=(1.0, 2.0, 3.0), rotation=(0.0, 0.0, 0.7071, 0.7071))
    out = _roundtrip("transform", t)
    assert out.position == (1.0, 2.0, 3.0)
    assert out.rotation == (0.0, 0.0, 0.7071, 0.7071)


def test_joint_roundtrip():
    j = JointComponent(
        type="revolute",
        axis=(0.0, 0.0, 1.0),
        parent_link="ent_link_aaaa1111",
        child_link="ent_link_bbbb2222",
        limits=JointLimits(lower=-1.5, upper=1.5, effort=10.0, velocity=2.0),
        dynamics=JointDynamics(damping=0.1, friction=0.05),
    )
    out = _roundtrip("joint", j)
    assert out.type == "revolute"
    assert out.parent_link == "ent_link_aaaa1111"
    assert out.limits is not None and out.limits.upper == 1.5
    assert out.dynamics is not None and out.dynamics.damping == 0.1


def test_link_roundtrip_with_geometry():
    link = LinkComponent(
        inertial=Inertial(
            mass=2.5,
            origin=(0.0, 0.0, 0.05),
            inertia=InertiaTensor(ixx=0.01, iyy=0.01, izz=0.005),
        ),
        visuals=[Geometry(mesh="link_visual", material="steel")],
        collisions=[Geometry(primitive="box", primitive_params={"x": 0.2, "y": 0.2, "z": 0.1})],
    )
    out = _roundtrip("link", link)
    assert out.inertial.mass == 2.5
    assert out.inertial.inertia.ixx == 0.01
    assert len(out.visuals) == 1
    assert out.visuals[0].mesh == "link_visual"
    assert len(out.collisions) == 1
    assert out.collisions[0].primitive == "box"
    assert out.collisions[0].primitive_params["x"] == 0.2
