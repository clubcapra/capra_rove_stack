"""ForgeBOT CLI entry point."""

from __future__ import annotations

import typer

from .convert import convert_command
from .editor import editor_command
from .ik import ik_app
from .inspect import inspect_command
from .validate import validate_command

app = typer.Typer(
    name="forgebot",
    help="Universal robot and automation editor — CLI",
    no_args_is_help=True,
)

app.command("convert")(convert_command)
app.command("validate")(validate_command)
app.command("inspect")(inspect_command)
app.command("editor")(editor_command)
app.add_typer(ik_app, name="ik")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
