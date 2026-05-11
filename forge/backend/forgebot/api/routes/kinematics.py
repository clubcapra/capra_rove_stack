"""Kinematics routes: forward kinematics, chain extraction, IK, IK tuning."""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ...core.kinematics import (
    extract_chain,
    run_tune,
    solve_position_ik,
    world_transforms,
)
from ...core.kinematics.tune import TuneStatus
from ...core.model import IKProfile
from ...core.validation import check_collisions
from ..schemas import FKRequest, FKResponse
from ..state import get_state

router = APIRouter(prefix="/api/v1/kinematics", tags=["kinematics"])


@router.post("/fk", response_model=FKResponse)
def forward_kinematics(body: FKRequest) -> FKResponse:
    tfs = world_transforms(get_state().project, body.joint_values)
    return FKResponse(
        transforms={eid: tf.tolist() for eid, tf in tfs.items()},
    )


@router.get("/chain")
def get_chain(base: str, tip: str) -> dict:
    project = get_state().project
    try:
        chain = extract_chain(project, base, tip)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"base": chain.base, "tip": chain.tip, "joints": chain.joints}


class IKRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base: str
    tip: str
    target_world: tuple[float, float, float]
    target_rotation: tuple[float, float, float, float] | None = None
    initial_joint_values: dict[str, float] = Field(default_factory=dict)
    max_iter: int = 100
    tol: float = 1e-4
    damping: float = 0.05
    orientation_weight: float = 1.0
    # Optional null-space bias toward a "rest" pose (e.g. project.home_pose).
    # Off by default — DLS without bias gives the minimum-norm joint step,
    # which is what you want for live drag (least joint motion to reach
    # the target). Opt in when you want the chain to drift toward a known
    # comfortable configuration in the redundant DOFs.
    rest_pose: dict[str, float] | None = None
    rest_pose_gain: float = 0.05
    use_home_pose: bool = False
    joint_weight_strength: float = 1.0
    check_collisions: bool = False
    # If true, the IK solver itself rejects any step that introduces a
    # new collision pair (separate from `check_collisions`, which only
    # *reports* the collisions in the response).
    respect_collisions: bool = False
    # "pose_locked" or "pos_primary" — see solve_position_ik for details.
    mode: str = "pose_locked"
    orientation_secondary_gain: float = 0.5
    max_dq_step: float | None = None
    max_pos_step: float | None = None
    # TCP (tool center point) offset in the tip link's local frame. When
    # set, the IK position task targets `link_pos + link_R @ tcp_offset`
    # instead of `link_pos`. Used by the rotate gizmo to make the chain
    # pivot around the visible gripper centroid rather than the link
    # origin (which can be far away on STEP-imported assemblies).
    tcp_offset_local: tuple[float, float, float] | None = None
    max_total_dq_step: float | None = None


class CollisionPairOut(BaseModel):
    a: str
    b: str
    distance: float
    penetration: float


class IKResponse(BaseModel):
    joint_values: dict[str, float]
    iterations: int
    residual: float
    converged: bool
    pos_residual: float = 0.0
    rot_residual: float = 0.0
    collisions: list[CollisionPairOut] = Field(default_factory=list)


