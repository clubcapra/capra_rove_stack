"""`forgebot editor` — start the API server (frontend launches separately)."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

console = Console()


def editor_command(
    project_path: Path | None = typer.Argument(None, exists=True, dir_okay=False, readable=True),
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int = typer.Option(8420, "--port"),
) -> None:
    """Launch the FastAPI backend (and load `project_path` if given)."""
    try:
        import uvicorn
    except ImportError as e:
        console.print(
            "[red]uvicorn is not installed.[/red] Install API extras: "
            "`pip install -e .[api]`"
        )
        raise typer.Exit(code=1) from e

    if project_path is not None:
        from ..api import get_state
        from ._io import load_any
        get_state().replace_project(load_any(project_path))
        console.print(f"[green]loaded[/green] {project_path}")

    console.print(f"[cyan]ForgeBOT API[/cyan] listening on http://{host}:{port}")
    uvicorn.run("forgebot.api.main:app", host=host, port=port, reload=False)
