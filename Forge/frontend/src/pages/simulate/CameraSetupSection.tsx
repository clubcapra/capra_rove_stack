// "Cameras" section of the Simulate panel — siblings the Lidar Setup
// section. Same Add → Connect → Bind pattern, plus FOV/aspect and a
// "Lock view" toggle that drives the viewport camera from this stream.
//
// Camera intrinsics are stored on the SensorBinding (sensors.<slot>.intrinsics)
// so the lidar-color splat pipeline can read fx/fy/cx/cy/distortion later
// without a schema migration. Today only fov_h_deg + image_width/height
// (= aspect) are exposed in the UI.

import { Eye, EyeOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useScene } from "../../api/hooks";
import { useSimulateStore } from "../../stores/simulateStore";
import type { Entity } from "../../types/model";

type DeviceStatus = "idle" | "connecting" | "connected" | "error";

interface CameraDevice {
  id: string;
  name: string;
  rtsp_url: string; // already redacted by the backend
  stream_id: string;
  image_width: number;
  image_height: number;
  codec: string;
  status: DeviceStatus;
  error: string | null;
  bytes_recv: number;
  consumers: number;
  last_seen_us: number;
}

interface CameraIntrinsics {
  image_width?: number;
  image_height?: number;
  fov_h_deg?: number;
  fx?: number | null;
  fy?: number | null;
  cx?: number | null;
  cy?: number | null;
  k1?: number;
  k2?: number;
  k3?: number;
  p1?: number;
  p2?: number;
}

interface CameraBinding {
  entity: string;
  stream_id: string;
  kind: "camera";
  mount_rpy_deg?: [number, number, number];
  intrinsics?: CameraIntrinsics;
}

interface BindingsDoc {
  bindings: {
    telemetry: Record<string, unknown>;
    control: Record<string, unknown>;
    sensors: Record<
      string,
      {
        entity: string;
        stream_id: string;
        kind: "lidar" | "camera" | "imu";
        mount_rpy_deg?: [number, number, number];
        intrinsics?: CameraIntrinsics;
      }
    >;
  };
}

const DEFAULT_INTRINSICS: Required<CameraIntrinsics> = {
  image_width: 1920,
  image_height: 1080,
  fov_h_deg: 90,
  fx: null as unknown as number,
  fy: null as unknown as number,
  cx: null as unknown as number,
  cy: null as unknown as number,
  k1: 0,
  k2: 0,
  k3: 0,
  p1: 0,
  p2: 0,
};

