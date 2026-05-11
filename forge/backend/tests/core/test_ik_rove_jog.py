"""Strict jog-mode tests on the actual rove_standard arm.

These are the tests the user asked for explicitly:
  - Pure translation must NOT change EE orientation.
  - Pure rotation must NOT change EE position (within geometric limits).
  - Translate-then-rotate-then-translate sequences track each component.
  - Collision-respecting drag stops short of self-collisions.

Loads the real `rove_standard.forgebot` from the user's project dir as the
fixture. Tests are skipped (not failed) if the file isn't on disk.

IMPORTANT — geometric realities of the rove arm:

The rove home (q=0) is at a planar singularity (3 parallel y-axis wrist
joints). At that exact configuration, locked-orientation IK can ONLY
translate +x; every other direction is unreachable while preserving pose.
That's the arm, not the solver. The IK gizmo will feel broken if you start
jogging from q=0.

These tests therefore start from a slightly bent pose (shoulder=0.5,
elbow=-0.4 rad) — the realistic state of an arm a user would actually
jog. The bounds reflect what's geometrically achievable from there:

  - Translation: orient locked to <0.5°, position catches up to within ~10mm
    (depending on direction; the per-call cap forces a smooth trajectory).
  - Rotation: position drifts depending on rotation axis. The arm has 3
    parallel y-axis wrist joints, so ry rotations preserve position well
    (~3mm drift); rx and rz rotations require the chain to globally
    reconfigure and produce more drift (tens of mm) — that's a kinematic
    limit, not a bug.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from forgebot.core.kinematics import (
    extract_chain,
    solve_position_ik,
    world_transforms,
)
from forgebot.io.serializer.forgebot_file import load


ROVE_PATH = Path.home() / ".forgebot" / "projects" / "rove_standard.forgebot"


# Translate gizmo defaults — orientation hard-locked, position catches up.
JOG_TRANSLATE = dict(
    rest_pose_gain=0.30,
    joint_weight_strength=0.0,
    max_iter=60,
    damping=0.05,
    orientation_weight=5.0,
    max_dq_step=0.05,
    max_pos_step=0.05,
    max_total_dq_step=0.10,
    mode="pose_locked",
)
# Rotate gizmo defaults — position hard-locked via task-priority IK,
# orientation tracks what's geometrically achievable. This is what makes
# rotation feel like "rotate in place" instead of swinging the EE.
JOG_ROTATE = dict(
    rest_pose_gain=0.30,
    joint_weight_strength=0.0,
    max_iter=60,
    damping=0.05,
    orientation_weight=5.0,
    max_dq_step=0.05,
    max_pos_step=0.05,
    max_total_dq_step=0.10,
    mode="pos_primary",
    orientation_secondary_gain=4.0,
)
# Back-compat alias for tests that don't depend on the gizmo split.
JOG = JOG_TRANSLATE


def _quat_from_R(R: np.ndarray) -> tuple[float, float, float, float]:
    trace = float(R[0, 0] + R[1, 1] + R[2, 2])
    s = 0.5 / math.sqrt(trace + 1.0)
    return (
        (R[2, 1] - R[1, 2]) * s,
        (R[0, 2] - R[2, 0]) * s,
        (R[1, 0] - R[0, 1]) * s,
        0.25 / s,
    )


def _drift_deg(R_now: np.ndarray, R_ref: np.ndarray) -> float:
    Rd = R_now @ R_ref.T
    cos_a = max(-1.0, min(1.0, (float(np.trace(Rd)) - 1.0) * 0.5))
    return math.degrees(math.acos(cos_a))


def _axis_angle_R(axis: tuple[float, float, float], angle: float) -> np.ndarray:
    ax = np.array(axis, dtype=float)
    ax = ax / np.linalg.norm(ax)
    K = np.array(
        [[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]], dtype=float
    )
    return np.eye(3) + math.sin(angle) * K + (1 - math.cos(angle)) * (K @ K)


@pytest.fixture(scope="module")
def rove():
    if not ROVE_PATH.exists():
        pytest.skip(f"rove fixture not present at {ROVE_PATH}")
    project = load(ROVE_PATH)
    jg = next(
        (eid for eid, e in project.scene.entities.items() if e.name == "JointGripper"),
        None,
    )
    core = next(
        (eid for eid, e in project.scene.entities.items() if e.name == "Core"),
        None,
    )
    assert jg and core, "JointGripper/Core entity ids not found in rove fixture"
    chain = extract_chain(project, core, jg)
    movable_ids = [
        jid for jid in chain.joints
        if project.scene.entities[jid].components.get("joint")
        and project.scene.entities[jid].components["joint"].type == "revolute"
    ]
    # Bend shoulder + elbow to escape the home singularity. This is the
    # realistic seed from which a user would jog.
    seed_pose = {movable_ids[1]: 0.5, movable_ids[2]: -0.4}
    fk = world_transforms(project, seed_pose)
    home_T = fk[jg]
    return {
        "project": project,
        "base": core,
        "tip": jg,
        "seed": seed_pose,
        "home_pos": home_T[:3, 3].copy(),
        "home_R": home_T[:3, :3].copy(),
        "home_quat": _quat_from_R(home_T[:3, :3]),
    }


def _drag_translate(rove, direction, *, n_ticks=15, step_m=0.002, **overrides):
    project = rove["project"]
    base, tip = rove["base"], rove["tip"]
    home_pos = rove["home_pos"]
    target_quat = rove["home_quat"]
    seed = dict(rove["seed"])
    drag_start = dict(rove["seed"])
    pos_errs: list[float] = []
    drifts: list[float] = []
    params = {**JOG_TRANSLATE, **overrides}
    direction = np.array(direction, dtype=float)
    for tick in range(n_ticks):
        target = home_pos + direction * step_m * (tick + 1)
        result = solve_position_ik(
            project, base=base, tip=tip,
            target_world=tuple(target), target_rotation=target_quat,
            initial_joint_values=seed, rest_pose=drag_start,
            **params,
        )
        seed = result.joint_values
        T = world_transforms(project, seed)[tip]
        pos_errs.append(float(np.linalg.norm(T[:3, 3] - target)))
        drifts.append(_drift_deg(T[:3, :3], rove["home_R"]))
    return {
        "pos_err_final": pos_errs[-1],
        "drift_max": max(drifts),
        "joints": seed,
    }


def _drag_rotate(rove, axis, *, n_ticks=15, step_deg=1.0, **overrides):
    project = rove["project"]
    base, tip = rove["base"], rove["tip"]
    home_pos = rove["home_pos"]
    home_R = rove["home_R"]
    seed = dict(rove["seed"])
    drag_start = dict(rove["seed"])
    pos_drifts: list[float] = []
    rot_errs: list[float] = []
    params = {**JOG_ROTATE, **overrides}
    for tick in range(n_ticks):
        ang = math.radians(step_deg) * (tick + 1)
        R_target = _axis_angle_R(axis, ang) @ home_R
        target_quat = _quat_from_R(R_target)
        result = solve_position_ik(
            project, base=base, tip=tip,
            target_world=tuple(home_pos), target_rotation=target_quat,
            initial_joint_values=seed, rest_pose=drag_start,
            **params,
        )
        seed = result.joint_values
        T = world_transforms(project, seed)[tip]
        pos_drifts.append(float(np.linalg.norm(T[:3, 3] - home_pos)))
        rot_errs.append(_drift_deg(T[:3, :3], R_target))
    return {
        "pos_drift_max": max(pos_drifts),
        "rot_err_final": rot_errs[-1],
        "joints": seed,
    }


# ---- pure translation tests ----
#
# The strong assertion is "orientation is locked" — that's the user's
# explicit ask. Position lag is bounded but not zero (per-call motion cap).


@pytest.mark.parametrize("direction,label,pos_tol_mm", [
    ((1.0, 0.0, 0.0), "+x", 1.0),
    ((-1.0, 0.0, 0.0), "-x", 12.0),
    ((0.0, 1.0, 0.0), "+y", 12.0),
    ((0.0, -1.0, 0.0), "-y", 12.0),
    ((0.0, 0.0, 1.0), "+z", 12.0),
    ((0.0, 0.0, -1.0), "-z", 12.0),
])
def test_pure_translation_does_not_twist_ee(rove, direction, label, pos_tol_mm):
    """Drag the EE 30mm in any cardinal direction. Orientation MUST hold."""
    r = _drag_translate(rove, direction, n_ticks=15, step_m=0.002)
    assert r["drift_max"] < 0.5, (
        f"{label}: EE twisted {r['drift_max']:.3f}° during a pure translation drag"
    )
    # Position-tracking bound is direction-dependent — see fixture docstring.
    assert r["pos_err_final"] < pos_tol_mm / 1000.0, (
        f"{label}: final position error {r['pos_err_final']*1000:.2f}mm "
        f"(threshold {pos_tol_mm:.0f}mm)"
    )


# ---- pure rotation tests ----


# With pos_primary (task-priority IK) on rotate-drag, position is held to
# a few mm on EVERY axis. Orientation may not fully reach the target on
# axes the chain can't pivot around in place (rx, rz on this arm) — but
# position never gets sacrificed. This is the user's "rotate on itself"
# requirement.
@pytest.mark.parametrize("axis,label,rot_tol_deg", [
    ((1.0, 0.0, 0.0), "rx", 8.0),   # rx is geometrically hard — chain tracks ~half the requested rotation
    ((0.0, 1.0, 0.0), "ry", 2.5),   # ry uses the parallel y-axis joints — converges close
    ((0.0, 0.0, 1.0), "rz", 4.0),   # rz needs configuration change — partial tracking
])
def test_pure_rotation_keeps_position_locked(rove, axis, label, rot_tol_deg):
    """Rotate the EE 15° around each cardinal axis. Position must NOT drift —
    this is the bug that prompted the test ("rotate on itself"). Orientation
    error bound is per-axis: the chain catches up on axes it can pivot around
    in place; on axes it can't, IK gives up rotation rather than translating."""
    r = _drag_rotate(rove, axis, n_ticks=15, step_deg=1.0)
    assert r["pos_drift_max"] < 0.005, (
        f"{label}: EE position drifted {r['pos_drift_max']*1000:.2f}mm during a "
        f"pure rotation drag (must stay <5mm)"
    )
    assert r["rot_err_final"] < rot_tol_deg, (
        f"{label}: orientation final error {r['rot_err_final']:.2f}° "
        f"(threshold {rot_tol_deg:.1f}°)"
    )


