"""`forgebot convert` — load any supported format, write any supported format."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

from ..io.exporters import find_exporter, find_exporter_by_path
from ..io.serializer import save as save_forgebot
from ._io import FORGEBOT_EXTS, load_any

console = Console()


def convert_command(
    input_path: Path = typer.Argument(..., exists=True, dir_okay=False, readable=True),
    output: Path = typer.Option(..., "-o", "--output", help="Output file path"),
    fmt: str | None = typer.Option(
        None, "--to", help="Force output format (urdf, forgebot). Default: from output extension."
    ),
) -> None:
    """Convert between formats. Goes through the in-memory Project."""
    project = load_any(input_path)

    out_fmt = (fmt or output.suffix.lstrip(".")).lower()
    if out_fmt in {"forgebot", "fbot"} or output.suffix.lower() in FORGEBOT_EXTS:
        save_forgebot(project, output)
        console.print(f"[green]wrote[/green] {output} (.forgebot)")
        return

    exporter = find_exporter(out_fmt) if fmt else find_exporter_by_path(output)
    if exporter is None:
        raise typer.BadParameter(f"no exporter for format {out_fmt!r}")

    result = exporter.export(project, output)
    for d in result.diagnostics:
        color = {"error": "red", "warning": "yellow", "info": "blue"}.get(d.severity.value, "white")
        console.print(f"[{color}]{d.severity.value}[/{color}] {d.code}: {d.message}")
    if any(d.is_error for d in result.diagnostics):
        raise typer.Exit(code=1)
    console.print(f"[green]wrote[/green] {output}")
