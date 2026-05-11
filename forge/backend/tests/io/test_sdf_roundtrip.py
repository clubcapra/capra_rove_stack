"""SDF importer + exporter round-trip."""

from __future__ import annotations

from pathlib import Path
from typing import cast

from forgebot.core.model import JointComponent
from forgebot.io.exporters import SDFExporter
from forgebot.io.importers import SDFImporter


def _names(project, predicate):
    return sorted(e.name for e in project.scene.entities.values() if predicate(e))


def test_sdf_import(fixtures_dir: Path):
    fixture = fixtures_dir / "simple_arm.sdf"
    importer = SDFImporter()
    assert importer.can_import(fixture)
    p = importer.import_file(fixture).project
    link_names = _names(p, lambda e: e.has("link"))
    joint_names = _names(p, lambda e: e.has("joint"))
    assert link_names == ["base_link", "forearm", "upper_arm"]
    assert joint_names == ["elbow", "shoulder_pan"]


def test_sdf_roundtrip(fixtures_dir: Path, tmp_path: Path):
    fixture = fixtures_dir / "simple_arm.sdf"
    p1 = SDFImporter().import_file(fixture).project
    out = tmp_path / "out.sdf"
    SDFExporter().export(p1, out)
    assert out.is_file()
    p2 = SDFImporter().import_file(out).project

    assert _names(p1, lambda e: e.has("link")) == _names(p2, lambda e: e.has("link"))
    assert _names(p1, lambda e: e.has("joint")) == _names(p2, lambda e: e.has("joint"))

    j1 = next(
        cast(JointComponent, e.get("joint"))
        for e in p1.scene.entities.values()
        if e.name == "shoulder_pan"
    )
    j2 = next(
        cast(JointComponent, e.get("joint"))
        for e in p2.scene.entities.values()
        if e.name == "shoulder_pan"
    )
    assert j1.type == j2.type
    assert j1.limits is not None and j2.limits is not None
    assert abs(j1.limits.upper - j2.limits.upper) < 1e-6
    assert abs(j1.dynamics.damping - j2.dynamics.damping) < 1e-6  # type: ignore[union-attr]


def test_urdf_to_sdf_to_urdf(fixtures_dir: Path, tmp_path: Path):
    """Cross-format round-trip through SDF."""
    from forgebot.io.exporters import URDFExporter
    from forgebot.io.importers import URDFImporter

    p1 = URDFImporter().import_file(fixtures_dir / "simple_arm.urdf").project
    sdf_path = tmp_path / "via.sdf"
    SDFExporter().export(p1, sdf_path)
    p2 = SDFImporter().import_file(sdf_path).project

    out_urdf = tmp_path / "back.urdf"
    URDFExporter().export(p2, out_urdf)
    p3 = URDFImporter().import_file(out_urdf).project

    # Same set of links survives the trip
    assert _names(p1, lambda e: e.has("link")) == _names(p3, lambda e: e.has("link"))
