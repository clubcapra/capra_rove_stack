"""MJCF (MuJoCo) exporter.

Walks the scene tree as a sequence of nested <body> elements. Each link
becomes a body whose pose comes from the joint above it. Joints emit
<joint> elements inside their child link's body.
"""

from __future__ import annotations

from pathlib import Path
from typing import cast
from xml.etree import ElementTree as ET

from ...core.model import Entity, JointComponent, LinkComponent, Project, TransformComponent
from ...core.model.components.link import Geometry, Inertial
from ...core.validation.rules import Diagnostic, Severity
from .base import BaseExporter, ExportOptions, ExportResult


FORGEBOT_TO_MJCF_JOINT: dict[str, str] = {
    "revolute": "hinge",
    "continuous": "hinge",
    "prismatic": "slide",
    "ball": "ball",
    "floating": "free",
}


def _xyz_str(v: tuple[float, float, float]) -> str:
    return f"{v[0]:g} {v[1]:g} {v[2]:g}"


def _quat_str(q: tuple[float, float, float, float]) -> str:
    """ForgeBOT quat is (x, y, z, w); MuJoCo expects (w, x, y, z)."""
    x, y, z, w = q
    return f"{w:g} {x:g} {y:g} {z:g}"


class MJCFExporter(BaseExporter):
    def supported_formats(self) -> list[str]:
        return ["mjcf", "xml"]

    def validate_before_export(self, project: Project) -> list[Diagnostic]:
        diags: list[Diagnostic] = []
        if not project.scene.entities:
            diags.append(
                Diagnostic(
                    severity=Severity.ERROR,
                    code="mjcf.empty_scene",
                    message="cannot export an empty scene to MJCF",
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

        model_name = project.manifest.metadata.name or "model"
        root = ET.Element("mujoco", model=model_name)

        # Materials -> <asset>
        if project.assets.materials:
            asset_elem = ET.SubElement(root, "asset")
            for name, mat in project.assets.materials.items():
                ET.SubElement(
                    asset_elem,
                    "material",
                    name=name,
                    rgba=f"{mat.color[0]:g} {mat.color[1]:g} {mat.color[2]:g} {mat.color[3]:g}",
                )

        worldbody = ET.SubElement(root, "worldbody")

        # Walk every link entity that has no link parent (i.e. its scene parent is
        # either None, or a non-joint entity). Those are the world-level bodies.
        for root_id in project.scene.roots:
            root_entity = project.scene.entities.get(root_id)
            if root_entity is None:
                continue
            if root_entity.has("link"):
                self._emit_body(root_entity, worldbody, project, diagnostics)

        ET.indent(root, space="  ")
        tree = ET.ElementTree(root)
        tree.write(output_path, encoding="utf-8", xml_declaration=True)
        return ExportResult(output_path=output_path, diagnostics=diagnostics)

    # ----- helpers -----

    def _emit_body(
        self,
        link_entity: Entity,
        parent_xml: ET.Element,
        project: Project,
        diagnostics: list[Diagnostic],
    ) -> None:
        """Emit one <body> for a link entity, including any <joint> coming from
        the joint that sits above it (its parent in the scene graph)."""
        scene = project.scene
        body_attrs: dict[str, str] = {"name": link_entity.name or link_entity.id}

        # The pose comes from the parent joint's transform if there is one,
        # else from the link's own transform.
        parent_id = link_entity.parent
        parent_joint: JointComponent | None = None
        parent_joint_eid: str | None = None
        parent_joint_transform: TransformComponent | None = None
        if parent_id is not None:
            parent_entity = scene.get(parent_id)
            if parent_entity is not None and parent_entity.has("joint"):
                parent_joint = cast(JointComponent, parent_entity.get("joint"))
                parent_joint_eid = parent_entity.id
                parent_joint_transform = cast(TransformComponent, parent_entity.get("transform")) \
                    if parent_entity.has("transform") else None

        if parent_joint_transform is not None:
            if parent_joint_transform.position != (0.0, 0.0, 0.0):
                body_attrs["pos"] = _xyz_str(parent_joint_transform.position)
            if parent_joint_transform.rotation != (0.0, 0.0, 0.0, 1.0):
                body_attrs["quat"] = _quat_str(parent_joint_transform.rotation)
        else:
            t = cast(TransformComponent | None, link_entity.get("transform"))
            if t is not None:
                if t.position != (0.0, 0.0, 0.0):
                    body_attrs["pos"] = _xyz_str(t.position)
                if t.rotation != (0.0, 0.0, 0.0, 1.0):
                    body_attrs["quat"] = _quat_str(t.rotation)

        body_elem = ET.SubElement(parent_xml, "body", **body_attrs)

        # Joint: only if the parent joint isn't a synthetic fixed weld AND it isn't a fixed type.
        if parent_joint is not None and parent_joint.type != "fixed":
            mjcf_type = FORGEBOT_TO_MJCF_JOINT.get(parent_joint.type, "hinge")
            j_attrs: dict[str, str] = {
                "name": (scene.entities[parent_joint_eid].name if parent_joint_eid else "joint"),
                "type": mjcf_type,
                "axis": _xyz_str(parent_joint.axis),
            }
            if parent_joint.limits is not None and (
                parent_joint.limits.lower != 0.0 or parent_joint.limits.upper != 0.0
            ):
                j_attrs["range"] = f"{parent_joint.limits.lower:g} {parent_joint.limits.upper:g}"
            ET.SubElement(body_elem, "joint", **j_attrs)

        # Inertial
        link = cast(LinkComponent, link_entity.get("link"))
        if link.inertial.mass > 0:
            self._emit_inertial(body_elem, link.inertial)

        # Geoms (use visuals; collisions are duplicates for MJCF since it merges them)
        for vis in link.visuals:
            self._emit_geom(body_elem, vis)

        # Recurse: every joint child of this link maps to one nested body.
        for child_id in link_entity.children:
            child = scene.get(child_id)
            if child is None:
                continue
            if child.has("joint"):
                # The joint's children are link entities — emit one body per child link.
                for grandchild_id in child.children:
                    grandchild = scene.get(grandchild_id)
                    if grandchild is not None and grandchild.has("link"):
                        self._emit_body(grandchild, body_elem, project, diagnostics)
            elif child.has("link"):
                # Direct link child (no joint between) — shouldn't happen in well-formed scenes,
                # but handle it as a welded body.
                self._emit_body(child, body_elem, project, diagnostics)

    def _emit_inertial(self, body_elem: ET.Element, inertial: Inertial) -> None:
        attrs: dict[str, str] = {"mass": f"{inertial.mass:g}"}
        if inertial.origin != (0.0, 0.0, 0.0):
            attrs["pos"] = _xyz_str(inertial.origin)
        if inertial.origin_rotation != (0.0, 0.0, 0.0, 1.0):
            attrs["quat"] = _quat_str(inertial.origin_rotation)
        i = inertial.inertia
        attrs["diaginertia"] = f"{i.ixx:g} {i.iyy:g} {i.izz:g}"
        ET.SubElement(body_elem, "inertial", **attrs)

    def _emit_geom(self, body_elem: ET.Element, g: Geometry) -> None:
        attrs: dict[str, str] = {}
        if g.material:
            attrs["material"] = g.material
        if g.origin != (0.0, 0.0, 0.0):
            attrs["pos"] = _xyz_str(g.origin)
        if g.origin_rotation != (0.0, 0.0, 0.0, 1.0):
            attrs["quat"] = _quat_str(g.origin_rotation)
        if g.mesh:
            attrs["type"] = "mesh"
            attrs["mesh"] = g.mesh
        elif g.primitive == "box":
            p = g.primitive_params
            attrs["type"] = "box"
            attrs["size"] = f"{p.get('x', 1) / 2:g} {p.get('y', 1) / 2:g} {p.get('z', 1) / 2:g}"
        elif g.primitive == "sphere":
            attrs["type"] = "sphere"
            attrs["size"] = f"{g.primitive_params.get('radius', 1):g}"
        elif g.primitive == "cylinder":
            attrs["type"] = "cylinder"
            attrs["size"] = (
                f"{g.primitive_params.get('radius', 1):g} "
                f"{g.primitive_params.get('length', 1) / 2:g}"
            )
        else:
            attrs["type"] = "sphere"
            attrs["size"] = "0.05"
        ET.SubElement(body_elem, "geom", **attrs)
