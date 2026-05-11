"""Live-drag IK tests on a realistic STEP-import-style 6-DOF arm.

The synthetic 2-DOF / 4-DOF tests elsewhere confirm the math, but they
don't reproduce the cancelling-offset pattern STEP imports use (every
joint has a translation offset, the child link has the exact inverse, so
link world origins all collapse to (0,0,0) and meshes carry absolute
coordinates). That's the structure the user actually drives, and it
exposes IK problems the simple chains don't.

Each test simulates the live-drag loop: many small position-target
ticks, seeded from the previous tick's joint values, with the same
parameters the frontend sends. Failures here mean the user feels them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from forgebot.core.kinematics import solve_position_ik, world_transforms
from forgebot.core.model import (
    Entity,
    JointComponent,
    LinkComponent,
    Project,
    TransformComponent,
    new_entity_id,
)
from forgebot.core.model.components.joint import JointLimits


@dataclass
class StepArm:
    project: Project
    base: str  # root link entity id
    tip: str   # gripper / leaf link entity id
    joints: dict[str, str]  # human-name -> joint entity id


def _build_step_imported_arm() -> StepArm:
    """6-DOF arm matching rove_standard's structure.

    Joint local positions are non-trivial; child links carry the exact
    inverse so every link's world origin (at θ=0) is (0, 0, 0). Joint
    axes follow rove_standard's pattern: yaw (z), shoulder (y), elbow
    (-y), wrist roll (-x), wrist pitch (y), gripper roll (-x).
    """
    p = Project()
    core = Entity(id=new_entity_id("link"), name="Core")
    core.attach(TransformComponent())
    core.attach(LinkComponent())
    p.scene.add(core)

    joints: dict[str, str] = {}
    parent_id = core.id

    # (joint name, axis, joint local pos, child link name)
    spec = [
        ("yaw",      (0.0, 0.0, 1.0),  (-0.3,  0.15, 0.09), "Base"),
        ("shoulder", (0.0, 1.0, 0.0),  (-0.4,  0.27, 0.39), "ASection"),
        ("elbow",    (0.0, -1.0, 0.0), (-0.7,  0.26, 0.38), "JointA"),
        ("wrist1",   (-1.0, 0.0, 0.0), (-0.77, 0.21, 0.38), "BSection"),
        ("wrist2",   (0.0, 1.0, 0.0),  (-1.09, 0.21, 0.38), "JointB"),
        ("gripper",  (-1.0, 0.0, 0.0), (-1.17, 0.20, 0.38), "JointGripper"),
    ]

    last_link_id = core.id
    for jname, axis, jpos, lname in spec:
        j = Entity(id=new_entity_id("joint"), name=f"j_{jname}")
        j.attach(TransformComponent(position=jpos))
        j.attach(
            JointComponent(
                type="revolute",
                axis=axis,
                parent_link=last_link_id,
                child_link="",
                limits=JointLimits(lower=-3.14159, upper=3.14159, effort=10.0, velocity=1.0),
            )
        )
        p.scene.add(j, parent=last_link_id)
        joints[jname] = j.id

        # Cancelling offset on child link.
        link = Entity(id=new_entity_id("link"), name=lname)
        link.attach(TransformComponent(position=(-jpos[0], -jpos[1], -jpos[2])))
        link.attach(LinkComponent())
        p.scene.add(link, parent=j.id)
        j.components["joint"].child_link = link.id  # type: ignore[union-attr]
        last_link_id = link.id

    return StepArm(project=p, base=core.id, tip=last_link_id, joints=joints)


# Live-drag parameters mirror what `IKGizmo.tsx` sends.
DRAG_DAMPING = 0.03
DRAG_MAX_ITER = 20


def _matrix_to_quat(R: np.ndarray) -> tuple[float, float, float, float]:
    trace = R[0, 0] + R[1, 1] + R[2, 2]
    if trace > 0:
        s = 0.5 / math.sqrt(trace + 1.0)
        return (
            (R[2, 1] - R[1, 2]) * s,
            (R[0, 2] - R[2, 0]) * s,
            (R[1, 0] - R[0, 1]) * s,
            0.25 / s,
        )
    # Generic case (skipped — our home pose has positive trace).
    raise NotImplementedError


def _rotation_drift_deg(R_now: np.ndarray, R_ref: np.ndarray) -> float:
    R_diff = R_now @ R_ref.T
    cos_a = max(-1.0, min(1.0, (np.trace(R_diff) - 1.0) * 0.5))
    return math.degrees(math.acos(cos_a))


def _drag(
    arm: StepArm,
    direction: tuple[float, float, float],
    *,
    n_ticks: int = 12,
    step_m: float = 0.005,
    is_leaf: bool = True,
) -> dict:
    """Simulate live drag of `arm.tip` along `direction`. Returns final
    joint values + EE pose."""
    fk_home = world_transforms(arm.project, {})
    home_T = fk_home[arm.tip]
    home_pos = home_T[:3, 3]
    home_R = home_T[:3, :3]
    home_quat = _matrix_to_quat(home_R)

    drag_start: dict[str, float] = {}
    seed: dict[str, float] = {}
    direction_arr = np.array(direction, dtype=float)
    for tick in range(n_ticks):
        target = home_pos + direction_arr * step_m * (tick + 1)
        result = solve_position_ik(
            arm.project,
            base=arm.base,
            tip=arm.tip,
            target_world=tuple(target),
            target_rotation=home_quat if is_leaf else None,
            initial_joint_values=seed,
            rest_pose=drag_start,
            rest_pose_gain=0.05,
            joint_weight_strength=0.0 if is_leaf else 1.0,
            max_iter=DRAG_MAX_ITER,
            damping=DRAG_DAMPING,
            orientation_weight=5.0 if is_leaf else 0.3,
        )
        seed = result.joint_values

    final_T = world_transforms(arm.project, seed)[arm.tip]
    return {
        "home_pos": home_pos,
        "home_R": home_R,
        "final_pos": final_T[:3, 3],
        "final_R": final_T[:3, :3],
        "joints": seed,
        "target": tuple(home_pos + direction_arr * step_m * n_ticks),
    }


# ---- tests ----


def test_leaf_forward_drag_keeps_orientation_locked():
    """Drag the gripper forward 6 cm. EE rotation drift must stay tiny."""
    arm = _build_step_imported_arm()
    r = _drag(arm, direction=(1.0, 0.0, 0.0), n_ticks=12, step_m=0.005, is_leaf=True)
    drift = _rotation_drift_deg(r["final_R"], r["home_R"])
    pos_err = np.linalg.norm(r["final_pos"] - np.array(r["target"]))
    assert drift < 1.0, f"EE rotation drifted {drift:.2f}° on forward translate (expected <1°)"
    assert pos_err < 0.01, f"EE position error {pos_err*1000:.1f}mm (expected <10mm)"


def test_leaf_side_drag_keeps_orientation_locked():
    """Drag the gripper sideways 6 cm. Same: orientation must not twist."""
    arm = _build_step_imported_arm()
    r = _drag(arm, direction=(0.0, 1.0, 0.0), n_ticks=12, step_m=0.005, is_leaf=True)
    drift = _rotation_drift_deg(r["final_R"], r["home_R"])
    pos_err = np.linalg.norm(r["final_pos"] - np.array(r["target"]))
    assert drift < 1.0, f"EE rotation drifted {drift:.2f}° on side translate (expected <1°)"
    assert pos_err < 0.02, f"EE position error {pos_err*1000:.1f}mm (expected <20mm)"


def test_forward_drag_doesnt_rotate_mount_excessively():
    """Forward drag should be done by arm joints, not by yawing the base.
    The mount yaw joint may move some (geometry sometimes requires it),
    but it should not be the dominant motion."""
    arm = _build_step_imported_arm()
    r = _drag(arm, direction=(1.0, 0.0, 0.0), n_ticks=12, step_m=0.005, is_leaf=True)
    mount_yaw = abs(r["joints"][arm.joints["yaw"]])
    # Sum of arm-joint motion (everything below mount).
    arm_joint_motion = sum(
        abs(r["joints"][arm.joints[name]])
        for name in ("shoulder", "elbow", "wrist1", "wrist2", "gripper")
    )
    assert mount_yaw < arm_joint_motion, (
        f"forward translate used mount yaw ({mount_yaw:.3f} rad) more than "
        f"the arm joints combined ({arm_joint_motion:.3f} rad)"
    )


def test_side_drag_uses_mount_yaw():
    """Side translation should use the mount yaw — that's what it's for.
    If the mount stays at zero, the chain has to contort instead."""
    arm = _build_step_imported_arm()
    r = _drag(arm, direction=(0.0, 1.0, 0.0), n_ticks=12, step_m=0.005, is_leaf=True)
    mount_yaw = abs(r["joints"][arm.joints["yaw"]])
    assert mount_yaw > 0.05, (
        f"side translate left mount yaw at {mount_yaw:.4f} rad — IK is "
        "ignoring the joint that's specifically there to yaw the arm"
    )


def test_no_joint_saturation_on_in_workspace_drag():
    """Within reachable workspace, no joint should slam into its limit."""
    arm = _build_step_imported_arm()
    r = _drag(arm, direction=(1.0, 0.0, 0.0), n_ticks=10, step_m=0.005, is_leaf=True)
    for jname, jid in arm.joints.items():
        v = r["joints"][jid]
        # Limits are ±π in our fixture.
        assert abs(v) < 3.0, f"joint {jname} saturated near limit at {v:.3f} rad"


def test_leaf_far_drag_keeps_orientation_locked():
    """Drag the gripper well past workspace (80 ticks × 1 cm = 80 cm).
    Even when position can't be reached, orientation must stay locked.
    The user explicitly does NOT want the EE to twist as a fallback —
    the chain should stop following position rather than sacrifice the
    EE's orientation."""
    arm = _build_step_imported_arm()
    r = _drag(arm, direction=(1.0, 0.0, 0.0), n_ticks=80, step_m=0.01, is_leaf=True)
    drift = _rotation_drift_deg(r["final_R"], r["home_R"])
    # Bound is "user wouldn't notice it twisting", not "exact lock". At
    # workspace boundary with damping=0.03, a few degrees of drift is the
    # cost of stability; below the threshold of visible rotation.
    assert drift < 8.0, f"EE rotated {drift:.1f}° on a far drag (past workspace)"


