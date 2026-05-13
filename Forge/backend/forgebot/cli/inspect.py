"""`forgebot inspect` — print scene tree summary."""

from __future__ import annotations

from pathlib import Path
from typing import cast

import typer
from rich.console import Console
from rich.tree import Tree

from ..core.model import Entity, JointComponent, LinkComponent, Project
from ._io import load_any

console = Console()


def inspect_command(
    input_path: Path = typer.Argument(..., exists=True, dir_okay=False, readable=True),
    fmt: str = typer.Option("tree", "--format", help="tree | summary"),
) -> None:
    """Show structure of a project."""
    project = load_any(input_path)
    if fmt == "summary":
        _print_summary(project)
    else:
        _print_tree(project)


def _print_summary(project: Project) -> None:
    n_links = sum(1 for e in project.scene.entities.values() if e.has("link"))
    n_joints = sum(1 for e in project.scene.entities.values() if e.has("joint"))
    n_meshes = len(project.assets.mesh_files)
    n_materials = len(project.assets.materials)
    console.print(f"[bold]{project.manifest.metadata.name}[/bold]")
    console.print(f"  entities:  {len(project.scene.entities)}")
    console.print(f"  links:     {n_links}")
    console.print(f"  joints:    {n_joints}")
    console.print(f"  meshes:    {n_meshes}")
    console.print(f"  materials: {n_materials}")
    console.print(f"  roots:     {len(project.scene.roots)}")


def _print_tree(project: Project) -> None:
    title = project.manifest.metadata.name or "scene"
    tree = Tree(f"[bold]{title}[/bold]")
    for root_id in project.scene.roots:
        _add_node(project, tree, root_id)
    console.print(tree)


def _add_node(project: Project, parent_node: Tree, eid: str) -> None:
    e = project.scene.entities.get(eid)
    if e is None:
        return
    label = _label_for(e)
    node = parent_node.add(label)
    for child_id in e.children:
        _add_node(project, node, child_id)


def _label_for(e: Entity) -> str:
    name = e.name or e.id
    if e.has("joint"):
        j = cast(JointComponent, e.get("joint"))
        return rf"[yellow]\[{j.type}][/yellow] {name}"
    if e.has("link"):
        link = cast(LinkComponent, e.get("link"))
        suffix = f" [dim](mass={link.inertial.mass:g})[/dim]" if link.inertial.mass else ""
        return f"[cyan]link[/cyan] {name}{suffix}"
    return f"[dim]{name}[/dim]"
