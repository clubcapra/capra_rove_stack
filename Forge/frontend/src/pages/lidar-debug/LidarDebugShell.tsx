// Lidar Debug — render raw incoming points with NO transforms.
//
// No mount entity, no rotation, no entity-frame composition. Points are
// dropped into the buffer exactly as the wire protocol delivers them
// (lidar-local frame: raw x, y, z meters from the device). Use this
// page to confirm the raw data range/shape independent of the Simulate
// page's binding pipeline.
//
// Live readouts of min/max per axis are shown so you can compare the
// numerical extents against the physical room dimensions.

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  PointsMaterial,
} from "three";

import { useLidarFrames, useLidarStreams } from "../../api/lidarStream";
import { PageNav } from "../../components/layout/PageNav";

const CAPACITY = 1_000_000;

export function LidarDebugShell() {
  const { client } = useLidarStreams();
  const [streamIds, setStreamIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Poll the WS client's "latest" map for known stream IDs. The client
  // discovers them as frames arrive, so we just enumerate periodically.
  useEffect(() => {
    const tick = () => {
      const ids: string[] = [];
      // @ts-expect-error - reaching into the private map is fine for a debug page
      for (const k of client["latest"].keys()) ids.push(k);
      ids.sort();
      setStreamIds((prev) =>
        prev.length === ids.length && prev.every((s, i) => s === ids[i])
          ? prev
          : ids,
      );
      if (!activeId && ids.length > 0) setActiveId(ids[0]);
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [client, activeId]);

  return (
    <div className="h-screen flex flex-col bg-zinc-900 text-zinc-200">
      <PageNav current="lidar-debug" />
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 relative">
          <Canvas
            shadows={false}
            camera={{ position: [4, -4, 3], up: [0, 0, 1], fov: 50, near: 0.05, far: 500 }}
          >
            <color attach="background" args={["#0a0a0a"]} />
            <ambientLight intensity={1.0} />
            <gridHelper
              args={[40, 40, 0x52525b, 0x27272a]}
              rotation={[Math.PI / 2, 0, 0]}
            />
            <axesHelper args={[1.0]} />
            <Text position={[1.08, 0, 0]} fontSize={0.08} color="#ef4444">
              X
            </Text>
            <Text position={[0, 1.08, 0]} fontSize={0.08} color="#22c55e">
              Y
            </Text>
            <Text position={[0, 0, 1.08]} fontSize={0.08} color="#3b82f6">
              Z
            </Text>
            {activeId && <RawCloud streamId={activeId} />}
            <OrbitControls
              makeDefault
              enableDamping
              dampingFactor={0.12}
              minDistance={0.05}
              maxDistance={200}
              target={[0, 0, 0]}
            />
          </Canvas>
          <Legend />
        </div>
        <DebugSidebar
          streamIds={streamIds}
          activeId={activeId}
          onPick={setActiveId}
        />
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="absolute top-2 left-2 bg-zinc-950/80 border border-zinc-800 rounded px-2 py-1.5 text-[10px] text-zinc-400 space-y-0.5 font-mono pointer-events-none">
      <div>raw lidar-local frame · NO transforms applied</div>
      <div>1 grid square = 1 m · axes = 1 m</div>
    </div>
  );
}

interface CloudStats {
  count: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  pktsRecv: number;
  ptsRecv: number;
  lastUs: number;
}

const EMPTY_STATS: CloudStats = {
  count: 0,
  xMin: Infinity,
  xMax: -Infinity,
  yMin: Infinity,
  yMax: -Infinity,
  zMin: Infinity,
  zMax: -Infinity,
  pktsRecv: 0,
  ptsRecv: 0,
  lastUs: 0,
};

function RawCloud({ streamId }: { streamId: string }) {
  const positions = useRef(new Float32Array(CAPACITY * 3));
  const writeIdx = useRef(0);
  const filled = useRef(0);
  const stats = useRef<CloudStats>({ ...EMPTY_STATS });
  const [, force] = useState(0);

  const { geometry, material, points } = useMemo(() => {
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(positions.current, 3));
    geom.setDrawRange(0, 0);
    const mat = new PointsMaterial({
      size: 2.0,
      sizeAttenuation: false,
      color: new Color("#22d3ee"),
    });
    const pts = new Points(geom, mat);
    pts.frustumCulled = false;
    return { geometry: geom, material: mat, points: pts };
  }, []);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  // Reset buffer when the stream id changes — different device, fresh extents.
  useEffect(() => {
    writeIdx.current = 0;
    filled.current = 0;
    stats.current = { ...EMPTY_STATS };
    geometry.setDrawRange(0, 0);
    force((n) => n + 1);
  }, [streamId, geometry]);

  useLidarFrames((frame) => {
    if (frame.streamId !== streamId) return;
    const nPts = frame.xyzi.length / 4;
    if (nPts === 0) return;
    const dst = positions.current;
    let w = writeIdx.current;
    const s = stats.current;
    for (let i = 0; i < nPts; i++) {
      const j = i * 4;
      const x = frame.xyzi[j];
      const y = frame.xyzi[j + 1];
      const z = frame.xyzi[j + 2];
      const k = w * 3;
      dst[k] = x;
      dst[k + 1] = y;
      dst[k + 2] = z;
      if (x < s.xMin) s.xMin = x;
      if (x > s.xMax) s.xMax = x;
      if (y < s.yMin) s.yMin = y;
      if (y > s.yMax) s.yMax = y;
      if (z < s.zMin) s.zMin = z;
      if (z > s.zMax) s.zMax = z;
      w = (w + 1) % CAPACITY;
    }
    writeIdx.current = w;
    filled.current = Math.min(CAPACITY, filled.current + nPts);
    s.count = filled.current;
    s.pktsRecv += 1;
    s.ptsRecv += nPts;
    s.lastUs = frame.tUs;
    const attr = geometry.getAttribute("position") as BufferAttribute;
    attr.needsUpdate = true;
    geometry.setDrawRange(0, filled.current);
  });

  // Republish stats to the sidebar once every render frame (cheap).
  useFrame(() => {
    publishStats(streamId, stats.current);
  });

  return <primitive object={points} />;
}

// Tiny pub-sub so the sidebar can read the live stats without re-rendering
// the Canvas each frame.
const statsListeners = new Map<string, Set<(s: CloudStats) => void>>();
const statsLatest = new Map<string, CloudStats>();
function publishStats(id: string, s: CloudStats) {
  statsLatest.set(id, { ...s });
  const ls = statsListeners.get(id);
  if (ls) for (const f of ls) f(s);
}
function subscribeStats(id: string, cb: (s: CloudStats) => void): () => void {
  let set = statsListeners.get(id);
  if (!set) {
    set = new Set();
    statsListeners.set(id, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

function DebugSidebar({
  streamIds,
  activeId,
  onPick,
}: {
  streamIds: string[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  const [stats, setStats] = useState<CloudStats | null>(null);
  useEffect(() => {
    if (!activeId) return;
    setStats(statsLatest.get(activeId) ?? null);
    // Throttle sidebar updates to ~10 Hz so we don't churn React on every
    // 60 Hz render frame.
    let pending: CloudStats | null = null;
    const flushTimer = setInterval(() => {
      if (pending) {
        setStats(pending);
        pending = null;
      }
    }, 100);
    const unsub = subscribeStats(activeId, (s) => {
      pending = { ...s };
    });
    return () => {
      clearInterval(flushTimer);
      unsub();
    };
  }, [activeId]);

  return (
    <div className="w-80 border-l border-zinc-800 bg-zinc-950 text-zinc-200 flex flex-col">
      <div className="px-3 py-2 border-b border-zinc-800 text-sm font-medium">
        Lidar Debug
      </div>
      <section className="px-3 py-3 border-b border-zinc-900 space-y-2">
        <div className="text-xs uppercase tracking-wide text-zinc-500">
          Stream
        </div>
        {streamIds.length === 0 && (
          <div className="text-xs text-zinc-600">
            No streams seen yet. Connect a device on the Simulate page,
            then come back here.
          </div>
        )}
        {streamIds.length > 0 && (
          <select
            value={activeId ?? ""}
            onChange={(e) => onPick(e.target.value)}
            className="w-full text-xs bg-zinc-900 border border-zinc-800 rounded px-2 py-1 focus:border-zinc-600 focus:outline-none font-mono"
          >
            {streamIds.map((sid) => (
              <option key={sid} value={sid}>
                {sid}
              </option>
            ))}
          </select>
        )}
      </section>
      {activeId && stats && (
        <section className="px-3 py-3 border-b border-zinc-900 space-y-1.5 text-[11px] font-mono">
          <div className="text-xs uppercase tracking-wide text-zinc-500 not-italic">
            Stats (raw frame, meters)
          </div>
          <Row k="points buffered" v={`${stats.count.toLocaleString()} / ${CAPACITY.toLocaleString()}`} />
          <Row k="frames recv" v={stats.pktsRecv.toLocaleString()} />
          <Row k="points recv" v={stats.ptsRecv.toLocaleString()} />
          <div className="pt-1.5 mt-1.5 border-t border-zinc-800">
            <Row k="x" v={fmtRange(stats.xMin, stats.xMax)} />
            <Row k="y" v={fmtRange(stats.yMin, stats.yMax)} />
            <Row k="z" v={fmtRange(stats.zMin, stats.zMax)} />
          </div>
          <div className="pt-1.5 mt-1.5 border-t border-zinc-800">
            <Row
              k="extent"
              v={`${fmtSpan(stats.xMin, stats.xMax)} × ${fmtSpan(stats.yMin, stats.yMax)} × ${fmtSpan(stats.zMin, stats.zMax)} m`}
            />
          </div>
        </section>
      )}
      <div className="px-3 py-2 mt-auto border-t border-zinc-800 text-[10px] text-zinc-500 leading-snug">
        Points are rendered exactly as the wire frames deliver them — no
        binding entity, no rotation, no scaling. If extents disagree with
        the physical room, the bug is upstream of the viewport (parser,
        firmware, or device config).
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-zinc-500">{k}</span>
      <span className="text-zinc-200">{v}</span>
    </div>
  );
}
function fmtRange(lo: number, hi: number): string {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return "—";
  return `${lo.toFixed(2)} … ${hi.toFixed(2)}`;
}
function fmtSpan(lo: number, hi: number): string {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return "—";
  return (hi - lo).toFixed(2);
}