export function CameraSetupSection() {
  const sceneQ = useScene();
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [bindings, setBindings] = useState<BindingsDoc["bindings"] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lockedStreamId = useSimulateStore((s) => s.lockedCameraStreamId);
  const lockToCamera = useSimulateStore((s) => s.lockToCamera);

  // Poll devices and bindings.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [dr, br] = await Promise.all([
          fetch("/api/v1/cameras/devices"),
          fetch("/api/v1/bindings"),
        ]);
        const d: CameraDevice[] = await dr.json();
        const b: BindingsDoc = await br.json();
        if (!cancelled) {
          setDevices(d);
          setBindings(b.bindings);
        }
      } catch {
        /* transient — retry next tick */
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sceneQ.dataUpdatedAt]);

  // Bind candidates — entities that look like cameras, falling back
  // to all link entities so the user can attach to anything.
  const candidates: Entity[] = useMemo(() => {
    if (!sceneQ.data) return [];
    const ents = Object.entries(sceneQ.data.entities).map(([id, e]) => ({
      ...e,
      id,
    }));
    const named = ents.filter((e) => {
      const n = (e.name ?? "").toLowerCase();
      return n.includes("camera") || n.includes("cam");
    });
    if (named.length > 0) return named;
    return ents.filter(
      (e) => (e.components as Record<string, unknown>)?.link,
    );
  }, [sceneQ.data]);

  const bindingForStream = (sid: string): CameraBinding | null => {
    if (!bindings) return null;
    for (const v of Object.values(bindings.sensors)) {
      if (v.kind === "camera" && v.stream_id === sid) {
        return {
          entity: v.entity,
          stream_id: v.stream_id,
          kind: "camera",
          mount_rpy_deg: v.mount_rpy_deg as [number, number, number] | undefined,
          intrinsics: v.intrinsics,
        };
      }
    }
    return null;
  };

  const putBindings = async (next: BindingsDoc["bindings"]) => {
    const r = await fetch("/api/v1/bindings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bindings: next }),
    });
    if (!r.ok) throw new Error(await r.text());
    const saved: BindingsDoc = await r.json();
    setBindings(saved.bindings);
  };

  const setStreamBinding = async (sid: string, entityId: string | null) => {
    if (!bindings) return;
    setBusy(`bind:${sid}`);
    setError(null);
    try {
      const next: BindingsDoc["bindings"] = JSON.parse(JSON.stringify(bindings));
      for (const [k, v] of Object.entries(next.sensors)) {
        if (v.kind === "camera" && v.stream_id === sid) delete next.sensors[k];
      }
      if (entityId) {
        let slot = sid;
        let i = 2;
        while (slot in next.sensors) slot = `${sid}_${i++}`;
        next.sensors[slot] = {
          entity: entityId,
          stream_id: sid,
          kind: "camera",
          mount_rpy_deg: [0, 0, 0],
          intrinsics: { ...DEFAULT_INTRINSICS },
        };
      }
      await putBindings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const updateBinding = async (
    sid: string,
    fn: (
      b: BindingsDoc["bindings"]["sensors"][string],
    ) => BindingsDoc["bindings"]["sensors"][string],
  ) => {
    if (!bindings) return;
    setBusy(`update:${sid}`);
    setError(null);
    try {
      const next: BindingsDoc["bindings"] = JSON.parse(JSON.stringify(bindings));
      for (const [k, v] of Object.entries(next.sensors)) {
        if (v.kind === "camera" && v.stream_id === sid) {
          next.sensors[k] = fn(v);
        }
      }
      await putBindings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = async (id: string) => {
    setBusy(`connect:${id}`);
    setError(null);
    try {
      const r = await fetch(
        `/api/v1/cameras/devices/${encodeURIComponent(id)}/connect`,
        { method: "POST" },
      );
      if (!r.ok) {
        let detail = "";
        try {
          detail = (await r.json())?.detail ?? "";
        } catch {
          detail = await r.text();
        }
        setError(`Connect failed: ${detail || r.statusText}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (id: string) => {
    setBusy(`disconnect:${id}`);
    try {
      await fetch(
        `/api/v1/cameras/devices/${encodeURIComponent(id)}/disconnect`,
        { method: "POST" },
      );
    } finally {
      setBusy(null);
    }
  };

  const drop = async (id: string) => {
    if (!window.confirm(`Remove camera ${id}?`)) return;
    setBusy(`drop:${id}`);
    try {
      await fetch(`/api/v1/cameras/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="px-3 py-3 border-b border-zinc-900 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-500">
          Cameras ({devices.length})
        </div>
        <button
          onClick={() => setAddOpen((v) => !v)}
          className="text-[11px] text-zinc-400 hover:text-zinc-200"
        >
          {addOpen ? "−" : "+"} Add RTSP
        </button>
      </div>

      {addOpen && (
        <CameraAddForm
          onAdded={() => setAddOpen(false)}
          onError={setError}
        />
      )}

      {devices.length === 0 && (
        <div className="text-xs text-zinc-600">
          No cameras yet. Click <code className="text-zinc-400">+ Add RTSP</code>{" "}
          and paste your camera's RTSP URL.
        </div>
      )}

      {devices.map((d) => {
        const isConnected = d.status === "connected";
        const isPending = d.status === "connecting";
        const binding = bindingForStream(d.stream_id);
        const isLocked = lockedStreamId === d.stream_id;
        return (
          <div
            key={d.id}
            className="rounded border border-zinc-800 bg-zinc-900/40 px-2.5 py-2 space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <CameraStatusDot status={d.status} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-mono text-zinc-100 truncate">
                  {d.name}
                </div>
                <div className="text-[10px] text-zinc-500 font-mono truncate">
                  {d.rtsp_url}
                </div>
              </div>
              <button
                onClick={() => drop(d.id)}
                title="Remove camera"
                className="text-zinc-600 hover:text-red-400 text-[10px] px-1"
              >
                ✕
              </button>
            </div>

            {d.error && (
              <div className="text-[10px] text-red-400 break-all">
                {d.error}
              </div>
            )}

            {isConnected && (
              <div className="text-[10px] text-zinc-500 font-mono space-y-0.5">
                <div>
                  rx:{" "}
                  <span className="text-zinc-300">
                    {(d.bytes_recv / 1024).toFixed(1)} KB · {d.consumers}{" "}
                    consumer{d.consumers === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            )}

            <div className="flex gap-1.5">
              {!isConnected ? (
                <button
                  onClick={() => connect(d.id)}
                  disabled={isPending || busy === `connect:${d.id}`}
                  className="flex-1 text-xs rounded bg-teal-700/40 hover:bg-teal-700/60 text-teal-100 py-1 disabled:opacity-40"
                >
                  {isPending ? "Connecting…" : "Connect"}
                </button>
              ) : (
                <button
                  onClick={() => disconnect(d.id)}
                  disabled={busy === `disconnect:${d.id}`}
                  className="flex-1 text-xs rounded border border-zinc-700 hover:bg-zinc-800 text-zinc-300 py-1 disabled:opacity-40"
                >
                  Disconnect
                </button>
              )}
            </div>

            <div>
              <label className="text-[10px] text-zinc-500">Bind to</label>
              <select
                value={binding?.entity ?? ""}
                disabled={busy === `bind:${d.stream_id}`}
                onChange={(e) =>
                  setStreamBinding(d.stream_id, e.target.value || null)
                }
                className="w-full text-xs bg-zinc-900 border border-zinc-800 rounded px-1.5 py-1 focus:border-zinc-600 focus:outline-none"
              >
                <option value="">— Unbound —</option>
                {candidates.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name ?? e.id}
                  </option>
                ))}
              </select>
            </div>

            {binding && (
              <CameraIntrinsicsRow
                binding={binding}
                onChange={(intrinsics, mount) =>
                  updateBinding(d.stream_id, (slot) => ({
                    ...slot,
                    intrinsics: { ...(slot.intrinsics ?? {}), ...intrinsics },
                    mount_rpy_deg: mount ?? slot.mount_rpy_deg,
                  }))
                }
              />
            )}

            {binding && isConnected && (
              <button
                onClick={() => lockToCamera(isLocked ? null : d.stream_id)}
                className={
                  "w-full text-xs rounded py-1 flex items-center justify-center gap-1.5 " +
                  (isLocked
                    ? "bg-amber-700/40 hover:bg-amber-700/60 text-amber-100 border border-amber-800/60"
                    : "border border-zinc-700 hover:bg-zinc-800 text-zinc-300")
                }
                title="Drive the viewport camera from this stream's pose + FOV. Use to align lidar overlay with the video frame."
              >
                {isLocked ? <EyeOff size={12} /> : <Eye size={12} />}
                {isLocked ? "Unlock view" : "Lock view to this camera"}
              </button>
            )}
          </div>
        );
      })}

      {error && (
        <div className="text-[10px] text-red-400 break-all">{error}</div>
      )}
    </section>
  );
}

function CameraStatusDot({ status }: { status: DeviceStatus }) {
  const map: Record<DeviceStatus, { c: string; glow: boolean }> = {
    idle: { c: "#52525b", glow: false },
    connecting: { c: "#fbbf24", glow: false },
    connected: { c: "#22c55e", glow: true },
    error: { c: "#ef4444", glow: false },
  };
  const { c, glow } = map[status];
  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
      style={{
        background: c,
        boxShadow: glow ? `0 0 6px ${c}` : "none",
      }}
    />
  );
}

function CameraAddForm({
  onAdded,
  onError,
}: {
  onAdded: () => void;
  onError: (msg: string | null) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!url.trim().toLowerCase().startsWith("rtsp")) {
      onError("URL must start with rtsp:// (or rtsps://)");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const r = await fetch("/api/v1/cameras/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rtsp_url: url.trim(),
          name: name.trim() || undefined,
        }),
      });
      if (!r.ok) {
        let detail = "";
        try {
          detail = (await r.json())?.detail ?? "";
        } catch {
          detail = await r.text();
        }
        onError(`Add failed: ${detail || r.statusText}`);
        return;
      }
      setUrl("");
      setName("");
      onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 mt-1 rounded border border-zinc-800 bg-zinc-900/30 p-2">
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="rtsp://user:pass@192.168.2.30:554/..."
        className="w-full text-xs font-mono bg-zinc-900 border border-zinc-800 rounded px-1.5 py-1 focus:border-zinc-600 focus:outline-none"
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        className="w-full text-xs bg-zinc-900 border border-zinc-800 rounded px-1.5 py-1 focus:border-zinc-600 focus:outline-none"
      />
      <button
        onClick={submit}
        disabled={busy || !url.trim()}
        className="w-full text-xs rounded bg-teal-700/40 hover:bg-teal-700/60 text-teal-100 py-1 disabled:opacity-40"
      >
        {busy ? "Adding…" : "Add camera"}
      </button>
    </div>
  );
}