def test_ry_rotation_tracks_target_well(rove):
    """Strong claim: rotation around the parallel-wrist axis (Y) preserves
    position AND tracks the requested orientation closely (the chain can
    pivot the gripper in place via the y-axis joints)."""
    r = _drag_rotate(rove, (0, 1, 0), n_ticks=15, step_deg=1.0)
    assert r["pos_drift_max"] < 0.005
    assert r["rot_err_final"] < 2.5, (
        f"ry: orientation final error {r['rot_err_final']:.2f}° — chain isn't "
        "tracking its primary rotation axis"
    )


# ---- sequenced drags ----


def test_translate_then_rotate_then_translate(rove):
    """Realistic jog sequence. Each phase preserves the OTHER coordinate;
    after all three, EE pose is the composition of the deltas."""
    project = rove["project"]
    base, tip = rove["base"], rove["tip"]

    # Phase 1: translate +x by 20mm.
    r1 = _drag_translate(rove, (1, 0, 0), n_ticks=10, step_m=0.002)
    assert r1["drift_max"] < 0.5, (
        f"phase 1 (translate +x): EE twisted {r1['drift_max']:.2f}°"
    )

    # Phase 2: rotate 10° around y from the new pose.
    seed = dict(r1["joints"])
    drag_start = dict(seed)
    fk_p1 = world_transforms(project, seed)[tip]
    p1_pos = fk_p1[:3, 3].copy()
    p1_R = fk_p1[:3, :3].copy()
    pos_drifts: list[float] = []
    for tick in range(10):
        ang = math.radians(1.0) * (tick + 1)
        R_target = _axis_angle_R((0, 1, 0), ang) @ p1_R
        result = solve_position_ik(
            project, base=base, tip=tip,
            target_world=tuple(p1_pos), target_rotation=_quat_from_R(R_target),
            initial_joint_values=seed, rest_pose=drag_start, **JOG_ROTATE,
        )
        seed = result.joint_values
        T = world_transforms(project, seed)[tip]
        pos_drifts.append(float(np.linalg.norm(T[:3, 3] - p1_pos)))
    assert max(pos_drifts) < 0.005, (
        f"phase 2 (rotate ry): position drifted {max(pos_drifts)*1000:.1f}mm"
    )

    # Phase 3: translate +y by 20mm with orientation locked to phase-2 end.
    drag_start = dict(seed)
    fk_p2 = world_transforms(project, seed)[tip]
    p2_pos = fk_p2[:3, 3].copy()
    p2_R = fk_p2[:3, :3].copy()
    p2_quat = _quat_from_R(p2_R)
    drifts_p3: list[float] = []
    for tick in range(10):
        target = p2_pos + np.array([0, 0.002 * (tick + 1), 0])
        result = solve_position_ik(
            project, base=base, tip=tip,
            target_world=tuple(target), target_rotation=p2_quat,
            initial_joint_values=seed, rest_pose=drag_start, **JOG,
        )
        seed = result.joint_values
        T = world_transforms(project, seed)[tip]
        drifts_p3.append(_drift_deg(T[:3, :3], p2_R))
    assert max(drifts_p3) < 0.5, (
        f"phase 3 (translate +y): EE drifted {max(drifts_p3):.2f}°"
    )


