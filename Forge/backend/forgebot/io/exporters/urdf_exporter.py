"""URDF exporter: Project -> URDF XML (+ meshes copied alongside).

Layout written by `export(project, "out/robot.urdf")`:
  out/robot.urdf
  out/meshes/<stem>.<ext>     # if any meshes are referenced
  out/textures/<stem>.<ext>   # if any textures are referenced

Limitations (logged as diagnostics, not errors):
  - URDF doesn't support sensors, signal graphs, layout zones — dropped.
  - Multiple kinematic roots become multiple disjoint subtrees in one <robot>;
    URDF technically expects a single tree but most tools tolerate it.
"""

from __future__ import annotations

import shutil
from math import asin, atan2
from pathlib import Path
from typing import cast
from xml.etree import ElementTree as ET

from ...core.model import (
    Entity,
    JointComponent,
    LinkComponent,
    Material,
    Project,
    Scene,
    TransformComponent,
)
from ...core.model.components.link import Geometry, Inertial
from ...core.validation.rules import Diagnostic, Severity
from .base import BaseExporter, ExportOptions, ExportResult


def _quat_mul(
    a: tuple[float, float, float, float], b: tuple[float, float, float, float]
) -> tuple[float, float, float, float]:
    """Hamilton product (xyzw)."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def _quat_rotate(
    q: tuple[float, float, float, float], v: tuple[float, float, float]
) -> tuple[float, float, float]:
    """Rotate a 3-vector by quaternion (xyzw)."""
    x, y, z, w = q
    vx, vy, vz = v
    # v' = q * (vx, vy, vz, 0) * q⁻¹, expanded.
    tx = 2 * (y * vz - z * vy)
    ty = 2 * (z * vx - x * vz)
    tz = 2 * (x * vy - y * vx)
    return (
        vx + w * tx + (y * tz - z * ty),
        vy + w * ty + (z * tx - x * tz),
        vz + w * tz + (x * ty - y * tx),
    )


def _compose(
    p1: tuple[float, float, float],
    q1: tuple[float, float, float, float],
    p2: tuple[float, float, float],
    q2: tuple[float, float, float, float],
) -> tuple[tuple[float, float, float], tuple[float, float, float, float]]:
    """Compose T1 * T2 — combined.position = p1 + R(q1)·p2, combined.rotation = q1·q2."""
    rotated = _quat_rotate(q1, p2)
    return (
        (p1[0] + rotated[0], p1[1] + rotated[1], p1[2] + rotated[2]),
        _quat_mul(q1, q2),
    )


def _quat_to_rpy(q: tuple[float, float, float, float]) -> tuple[float, float, float]:
    """Quaternion (x, y, z, w) -> roll, pitch, yaw (URDF/ROS convention)."""
    x, y, z, w = q
    # Normalize to avoid drift bites.
    n = (x * x + y * y + z * z + w * w) ** 0.5 or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    sinr_cosp = 2.0 * (w * x + y * z)
    cosr_cosp = 1.0 - 2.0 * (x * x + y * y)
    roll = atan2(sinr_cosp, cosr_cosp)
    sinp = 2.0 * (w * y - z * x)
    if abs(sinp) >= 1.0:
        pitch = 1.5707963267948966 if sinp > 0 else -1.5707963267948966
    else:
        pitch = asin(sinp)
    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    yaw = atan2(siny_cosp, cosy_cosp)
    return (roll, pitch, yaw)


def _xyz_str(v: tuple[float, float, float]) -> str:
    return f"{v[0]:g} {v[1]:g} {v[2]:g}"


def _origin_subelem(parent: ET.Element, xyz: tuple[float, float, float], rot: tuple[float, float, float, float]) -> None:
    rpy = _quat_to_rpy(rot)
    if xyz == (0.0, 0.0, 0.0) and rpy == (0.0, 0.0, 0.0):
        return
    ET.SubElement(parent, "origin", xyz=_xyz_str(xyz), rpy=_xyz_str(rpy))


def _geometry_to_xml(parent: ET.Element, g: Geometry, mesh_suffix_lookup: dict[str, str]) -> None:
    geom_elem = ET.SubElement(parent, "geometry")
    if g.mesh:
        suffix = mesh_suffix_lookup.get(g.mesh, ".stl")
        mesh_elem = ET.SubElement(geom_elem, "mesh", filename=f"meshes/{g.mesh}{suffix}")
        if g.scale != (1.0, 1.0, 1.0):
            mesh_elem.set("scale", _xyz_str(g.scale))
    elif g.primitive == "box":
        p = g.primitive_params
        ET.SubElement(geom_elem, "box", size=f"{p.get('x', 1):g} {p.get('y', 1):g} {p.get('z', 1):g}")
    elif g.primitive == "sphere":
        ET.SubElement(geom_elem, "sphere", radius=f"{g.primitive_params.get('radius', 1):g}")
    elif g.primitive == "cylinder":
        ET.SubElement(
            geom_elem,
            "cylinder",
            radius=f"{g.primitive_params.get('radius', 1):g}",
            length=f"{g.primitive_params.get('length', 1):g}",
        )


class URDFExporter(BaseExporter):
    def supported_formats(self) -> list[str]:
        return ["urdf"]

    def validate_before_export(self, project: Project) -> list[Diagnostic]:
        diags: list[Diagnostic] = []
        scene = project.scene
        if not scene.entities:
            diags.append(
                Diagnostic(
                    severity=Severity.ERROR,
                    code="urdf.empty_scene",
                    message="cannot export an empty scene to URDF",
                )
            )
        for e in scene.entities.values():
            j = cast(JointComponent | None, e.get("joint"))
            if j is not None and j.type in ("ball", "floating"):
                diags.append(
                    Diagnostic(
                        severity=Severity.WARNING,
                        code="urdf.unsupported_joint_type",
                        message=f"joint '{e.name}' has type {j.type!r}, "
                        "not supported by URDF — exporting as fixed",
                        entity_id=e.id,
                    )
                )
        return diags

    def export(
        self,
        project: Project,
        output_path: Path,
        options: ExportOptions | None = None,
    ) -> ExportResult:
        diagnostics = self.validate_before_export(project)
        if any(d.is_error for d in diagnostics):
            return ExportResult(output_path=output_path, diagnostics=diagnostics)

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        robot_name = project.manifest.metadata.name or "robot"
        root = ET.Element("robot", name=robot_name)

        # Emit <material> entries at robot scope (URDF allows them anywhere; root keeps refs simple).
        for mat_name, mat in project.assets.materials.items():
            self._material_to_xml(root, mat_name, mat)

        mesh_suffixes = self._build_mesh_suffix_lookup(project)
        # URDF requires every link and joint name to be unique. The editor
        # lets users keep duplicates (e.g. five "joint_revolute" joints), so
        # build an eid → stable unique-name map up front and use it for
        # every link/joint reference. Without this, external URDF parsers
        # see one anchor link and a tangle of orphaned joints.
        name_map = self._build_unique_names(project, diagnostics)

        # Emit <link> for every link entity, <joint> for every joint entity.
        for eid, e in project.scene.entities.items():
            if e.has("link"):
                self._link_to_xml(root, e, mesh_suffixes, name_map)
            elif e.has("joint"):
                self._joint_to_xml(root, e, project.scene, name_map, diagnostics)

        ET.indent(root, space="  ")
        tree = ET.ElementTree(root)
        tree.write(output_path, encoding="utf-8", xml_declaration=True)

        # Copy mesh and texture files.
        self._copy_assets(project, output_path.parent, diagnostics)

        return ExportResult(output_path=output_path, diagnostics=diagnostics)

    @staticmethod
    def _build_unique_names(
        project: Project, diagnostics: list[Diagnostic]
    ) -> dict[str, str]:
        """Map entity id → URDF-safe unique name. Duplicates get `_2, _3, …`
        suffixes; spaces and slashes in the user's name are stripped. We
        log a warning whenever a rename happens so the user knows the
        emitted name differs from the editor's display."""
        used: set[str] = set()
        name_map: dict[str, str] = {}
        for eid, e in project.scene.entities.items():
            if not (e.has("link") or e.has("joint")):
                continue
            base = (e.name or eid).strip() or eid
            base = base.replace(" ", "_").replace("/", "_")
            candidate = base
            i = 2
            while candidate in used:
                candidate = f"{base}_{i}"
                i += 1
            if candidate != base:
                diagnostics.append(
                    Diagnostic(
                        severity=Severity.INFO,
                        code="urdf.renamed_for_uniqueness",
                        message=f"renamed {base!r} → {candidate!r} for URDF (names must be unique)",
                        entity_id=eid,
                    )
                )
            name_map[eid] = candidate
            used.add(candidate)
        return name_map

    # ----- helpers -----

    def _link_to_xml(
        self,
        root: ET.Element,
        e: Entity,
        mesh_suffixes: dict[str, str],
        name_map: dict[str, str],
    ) -> None:
        link = cast(LinkComponent, e.get("link"))
        # link.transform (the joint→link offset our model splits across
        # both the joint AND the child link) is applied via a fixed
        # dummy sub-joint emitted by `_joint_to_xml`. That keeps the
        # URDF rotation pivot at the joint and still places the mesh
        # at the right world location, which a single-frame URDF link
        # can't represent natively for cancelling-offset assemblies.
        link_elem = ET.SubElement(root, "link", name=name_map.get(e.id, e.name or e.id))

        if link.inertial.mass > 0 or _has_inertia(link.inertial):
            self._inertial_to_xml(link_elem, link.inertial)

        for vis in link.visuals:
            self._visual_to_xml(link_elem, vis, "visual", mesh_suffixes)
        for col in link.collisions:
            self._visual_to_xml(link_elem, col, "collision", mesh_suffixes)

    def _inertial_to_xml(self, link_elem: ET.Element, inertial: Inertial) -> None:
        i_elem = ET.SubElement(link_elem, "inertial")
        _origin_subelem(i_elem, inertial.origin, inertial.origin_rotation)
        ET.SubElement(i_elem, "mass", value=f"{inertial.mass:g}")
        i = inertial.inertia
        ET.SubElement(
            i_elem,
            "inertia",
            ixx=f"{i.ixx:g}",
            iyy=f"{i.iyy:g}",
            izz=f"{i.izz:g}",
            ixy=f"{i.ixy:g}",
            ixz=f"{i.ixz:g}",
            iyz=f"{i.iyz:g}",
        )

    def _visual_to_xml(
        self,
        link_elem: ET.Element,
        g: Geometry,
        tag: str,
        mesh_suffixes: dict[str, str],
    ) -> None:
        elem = ET.SubElement(link_elem, tag)
        _origin_subelem(elem, g.origin, g.origin_rotation)
        _geometry_to_xml(elem, g, mesh_suffixes)
        if g.material and tag == "visual":
            ET.SubElement(elem, "material", name=g.material)

    def _joint_to_xml(
        self,
        root: ET.Element,
        e: Entity,
        scene: Scene,
        name_map: dict[str, str],
        diagnostics: list[Diagnostic],
    ) -> None:
        j = cast(JointComponent, e.get("joint"))
        t = cast(TransformComponent | None, e.get("transform")) or TransformComponent()

        urdf_type = j.type
        if urdf_type in ("ball", "floating"):
            urdf_type = "fixed"  # warned in validate_before_export

        # Our model splits the parent→child static transform across the
        # JOINT (rotation pivot) and the CHILD LINK (post-actuation
        # offset). URDF has no link-frame offset, so we encode the split
        # by inserting a fixed dummy sub-joint when child.transform is
        # non-trivial:
        #     parent ──(actuated, origin=joint.transform)──► <child>_pivot
        #     <child>_pivot ──(fixed, origin=link.transform)──► child
        # The actuated joint rotates around the actual hinge; the fixed
        # offset lands the link where our model places it. With this,
        # both rest-pose mesh placement AND non-zero-θ rotation pivot
        # match the editor.
        child_e = scene.get(j.child_link)
        child_t = (
            cast(TransformComponent | None, child_e.get("transform"))
            if child_e
            else None
        )
        link_offset_nontrivial = child_t is not None and (
            child_t.position != (0.0, 0.0, 0.0)
            or child_t.rotation != (0.0, 0.0, 0.0, 1.0)
        )

        joint_name = name_map.get(e.id, e.name or e.id)
        parent_name = name_map.get(j.parent_link, "")
        child_name = name_map.get(j.child_link, "")
        if not parent_name or not child_name:
            diagnostics.append(
                Diagnostic(
                    severity=Severity.WARNING,
                    code="urdf.joint_missing_link",
                    message=f"joint '{joint_name}' missing parent or child link reference",
                    entity_id=e.id,
                )
            )

        # Actuated portion. Mounts to a dummy if a fixed sub-joint will
        # carry the link offset; otherwise mounts directly to the child.
        actuated_child = (
            f"{child_name}_pivot" if link_offset_nontrivial else child_name
        )
        joint_elem = ET.SubElement(root, "joint", name=joint_name, type=urdf_type)
        _origin_subelem(joint_elem, t.position, t.rotation)
        ET.SubElement(joint_elem, "parent", link=parent_name)
        ET.SubElement(joint_elem, "child", link=actuated_child)
        if j.axis != (0.0, 0.0, 0.0):
            ET.SubElement(joint_elem, "axis", xyz=_xyz_str(j.axis))
        if j.limits is not None:
            ET.SubElement(
                joint_elem,
                "limit",
                lower=f"{j.limits.lower:g}",
                upper=f"{j.limits.upper:g}",
                effort=f"{j.limits.effort:g}",
                velocity=f"{j.limits.velocity:g}",
            )
        if j.dynamics is not None:
            ET.SubElement(
                joint_elem,
                "dynamics",
                damping=f"{j.dynamics.damping:g}",
                friction=f"{j.dynamics.friction:g}",
            )

        if link_offset_nontrivial and child_t is not None:
            # Massless dummy that the actuated joint pivots around.
            ET.SubElement(root, "link", name=actuated_child)
            # Fixed sub-joint applying the link.transform offset.
            fix_elem = ET.SubElement(
                root, "joint", name=f"{joint_name}_offset", type="fixed"
            )
            _origin_subelem(fix_elem, child_t.position, child_t.rotation)
            ET.SubElement(fix_elem, "parent", link=actuated_child)
            ET.SubElement(fix_elem, "child", link=child_name)

    def _material_to_xml(self, root: ET.Element, name: str, mat: Material) -> None:
        m_elem = ET.SubElement(root, "material", name=name)
        ET.SubElement(
            m_elem,
            "color",
            rgba=f"{mat.color[0]:g} {mat.color[1]:g} {mat.color[2]:g} {mat.color[3]:g}",
        )

    @staticmethod
    def _build_mesh_suffix_lookup(project: Project) -> dict[str, str]:
        out: dict[str, str] = {}
        for stem, asset in project.assets.mesh_data.items():
            out[stem] = asset.suffix
        for stem, path_str in project.assets.mesh_files.items():
            if stem not in out:
                sfx = Path(path_str).suffix
                if sfx:
                    out[stem] = sfx
        return out

    def _copy_assets(self, project: Project, dest_dir: Path, diagnostics: list[Diagnostic]) -> None:
        # Meshes
        if project.assets.mesh_data or project.assets.mesh_files:
            (dest_dir / "meshes").mkdir(exist_ok=True)
        written: set[str] = set()
        for stem, asset in project.assets.mesh_data.items():
            target = dest_dir / "meshes" / f"{stem}{asset.suffix}"
            target.write_bytes(asset.data)
            written.add(stem)
        for stem, src_path in project.assets.mesh_files.items():
            if stem in written:
                continue
            src = Path(src_path)
            if src.is_file():
                target = dest_dir / "meshes" / f"{stem}{src.suffix}"
                if src.resolve() != target.resolve():
                    shutil.copy2(src, target)
            else:
                diagnostics.append(
                    Diagnostic(
                        severity=Severity.WARNING,
                        code="urdf.mesh_missing_on_export",
                        message=f"mesh source missing: {src_path} (stem={stem})",
                    )
                )

        # Textures
        if project.assets.texture_data or project.assets.texture_files:
            (dest_dir / "textures").mkdir(exist_ok=True)
        written_tex: set[str] = set()
        for stem, asset in project.assets.texture_data.items():
            target = dest_dir / "textures" / f"{stem}{asset.suffix}"
            target.write_bytes(asset.data)
            written_tex.add(stem)
        for stem, src_path in project.assets.texture_files.items():
            if stem in written_tex:
                continue
            src = Path(src_path)
            if src.is_file():
                target = dest_dir / "textures" / f"{stem}{src.suffix}"
                if src.resolve() != target.resolve():
                    shutil.copy2(src, target)


def _has_inertia(inertial: Inertial) -> bool:
    i = inertial.inertia
    return any([i.ixx, i.iyy, i.izz, i.ixy, i.ixz, i.iyz])
