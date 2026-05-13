// In-viewport UI for the "joint mode" mate-connector workflow.
//
// • Renders a small marker at every picked surface point (sphere + axis arrow
//   along the captured normal).
// • Once 2 picks exist, shows a drei <Html> popover anchored at the second
//   pick with: joint type dropdown + Connect / Cancel buttons.
// • On Connect, computes parent-local position + axis from the first pick
//   and POSTs to /api/v1/scene/connect (preserving the child's world pose).

import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Cog, X } from "lucide-react";
import { useRef, useState } from "react";
import { Group, Vector3 } from "three";

import { useConnectJoint } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";
import type { JointPick, SnapCandidate } from "../../stores/editorStore";

// Marker sizes are expressed as a fraction of the camera-to-marker distance,
// so they appear roughly the same on screen at any zoom. e.g. INACTIVE = 0.0035
// → at distance 1m a marker has world-radius 3.5mm; at 10m it has 35mm.
const SIZE_INACTIVE = 0.0035;
const SIZE_ACTIVE = 0.006;
const SIZE_RING_INNER = 0.011;
const SIZE_RING_OUTER = 0.015;

const JOINT_TYPES = ["revolute", "continuous", "prismatic", "fixed", "planar", "ball"] as const;
type JointType = (typeof JOINT_TYPES)[number];

const PICK_COLORS = ["#fbbf24", "#34d399"] as const; // amber, emerald

export function JointPickOverlay() {
  const gizmoMode = useEditorStore((s) => s.gizmoMode);
  const picks = useEditorStore((s) => s.jointPicks);
  const candidates = useEditorStore((s) => s.snapCandidates);
  const activeIndex = useEditorStore((s) => s.activeSnapIndex);
  if (gizmoMode !== "joint") return null;
  return (
    <group>
      <SnapCandidates candidates={candidates} activeIndex={activeIndex} />
      {picks.map((p, i) => (
        <PickMarker key={i} pick={p} color={PICK_COLORS[i] ?? "#a1a1aa"} />
      ))}
      {picks.length === 2 && <ConnectPopover />}
    </group>
  );
}

const SNAP_COLORS: Record<string, string> = {
  vertex: "#f87171", // red
  edge: "#60a5fa",   // blue
  face: "#4ade80",   // green
  raw: "#a1a1aa",
};

function SnapCandidates({
  candidates,
  activeIndex,
}: {
  candidates: SnapCandidate[];
  activeIndex: number;
}) {
  if (candidates.length === 0) return null;
  return (
    <group>
      {candidates.map((c, i) => (
        <SnapMarker key={i} snap={c} active={i === activeIndex} />
      ))}
      {activeIndex >= 0 && activeIndex < candidates.length && (
        <SnapLabel snap={candidates[activeIndex]} />
      )}
    </group>
  );
}

// Non-pickable: snap markers must not consume the raycast — otherwise the
// cursor hovering over a marker would steal pointer events from the
// underlying mesh and the snap state would jitter.
const NO_RAYCAST = () => undefined;

