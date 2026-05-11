"""SDFormat (SDF) exporter."""

from __future__ import annotations

from math import asin, atan2
from pathlib import Path
from typing import cast
from xml.etree import ElementTree as ET

from ...core.model import Entity, JointComponent, LinkComponent, Project, TransformComponent
from ...core.model.components.link import Geometry, Inertial
from ...core.validation.rules import Diagnostic, Severity
from .base import BaseExporter, ExportOptions, ExportResult


FORGEBOT_TO_SDF_JOINT: dict[str, str] = {
    "revolute": "revolute",
    "continuous": "revolute",
    "prismatic": "prismatic",
    "fixed": "fixed",
    "ball": "ball",
    "floating": "fixed",
    "planar": "fixed",
}


def _quat_to_rpy(q: tuple[float, float, float, float]) -> tuple[float, float, float]:
    x, y, z, w = q
    n = (x * x + y * y + z * z + w * w) ** 0.5 or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    sinr_cosp = 2.0 * (w * x + y * z)
    cosr_cosp = 1.0 - 2.0 * (x * x + y * y)
    roll = atan2(sinr_cosp, cosr_cosp)
    sinp = 2.0 * (w * y - z * x)
    pitch = asin(max(-1.0, min(1.0, sinp)))
    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    yaw = atan2(siny_cosp, cosy_cosp)
    return (roll, pitch, yaw)


def _pose_text(xyz: tuple[float, float, float], quat: tuple[float, float, float, float]) -> str:
    rpy = _quat_to_rpy(quat)
    return f"{xyz[0]:g} {xyz[1]:g} {xyz[2]:g} {rpy[0]:g} {rpy[1]:g} {rpy[2]:g}"


def _add_pose(parent: ET.Element, xyz: tuple[float, float, float], quat: tuple[float, float, float, float]) -> None:
    if xyz == (0.0, 0.0, 0.0) and quat == (0.0, 0.0, 0.0, 1.0):
        return
    pose = ET.SubElement(parent, "pose")
    pose.text = _pose_text(xyz, quat)


def _xyz_str(v: tuple[float, float, float]) -> str:
    return f"{v[0]:g} {v[1]:g} {v[2]:g}"


