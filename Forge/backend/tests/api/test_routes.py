"""FastAPI route tests using TestClient."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient

from forgebot.api import create_app, reset_state


@pytest.fixture
def client() -> TestClient:
    reset_state()
    return TestClient(create_app())


def test_health(client: TestClient):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_summary_empty_project(client: TestClient):
    r = client.get("/api/v1/project/summary")
    assert r.status_code == 200
    body = r.json()
    assert body["entity_count"] == 0
    assert body["link_count"] == 0


def test_create_entity_via_api(client: TestClient):
    r = client.post(
        "/api/v1/entities",
        json={"name": "root", "entity_type": "link", "components": {"link": {}}},
    )
    assert r.status_code == 200
    eid = r.json()["id"]
    summary = client.get("/api/v1/project/summary").json()
    assert summary["entity_count"] == 1
    assert summary["link_count"] == 1

    # Update the link component (set mass)
    r = client.patch(
        f"/api/v1/entities/{eid}/components/link",
        json={"updates": {"inertial": {"mass": 2.5}}},
    )
    assert r.status_code == 200
    entity = client.get(f"/api/v1/scene/entity/{eid}").json()
    assert entity["components"]["link"]["inertial"]["mass"] == 2.5


def test_undo_redo_via_api(client: TestClient):
    r = client.post(
        "/api/v1/entities",
        json={"name": "x", "entity_type": "link", "components": {"link": {}}},
    )
    eid = r.json()["id"]
    assert client.get("/api/v1/project/summary").json()["entity_count"] == 1
    assert client.post("/api/v1/project/undo").json()["ok"] is True
    assert client.get("/api/v1/project/summary").json()["entity_count"] == 0
    assert client.post("/api/v1/project/redo").json()["ok"] is True
    assert client.get("/api/v1/project/summary").json()["entity_count"] == 1
    assert eid in client.get("/api/v1/scene").json()["entities"]


def test_import_urdf_via_api(client: TestClient, simple_arm_urdf: Path):
    with open(simple_arm_urdf, "rb") as f:
        r = client.post(
            "/api/v1/io/import",
            files={"file": ("simple_arm.urdf", f, "application/xml")},
        )
    assert r.status_code == 200
    summary = client.get("/api/v1/project/summary").json()
    assert summary["link_count"] == 4
    assert summary["joint_count"] == 3


def test_validation_route(client: TestClient, simple_arm_urdf: Path):
    with open(simple_arm_urdf, "rb") as f:
        client.post("/api/v1/io/import", files={"file": ("a.urdf", f, "application/xml")})
    r = client.get("/api/v1/validation")
    assert r.status_code == 200
    assert isinstance(r.json(), list)
    # Simple arm fixture is valid; expect no errors.
    assert all(d["severity"] != "error" for d in r.json())


def test_fk_route(client: TestClient, simple_arm_urdf: Path):
    with open(simple_arm_urdf, "rb") as f:
        client.post("/api/v1/io/import", files={"file": ("a.urdf", f, "application/xml")})
    r = client.post("/api/v1/kinematics/fk", json={"joint_values": {}})
    assert r.status_code == 200
    transforms = r.json()["transforms"]
    assert len(transforms) > 0
    # Each transform should be a 4x4 list-of-lists.
    for tf in transforms.values():
        assert len(tf) == 4
        assert len(tf[0]) == 4


def test_export_urdf_via_api(client: TestClient, simple_arm_urdf: Path):
    import io
    from zipfile import ZipFile

    with open(simple_arm_urdf, "rb") as f:
        client.post("/api/v1/io/import", files={"file": ("a.urdf", f, "application/xml")})
    r = client.get("/api/v1/io/export?fmt=urdf")
    assert r.status_code == 200
    # Now a self-contained zip bundle: at least one *.urdf entry.
    with ZipFile(io.BytesIO(r.content)) as zf:
        urdfs = [n for n in zf.namelist() if n.endswith(".urdf")]
        assert urdfs, f"no .urdf in bundle, got: {zf.namelist()}"
        assert b"<robot" in zf.read(urdfs[0])