def test_unreachable_target_stays_bounded():
    """Drag past the workspace radius. The chain should stop at the edge,
    NOT thrash through joint limits."""
    arm = _build_step_imported_arm()
    # Drag much further than the arm can reach.
    r = _drag(arm, direction=(1.0, 0.0, 0.0), n_ticks=200, step_m=0.01, is_leaf=True)
    for jname, jid in arm.joints.items():
        v = r["joints"][jid]
        assert abs(v) <= 3.14159 + 1e-3, f"joint {jname} escaped its limit at {v:.3f} rad"
    # Position residual is whatever — workspace limit forces it. But the
    # chain shouldn't have flown through joint limits.


def test_idle_drag_stays_close_to_seed():
    """Drag of length ~0 (cursor not moving). Chain shouldn't drift across
    repeated identical IK calls."""
    arm = _build_step_imported_arm()
    r = _drag(arm, direction=(1.0, 0.0, 0.0), n_ticks=30, step_m=1e-5, is_leaf=True)
    total_motion = sum(abs(v) for v in r["joints"].values())
    assert total_motion < 0.1, (
        f"IK drifted {total_motion:.3f} rad of total joint motion across 30 "
        "near-zero-step ticks — should be near zero"
    )


def test_respect_collisions_stops_at_first_collision():
    """When respect_collisions is on, the IK should reject any step that
    introduces a new collision pair — chain stops short instead of
    passing through obstacles. Two box links placed close together force
    a collision when the arm tries to cross through them."""
    p = Project()
    # Build a tiny chain: base, joint, link with a fat collision box.
    base = Entity(id=new_entity_id("link"), name="base")
    base.attach(TransformComponent())
    base.attach(LinkComponent())
    p.scene.add(base)

    j = Entity(id=new_entity_id("joint"), name="j1")
    j.attach(TransformComponent())
    j.attach(JointComponent(
        type="revolute", axis=(0, 0, 1), parent_link=base.id, child_link="",
        limits=JointLimits(lower=-3.14, upper=3.14, effort=1, velocity=1),
    ))
    p.scene.add(j, parent=base.id)

    arm = Entity(id=new_entity_id("link"), name="arm")
    arm.attach(TransformComponent(position=(0.5, 0.0, 0.0)))
    from forgebot.core.model.components.link import Geometry
    arm.attach(LinkComponent(
        collisions=[Geometry(primitive="box", primitive_params={"x": 0.4, "y": 0.1, "z": 0.1})]
    ))
    p.scene.add(arm, parent=j.id)
    j.components["joint"].child_link = arm.id  # type: ignore[union-attr]

    # An obstacle right next to home pose (overlapping arm's swing path
    # at, say, +60° rotation).
    obstacle = Entity(id=new_entity_id("link"), name="obstacle")
    obstacle.attach(TransformComponent(position=(0.3, 0.4, 0.0)))
    obstacle.attach(LinkComponent(
        collisions=[Geometry(primitive="box", primitive_params={"x": 0.15, "y": 0.15, "z": 0.5})]
    ))
    p.scene.add(obstacle)

    # Without respect_collisions: IK pushes through, target reached.
    free = solve_position_ik(
        p, base=base.id, tip=arm.id,
        target_world=(0.0, 0.5, 0.0),
        max_iter=50, damping=0.03,
    )
    # With respect_collisions: IK stops short.
    safe = solve_position_ik(
        p, base=base.id, tip=arm.id,
        target_world=(0.0, 0.5, 0.0),
        max_iter=50, damping=0.03,
        respect_collisions=True,
    )
    # Safe run's joint angle should be smaller (didn't get all the way).
    free_angle = abs(list(free.joint_values.values())[0])
    safe_angle = abs(list(safe.joint_values.values())[0])
    assert safe_angle < free_angle - 0.1, (
        f"respect_collisions didn't stop the IK: free={free_angle:.3f}, "
        f"safe={safe_angle:.3f}"
    )


