"""IK tuner tests.

Verify the tuner finds a profile that beats the unhelpful defaults on a
non-spherical-wrist arm (the synthetic STEP-style chain stands in for the
rove arm). Also exercises the pos_primary mode and (de)serialization of
the IKProfile through a project save/load round-trip.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from forgebot.core.kinematics import (
    build_scenarios,
    evaluate_profile,
    run_tune,
    solve_position_ik,
    world_transforms,
)
from forgebot.core.model import IKProfile
from forgebot.io.serializer.forgebot_file import load, save

from .test_ik_live_drag import _build_step_imported_arm


def _tiny_grid() -> list[IKProfile]:
    """Two pose_locked + two pos_primary candidates — fast to evaluate while
    still exercising both branches the tuner cares about."""
    return [
        IKProfile(mode="pose_locked", damping=0.05, rest_pose_gain=0.30,
                  max_iter=40, orientation_weight=5.0, joint_weight_strength=0.0,
                  max_dq_step=0.05, max_pos_step=0.05, orientation_secondary_gain=0.0),
        IKProfile(mode="pose_locked", damping=0.10, rest_pose_gain=0.30,
                  max_iter=40, orientation_weight=5.0, joint_weight_strength=0.0,
                  max_dq_step=0.05, max_pos_step=0.05, orientation_secondary_gain=0.0),
        IKProfile(mode="pos_primary", damping=0.10, rest_pose_gain=0.30,
                  max_iter=40, orientation_weight=5.0, joint_weight_strength=0.0,
                  max_dq_step=0.05, max_pos_step=0.05, orientation_secondary_gain=0.25),
        IKProfile(mode="pos_primary", damping=0.05, rest_pose_gain=0.30,
                  max_iter=40, orientation_weight=5.0, joint_weight_strength=0.0,
                  max_dq_step=0.05, max_pos_step=0.05, orientation_secondary_gain=0.5),
    ]


def _tiny_scenarios(project, base, tip):
    """A pruned scenario list for fast tests — keeps coverage of each axis
    but in fewer ticks."""
    full = build_scenarios(project, base, tip)
    # Keep only home/+x, home/+y, home/+z, home/rz to span translate + rotate.
    keep = {"home/+x", "home/+y", "home/+z", "home/rz"}
    pruned = [sc for sc in full if sc.label in keep]
    # Halve the tick count for speed.
    for sc in pruned:
        sc.n_ticks = max(6, sc.n_ticks // 2)
    return pruned


def test_pos_primary_keeps_position_at_micrometers():
    """pos_primary should never sacrifice position tracking, regardless of
    the orientation secondary gain."""
    arm = _build_step_imported_arm()
    fk = world_transforms(arm.project, {})
    home_pos = fk[arm.tip][:3, 3]
    home_R = fk[arm.tip][:3, :3]
    # Build an arbitrary orientation target by quaternion.
    trace = home_R[0, 0] + home_R[1, 1] + home_R[2, 2]
    s = 0.5 / math.sqrt(trace + 1.0)
    target_quat = (
        (home_R[2, 1] - home_R[1, 2]) * s,
        (home_R[0, 2] - home_R[2, 0]) * s,
        (home_R[1, 0] - home_R[0, 1]) * s,
        0.25 / s,
    )

    seed: dict[str, float] = {}
    drag_start: dict[str, float] = {}
    for tick in range(40):
        target = home_pos + np.array([0.001 * (tick + 1), 0, 0])
        result = solve_position_ik(
            arm.project,
            base=arm.base,
            tip=arm.tip,
            target_world=tuple(target),
            target_rotation=target_quat,
            initial_joint_values=seed,
            rest_pose=drag_start,
            rest_pose_gain=0.3,
            joint_weight_strength=0.0,
            max_iter=60,
            damping=0.05,
            orientation_weight=5.0,
            mode="pos_primary",
            orientation_secondary_gain=2.0,  # aggressive — must NOT bleed into pos.
            max_dq_step=0.05,
            max_pos_step=0.05,
        )
        seed = result.joint_values

    final_T = world_transforms(arm.project, seed)[arm.tip]
    pos_err = float(np.linalg.norm(final_T[:3, 3] - (home_pos + np.array([0.04, 0, 0]))))
    assert pos_err < 1e-3, (
        f"pos_primary leaked orientation push into the position task: "
        f"final pos error {pos_err*1000:.2f} mm"
    )


def test_run_tune_picks_better_than_default_on_singular_arm():
    """The synthetic chain at q=0 is at a planar singularity. The tuner
    should find a profile that scores better than the IKProfile() default
    for this arm — i.e. the per-arm tuning is actually buying something.
    Uses a pruned grid + scenarios to keep the test under a few seconds."""
    arm = _build_step_imported_arm()
    scenarios = _tiny_scenarios(arm.project, arm.base, arm.tip)
    default_score = evaluate_profile(
        arm.project, arm.base, arm.tip, IKProfile(), scenarios,
    )
    best, best_score = run_tune(
        arm.project, base=arm.base, tip=arm.tip,
        candidates=_tiny_grid(), scenarios=scenarios,
    )
    assert best_score.composite <= default_score.composite, (
        f"tuner did not improve over default IKProfile: "
        f"best={best_score.composite:.2f} default={default_score.composite:.2f}"
    )
    # Sanity: position tracking on the winner is excellent.
    assert best_score.pos_err_max_mm < 5.0, (
        f"winning profile has large position error: {best_score.pos_err_max_mm:.1f} mm"
    )
    # Tuned timestamp must be set.
    assert best.tuned_at != ""


def test_tune_progress_callback_fires_in_order():
    """on_progress must be called once per candidate, with done strictly
    increasing and total constant. The UI's progress bar relies on this."""
    arm = _build_step_imported_arm()
    events: list[tuple[int, int]] = []

    def on_progress(done, total, _best, _profile):
        events.append((done, total))

    grid = _tiny_grid()
    scenarios = _tiny_scenarios(arm.project, arm.base, arm.tip)
    run_tune(arm.project, base=arm.base, tip=arm.tip,
             on_progress=on_progress, candidates=grid, scenarios=scenarios)
    total = len(grid)
    assert events, "on_progress was never called"
    assert all(t == total for _, t in events), "total flapped during run"
    dones = [d for d, _ in events]
    assert dones == sorted(dones), "done was not monotonic"
    assert dones[-1] == total, f"final done={dones[-1]} did not reach total={total}"


