"""`forgebot validate` — run all validators on a file, print diagnostics."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from ..core.validation import has_errors, validate_all
from ._io import load_any

console = Console()


def validate_command(
    input_path: Path = typer.Argument(..., exists=True, dir_okay=False, readable=True),
) -> None:
    """Validate a project. Exits with code 1 if any errors are found."""
    project = load_any(input_path)
    diagnostics = validate_all(project)

    if not diagnostics:
        console.print("[green]✓ no diagnostics[/green]")
        return

    table = Table(show_header=True, header_style="bold")
    table.add_column("severity")
    table.add_column("code")
    table.add_column("message")
    table.add_column("entity")

    for d in diagnostics:
        color = {"error": "red", "warning": "yellow", "info": "blue"}[d.severity.value]
        table.add_row(
            f"[{color}]{d.severity.value}[/{color}]",
            d.code,
            d.message,
            d.entity_id or "",
        )
    console.print(table)
    n_errors = sum(1 for d in diagnostics if d.is_error)
    n_warnings = sum(1 for d in diagnostics if d.severity.value == "warning")
    console.print(f"\nResult: {n_errors} error(s), {n_warnings} warning(s)")
    if has_errors(diagnostics):
        raise typer.Exit(code=1)
