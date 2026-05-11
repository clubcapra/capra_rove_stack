"""Asset loader strategies. Each loader turns an `AssetEntry` into a Project
(or raises with a diagnostic if the format is unsupported).

Strategy pattern: register concrete loaders in `LOADERS` keyed by loader_id.
"""

from __future__ import annotations

import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path

from ...core.model import (
    Entity,
    LinkComponent,
    Material,
    MeshAsset,
    Project,
    TransformComponent,
    new_entity_id,
)
from ...core.model.components.link import Geometry, Inertial, InertiaTensor
from ...core.validation.rules import Diagnostic, Severity
from ..converters import ConversionError, convert_to_browser_mesh
from .catalog import AssetEntry

# Where local library assets live. User-uploaded 3D files end up under
# `<id>/`, and pre-downloaded copies of formerly-remote assets are
# cached here too. Path is resolved lazily so tests can monkeypatch it.
def library_assets_root() -> Path:
    return Path.home() / ".forgebot" / "library_assets"


class LoaderError(Exception):
    """Raised when an asset can't be loaded; includes diagnostics."""

    def __init__(self, message: str, diagnostics: list[Diagnostic] | None = None) -> None:
        super().__init__(message)
        self.diagnostics = diagnostics or []


@dataclass
class LoadedAsset:
    project: Project
    diagnostics: list[Diagnostic] = field(default_factory=list)


class BaseAssetLoader(ABC):
    @abstractmethod
    def load(self, entry: AssetEntry) -> LoadedAsset: ...


