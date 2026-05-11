// Simulate's lidar binding side panel.
//
// Two layers stacked:
// 1. DEVICES — UDP-discovered or manually-IP'd lidars. The user picks
//    a type, scans, optionally adds by IP, then connects (which has the
//    backend open a UDP socket and forward packets into the bus).
// 2. BINDINGS — once connected, each device's stream_id is mapped to a
//    model entity, so the viewport renders its points in that entity's
//    world frame (i.e., on the right mount point).
//
// Both pieces poll cheaply so changes from elsewhere (CLI, another
// browser tab) reflect within ~1s.

import { useEffect, useMemo, useState } from "react";

import { useScene } from "../../api/hooks";
import type { Entity } from "../../types/model";

import { CameraSetupSection } from "./CameraSetupSection";

type DeviceStatus = "idle" | "connecting" | "connected" | "error";

interface LidarDevice {
  id: string;
  kind: string;
  ip: string;
  name: string;
  port_data: number;
  port_imu: number;
  port_cmd: number;
  serial: string | null;
  status: DeviceStatus;
  error: string | null;
  discovered: boolean;
  stream_id: string;
  packets: number;
  bytes: number;
  last_packet_t_us: number;
  bind_addr: string;
  host_ip: string;
}

interface SensorBinding {
  entity: string;
  stream_id: string;
  kind: "lidar" | "camera" | "imu";
  mount_rpy_deg?: [number, number, number];
}

interface BindingsDoc {
  bindings: {
    telemetry: Record<string, unknown>;
    control: Record<string, unknown>;
    sensors: Record<string, SensorBinding>;
  };
}

const STREAM_COLORS = ["#22d3ee", "#a78bfa", "#fb923c", "#34d399", "#f87171"];

