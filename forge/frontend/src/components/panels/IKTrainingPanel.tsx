// IK Training panel — modal that runs the per-arm IK parameter tuner.
//
// Pick the chain (auto-derived from current selection: tip = selected entity,
// base = topmost link ancestor). Press Start; backend runs a grid search
// scoring each candidate IKProfile against jog scenarios while respecting
// the robot's collision geometry (drums, flippers, arm). WebSocket events
// stream progress; on completion the winning profile is saved into
// `project.ik_profiles[base]` and consumed by the IK gizmo.

import { Activity, Play, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type IKTunedProfile, type IKTuneStatus } from "../../api/client";
import { useScene } from "../../api/hooks";
import { eventStream } from "../../api/ws";
import { useEditorStore } from "../../stores/editorStore";
import { findIkBase } from "../viewport/ikChain";

type RunState =
  | { kind: "idle" }
  | { kind: "running"; jobId: string; status: IKTuneStatus }
  | { kind: "done"; status: IKTuneStatus }
  | { kind: "error"; message: string };

export function IKTrainingPanel() {
  const open = useEditorStore((s) => s.ikTrainingOpen);
  const setOpen = useEditorStore((s) => s.setIkTrainingOpen);
  const selectedId = useEditorStore((s) => s.selectedId);
  const sceneQ = useScene();

  const baseId = useMemo(() => {
    if (!selectedId || !sceneQ.data) return null;
    const b = findIkBase(sceneQ.data.entities, selectedId);
    return b === selectedId ? null : b;
  }, [selectedId, sceneQ.data]);

  const [state, setState] = useState<RunState>({ kind: "idle" });
  const [profiles, setProfiles] = useState<Record<string, IKTunedProfile>>({});
  const pollRef = useRef<number | null>(null);

  // Refresh existing profiles when the panel opens.
  useEffect(() => {
    if (!open) return;
    api.listIkProfiles().then(setProfiles).catch(() => {});
  }, [open]);

  // Subscribe to WS progress events while a job is running.
  useEffect(() => {
    if (state.kind !== "running") return;
    const off = eventStream.on((e) => {
      if (e.type === "ik_tune.progress" && e.payload.job_id === state.jobId) {
        // Refresh status from REST to get the full payload (incl. best profile).
        api.getIkTune(state.jobId).then((s) => {
          setState({ kind: "running", jobId: state.jobId, status: s });
        }).catch(() => {});
      } else if (e.type === "ik_tune.done" && e.payload.job_id === state.jobId) {
        api.getIkTune(state.jobId).then((s) => {
          setState({ kind: "done", status: s });
          api.listIkProfiles().then(setProfiles).catch(() => {});
        }).catch(() => {});
      }
    });
    eventStream.start();
    return off;
  }, [state]);

  // Fallback poll in case WS events are missed (rare reconnect window).
  useEffect(() => {
    if (state.kind !== "running") return;
    pollRef.current = window.setInterval(() => {
      api.getIkTune(state.jobId).then((s) => {
        if (s.finished || s.error) {
          setState(s.error ? { kind: "error", message: s.error } : { kind: "done", status: s });
          api.listIkProfiles().then(setProfiles).catch(() => {});
        } else {
          setState({ kind: "running", jobId: s.job_id, status: s });
        }
      }).catch(() => {});
    }, 1500);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [state]);

  const onStart = async () => {
    if (!selectedId || !baseId) return;
    try {
      const status = await api.startIkTune({ base: baseId, tip: selectedId });
      setState({ kind: "running", jobId: status.job_id, status });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onCancel = async () => {
    if (state.kind !== "running") return;
    try {
      await api.cancelIkTune(state.jobId);
    } catch {
      // ignore — the next poll will reflect cancellation if it took.
    }
  };

  const onClose = () => {
    if (state.kind === "running") {
      // Don't kill a job on close; let it run in the background. Reset UI state
      // so reopening starts fresh (the existing profile gets re-listed).
    }
    setOpen(false);
  };

  const onDeleteProfile = async (base: string) => {
    await api.deleteIkProfile(base);
    api.listIkProfiles().then(setProfiles).catch(() => {});
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-[640px] max-w-[90vw] flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
          <div className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-teal-300">
            <Activity size={14} /> IK Training
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 p-4 text-[13px]">
          <ChainPickerSummary selectedId={selectedId} baseId={baseId} entities={sceneQ.data?.entities} />

          {state.kind === "idle" && (
            <div className="flex justify-end gap-2">
              <button
                disabled={!selectedId || !baseId}
                onClick={onStart}
                className={
                  "flex items-center gap-1.5 rounded px-3 py-1.5 transition-colors " +
                  (!selectedId || !baseId
                    ? "bg-zinc-800 text-zinc-500"
                    : "bg-teal-600 text-white hover:bg-teal-500")
                }
              >
                <Play size={13} /> Start training
              </button>
            </div>
          )}

          {state.kind === "running" && (
            <RunningView status={state.status} onCancel={onCancel} />
          )}

          {state.kind === "done" && (
            <DoneView status={state.status} onRestart={onStart} onClose={onClose} />
          )}

          {state.kind === "error" && (
            <div className="rounded border border-red-700/40 bg-red-900/20 p-3 text-red-200">
              {state.message}
            </div>
          )}

          <ExistingProfilesSection profiles={profiles} onDelete={onDeleteProfile} />
        </div>
      </div>
    </div>
  );
}

function ChainPickerSummary({
  selectedId,
  baseId,
  entities,
}: {
  selectedId: string | null;
  baseId: string | null;
  entities: Record<string, { name?: string }> | undefined;
}) {
  const tipName = selectedId && entities ? entities[selectedId]?.name ?? selectedId : "—";
  const baseName = baseId && entities ? entities[baseId]?.name ?? baseId : "—";

  if (!selectedId) {
    return (
      <div className="rounded border border-amber-700/40 bg-amber-900/20 p-3 text-[12px] text-amber-200">
        Select the end-effector link in the scene tree first. Training tunes the
        IK chain from its base ancestor to your selection.
      </div>
    );
  }
  if (!baseId) {
    return (
      <div className="rounded border border-amber-700/40 bg-amber-900/20 p-3 text-[12px] text-amber-200">
        The selected link has no IK chain (no movable joints between it and the
        root). Pick a different tip.
      </div>
    );
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-[12px]">
      <div className="mb-1.5 text-zinc-400">Chain to tune</div>
      <div className="flex flex-col gap-1">
        <Row label="Tip (selected)" value={tipName} mono />
        <Row label="Base" value={baseName} mono />
      </div>
      <div className="mt-2 text-[11px] text-zinc-500">
        Collisions are respected during training (drums, flippers, arm self-collisions
        all count). Run takes ~30s on a 6-DOF arm.
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className={"truncate " + (mono ? "font-mono text-zinc-200" : "text-zinc-200")}>
        {value}
      </span>
    </div>
  );
}

function RunningView({ status, onCancel }: { status: IKTuneStatus; onCancel: () => void }) {
  const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-[12px] text-zinc-400">
        <span>
          Evaluating candidate <span className="text-zinc-100">{status.done}/{status.total}</span>
        </span>
        <span className="tabular-nums">
          {fmtTime(status.elapsed_s)} elapsed · ETA {fmtTime(status.eta_s)}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-zinc-800">
        <div
          className="h-full bg-teal-500 transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[12px]">
        <BestSoFar profile={status.best_profile} score={status.best_score} />
        <button
          onClick={onCancel}
          className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function DoneView({
  status,
  onRestart,
  onClose,
}: {
  status: IKTuneStatus;
  onRestart: () => void;
  onClose: () => void;
}) {
  const cancelled = status.cancelled || !status.best_profile;
  return (
    <div className="space-y-2">
      <div
        className={
          "rounded border p-3 text-[12px] " +
          (cancelled
            ? "border-zinc-700 bg-zinc-950/40 text-zinc-300"
            : "border-teal-700/40 bg-teal-900/15 text-teal-100")
        }
      >
        {cancelled
          ? "Training cancelled. The previous profile (if any) is unchanged."
          : `Training complete in ${fmtTime(status.elapsed_s)}. Tuned profile saved to this robot.`}
      </div>
      {status.best_profile && <ProfileDetails profile={status.best_profile} />}
      <div className="flex justify-end gap-2">
        <button
          onClick={onRestart}
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:bg-zinc-800"
        >
          <RefreshCw size={13} /> Run again
        </button>
        <button
          onClick={onClose}
          className="rounded bg-teal-600 px-3 py-1.5 text-white hover:bg-teal-500"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function BestSoFar({
  profile,
  score,
}: {
  profile: IKTunedProfile | null;
  score: number;
}) {
  if (!profile || !Number.isFinite(score)) {
    return <span className="text-zinc-500">Best so far: —</span>;
  }
  return (
    <span className="text-zinc-300">
      Best so far: <span className="font-mono text-zinc-100">{score.toFixed(1)}</span>
      <span className="ml-2 text-zinc-500">({profile.mode})</span>
    </span>
  );
}

function ProfileDetails({ profile }: { profile: IKTunedProfile }) {
  return (
    <div className="space-y-2">
      <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-[12px]">
        <div className="mb-1.5 text-zinc-400">Tuned parameters</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
          <Row label="mode" value={profile.mode} mono />
          <Row label="score" value={profile.score.toFixed(2)} mono />
          <Row label="damping" value={profile.damping.toFixed(3)} mono />
          <Row label="rest_pose_gain" value={profile.rest_pose_gain.toFixed(2)} mono />
          <Row label="orient_weight" value={profile.orientation_weight.toFixed(2)} mono />
          <Row label="orient_secondary" value={profile.orientation_secondary_gain.toFixed(2)} mono />
          <Row label="joint_weight_str" value={profile.joint_weight_strength.toFixed(2)} mono />
          <Row label="max_iter" value={String(profile.max_iter)} mono />
          <Row label="max_dq_step" value={profile.max_dq_step.toFixed(3)} mono />
          <Row label="max_pos_step" value={profile.max_pos_step.toFixed(3)} mono />
          <Row
            label="max_total_dq_step"
            value={
              profile.max_total_dq_step == null
                ? "none"
                : profile.max_total_dq_step.toFixed(3)
            }
            mono
          />
        </div>
      </div>
      <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-[12px]">
        <div className="mb-1.5 text-zinc-400">Score breakdown (lower = better)</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
          <Row label="pos err (max)" value={`${profile.pos_err_max_mm.toFixed(2)} mm`} mono />
          <Row label="orient drift (max)" value={`${profile.rot_drift_deg.toFixed(2)}°`} mono />
          <Row label="per-tick jump (max)" value={`${profile.max_jump_rad.toFixed(3)} rad`} mono />
          <Row label="total motion" value={`${profile.total_motion_rad.toFixed(2)} rad`} mono />
          <Row label="saturated joints" value={String(profile.saturated_joints)} mono />
          <Row label="new collision pairs" value={String(profile.new_collision_pairs)} mono />
        </div>
      </div>
    </div>
  );
}

function ExistingProfilesSection({
  profiles,
  onDelete,
}: {
  profiles: Record<string, IKTunedProfile>;
  onDelete: (base: string) => void;
}) {
  const entries = Object.entries(profiles);
  if (entries.length === 0) return null;
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-2 text-[12px] text-zinc-400">Existing tuned chains</div>
      <div className="space-y-1">
        {entries.map(([base, p]) => (
          <div key={base} className="flex items-center justify-between text-[11px]">
            <span className="font-mono text-zinc-300">{base}</span>
            <span className="text-zinc-500">
              {p.mode} · score {p.score.toFixed(1)}
            </span>
            <button
              onClick={() => onDelete(base)}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-300"
              title="Discard tuned profile"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}m ${s}s`;
}