@router.post("/ik", response_model=IKResponse)
def inverse_kinematics(body: IKRequest) -> IKResponse:
    project = get_state().project
    if body.base not in project.scene:
        raise HTTPException(status_code=404, detail=f"base {body.base!r} not found")
    if body.tip not in project.scene:
        raise HTTPException(status_code=404, detail=f"tip {body.tip!r} not found")
    try:
        rest_pose: dict[str, float] | None = body.rest_pose
        if rest_pose is None and body.use_home_pose:
            rest_pose = dict(project.home_pose) or None
        kwargs: dict = {}
        if body.max_dq_step is not None:
            kwargs["max_dq_step"] = body.max_dq_step
        if body.max_pos_step is not None:
            kwargs["max_pos_step"] = body.max_pos_step
        if body.max_total_dq_step is not None:
            kwargs["max_total_dq_step"] = body.max_total_dq_step
        result = solve_position_ik(
            project,
            base=body.base,
            tip=body.tip,
            target_world=body.target_world,
            target_rotation=body.target_rotation,
            initial_joint_values=body.initial_joint_values,
            rest_pose=rest_pose,
            rest_pose_gain=body.rest_pose_gain,
            joint_weight_strength=body.joint_weight_strength,
            respect_collisions=body.respect_collisions,
            max_iter=body.max_iter,
            tol=body.tol,
            damping=body.damping,
            orientation_weight=body.orientation_weight,
            mode=body.mode,
            orientation_secondary_gain=body.orientation_secondary_gain,
            tcp_offset_local=body.tcp_offset_local,
            **kwargs,
        )
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    collisions: list[CollisionPairOut] = []
    if body.check_collisions:
        pairs = check_collisions(project, joint_values=result.joint_values)
        pairs.sort(key=lambda p: p.penetration, reverse=True)
        collisions = [
            CollisionPairOut(a=p.a, b=p.b, distance=p.distance, penetration=p.penetration)
            for p in pairs
        ]
    return IKResponse(
        joint_values=result.joint_values,
        iterations=result.iterations,
        residual=result.residual,
        converged=result.converged,
        pos_residual=result.pos_residual,
        rot_residual=result.rot_residual,
        collisions=collisions,
    )


# ---- IK tuning ----


class _TuneJob:
    """In-memory record of a running tune. Mutated from the worker thread,
    read from request handlers — only `done`, `best_score`, `cancelled`,
    `finished`, `best_profile`, `error` are read concurrently. The asserts
    below all hold under the GIL for atomic primitive assignments."""

    __slots__ = (
        "job_id", "base", "tip", "started_at", "done", "total",
        "best_score", "best_profile", "finished", "cancelled", "error",
        "thread",
    )

    def __init__(self, job_id: str, base: str, tip: str, total: int) -> None:
        self.job_id = job_id
        self.base = base
        self.tip = tip
        self.started_at = time.monotonic()
        self.done = 0
        self.total = total
        self.best_score = float("inf")
        self.best_profile: IKProfile | None = None
        self.finished = False
        self.cancelled = False
        self.error: str | None = None
        self.thread: threading.Thread | None = None

    def status(self) -> TuneStatus:
        elapsed = time.monotonic() - self.started_at
        eta = 0.0
        if 0 < self.done < self.total:
            eta = elapsed * (self.total - self.done) / self.done
        return TuneStatus(
            job_id=self.job_id,
            base=self.base,
            tip=self.tip,
            done=self.done,
            total=self.total,
            started_at=self.started_at,
            eta_s=eta,
            best_score=self.best_score,
            best_profile=self.best_profile,
            finished=self.finished,
            cancelled=self.cancelled,
            error=self.error,
        )


_jobs: dict[str, _TuneJob] = {}
_jobs_lock = threading.Lock()


class IKTuneStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base: str
    tip: str


class IKTuneProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: str
    damping: float
    rest_pose_gain: float
    max_iter: int
    orientation_weight: float
    joint_weight_strength: float
    max_dq_step: float
    max_pos_step: float
    max_total_dq_step: float | None
    orientation_secondary_gain: float
    score: float
    pos_err_max_mm: float
    rot_drift_deg: float
    max_jump_rad: float
    total_motion_rad: float
    saturated_joints: int
    new_collision_pairs: int
    tuned_at: str


class IKTuneStatusResponse(BaseModel):
    job_id: str
    base: str
    tip: str
    done: int
    total: int
    started_at: float
    elapsed_s: float
    eta_s: float
    best_score: float
    best_profile: IKTuneProfile | None
    finished: bool
    cancelled: bool
    error: str | None = None


def _profile_to_schema(p: IKProfile | None) -> IKTuneProfile | None:
    if p is None:
        return None
    return IKTuneProfile(
        mode=p.mode,
        damping=p.damping,
        rest_pose_gain=p.rest_pose_gain,
        max_iter=p.max_iter,
        orientation_weight=p.orientation_weight,
        joint_weight_strength=p.joint_weight_strength,
        max_dq_step=p.max_dq_step,
        max_pos_step=p.max_pos_step,
        max_total_dq_step=p.max_total_dq_step,
        orientation_secondary_gain=p.orientation_secondary_gain,
        score=p.score,
        pos_err_max_mm=p.pos_err_max_mm,
        rot_drift_deg=p.rot_drift_deg,
        max_jump_rad=p.max_jump_rad,
        total_motion_rad=p.total_motion_rad,
        saturated_joints=p.saturated_joints,
        new_collision_pairs=p.new_collision_pairs,
        tuned_at=p.tuned_at,
    )