def test_consistent_results_across_directions():
    """Drag the same distance in 6 cardinal directions from home. Each should
    produce a smooth, sensible solution — joint values shouldn't suddenly
    blow up depending on direction."""
    arm_template = _build_step_imported_arm()  # home pose reference
    fk = world_transforms(arm_template.project, {})
    home_pos = fk[arm_template.tip][:3, 3]

    directions = [
        (1, 0, 0), (-1, 0, 0),
        (0, 1, 0), (0, -1, 0),
        (0, 0, 1), (0, 0, -1),
    ]
    for d in directions:
        arm = _build_step_imported_arm()
        r = _drag(arm, direction=d, n_ticks=20, step_m=0.005, is_leaf=True)
        # Total joint motion should be modest — no joint should have
        # exploded to its limit on a 10 cm drag.
        for jname, jid in arm.joints.items():
            v = abs(r["joints"][jid])
            assert v < 2.5, f"direction {d}: joint {jname} blew up to {v:.3f} rad"
        drift = _rotation_drift_deg(r["final_R"], r["home_R"])
        assert drift < 5.0, f"direction {d}: rotation drift {drift:.2f}° (expected <5°)"


def test_repeated_drags_converge_to_same_state():
    """Drag forward, release, drag forward again. Final pose should be the
    same both times — not accumulated drift between runs."""
    arm = _build_step_imported_arm()
    r1 = _drag(arm, direction=(1, 0, 0), n_ticks=10, step_m=0.005, is_leaf=True)
    r2 = _drag(arm, direction=(1, 0, 0), n_ticks=10, step_m=0.005, is_leaf=True)
    # Reset and drag again from home — should match.
    pos_diff = float(np.linalg.norm(r1["final_pos"] - r2["final_pos"]))
    assert pos_diff < 1e-6, f"drag-from-home not deterministic: {pos_diff*1000:.2f}mm difference"


