"""Exporter registry. New format = new module + entry in `EXPORTERS`."""

from __future__ import annotations

from pathlib import Path

from .base import BaseExporter, ExportOptions, ExportResult
from .ik_engine_exporter import IKEngineExporter
from .mjcf_exporter import MJCFExporter
from .sdf_exporter import SDFExporter
from .urdf_exporter import URDFExporter

EXPORTERS: dict[str, BaseExporter] = {
    "urdf": URDFExporter(),
    "mjcf": MJCFExporter(),
    "sdf": SDFExporter(),
    "ik_engine": IKEngineExporter(),
}


def find_exporter(fmt: str) -> BaseExporter | None:
    return EXPORTERS.get(fmt.lower())


def find_exporter_by_path(output_path: Path) -> BaseExporter | None:
    return find_exporter(output_path.suffix.lstrip(".").lower())


def export_file(
    project,
    output_path: Path,
    fmt: str | None = None,
    options: ExportOptions | None = None,
) -> ExportResult:
    exp = find_exporter(fmt) if fmt else find_exporter_by_path(output_path)
    if exp is None:
        raise ValueError(f"no exporter for format {fmt!r} or path {output_path}")
    return exp.export(project, output_path, options)


__all__ = [
    "BaseExporter",
    "EXPORTERS",
    "ExportOptions",
    "ExportResult",
    "IKEngineExporter",
    "MJCFExporter",
    "SDFExporter",
    "URDFExporter",
    "export_file",
    "find_exporter",
    "find_exporter_by_path",
]