function SnapMarker({ snap, active }: { snap: SnapCandidate; active: boolean }) {
  const color = SNAP_COLORS[snap.type] ?? "#a1a1aa";
  // Scale the marker every frame so its on-screen size is roughly constant
  // regardless of camera distance.
  const groupRef = useRef<Group>(null);
  const { camera } = useThree();
  useFrame(() => {
    if (!groupRef.current) return;
    const d = camera.position.distanceTo(groupRef.current.position);
    groupRef.current.scale.setScalar(Math.max(d, 0.05));
  });

  if (!active) {
    return (
      <group ref={groupRef} position={snap.point}>
        <mesh raycast={NO_RAYCAST} renderOrder={999}>
          <sphereGeometry args={[SIZE_INACTIVE, 10, 10]} />
          <meshBasicMaterial color={color} transparent opacity={0.55} depthTest={false} />
        </mesh>
      </group>
    );
  }
  return (
    <group ref={groupRef} position={snap.point}>
      <mesh raycast={NO_RAYCAST} renderOrder={1000}>
        <sphereGeometry args={[SIZE_ACTIVE, 16, 16]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
      <mesh raycast={NO_RAYCAST} renderOrder={1000}>
        <ringGeometry args={[SIZE_RING_INNER, SIZE_RING_OUTER, 28]} />
        <meshBasicMaterial color={color} transparent opacity={0.55} side={2} depthTest={false} />
      </mesh>
    </group>
  );
}

function SnapLabel({ snap }: { snap: SnapCandidate }) {
  const color = SNAP_COLORS[snap.type] ?? "#a1a1aa";
  return (
    <group position={snap.point}>
      <Html distanceFactor={1.2} center transform={false} style={{ pointerEvents: "none" }}>
        <div
          className="rounded bg-zinc-950/85 px-1.5 py-0.5 font-mono text-[10px] uppercase backdrop-blur"
          style={{ color, transform: "translateY(-22px)" }}
        >
          {snap.type}
        </div>
      </Html>
    </group>
  );
}

function PickMarker({ pick, color }: { pick: JointPick; color: string }) {
  // Build a quaternion that rotates +Z onto the pick normal so the arrow
  // points along the surface.
  const normalDir = new Vector3(...pick.normal).normalize();

  return (
    <group position={pick.point}>
      <mesh>
        <sphereGeometry args={[0.008, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} />
      </mesh>
      <ArrowAlong direction={normalDir} length={0.05} color={color} />
    </group>
  );
}

function ArrowAlong({
  direction,
  length,
  color,
}: {
  direction: Vector3;
  length: number;
  color: string;
}) {
  // A short cylinder rotated so +Y → `direction`, offset half-length along it.
  const target = direction.clone().normalize();
  const yAxis = new Vector3(0, 1, 0);
  const dot = Math.max(-1, Math.min(1, yAxis.dot(target)));
  let quat: [number, number, number, number] = [0, 0, 0, 1];
  if (dot < 0.9999) {
    const angle = Math.acos(dot);
    const axis = new Vector3().crossVectors(yAxis, target);
    if (axis.lengthSq() > 1e-12) {
      axis.normalize();
      const half = angle / 2;
      const s = Math.sin(half);
      quat = [axis.x * s, axis.y * s, axis.z * s, Math.cos(half)];
    } else {
      // Anti-parallel: 180° about any perpendicular axis.
      quat = [1, 0, 0, 0];
    }
  }
  const offset = target.clone().multiplyScalar(length / 2);
  return (
    <mesh position={[offset.x, offset.y, offset.z]} quaternion={quat}>
      <cylinderGeometry args={[0.0015, 0.0015, length, 12]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}

function ConnectPopover() {
  const picks = useEditorStore((s) => s.jointPicks);
  const setGizmoMode = useEditorStore((s) => s.setGizmoMode);
  const clearPicks = useEditorStore((s) => s.clearJointPicks);
  const select = useEditorStore((s) => s.select);
  const connect = useConnectJoint();
  const [jointType, setJointType] = useState<JointType>("revolute");
  const [error, setError] = useState<string | null>(null);

  if (picks.length !== 2) return null;
  const [a, b] = picks;
  const sameEntity = a.entityId === b.entityId;

  const onCancel = () => {
    clearPicks();
    setGizmoMode("none");
  };

  const onConnect = () => {
    setError(null);
    if (sameEntity) {
      setError("Pick two surfaces on different links.");
      return;
    }
    // Send world-space pick data; the backend converts to parent-local via FK.
    connect.mutate(
      {
        parent_link: a.entityId,
        child_link: b.entityId,
        joint_type: jointType,
        axis_world: a.normal,
        position_world: a.point,
        name: `joint_${jointType}`,
        limits:
          jointType === "revolute" || jointType === "prismatic"
            ? [-3.14159, 3.14159]
            : null,
      },
      {
        onSuccess: (resp) => {
          select(resp.joint_id);
          clearPicks();
          setGizmoMode("none");
        },
        onError: (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          // eslint-disable-next-line no-console
          console.error("connectJoint failed", e);
        },
      },
    );
  };

  return (
    <Html position={b.point} distanceFactor={1.5} center transform={false}>
      <div className="pointer-events-auto w-64 rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 text-xs text-zinc-100 shadow-xl backdrop-blur">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-teal-300">
            <Cog size={12} /> Connect joint
          </div>
          <button
            onClick={onCancel}
            className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X size={12} />
          </button>
        </div>
        <div className="mb-2 space-y-1 text-[10px] text-zinc-400">
          <div>parent: <span className="font-mono text-zinc-300">{a.entityId}</span></div>
          <div>child: <span className="font-mono text-zinc-300">{b.entityId}</span></div>
        </div>
        {sameEntity && (
          <div className="mb-2 rounded bg-red-950/40 px-2 py-1 text-[10px] text-red-300">
            Both picks are on the same entity. Pick a surface on a different link.
          </div>
        )}
        <label className="mb-2 flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Type</span>
          <select
            value={jointType}
            onChange={(e) => setJointType(e.target.value as JointType)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus:border-teal-500 focus:outline-none"
          >
            {JOINT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <div className="mb-2 rounded bg-red-950/40 px-2 py-1 text-[10px] text-red-300 break-words">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={onConnect}
            disabled={sameEntity || connect.isPending}
            className="rounded bg-teal-700/40 px-2 py-1 text-[11px] text-teal-200 hover:bg-teal-700/60 disabled:opacity-40"
          >
            {connect.isPending ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </Html>
  );
}

