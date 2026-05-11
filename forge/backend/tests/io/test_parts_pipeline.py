"""End-to-end test of the parts pipeline: STEP file -> link entity in project."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("cascadio")

from fastapi.testclient import TestClient

from forgebot.api import create_app, reset_state
from forgebot.core.commands import AddPartCommand, CommandStack, MergeSubprojectCommand
from forgebot.core.model import Project, merge_subproject
from forgebot.io.converters import convert_to_browser_mesh


ROVE2 = Path("/home/arc/Documents/Rove2")


def test_step_converts_to_glb():
    if not (ROVE2 / "Base.stp").exists():
        pytest.skip("Rove2 STEP fixtures not available")
    data = (ROVE2 / "Base.stp").read_bytes()
    out, sfx = convert_to_browser_mesh(data, ".stp")
    assert sfx == ".glb"
    assert len(out) > 100  # GLB has a 12-byte header at minimum


def test_add_part_command_undo():
    p = Project()
    stack = CommandStack(p)
    cmd = AddPartCommand(name="cube", mesh_bytes=b"FAKE", mesh_suffix=".stl")
    stack.execute(cmd)
    assert len(p.scene.entities) == 1
    assert "cube" in p.assets.mesh_data
    stack.undo()
    assert len(p.scene.entities) == 0
    assert "cube" not in p.assets.mesh_data


def test_merge_subproject_renames_ids():
    a = Project()
    a_root = a.scene.create(name="a", entity_type="link")
    b = Project()
    b_root = b.scene.create(name="b", entity_type="link")
    new_roots = merge_subproject(a, b, parent_id=a_root.id)
    assert len(new_roots) == 1
    assert new_roots[0] != b_root.id  # ID was remapped
    # b's link is now under a's root
    assert a.scene.entities[new_roots[0]].parent == a_root.id
    assert new_roots[0] in a.scene.entities[a_root.id].children


def test_upload_step_via_api():
    if not (ROVE2 / "Base.stp").exists():
        pytest.skip("Rove2 STEP fixtures not available")
    reset_state()
    client = TestClient(create_app())

    with open(ROVE2 / "Base.stp", "rb") as f:
        r = client.post(
            "/api/v1/parts/upload",
            files=[("files", ("Base.stp", f, "application/step"))],
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["added"]) == 1
    assert body["added"][0]["mesh_suffix"] == ".glb"
    eid = body["added"][0]["entity_id"]

    # Entity now exists in project
    summary = client.get("/api/v1/project/summary").json()
    assert summary["entity_count"] == 1
    assert summary["link_count"] == 1

    # Mesh is streamable
    stem = body["added"][0]["mesh_stem"]
    r = client.get(f"/api/v1/assets/mesh/{stem}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "model/gltf-binary"

    # Undo removes the entity AND the mesh
    client.post("/api/v1/project/undo")
    summary = client.get("/api/v1/project/summary").json()
    assert summary["entity_count"] == 0
    r = client.get(f"/api/v1/assets/mesh/{stem}")
    assert r.status_code == 404


def test_library_lists_entries():
    reset_state()
    client = TestClient(create_app())
    r = client.get("/api/v1/library")
    assert r.status_code == 200
    entries = r.json()
    ids = {e["id"] for e in entries}
    # Built-ins ship with the package; user-uploaded entries get
    # appended via the upload endpoint, but the seed list must be here.
    assert {"robotiq_2f_140", "dji_mid360"} <= ids


def test_library_loaders_endpoint():
    """The form's loader dropdown reads this endpoint; the local_file
    loader must be registered so user-uploaded entries can dispatch."""
    reset_state()
    client = TestClient(create_app())
    r = client.get("/api/v1/library/loaders")
    assert r.status_code == 200
    loaders = r.json()
    assert "local_file" in loaders
    assert "remote_step" in loaders