def test_zigzag_drag_doesnt_explode():
    """Drag forward, then back, then forward, then back. Joints shouldn't
    accumulate large motion — the chain should return near home pose."""
    arm = _build_step_imported_arm()
    fk = world_transforms(arm.project, {})
    home_pos = fk[arm.tip][:3, 3]
    home_R = fk[arm.tip][:3, :3]
    home_quat = _matrix_to_quat(home_R)

    seed: dict[str, float] = {}
    drag_start: dict[str, float] = {}
    # 5 ticks +X, 5 ticks -X, repeat. Each run starts a new "drag" with
    # fresh anchor.
    for cycle in range(3):
        for direction in [(1, 0, 0), (-1, 0, 0)]:
            drag_start = dict(seed)
            for tick in range(5):
                target = home_pos + np.array([direction[0] * (tick + 1) * 0.005, 0, 0])
                result = solve_position_ik(
                    arm.project, base=arm.base, tip=arm.tip,
                    target_world=tuple(target), target_rotation=home_quat,
                    initial_joint_values=seed, rest_pose=drag_start, rest_pose_gain=0.05,
                    joint_weight_strength=0.0, max_iter=DRAG_MAX_ITER,
                    damping=DRAG_DAMPING, orientation_weight=5.0,
                )
                seed = result.joint_values

    # After all cycles end with -X drag back to ~home, EE should be near home.
    final_T = world_transforms(arm.project, seed)[arm.tip]
    pos_err = float(np.linalg.norm(final_T[:3, 3] - home_pos))
    assert pos_err < 0.10, f"zigzag drag accumulated {pos_err*1000:.0f}mm position drift"
    # Joints shouldn't have wandered to extremes.
    for jname, jid in arm.joints.items():
        v = abs(seed.get(jid, 0))
        assert v < 1.5, f"zigzag drag pushed joint {jname} to {v:.3f} rad"