function CameraIntrinsicsRow({
  binding,
  onChange,
}: {
  binding: CameraBinding;
  onChange: (
    intrinsics: Partial<CameraIntrinsics>,
    mount?: [number, number, number],
  ) => void;
}) {
  const i = binding.intrinsics ?? {};
  const fov = i.fov_h_deg ?? DEFAULT_INTRINSICS.fov_h_deg;
  const w = i.image_width ?? DEFAULT_INTRINSICS.image_width;
  const h = i.image_height ?? DEFAULT_INTRINSICS.image_height;
  const rpy = binding.mount_rpy_deg ?? [0, 0, 0];

  // Local draft so partial typing ("-", "1.") doesn't fight the parent.
  const [draft, setDraft] = useState({
    fov: String(fov),
    w: String(w),
    h: String(h),
    rpy: rpy.map((v) => String(v)) as [string, string, string],
  });
  useEffect(() => {
    setDraft({
      fov: String(fov),
      w: String(w),
      h: String(h),
      rpy: rpy.map((v) => String(v)) as [string, string, string],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fov, w, h, rpy[0], rpy[1], rpy[2]]);

  const commit = () => {
    const fovN = parseFloat(draft.fov);
    const wN = parseInt(draft.w, 10);
    const hN = parseInt(draft.h, 10);
    const rN = parseFloat(draft.rpy[0]);
    const pN = parseFloat(draft.rpy[1]);
    const yN = parseFloat(draft.rpy[2]);
    const intrinsics: Partial<CameraIntrinsics> = {};
    if (Number.isFinite(fovN) && fovN > 0 && fovN < 180) intrinsics.fov_h_deg = fovN;
    if (Number.isFinite(wN) && wN > 0) intrinsics.image_width = wN;
    if (Number.isFinite(hN) && hN > 0) intrinsics.image_height = hN;
    const mount: [number, number, number] = [
      Number.isFinite(rN) ? rN : 0,
      Number.isFinite(pN) ? pN : 0,
      Number.isFinite(yN) ? yN : 0,
    ];
    onChange(intrinsics, mount);
  };

  return (
    <div className="space-y-1.5 pt-1.5 border-t border-zinc-800/60">
      <div>
        <label className="text-[10px] text-zinc-500">
          Intrinsics (H-FOV deg, image w × h)
        </label>
        <div className="grid grid-cols-3 gap-1">
          <Field
            label="FOV"
            value={draft.fov}
            onChange={(v) => setDraft({ ...draft, fov: v })}
            onCommit={commit}
            step="1"
          />
          <Field
            label="W"
            value={draft.w}
            onChange={(v) => setDraft({ ...draft, w: v })}
            onCommit={commit}
            step="1"
          />
          <Field
            label="H"
            value={draft.h}
            onChange={(v) => setDraft({ ...draft, h: v })}
            onCommit={commit}
            step="1"
          />
        </div>
      </div>
      <div>
        <label className="text-[10px] text-zinc-500">
          Mount RPY (deg, world frame)
        </label>
        <div className="grid grid-cols-3 gap-1">
          <Field
            label="R"
            value={draft.rpy[0]}
            onChange={(v) =>
              setDraft({ ...draft, rpy: [v, draft.rpy[1], draft.rpy[2]] })
            }
            onCommit={commit}
            step="1"
          />
          <Field
            label="P"
            value={draft.rpy[1]}
            onChange={(v) =>
              setDraft({ ...draft, rpy: [draft.rpy[0], v, draft.rpy[2]] })
            }
            onCommit={commit}
            step="1"
          />
          <Field
            label="Y"
            value={draft.rpy[2]}
            onChange={(v) =>
              setDraft({ ...draft, rpy: [draft.rpy[0], draft.rpy[1], v] })
            }
            onCommit={commit}
            step="1"
          />
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  onCommit,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  step?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-zinc-600 w-3">{label}</span>
      <input
        type="number"
        step={step ?? "any"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full text-xs font-mono bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 focus:border-zinc-600 focus:outline-none"
      />
    </div>
  );
}
