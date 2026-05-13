"""URDF importer + exporter: load fixture, export, reimport, compare."""

from __future__ import annotations

from pathlib import Path
from typing import cast

from forgebot.core.model import JointComponent, LinkComponent
from forgebot.io.exporters import URDFExporter
from forgebot.io.importers import URDFImporter


def _names(project, predicate):
    return sorted(e.name for e in project.scene.entities.values() if predicate(e))


def test_urdf_import(simple_arm_urdf: Path):
    importer = URDFImporter()
    assert importer.can_import(simple_arm_urdf)
    result = importer.import_file(simple_arm_urdf)
    project = result.project

    link_names = _names(project, lambda e: e.has("link"))
    joint_names = _names(project, lambda e: e.has("joint"))
    assert link_names == ["base_link", "end_effector", "forearm", "upper_arm"]
    assert joint_names == ["elbow", "shoulder_pan", "tool_mount"]
    assert "steel" in project.assets.materials


def test_urdf_roundtrip(simple_arm_urdf: Path, tmp_path: Path):
    importer = URDFImporter()
    exporter = URDFExporter()
    p1 = importer.import_file(simple_arm_urdf).project

    out_path = tmp_path / "out.urdf"
    exporter.export(p1, out_path)
    assert out_path.is_file()

    p2 = importer.import_file(out_path).project

    # Same set of links and joints by name
    assert _names(p1, lambda e: e.has("link")) == _names(p2, lambda e: e.has("link"))
    assert _names(p1, lambda e: e.has("joint")) == _names(p2, lambda e: e.has("joint"))

    # Joint types preserved
    j1_by_name = {e.name: cast(JointComponent, e.get("joint")) for e in p1.scene.entities.values() if e.has("joint")}
    j2_by_name = {e.name: cast(JointComponent, e.get("joint")) for e in p2.scene.entities.values() if e.has("joint")}
    for name in j1_by_name:
        assert j1_by_name[name].type == j2_by_name[name].type, f"joint {name} type drift"

    # Specific limit values preserved
    assert j2_by_name["shoulder_pan"].limits is not None
    assert abs(j2_by_name["shoulder_pan"].limits.upper - 3.14) < 1e-6

    # Inertials preserved
    base1 = next(e for e in p1.scene.entities.values() if e.name == "base_link")
    base2 = next(e for e in p2.scene.entities.values() if e.name == "base_link")
    l1 = cast(LinkComponent, base1.get("link"))
    l2 = cast(LinkComponent, base2.get("link"))
    assert abs(l1.inertial.mass - l2.inertial.mass) < 1e-9
    assert abs(l1.inertial.inertia.ixx - l2.inertial.inertia.ixx) < 1e-9