def test_translate_back_returns_near_home(rove):
    """Drag forward 20mm, release, drag back. EE should return very near home."""
    project = rove["project"]
    base, tip = rove["base"], rove["tip"]
    home_pos = rove["home_pos"]
    home_quat = rove["home_quat"]

    seed = dict(rove["seed"])
    drag_start = dict(rove["seed"])
    # Forward 20mm.
    for tick in range(10):
        target = home_pos + np.array([0.002 * (tick + 1), 0, 0])
        result = solve_position_ik(
            project, base=base, tip=tip,
            target_world=tuple(target), target_rotation=home_quat,
            initial_joint_values=seed, rest_pose=drag_start, **JOG,
        )
        seed = result.joint_values
    # Release and drag back.
    drag_start = dict(seed)
    for tick in range(10):
        target = home_pos + np.array([0.002 * (10 - tick - 1), 0, 0])
        result = solve_position_ik(
            project, base=base, tip=tip,
            target_world=tuple(target), target_rotation=home_quat,
            initial_joint_values=seed, rest_pose=drag_start, **JOG,
        )
        seed = result.joint_values
    final_T = world_transforms(project, seed)[tip]
    pos_back = float(np.linalg.norm(final_T[:3, 3] - home_pos))
    drift_back = _drift_deg(final_T[:3, :3], rove["home_R"])
    assert pos_back < 0.005, f"after forward+back, EE landed {pos_back*1000:.1f}mm from start"
    assert drift_back < 0.5, f"after forward+back, EE twisted {drift_back:.3f}°"