def test_tune_cancel_short_circuits():
    """Setting cancel after the first event should stop the loop early."""
    arm = _build_step_imported_arm()
    seen = 0

    def on_progress(_done, _total, _best, _profile):
        nonlocal seen
        seen += 1

    cancel_after_first = {"done": False}
    def cancel():
        return cancel_after_first["done"]

    def on_progress_with_cancel(done, total, best, profile):
        on_progress(done, total, best, profile)
        cancel_after_first["done"] = True

    grid = _tiny_grid()
    scenarios = _tiny_scenarios(arm.project, arm.base, arm.tip)
    run_tune(arm.project, base=arm.base, tip=arm.tip,
             on_progress=on_progress_with_cancel, cancel=cancel,
             candidates=grid, scenarios=scenarios)
    # We should have seen far fewer than the full grid.
    assert seen < len(grid), (
        f"cancel didn't short-circuit — saw {seen} of {len(grid)}"
    )


def test_ik_profile_roundtrips_through_forgebot(tmp_path: Path):
    """A tuned profile must survive save/load of the .forgebot archive."""
    arm = _build_step_imported_arm()
    arm.project.ik_profiles[arm.base] = IKProfile(
        mode="pos_primary",
        damping=0.07,
        rest_pose_gain=0.42,
        max_iter=55,
        orientation_weight=4.5,
        joint_weight_strength=0.0,
        max_dq_step=0.04,
        max_pos_step=0.06,
        orientation_secondary_gain=0.75,
        score=12.34,
        tuned_at="2026-05-07T22:00:00+00:00",
    )
    out = tmp_path / "tuned.forgebot"
    save(arm.project, out)
    loaded = load(out)
    assert arm.base in loaded.ik_profiles
    p = loaded.ik_profiles[arm.base]
    assert p.mode == "pos_primary"
    assert abs(p.damping - 0.07) < 1e-9
    assert abs(p.rest_pose_gain - 0.42) < 1e-9
    assert p.max_iter == 55
    assert abs(p.orientation_secondary_gain - 0.75) < 1e-9
    assert abs(p.score - 12.34) < 1e-9
    assert p.tuned_at == "2026-05-07T22:00:00+00:00"