def _http_get(url: str, timeout: float = 30.0) -> bytes:
    """Tiny GET helper; caller picks up errors as urllib exceptions."""
    req = urllib.request.Request(url, headers={"user-agent": "forgebot/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (trusted URLs)
        return resp.read()


# ---------- Robotiq 2F-140 ----------

_ROBOTIQ_BASE = (
    "https://raw.githubusercontent.com/ros-industrial-attic/robotiq/"
    "kinetic-devel/robotiq_2f_140_gripper_visualization/meshes/visual/"
)
_ROBOTIQ_MESHES = [
    "robotiq_arg2f_base_link.stl",
    "robotiq_arg2f_140_outer_knuckle.stl",
    "robotiq_arg2f_140_outer_finger.stl",
    "robotiq_arg2f_140_inner_knuckle.stl",
    "robotiq_arg2f_140_inner_finger.stl",
]


class RobotiqTwoFinger140Loader(BaseAssetLoader):
    """Bring the Robotiq 2F-140 visual meshes in as separate link entities.

    The upstream URDF is xacro-only and the gripper is a 4-bar linkage with
    mimic constraints; modeling the kinematics correctly requires a real
    xacro processor (which we don't ship) plus mimic-joint support. Rather
    than hand-craft an approximation that's wrong in subtle ways, this
    loader simply downloads the 5 visual STL meshes and creates one link
    per mesh at the origin. The user wires joints with the editor's
    snap-to-feature joint mode.
    """

    def load(self, entry: AssetEntry) -> LoadedAsset:
        diagnostics: list[Diagnostic] = []
        project = Project()
        project.manifest.metadata.name = entry.name
        project.manifest.metadata.description = entry.description
        project.assets.materials["plastic_grey"] = Material(
            color=(0.55, 0.55, 0.58, 1.0), metallic=0.1, roughness=0.7
        )

        # Prefer local cache (`~/.forgebot/library_assets/robotiq_2f_140/`);
        # fall back to upstream GitHub if any file is missing locally,
        # caching the download for next time.
        cache_dir = library_assets_root() / "robotiq_2f_140"
        cache_dir.mkdir(parents=True, exist_ok=True)
        fetched: list[str] = []
        for filename in _ROBOTIQ_MESHES:
            stem = filename.rsplit(".", 1)[0]
            local = cache_dir / filename
            data: bytes | None = None
            if local.is_file():
                data = local.read_bytes()
            else:
                try:
                    data = _http_get(_ROBOTIQ_BASE + filename)
                    local.write_bytes(data)
                except Exception as e:
                    diagnostics.append(
                        Diagnostic(
                            severity=Severity.WARNING,
                            code="library.robotiq.mesh_fetch_failed",
                            message=f"could not fetch {filename}: {e}",
                        )
                    )
                    continue
            project.assets.mesh_data[stem] = MeshAsset(suffix=".stl", data=data)
            fetched.append(stem)

        if not fetched:
            raise LoaderError(
                "no Robotiq meshes available locally or upstream",
                diagnostics=diagnostics,
            )

        # One link entity per mesh, all at origin. The user wires kinematics
        # using the joint-pick workflow (J).
        for stem in fetched:
            link = self._link_with_mesh(
                name=stem,
                mesh_stem=stem,
                mass=0.05,
            )
            project.scene.add(link)

        diagnostics.append(
            Diagnostic(
                severity=Severity.INFO,
                code="library.robotiq.kinematics_skipped",
                message=(
                    "Robotiq 2F-140 imported as 5 unconnected visual links. "
                    "Use joint mode (J) to wire the kinematics; the upstream "
                    "model is a 4-bar linkage with mimic joints we don't "
                    "auto-build."
                ),
            )
        )

        project.scene.roots = [
            eid for eid, e in project.scene.entities.items() if e.parent is None
        ]
        return LoadedAsset(project=project, diagnostics=diagnostics)

    @staticmethod
    def _link_with_mesh(*, name: str, mesh_stem: str, mass: float) -> Entity:
        eid = new_entity_id("link")
        e = Entity(id=eid, name=name)
        e.attach(TransformComponent())
        e.attach(
            LinkComponent(
                inertial=Inertial(
                    mass=mass,
                    inertia=InertiaTensor(ixx=1e-4, iyy=1e-4, izz=1e-4),
                ),
                visuals=[Geometry(mesh=mesh_stem, material="plastic_grey")],
                collisions=[Geometry(mesh=mesh_stem)],
            )
        )
        return e


# ---------- Remote STEP fetched from a URL and tessellated ----------


class RemoteSTEPLoader(BaseAssetLoader):
    """Download a STEP/IGES asset from `entry.source_url`, convert via cascadio,
    return a single-link Project with the mesh attached as visual+collision."""

    def load(self, entry: AssetEntry) -> LoadedAsset:
        if not entry.source_url:
            raise LoaderError(f"asset {entry.id} has no source_url")
        diagnostics: list[Diagnostic] = []

        # Pull the suffix from the URL path so we feed the converter correctly.
        from urllib.parse import urlparse

        url_path = urlparse(entry.source_url).path
        suffix = "." + url_path.rsplit(".", 1)[-1].lower() if "." in url_path else ".step"

        # Prefer local cache (`~/.forgebot/library_assets/<id>/<basename>`);
        # fall back to remote download and cache the result.
        cache_dir = library_assets_root() / entry.id
        cache_file = cache_dir / (Path(url_path).name or f"{entry.id}{suffix}")
        if cache_file.is_file():
            raw = cache_file.read_bytes()
        else:
            try:
                raw = _http_get(entry.source_url, timeout=120.0)
            except Exception as e:
                raise LoaderError(f"could not fetch {entry.source_url}: {e}") from e
            try:
                cache_dir.mkdir(parents=True, exist_ok=True)
                cache_file.write_bytes(raw)
            except OSError:
                pass  # cache write failure is non-fatal

        try:
            mesh_bytes, out_suffix = convert_to_browser_mesh(raw, suffix)
        except ConversionError as e:
            raise LoaderError(str(e)) from e

        project = Project()
        project.manifest.metadata.name = entry.name
        project.manifest.metadata.description = entry.description

        stem = entry.id
        project.assets.mesh_data[stem] = MeshAsset(suffix=out_suffix, data=mesh_bytes)

        eid = new_entity_id("link")
        e = Entity(id=eid, name=entry.id)
        e.attach(TransformComponent())
        e.attach(
            LinkComponent(
                inertial=Inertial(mass=0.0),
                visuals=[Geometry(mesh=stem)],
                collisions=[Geometry(mesh=stem)],
            )
        )
        project.scene.add(e)
        return LoadedAsset(project=project, diagnostics=diagnostics)


# ---------- Unsupported formats (SLDPRT) ----------


class UnsupportedFormatLoader(BaseAssetLoader):
    """Loader that always fails with a clear diagnostic.

    Used for catalog entries whose source format isn't readable in the browser
    (STEP B-rep without OCCT, SolidWorks proprietary SLDPRT). The catalog
    entry's `unsupported_reason` is surfaced via the API so the UI can show
    a helpful message.
    """

    def load(self, entry: AssetEntry) -> LoadedAsset:
        raise LoaderError(
            entry.unsupported_reason or f"format(s) {entry.formats} not supported in browser",
            diagnostics=[
                Diagnostic(
                    severity=Severity.ERROR,
                    code=f"library.{entry.loader_id}",
                    message=entry.unsupported_reason or "format not supported",
                )
            ],
        )


# ---------- Local file ----------


class LocalFileLoader(BaseAssetLoader):
    """Load a single 3D model from a local path and return a one-link
    Project. The path is taken from `entry.metadata['local_path']`,
    which can be either absolute or relative to `library_assets_root()`.

    Supported inputs are everything `convert_to_browser_mesh` handles
    (STEP / IGES tessellate via cascadio; STL / OBJ / GLB / PLY pass
    through). Output is whatever the converter produces.

    This is the default loader for user-uploaded library entries — see
    POST /api/v1/library/upload.
    """

    def load(self, entry: AssetEntry) -> LoadedAsset:
        rel = entry.metadata.get("local_path") if entry.metadata else None
        if not rel:
            raise LoaderError(f"asset {entry.id} has no metadata.local_path")
        path = Path(rel)
        if not path.is_absolute():
            path = library_assets_root() / path
        if not path.is_file():
            raise LoaderError(f"local file not found: {path}")
        raw = path.read_bytes()
        suffix = path.suffix.lower() or ".stl"
        try:
            mesh_bytes, out_suffix = convert_to_browser_mesh(raw, suffix)
        except ConversionError as e:
            raise LoaderError(str(e)) from e

        project = Project()
        project.manifest.metadata.name = entry.name
        project.manifest.metadata.description = entry.description
        stem = entry.id
        project.assets.mesh_data[stem] = MeshAsset(suffix=out_suffix, data=mesh_bytes)
        eid = new_entity_id("link")
        e = Entity(id=eid, name=entry.id)
        e.attach(TransformComponent())
        e.attach(
            LinkComponent(
                inertial=Inertial(mass=0.0),
                visuals=[Geometry(mesh=stem)],
                collisions=[Geometry(mesh=stem)],
            )
        )
        project.scene.add(e)
        return LoadedAsset(project=project)


# ---------- Registry ----------


LOADERS: dict[str, BaseAssetLoader] = {
    "robotiq_2f_140": RobotiqTwoFinger140Loader(),
    "remote_step": RemoteSTEPLoader(),
    "local_file": LocalFileLoader(),
    "sldprt_unsupported": UnsupportedFormatLoader(),
}


def load_asset(entry: AssetEntry) -> LoadedAsset:
    loader = LOADERS.get(entry.loader_id)
    if loader is None:
        raise LoaderError(f"no loader registered for loader_id={entry.loader_id!r}")
    return loader.load(entry)