export function BindingsPanel() {
  const sceneQ = useScene();
  const [kinds, setKinds] = useState<string[]>([]);
  const [selectedKind, setSelectedKind] = useState<string>("livox_mid360");
  const [devices, setDevices] = useState<LidarDevice[]>([]);
  const [bindings, setBindings] = useState<BindingsDoc["bindings"] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Pull device list on mount + poll every 1s. Status updates (idle →
  // connecting → connected) and bus point counters refresh through this.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/v1/lidar/devices");
        const d: LidarDevice[] = await r.json();
        if (!cancelled) setDevices(d);
      } catch {
        /* server momentarily unreachable */
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    fetch("/api/v1/lidar/kinds")
      .then((r) => r.json())
      .then((d: string[]) => {
        setKinds(d);
        if (d.length > 0 && !d.includes(selectedKind)) setSelectedKind(d[0]);
      });
  }, [selectedKind]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/v1/bindings");
        const d: BindingsDoc = await r.json();
        if (!cancelled) setBindings(d.bindings);
      } catch {
        /* keep last known */
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sceneQ.dataUpdatedAt]);

  // Lidar-mount entity candidates: prefer entities with a `lidar`
  // component, fall back to ones whose name contains "lidar" / "mid360",
  // and finally to all link entities. Entity.id is optional in the wire
  // type — the canonical ID is the entities-map key, so inject it here
  // so the dropdown's option value persists the real ID (not the name).
  const candidates: Entity[] = useMemo(() => {
    if (!sceneQ.data) return [];
    const ents = Object.entries(sceneQ.data.entities).map(([id, e]) => ({
      ...e,
      id,
    }));
    const withLidar = ents.filter(
      (e) => (e.components as Record<string, unknown>)?.lidar,
    );
    if (withLidar.length > 0) return withLidar;
    const namedLikeLidar = ents.filter(
      (e) =>
        e.name &&
        (e.name.toLowerCase().includes("lidar") ||
          e.name.toLowerCase().includes("mid360")),
    );
    if (namedLikeLidar.length > 0) return namedLikeLidar;
    return ents.filter((e) => (e.components as Record<string, unknown>)?.link);
  }, [sceneQ.data]);

  const colorOf = (streamId: string): string => {
    const lidarSensors = bindings
      ? Object.values(bindings.sensors)
          .filter((s) => s.kind === "lidar")
          .map((s) => s.stream_id)
          .sort()
      : [];
    const idx = lidarSensors.indexOf(streamId);
    return STREAM_COLORS[(idx >= 0 ? idx : 0) % STREAM_COLORS.length];
  };

  const bindingForStream = (streamId: string): SensorBinding | null => {
    if (!bindings) return null;
    for (const v of Object.values(bindings.sensors)) {
      if (v.kind === "lidar" && v.stream_id === streamId) return v;
    }
    return null;
  };

  const setStreamBinding = async (streamId: string, entityId: string | null) => {
    if (!bindings) return;
    setBusy(`bind:${streamId}`);
    setError(null);
    try {
      const next: BindingsDoc = {
        bindings: JSON.parse(JSON.stringify(bindings)),
      };
      // Drop any existing lidar binding for this stream id.
      for (const [k, v] of Object.entries(next.bindings.sensors)) {
        if (v.kind === "lidar" && v.stream_id === streamId) {
          delete next.bindings.sensors[k];
        }
      }
      if (entityId) {
        let slot = streamId;
        let i = 2;
        while (slot in next.bindings.sensors) slot = `${streamId}_${i++}`;
        next.bindings.sensors[slot] = {
          entity: entityId,
          stream_id: streamId,
          kind: "lidar",
          mount_rpy_deg: [0, 0, 0],
        };
      }
      const r = await fetch("/api/v1/bindings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindings: next.bindings }),
      });
      if (!r.ok) throw new Error(await r.text());
      const saved: BindingsDoc = await r.json();
      setBindings(saved.bindings);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const setStreamMountRpy = async (
    streamId: string,
    rpy: [number, number, number],
  ) => {
    if (!bindings) return;
    setBusy(`rpy:${streamId}`);
    setError(null);
    try {
      const next: BindingsDoc = {
        bindings: JSON.parse(JSON.stringify(bindings)),
      };
      for (const v of Object.values(next.bindings.sensors)) {
        if (v.kind === "lidar" && v.stream_id === streamId) {
          v.mount_rpy_deg = rpy;
        }
      }
      const r = await fetch("/api/v1/bindings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindings: next.bindings }),
      });
      if (!r.ok) throw new Error(await r.text());
      const saved: BindingsDoc = await r.json();
      setBindings(saved.bindings);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/lidar/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: selectedKind, timeout_s: 3.0 }),
      });
      if (!r.ok) {
        const txt = await r.text();
        setError(`Scan failed: ${txt}`);
      }
      // Devices list is polled, will update on its own.
    } finally {
      setScanning(false);
    }
  };

  const connect = async (id: string) => {
    setBusy(`connect:${id}`);
    setError(null);
    try {
      const r = await fetch(
        `/api/v1/lidar/devices/${encodeURIComponent(id)}/connect`,
        { method: "POST" },
      );
      if (!r.ok) setError(`Connect failed: ${await r.text()}`);
    } finally {
      setBusy(null);
    }
  };
  const disconnect = async (id: string) => {
    setBusy(`disconnect:${id}`);
    try {
      await fetch(
        `/api/v1/lidar/devices/${encodeURIComponent(id)}/disconnect`,
        { method: "POST" },
      );
    } finally {
      setBusy(null);
    }
  };
  const drop = async (id: string) => {
    if (!window.confirm(`Remove device ${id}?`)) return;
    setBusy(`drop:${id}`);
    try {
      await fetch(`/api/v1/lidar/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } finally {
      setBusy(null);
    }
  };
  const configure = async (id: string, hostIp: string | null) => {
    setBusy(`configure:${id}`);
    setError(null);
    try {
      const r = await fetch(
        `/api/v1/lidar/devices/${encodeURIComponent(id)}/configure`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ host_ip: hostIp || null }),
        },
      );
      const d = await r.json();
      if (!d.ok) setError(`Configure failed: ${d.message ?? r.statusText}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-80 border-l border-zinc-800 bg-zinc-950 text-zinc-200 flex flex-col">
      <div className="px-3 py-2 border-b border-zinc-800 text-sm font-medium">
        Sensor Setup
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Discover */}
        <section className="px-3 py-3 border-b border-zinc-900 space-y-2">
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            Discover
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedKind}
              onChange={(e) => setSelectedKind(e.target.value)}
              className="flex-1 text-xs bg-zinc-900 border border-zinc-800 rounded px-2 py-1 focus:border-zinc-600 focus:outline-none"
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <button
              onClick={scan}
              disabled={scanning}
              className="text-xs rounded bg-teal-700/40 hover:bg-teal-700/60 text-teal-100 px-2.5 py-1 disabled:opacity-40"
            >
              {scanning ? "Scanning…" : "Scan"}
            </button>
          </div>
          <button
            onClick={() => setManualOpen((v) => !v)}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            {manualOpen ? "−" : "+"} Add by IP
          </button>
          {manualOpen && (
            <ManualAddForm
              kind={selectedKind}
              onAdded={() => setManualOpen(false)}
              onError={setError}
            />
          )}
        </section>

        {/* Devices */}
        <section className="px-3 py-3 border-b border-zinc-900 space-y-2">
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            Devices ({devices.length})
          </div>
          {devices.length === 0 && (
            <div className="text-xs text-zinc-600">
              No devices yet. Scan or add by IP.
            </div>
          )}
          {devices.map((d) => {
            const isConnected = d.status === "connected";
            const isPending = d.status === "connecting";
            const binding = bindingForStream(d.stream_id);
            return (
              <div
                key={d.id}
                className="rounded border border-zinc-800 bg-zinc-900/40 px-2.5 py-2 space-y-1.5"
              >
                <div className="flex items-center gap-2">
                  <StatusDot
                    status={d.status}
                    color={isConnected ? colorOf(d.stream_id) : null}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-zinc-100 truncate">
                      {d.name}
                    </div>
                    <div className="text-[10px] text-zinc-500 font-mono">
                      {d.ip}:{d.port_data}
                      {d.discovered && (
                        <span className="ml-1 text-emerald-500">discovered</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => drop(d.id)}
                    title="Remove device"
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
                  <>
                    <DeviceDiagnostics device={d} />
                    <ConfigureRow
                      device={d}
                      busy={busy === `configure:${d.id}`}
                      onPushStart={(hostIp) => configure(d.id, hostIp)}
                    />
                  </>
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
                  <MountRpyRow
                    rpy={binding.mount_rpy_deg ?? [0, 0, 0]}
                    busy={busy === `rpy:${d.stream_id}`}
                    onChange={(rpy) => setStreamMountRpy(d.stream_id, rpy)}
                  />
                )}
              </div>
            );
          })}
        </section>

        <CameraSetupSection />
      </div>

      {error && (
        <div className="px-3 py-2 border-t border-red-900/40 bg-red-950/30 text-[10px] text-red-300 break-all">
          {error}
        </div>
      )}
      <div className="px-3 py-2 border-t border-zinc-800 text-[10px] text-zinc-500">
        Mid-360 broadcasts on UDP 56000 for scan; points on
        <code className="text-zinc-400"> port_data</code> (default 56300).
        Cameras bridge over RTSP via go2rtc → WebRTC.
      </div>
    </div>
  );
}