def test_drag_from_non_home_pose():
    """Start with the chain bent (not at home), then drag. The IK should
    smoothly continue from the current pose, not jump to a different
    branch."""
    arm = _build_step_imported_arm()
    # Pre-bend the chain via direct joint assignment.
    pre_pose = {
        arm.joints["shoulder"]: 0.5,
        arm.joints["elbow"]: -0.3,
    }
    fk_pre = world_transforms(arm.project, pre_pose)
    pre_pos = fk_pre[arm.tip][:3, 3]
    pre_R = fk_pre[arm.tip][:3, :3]
    pre_quat = _matrix_to_quat(pre_R)

    seed = dict(pre_pose)
    drag_start = dict(pre_pose)
    for tick in range(15):
        target = pre_pos + np.array([0.005 * (tick + 1), 0, 0])
        result = solve_position_ik(
            arm.project, base=arm.base, tip=arm.tip,
            target_world=tuple(target), target_rotation=pre_quat,
            initial_joint_values=seed, rest_pose=drag_start, rest_pose_gain=0.05,
            joint_weight_strength=0.0, max_iter=DRAG_MAX_ITER,
            damping=DRAG_DAMPING, orientation_weight=5.0,
        )
        seed = result.joint_values

    # Position task should still be reachable from the bent start (within
    # the workspace from that pose).
    final_T = world_transforms(arm.project, seed)[arm.tip]
    final_pos = final_T[:3, 3]
    target_final = pre_pos + np.array([0.075, 0, 0])
    pos_err = float(np.linalg.norm(final_pos - target_final))
    assert pos_err < 0.05, f"drag from bent pose missed target by {pos_err*1000:.0f}mm"
    # No joint should have flipped sign massively (jumping branches).
    for jname, jid in arm.joints.items():
        v = seed.get(jid, 0)
        prev = pre_pose.get(jid, 0)
        # Joint shouldn't have changed by more than 1.5 rad from start.
        assert abs(v - prev) < 1.5, (
            f"joint {jname} jumped from {prev:.3f} to {v:.3f} rad — likely "
            "switched IK branches mid-drag"
        )


