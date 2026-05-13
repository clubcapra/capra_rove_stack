"""`forgebot ik` — headless IK CLI. Smoke-tests the kinematics package.

Use this to verify IK works on a project from the shell without booting
the editor or any API. Useful for embedding the IK module in robot-side
software: if `forgebot ik solve` returns reasonable joint values, the
same Python import path works.
"""

from __future__ import annotations

import json
from pathlib import Path

import typer

from ..core.kinematics import solve_position_ik
from ..io.serializer.forgebot_file import load

ik_app = typer.Typer(no_args_is_help=True, help="Inverse kinematics CLI.")


@ik_app.command("solve")
def solve(
    project: Path = typer.Argument(..., help=".forgebot file"),
    base: str = typer.Option(..., help="Base link entity id"),
    tip: str = typer.Option(..., help="Tip link entity id"),
    target: tuple[float, float, float] = typer.Option(
        ..., help="Target world position (x y z)"
    ),
    target_rot: tuple[float, float, float, float] | None = typer.Option(
        None,
        help="Optional target rotation as quaternion (x y z w)",
    ),
    mode: str = typer.Option(
        "pos_primary", help="pos_primary or pose_locked"
    ),
    max_iter: int = typer.Option(200),
    damping: float = typer.Option(0.02),
    tol: float = typer.Option(1e-4),
) -> None:
    p = load(project)
    res = solve_position_ik(
        p,
        base=base,
        tip=tip,
        target_world=target,
        target_rotation=target_rot,
        initial_joint_values={},
        max_iter=max_iter,
        damping=damping,
        tol=tol,
        mode=mode,
    )
    print(
        json.dumps(
            {
                "converged": res.converged,
                "iterations": res.iterations,
                "pos_residual_mm": res.pos_residual * 1000,
                "rot_residual_deg": res.rot_residual * 57.29577951308232,
                "joint_values": res.joint_values,
            },
            indent=2,
        )
    )