function StatusDot({
  status,
  color,
}: {
  status: DeviceStatus;
  color: string | null;
}) {
  const map: Record<DeviceStatus, { c: string; glow: boolean }> = {
    idle: { c: "#52525b", glow: false },
    connecting: { c: "#fbbf24", glow: false },
    connected: { c: color ?? "#22c55e", glow: true },
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

function DeviceDiagnostics({ device }: { device: LidarDevice }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const ageMs =
    device.last_packet_t_us > 0
      ? Math.max(0, now - device.last_packet_t_us / 1000)
      : null;
  const fresh = ageMs !== null && ageMs < 1000;
  return (
    <div className="text-[10px] text-zinc-500 space-y-0.5 font-mono">
      <div>
        listen: <span className="text-zinc-300">{device.bind_addr || "—"}</span>
      </div>
      <div>
        rx:{" "}
        <span className={device.packets > 0 ? "text-zinc-200" : "text-zinc-600"}>
          {device.packets.toLocaleString()} pkts ·{" "}
          {(device.bytes / 1024).toFixed(1)} KB
        </span>
      </div>
      <div>
        last:{" "}
        <span className={fresh ? "text-emerald-400" : "text-zinc-600"}>
          {ageMs === null
            ? "no packets received"
            : ageMs < 2000
              ? `${ageMs.toFixed(0)} ms ago`
              : `${(ageMs / 1000).toFixed(1)} s ago`}
        </span>
      </div>
    </div>
  );
}

function ConfigureRow({
  device,
  busy,
  onPushStart,
}: {
  device: LidarDevice;
  busy: boolean;
  onPushStart: (hostIp: string | null) => void;
}) {
  const [hostIp, setHostIp] = useState(device.host_ip);
  // Sync if backend updates the auto-detected IP.
  useEffect(() => {
    if (!hostIp && device.host_ip) setHostIp(device.host_ip);
  }, [device.host_ip, hostIp]);

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-1.5 space-y-1.5">
      <label className="text-[10px] text-zinc-500 block">
        Host IP for lidar to push to
      </label>
      <input
        value={hostIp}
        onChange={(e) => setHostIp(e.target.value)}
        placeholder="e.g. 192.168.2.3"
        className="w-full text-xs font-mono bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 focus:border-zinc-600 focus:outline-none"
      />
      <button
        onClick={() => onPushStart(hostIp.trim() || null)}
        disabled={busy}
        title="Send Livox SDK2 SetParameter+WorkMode commands to the lidar"
        className="w-full text-xs rounded border border-amber-800 bg-amber-950/40 hover:bg-amber-950/70 text-amber-200 py-1 disabled:opacity-40"
      >
        {busy ? "Sending…" : "Push start (SDK2)"}
      </button>
    </div>
  );
}

function MountRpyRow({
  rpy,
  busy,
  onChange,
}: {
  rpy: [number, number, number];
  busy: boolean;
  onChange: (rpy: [number, number, number]) => void;
}) {
  // Local string state so partial input ("-", "1.") survives without
  // round-tripping through the parent until commit (blur / Enter).
  const [draft, setDraft] = useState<[string, string, string]>([
    String(rpy[0]),
    String(rpy[1]),
    String(rpy[2]),
  ]);
  useEffect(() => {
    setDraft([String(rpy[0]), String(rpy[1]), String(rpy[2])]);
  }, [rpy[0], rpy[1], rpy[2]]);

  const commit = () => {
    const parsed = draft.map((s) => {
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    }) as [number, number, number];
    if (parsed[0] !== rpy[0] || parsed[1] !== rpy[1] || parsed[2] !== rpy[2]) {
      onChange(parsed);
    } else {
      // Snap any "1.0" → "1" formatting.
      setDraft([String(parsed[0]), String(parsed[1]), String(parsed[2])]);
    }
  };

  const labels = ["R", "P", "Y"] as const;
  return (
    <div>
      <label className="text-[10px] text-zinc-500">
        Mount RPY (deg, world frame)
      </label>
      <div className="flex gap-1">
        {labels.map((lbl, i) => (
          <div key={lbl} className="flex-1 flex items-center gap-1">
            <span className="text-[10px] text-zinc-600 w-2">{lbl}</span>
            <input
              type="number"
              step="1"
              value={draft[i]}
              disabled={busy}
              onChange={(e) => {
                const next = [...draft] as [string, string, string];
                next[i] = e.target.value;
                setDraft(next);
              }}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="w-full text-xs font-mono bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 focus:border-zinc-600 focus:outline-none disabled:opacity-40"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ManualAddForm({
  kind,
  onAdded,
  onError,
}: {
  kind: string;
  onAdded: () => void;
  onError: (msg: string | null) => void;
}) {
  const [ip, setIp] = useState("");
  const [name, setName] = useState("");
  const [portData, setPortData] = useState("56301");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!ip.trim()) {
      onError("IP required");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const r = await fetch("/api/v1/lidar/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          ip: ip.trim(),
          name: name.trim() || undefined,
          port_data: Number(portData) || undefined,
        }),
      });
      if (!r.ok) {
        const txt = await r.text();
        onError(`Add failed: ${txt}`);
        return;
      }
      setIp("");
      setName("");
      onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 mt-1 rounded border border-zinc-800 bg-zinc-900/30 p-2">
      <input
        value={ip}
        onChange={(e) => setIp(e.target.value)}
        placeholder="IP address (e.g. 192.168.1.181)"
        className="w-full text-xs bg-zinc-900 border border-zinc-800 rounded px-1.5 py-1 focus:border-zinc-600 focus:outline-none"
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        className="w-full text-xs bg-zinc-900 border border-zinc-800 rounded px-1.5 py-1 focus:border-zinc-600 focus:outline-none"
      />
      <input
        value={portData}
        onChange={(e) => setPortData(e.target.value)}
        placeholder="Host point port (default 56301)"
        className="w-full text-xs bg-zinc-900 border border-zinc-800 rounded px-1.5 py-1 focus:border-zinc-600 focus:outline-none"
      />
      <button
        onClick={submit}
        disabled={busy || !ip.trim()}
        className="w-full text-xs rounded bg-teal-700/40 hover:bg-teal-700/60 text-teal-100 py-1 disabled:opacity-40"
      >
        {busy ? "Adding…" : "Add device"}
      </button>
    </div>
  );
}
