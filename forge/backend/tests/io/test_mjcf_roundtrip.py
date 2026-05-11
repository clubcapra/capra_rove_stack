"""MJCF importer + exporter round-trip."""

from __future__ import annotations

from pathlib import Path
from typing import cast

from forgebot.core.model import JointComponent, LinkComponent
from forgebot.io.exporters import MJCFExporter
from forgebot.io.importers import MJCFImporter


def _names(project, predicate):
    return sorted(e.name for e in project.scene.entities.values() if predicate(e))


def test_mjcf_import(fixtures_dir: Path):
    fixture = fixtures_dir / "simple_arm.mjcf"
    importer = MJCFImporter()
    assert importer.can_import(fixture)
    p = importer.import_file(fixture).project
    link_names = _names(p, lambda e: e.has("link"))
    joint_names = _names(p, lambda e: e.has("joint"))
    assert link_names == ["base_link", "end_effector", "forearm", "upper_arm"]
    # Two real joints, plus synthetic fixed joints for welded bodies (end_effector)
    assert "shoulder_pan" in joint_names
    assert "elbow" in joint_names


def test_mjcf_roundtrip(fixtures_dir: Path, tmp_path: Path):
    fixture = fixtures_dir / "simple_arm.mjcf"
    importer = MJCFImporter()
    exporter = MJCFExporter()
    p1 = importer.import_file(fixture).project

    out_path = tmp_path / "out.mjcf"
    exporter.export(p1, out_path)
    assert out_path.is_file()

    p2 = importer.import_file(out_path).project
    assert _names(p1, lambda e: e.has("link")) == _names(p2, lambda e: e.has("link"))

    # Real joint types preserved
    real_joints_1 = {
        e.name: cast(JointComponent, e.get("joint"))
        for e in p1.scene.entities.values()
        if e.has("joint") and (e.get("joint").source or {}).get("mjcf", {}).get("synthetic") is not True  # type: ignore[union-attr]
    }
    real_joints_2 = {
        e.name: cast(JointComponent, e.get("joint"))
        for e in p2.scene.entities.values()
        if e.has("joint") and (e.get("joint").source or {}).get("mjcf", {}).get("synthetic") is not True  # type: ignore[union-attr]
    }
    for name, j in real_joints_1.items():
        assert name in real_joints_2, f"{name} missing after round-trip"
        assert j.type == real_joints_2[name].type


def test_urdf_to_mjcf(simple_arm_urdf: Path, tmp_path: Path):
    from forgebot.io.importers import URDFImporter

    p = URDFImporter().import_file(simple_arm_urdf).project
    out = tmp_path / "out.mjcf"
    MJCFExporter().export(p, out)
    assert out.is_file()
    p2 = MJCFImporter().import_file(out).project
    assert any(e.name == "base_link" for e in p2.scene.entities.values())