def _status_response(job: _TuneJob) -> IKTuneStatusResponse:
    s = job.status()
    return IKTuneStatusResponse(
        job_id=s.job_id,
        base=s.base,
        tip=s.tip,
        done=s.done,
        total=s.total,
        started_at=s.started_at,
        elapsed_s=time.monotonic() - s.started_at,
        eta_s=s.eta_s,
        best_score=s.best_score,
        best_profile=_profile_to_schema(s.best_profile),
        finished=s.finished,
        cancelled=s.cancelled,
        error=s.error,
    )


def _run_tune_thread(job: _TuneJob) -> None:
    state = get_state()
    project = state.project

    def on_progress(done: int, total: int, best: float, profile: Any) -> None:
        job.done = done
        job.total = total
        job.best_score = best
        if profile is not None:
            job.best_profile = profile
        # Best-effort: publish progress to the WebSocket bus.
        state.events.publish(
            "ik_tune.progress",
            job_id=job.job_id,
            done=done,
            total=total,
            best_score=best if best != float("inf") else None,
            elapsed_s=time.monotonic() - job.started_at,
            eta_s=job.status().eta_s,
        )

    def cancel_fn() -> bool:
        return job.cancelled

    try:
        best_profile, best_score = run_tune(
            project,
            base=job.base,
            tip=job.tip,
            on_progress=on_progress,
            cancel=cancel_fn,
        )
        if not job.cancelled:
            project.ik_profiles[job.base] = best_profile
            project.touch()
            job.best_profile = best_profile
            job.best_score = best_score.composite
        job.finished = True
        state.events.publish(
            "ik_tune.done",
            job_id=job.job_id,
            base=job.base,
            cancelled=job.cancelled,
            score=job.best_score if job.best_score != float("inf") else None,
        )
    except Exception as e:  # noqa: BLE001
        job.error = f"{type(e).__name__}: {e}"
        job.finished = True
        state.events.publish(
            "ik_tune.done",
            job_id=job.job_id,
            base=job.base,
            cancelled=False,
            error=job.error,
        )


@router.post("/ik/tune/start", response_model=IKTuneStatusResponse)
def start_ik_tune(body: IKTuneStartRequest) -> IKTuneStatusResponse:
    project = get_state().project
    if body.base not in project.scene:
        raise HTTPException(status_code=404, detail=f"base {body.base!r} not found")
    if body.tip not in project.scene:
        raise HTTPException(status_code=404, detail=f"tip {body.tip!r} not found")
    try:
        extract_chain(project, body.base, body.tip)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    from ...core.kinematics.tune import candidate_grid as _grid
    total = len(_grid())
    job_id = uuid.uuid4().hex[:12]
    job = _TuneJob(job_id=job_id, base=body.base, tip=body.tip, total=total)
    with _jobs_lock:
        _jobs[job_id] = job
    t = threading.Thread(target=_run_tune_thread, args=(job,), daemon=True)
    job.thread = t
    t.start()
    return _status_response(job)


@router.get("/ik/tune/{job_id}", response_model=IKTuneStatusResponse)
def get_ik_tune(job_id: str) -> IKTuneStatusResponse:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return _status_response(job)


@router.post("/ik/tune/{job_id}/cancel", response_model=IKTuneStatusResponse)
def cancel_ik_tune(job_id: str) -> IKTuneStatusResponse:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    job.cancelled = True
    return _status_response(job)


@router.get("/ik/profiles", response_model=dict[str, IKTuneProfile])
def list_ik_profiles() -> dict[str, IKTuneProfile]:
    project = get_state().project
    return {
        base: _profile_to_schema(profile)  # type: ignore[misc]
        for base, profile in project.ik_profiles.items()
    }


@router.delete("/ik/profiles/{base}")
def delete_ik_profile(base: str) -> dict[str, bool]:
    project = get_state().project
    if base in project.ik_profiles:
        del project.ik_profiles[base]
        project.touch()
        get_state().events.publish("ik_tune.profile_deleted", base=base)
        return {"deleted": True}
    return {"deleted": False}
