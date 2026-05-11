"""Mesh bytes round-trip through importer -> serializer -> API."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient

from forgebot.api import create_app, reset_state
from forgebot.io.importers import URDFImporter
from forgebot.io.serializer import load, save


def test_urdf_importer_captures_mesh_bytes(fixtures_dir: Path):
    urdf = fixtures_dir / "with_mesh.urdf"
    p = URDFImporter().import_file(urdf).project
    assert "tiny" in p.assets.mesh_data
    asset = p.assets.mesh_data["tiny"]
    assert asset.suffix == ".stl"
    assert len(asset.data) > 80  # binary STL has 80-byte header


def test_forgebot_archive_roundtrips_mesh_bytes(fixtures_dir: Path, tmp_path: Path):
    urdf = fixtures_dir / "with_mesh.urdf"
    p1 = URDFImporter().import_file(urdf).project
    archive = tmp_path / "with_mesh.forgebot"
    save(p1, archive)

    p2 = load(archive)
    assert "tiny" in p2.assets.mesh_data
    assert p2.assets.mesh_data["tiny"].data == p1.assets.mesh_data["tiny"].data


def test_api_serves_mesh_bytes(fixtures_dir: Path, tmp_path: Path):
    """Import URDF locally (mesh sidecar resolves), save as .forgebot, then
    upload the archive — meshes survive the trip."""
    reset_state()
    client = TestClient(create_app())

    # Bundle the URDF + tiny.stl into a .forgebot archive; HTTP upload only
    # carries one file, so the archive is the way mesh-bearing projects move.
    p1 = URDFImporter().import_file(fixtures_dir / "with_mesh.urdf").project
    archive = tmp_path / "with_mesh.forgebot"
    save(p1, archive)

    with open(archive, "rb") as f:
        r = client.post(
            "/api/v1/project/upload",
            files={"file": ("with_mesh.forgebot", f, "application/zip")},
        )
    assert r.status_code == 200

    listing = client.get("/api/v1/assets/meshes").json()
    assert "tiny" in listing
    assert listing["tiny"]["suffix"] == ".stl"

    r = client.get("/api/v1/assets/mesh/tiny")
    assert r.status_code == 200
    assert r.headers["content-type"] == "model/stl"
    assert r.content == (fixtures_dir / "tiny.stl").read_bytes()