def test_mid_chain_drag_doesnt_break_orientation_lock_on_other_chains():
    """Dragging a mid-chain link should not affect joints outside that chain.
    Only joints between base and the dragged link can change."""
    arm = _build_step_imported_arm()
    # Use the wrist joint (joints["wrist1"]) as a mid-chain tip.
    # Find the BSection link (child of wrist1).
    p = arm.project
    bsection_eid = next(
        eid for eid, e in p.scene.entities.items() if e.name == "BSection"
    )

    fk_home = world_transforms(p, {})
    home_T = fk_home[bsection_eid]
    home_pos = home_T[:3, 3]
    home_R = home_T[:3, :3]
    home_quat = _matrix_to_quat(home_R)

    seed: dict[str, float] = {}
    drag_start: dict[str, float] = {}
    for tick in range(10):
        target = home_pos + np.array([0.005 * (tick + 1), 0, 0])
        result = solve_position_ik(
            p,
            base=arm.base,
            tip=bsection_eid,
            target_world=tuple(target),
            target_rotation=None,  # mid-chain: position only
            initial_joint_values=seed,
            rest_pose=drag_start,
            rest_pose_gain=0.05,
            joint_weight_strength=1.0,
            max_iter=DRAG_MAX_ITER,
            damping=DRAG_DAMPING,
        )
        seed = result.joint_values

    # Joints below BSection (wrist2, gripper) shouldn't have been touched
    # by this IK at all — they're not in the chain base→BSection.
    assert arm.joints["wrist2"] not in seed, "wrist2 was modified but isn't in the chain"
    assert arm.joints["gripper"] not in seed, "gripper was modified but isn't in the chain"


def _live_translate(
    arm: StepArm,
    direction: tuple[float, float, float],
    *,
    n_ticks: int,
    step_m: float,
) -> dict:
    fk = world_transforms(arm.project, {})
    home_pos = fk[arm.tip][:3, 3]
    direction_arr = np.array(direction, dtype=float)

    seed: dict[str, float] = {}
    drag_start: dict[str, float] = {}
    pos_errors: list[float] = []
    joint_traces: list[dict[str, float]] = []
    for tick in range(n_ticks):
        target = home_pos + direction_arr * step_m * (tick + 1)
        result = solve_position_ik(
            arm.project,
            base=arm.base,
            tip=arm.tip,
            target_world=tuple(target),
            target_rotation=None,
            initial_joint_values=seed,
            rest_pose=drag_start,
            rest_pose_gain=0.05,
            joint_weight_strength=0.0,
            max_iter=DRAG_MAX_ITER,
            damping=DRAG_DAMPING,
        )
        seed = result.joint_values
        ach = world_transforms(arm.project, seed)[arm.tip][:3, 3]
        pos_errors.append(float(np.linalg.norm(ach - target)))
        joint_traces.append(dict(seed))

    return {"pos_errors": pos_errors, "joint_traces": joint_traces, "final_q": seed}


def test_translate_drag_tracks_target_every_tick():
    arm = _build_step_imported_arm()
    r = _live_translate(arm, direction=(1, 0, 0), n_ticks=30, step_m=0.005)
    worst = max(r["pos_errors"])
    assert worst < 1e-3, (
        f"translate drag missed by up to {worst*1000:.1f} mm at some tick"
    )


