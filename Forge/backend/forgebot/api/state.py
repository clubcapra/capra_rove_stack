"""Per-server in-memory state.

Phase 1 keeps a single project at a time — multi-document opens later.
The state holds the Project, a CommandStack for undo/redo, and an
EventBus that fires whenever the project changes.
"""

from __future__ import annotations

from ..core.commands import Command, CommandStack
from ..core.model import Project
from .events import EventBus


class AppState:
    def __init__(self) -> None:
        self._project: Project = Project()
        self._stack: CommandStack = CommandStack(self._project)
        self.events: EventBus = EventBus()

    @property
    def project(self) -> Project:
        return self._project

    @property
    def stack(self) -> CommandStack:
        return self._stack

    def replace_project(self, project: Project) -> None:
        """Drop the current project (and its history) and adopt a new one."""
        self._project = project
        self._stack = CommandStack(self._project)
        # Mesh-bounds cache holds geometry across project lifetimes; reset.
        from ..core.validation import clear_collision_cache
        clear_collision_cache()
        self.events.publish("project.replaced", name=project.manifest.metadata.name)

    def execute(self, cmd: Command) -> None:
        """Run a command and broadcast a generic mutation event."""
        self._stack.execute(cmd)
        self.events.publish("project.mutated", description=cmd.description)


_state: AppState | None = None


def get_state() -> AppState:
    global _state
    if _state is None:
        _state = AppState()
    return _state


def reset_state() -> None:
    """For tests."""
    global _state
    _state = None
