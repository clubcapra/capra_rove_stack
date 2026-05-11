"""ZIP+TOML archive round-trip."""

from __future__ import annotations

from pathlib import Path

from forgebot.core.model import (
    Entity,
    JointComponent,
    KinematicChainSpec,
    LinkComponent,
    Material,
    Project,
    TransformComponent,
    new_entity_id,
)
from forgebot.io.serializer import load, save


def _build_project() -> Project:
    project = Project()
    project.manifest.metadata.name = "Round-trip arm"
    project.assets.materials["steel"] = Material(color=(0.7, 0.7, 0.72, 1.0), metallic=0.9, roughness=0.3)

    base = Entity(id=new_entity_id("link"), name="base_link")
    base.attach(TransformComponent())
    base.attach(LinkComponent())
    project.scene.add(base)

    j1 = Entity(id=new_entity_id("joint"), name="j1")
    j1.attach(TransformComponent(position=(0.0, 0.0, 0.1)))
    j1.attach(JointComponent(type="revolute", parent_link=base.id, child_link=""))
    project.scene.add(j1, parent=base.id)

    project.systems.kinematic_chains["main"] = KinematicChainSpec(
        base=base.id, tip=base.id, joints=[j1.id]
    )
    return project


def test_save_and_load_roundtrip(tmp_path: Path):
    project = _build_project()
    out = tmp_path / "test.forgebot"
    save(project, out)
    assert out.is_file()

    loaded = load(out)
    assert loaded.manifest.metadata.name == "Round-trip arm"
    assert len(loaded.scene.entities) == 2
    assert "steel" in loaded.assets.materials
    assert loaded.assets.materials["steel"].metallic == 0.9
    assert "main" in loaded.systems.kinematic_chains
    # Joint type should survive the trip
    j_eid = next(e for e in loaded.scene.entities.values() if e.has("joint")).id
    assert loaded.scene.entities[j_eid].components["joint"].type == "revolute"