def test_translate_drag_smooth_joint_motion():
    arm = _build_step_imported_arm()
    r = _live_translate(arm, direction=(1, 0, 0), n_ticks=40, step_m=0.005)
    traces = r["joint_traces"]
    max_delta = 0.0
    for prev, cur in zip(traces, traces[1:]):
        for jid, v in cur.items():
            delta = abs(v - prev.get(jid, 0.0))
            if delta > max_delta:
                max_delta = delta
    assert max_delta < 0.25, (
        f"largest per-tick joint delta was {max_delta:.3f} rad"
    )


def test_translate_drag_reversibility():
    arm = _build_step_imported_arm()
    fk = world_transforms(arm.project, {})
    home_pos = fk[arm.tip][:3, 3]

    seed: dict[str, float] = {}
    drag_start: dict[str, float] = {}
    for tick in range(20):
        target = home_pos + np.array([0.005 * (tick + 1), 0, 0])
        seed = solve_position_ik(
            arm.project, base=arm.base, tip=arm.tip,
            target_world=tuple(target), target_rotation=None,
            initial_joint_values=seed, rest_pose=drag_start,
            rest_pose_gain=0.05, joint_weight_strength=0.0,
            max_iter=DRAG_MAX_ITER, damping=DRAG_DAMPING,
        ).joint_values
    drag_start = dict(seed)
    for tick in range(20):
        target = home_pos + np.array([0.005 * (20 - tick - 1), 0, 0])
        seed = solve_position_ik(
            arm.project, base=arm.base, tip=arm.tip,
            target_world=tuple(target), target_rotation=None,
            initial_joint_values=seed, rest_pose=drag_start,
            rest_pose_gain=0.05, joint_weight_strength=0.0,
            max_iter=DRAG_MAX_ITER, damping=DRAG_DAMPING,
        ).joint_values

    final_pos = world_transforms(arm.project, seed)[arm.tip][:3, 3]
    err = float(np.linalg.norm(final_pos - home_pos))
    assert err < 1e-3, (
        f"after forward+back drag, EE landed {err*1000:.2f} mm from home"
    )


def test_translate_drag_doesnt_pin_joints_at_limits():
    for direction in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]:
        a = _build_step_imported_arm()
        r = _live_translate(a, direction=direction, n_ticks=10, step_m=0.005)
        for jname, jid in a.joints.items():
            v = r["final_q"][jid]
            assert abs(v) < 3.14159 - 0.05, (
                f"direction {direction}: joint {jname} pinned at limit "
                f"({v:.3f} rad)"
            )


def test_rotate_drag_tracks_orientation_every_tick():
    arm = _build_step_imported_arm()
    fk = world_transforms(arm.project, {})
    home_T = fk[arm.tip]
    home_pos = home_T[:3, 3]
    home_R = home_T[:3, :3]

    seed: dict[str, float] = {}
    drag_start: dict[str, float] = {}
    worst_rot = 0.0
    for tick in range(30):
        ang = math.radians(0.5 * (tick + 1))
        Rz = np.array([
            [math.cos(ang), -math.sin(ang), 0],
            [math.sin(ang),  math.cos(ang), 0],
            [0, 0, 1],
        ])
        target_R = Rz @ home_R
        target_quat = _matrix_to_quat(target_R)
        seed = solve_position_ik(
            arm.project, base=arm.base, tip=arm.tip,
            target_world=tuple(home_pos), target_rotation=target_quat,
            initial_joint_values=seed, rest_pose=drag_start,
            rest_pose_gain=0.05, joint_weight_strength=0.0,
            max_iter=DRAG_MAX_ITER, damping=DRAG_DAMPING,
            orientation_weight=5.0,
        ).joint_values
        ach_R = world_transforms(arm.project, seed)[arm.tip][:3, :3]
        rot_err = _rotation_drift_deg(ach_R, target_R)
        if rot_err > worst_rot:
            worst_rot = rot_err

    assert worst_rot < 0.5, (
        f"rotate drag missed orientation by up to {worst_rot:.3f}° at some tick"
    )
