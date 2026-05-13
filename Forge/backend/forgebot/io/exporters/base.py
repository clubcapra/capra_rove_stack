"""Base interface every exporter implements (Strategy pattern)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path

from ...core.model import Project
from ...core.validation.rules import Diagnostic


@dataclass
class ExportOptions:
    extras: dict[str, object] = field(default_factory=dict)


@dataclass
class ExportResult:
    output_path: Path
    diagnostics: list[Diagnostic] = field(default_factory=list)


class BaseExporter(ABC):
    @abstractmethod
    def export(
        self,
        project: Project,
        output_path: Path,
        options: ExportOptions | None = None,
    ) -> ExportResult: ...

    @abstractmethod
    def supported_formats(self) -> list[str]: ...

    @abstractmethod
    def validate_before_export(self, project: Project) -> list[Diagnostic]: ...