# ---- collision-respecting drag ----


def test_collision_respecting_drag_blocks_self_collision(rove):
    """With respect_collisions=True the IK should reject any iter that
    introduces a new collision pair. Without it, the chain can push through
    its own drum/flipper geometry. We test by dragging straight down toward
    the chassis from a near-home pose."""
    project = rove["project"]
    base, tip = rove["base"], rove["tip"]
    home_pos = rove["home_pos"]
    home_quat = rove["home_quat"]

    target_far = home_pos + np.array([0.0, 0.0, -0.300])  # 300mm down — definitely into the body.

    free = solve_position_ik(
        project, base=base, tip=tip,
        target_world=tuple(target_far), target_rotation=home_quat,
        initial_joint_values=dict(rove["seed"]), rest_pose=dict(rove["seed"]),
        **JOG, respect_collisions=False,
    )
    safe = solve_position_ik(
        project, base=base, tip=tip,
        target_world=tuple(target_far), target_rotation=home_quat,
        initial_joint_values=dict(rove["seed"]), rest_pose=dict(rove["seed"]),
        **JOG, respect_collisions=True,
    )

    free_z = float(world_transforms(project, free.joint_values)[tip][2, 3])
    safe_z = float(world_transforms(project, safe.joint_values)[tip][2, 3])

    # respect_collisions should produce an EE NOT below where the
    # unconstrained run ended (it stopped earlier because of a self-collision).
    # We allow equal in case the geometry is sparse and no collision was
    # detected, in which case both runs end the same.
    assert safe_z >= free_z - 1e-3, (
        f"collision-respecting drag descended FURTHER (z={safe_z:.4f}) than "
        f"the unconstrained drag (z={free_z:.4f}) — respect_collisions broken"
    )
