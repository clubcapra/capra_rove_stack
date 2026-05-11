"""Shared I/O helpers for CLI commands."""

from __future__ import annotations

from pathlib import Path

from ..core.model import Project
from ..io.importers import find_importer
from ..io.serializer import load as load_forgebot


FORGEBOT_EXTS = {".forgebot", ".fbot"}


def load_any(input_path: Path) -> Project:
    """Load a project from `.forgebot` or any supported foreign format."""
    if input_path.suffix.lower() in FORGEBOT_EXTS:
        return load_forgebot(input_path)
    importer = find_importer(input_path)
    if importer is None:
        raise ValueError(f"no importer can handle {input_path}")
    result = importer.import_file(input_path)
    return result.project