class SDFExporter(BaseExporter):
    def supported_formats(self) -> list[str]:
        return ["sdf"]

    def validate_before_export(self, project: Project) -> list[Diagnostic]:
        diags: list[Diagnostic] = []
        if not project.scene.entities:
            diags.append(
                Diagnostic(
                    severity=Severity.ERROR,
                    code="sdf.empty_scene",
                    message="cannot export an empty scene to SDF",
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

        sdf = ET.Element("sdf", version="1.7")
        model = ET.SubElement(sdf, "model", name=project.manifest.metadata.name or "model")

        for e in project.scene.entities.values():
            if e.has("link"):
                self._link_to_xml(model, e)
            elif e.has("joint"):
                self._joint_to_xml(model, e, project, diagnostics)

        ET.indent(sdf, space="  ")
        tree = ET.ElementTree(sdf)
        tree.write(output_path, encoding="utf-8", xml_declaration=True)
        return ExportResult(output_path=output_path, diagnostics=diagnostics)

    def _link_to_xml(self, model: ET.Element, e: Entity) -> None:
        link = cast(LinkComponent, e.get("link"))
        link_elem = ET.SubElement(model, "link", name=e.name or e.id)
        t = cast(TransformComponent | None, e.get("transform"))
        if t is not None:
            _add_pose(link_elem, t.position, t.rotation)

        if link.inertial.mass > 0 or _has_inertia(link.inertial):
            self._inertial_to_xml(link_elem, link.inertial)

        for vis in link.visuals:
            self._geom_to_xml(link_elem, vis, "visual")
        for col in link.collisions:
            self._geom_to_xml(link_elem, col, "collision")

    def _inertial_to_xml(self, link_elem: ET.Element, inertial: Inertial) -> None:
        i_elem = ET.SubElement(link_elem, "inertial")
        _add_pose(i_elem, inertial.origin, inertial.origin_rotation)
        ET.SubElement(i_elem, "mass").text = f"{inertial.mass:g}"
        i = inertial.inertia
        inertia_elem = ET.SubElement(i_elem, "inertia")
        for tag, val in (("ixx", i.ixx), ("iyy", i.iyy), ("izz", i.izz),
                         ("ixy", i.ixy), ("ixz", i.ixz), ("iyz", i.iyz)):
            ET.SubElement(inertia_elem, tag).text = f"{val:g}"

    def _geom_to_xml(self, link_elem: ET.Element, g: Geometry, tag: str) -> None:
        elem = ET.SubElement(link_elem, tag, name=g.material or tag)
        _add_pose(elem, g.origin, g.origin_rotation)
        geom_elem = ET.SubElement(elem, "geometry")
        if g.primitive == "box":
            box = ET.SubElement(geom_elem, "box")
            ET.SubElement(box, "size").text = (
                f"{g.primitive_params.get('x', 1):g} "
                f"{g.primitive_params.get('y', 1):g} "
                f"{g.primitive_params.get('z', 1):g}"
            )
        elif g.primitive == "sphere":
            sphere = ET.SubElement(geom_elem, "sphere")
            ET.SubElement(sphere, "radius").text = f"{g.primitive_params.get('radius', 1):g}"
        elif g.primitive == "cylinder":
            cyl = ET.SubElement(geom_elem, "cylinder")
            ET.SubElement(cyl, "radius").text = f"{g.primitive_params.get('radius', 1):g}"
            ET.SubElement(cyl, "length").text = f"{g.primitive_params.get('length', 1):g}"
        elif g.mesh:
            mesh = ET.SubElement(geom_elem, "mesh")
            ET.SubElement(mesh, "uri").text = f"meshes/{g.mesh}.stl"

    def _joint_to_xml(
        self,
        model: ET.Element,
        e: Entity,
        project: Project,
        diagnostics: list[Diagnostic],
    ) -> None:
        j = cast(JointComponent, e.get("joint"))
        sdf_type = FORGEBOT_TO_SDF_JOINT.get(j.type, "fixed")

        joint_elem = ET.SubElement(model, "joint", name=e.name or e.id, type=sdf_type)

        t = cast(TransformComponent | None, e.get("transform"))
        if t is not None:
            _add_pose(joint_elem, t.position, t.rotation)

        parent_name = self._link_name(project, j.parent_link)
        child_name = self._link_name(project, j.child_link)
        if not parent_name or not child_name:
            diagnostics.append(
                Diagnostic(
                    severity=Severity.WARNING,
                    code="sdf.joint_missing_link",
                    message=f"joint '{e.name}' missing parent or child link",
                    entity_id=e.id,
                )
            )
        ET.SubElement(joint_elem, "parent").text = parent_name
        ET.SubElement(joint_elem, "child").text = child_name

        if sdf_type != "fixed":
            axis_elem = ET.SubElement(joint_elem, "axis")
            ET.SubElement(axis_elem, "xyz").text = _xyz_str(j.axis)
            if j.limits is not None:
                lim_elem = ET.SubElement(axis_elem, "limit")
                ET.SubElement(lim_elem, "lower").text = f"{j.limits.lower:g}"
                ET.SubElement(lim_elem, "upper").text = f"{j.limits.upper:g}"
                ET.SubElement(lim_elem, "effort").text = f"{j.limits.effort:g}"
                ET.SubElement(lim_elem, "velocity").text = f"{j.limits.velocity:g}"
            if j.dynamics is not None:
                dyn_elem = ET.SubElement(axis_elem, "dynamics")
                ET.SubElement(dyn_elem, "damping").text = f"{j.dynamics.damping:g}"
                ET.SubElement(dyn_elem, "friction").text = f"{j.dynamics.friction:g}"

    def _link_name(self, project: Project, eid: str) -> str:
        e = project.scene.get(eid)
        if e is None:
            return ""
        return e.name or eid


def _has_inertia(inertial: Inertial) -> bool:
    i = inertial.inertia
    return any([i.ixx, i.iyy, i.izz, i.ixy, i.ixz, i.iyz])
