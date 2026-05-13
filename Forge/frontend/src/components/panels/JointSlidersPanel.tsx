// Joint sliders + per-joint inversion toggle.
//
// Each row: slider, value, and (for revolute/continuous joints) a
// small "invert" button. Toggling it flips the rotation direction in
// FK *and* sets `joint.inverted = true` so the exported chain.json
// carries the flag — the morpher uses it to negate the per-joint
// velocity the IK engine emits before sending it to the real arm.
//
// No offset / no calibration constant anywhere: IK runs in URDF-native
// joint coordinates so setting inversion never deforms the model or
// breaks IK convergence.

import { RotateCcw } from "lucide-react";
import { useEffect, useRef } from "react";

import { api } from "../../api/client";
import { useScene } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";
import type { Entity, JointComponent } from "../../types/model";

export function JointSlidersPanel() {
  const sceneQ = useScene();
  const jointValues = useEditorStore((s) => s.jointValues);
  const setJointValue = useEditorStore((s) => s.setJointValue);
  const selectedId = useEditorStore((s) => s.selectedId);

  const movableJoints = sceneQ.data
    ? Object.entries(sceneQ.data.entities).filter(([, e]) => {
        const j = e.components?.joint as JointComponent | undefined;
        return j !== undefined && j.type !== "fixed";
      })
    : [];

  // Auto-scroll the selected joint into view whenever selection changes
  // from outside (3D viewport click, scene tree click, gizmo pick).
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  useEffect(() => {
    if (!selectedId) return;
    const node = rowRefs.current.get(selectedId);
    if (node) node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  return (
    <PanelShell title={`Joint sliders (${movableJoints.length})`}>
      <div className="h-full overflow-y-auto overflow-x-hidden p-2 text-sm">
        {movableJoints.length === 0 && (
          <div className="p-2 text-xs text-zinc-500">No movable joints in this project.</div>
        )}
        {movableJoints.map(([eid, entity]) => (
          <SliderRow
            key={eid}
            eid={eid}
            entity={entity}
            value={jointValues[eid] ?? 0}
            onChange={(v) => setJointValue(eid, v)}
            onInvertSaved={() => sceneQ.refetch()}
            registerRef={(node) => {
              if (node) rowRefs.current.set(eid, node);
              else rowRefs.current.delete(eid);
            }}
          />
        ))}
      </div>
    </PanelShell>
  );
}

function SliderRow({
  eid,
  entity,
  value,
  onChange,
  onInvertSaved,
  registerRef,
}: {
  eid: string;
  entity: Entity;
  value: number;
  onChange: (v: number) => void;
  onInvertSaved: () => void;
  registerRef: (node: HTMLDivElement | null) => void;
}) {
  const j = entity.components?.joint as JointComponent;
  const lower = j.limits?.lower ?? -Math.PI;
  const upper = j.limits?.upper ?? Math.PI;
  const select = useEditorStore((s) => s.select);
  const isSelected = useEditorStore((s) => s.selectedId === eid);
  const isRevolute = j.type === "revolute" || j.type === "continuous";
  const inverted = j.inverted ?? false;

  const toggleInvert = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.updateComponent(eid, "joint", { inverted: !inverted });
      onInvertSaved();
    } catch (err) {
      console.error("failed to toggle invert", err);
    }
  };

  return (
    <div
      ref={registerRef}
      className={
        "mb-1 grid grid-cols-[140px_1fr_60px_64px] items-center gap-2 rounded border px-2 py-1 cursor-pointer transition-colors " +
        (isSelected
          ? "border-teal-500/70 bg-teal-700/25 ring-1 ring-teal-500/40"
          : "border-transparent hover:bg-zinc-800/60")
      }
      onClick={() => select(eid)}
    >
      <div className="truncate text-xs">{entity.name || eid}</div>
      <input
        type="range"
        min={lower}
        max={upper}
        step={(upper - lower) / 500 || 0.01}
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
        onClick={(e) => e.stopPropagation()}
        className="w-full accent-teal-500"
      />
      <div className="text-right text-[11px] text-zinc-400 tabular-nums">
        {value.toFixed(3)}
      </div>
      {isRevolute ? (
        <button
          type="button"
          onClick={toggleInvert}
          title={
            inverted
              ? "Inverted — IK velocity output will be negated for this joint at the morpher boundary. Click to un-invert."
              : "Normal direction. Click if the real joint rotates opposite the URDF axis."
          }
          className={
            "flex items-center justify-center gap-1 rounded border px-1.5 py-0.5 text-[10px] " +
            (inverted
              ? "border-amber-700 bg-amber-700/30 text-amber-200 hover:bg-amber-700/50"
              : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200")
          }
        >
          <RotateCcw size={11} />
          {inverted ? "inv" : "norm"}
        </button>
      ) : (
        <div />
      )}
    </div>
  );
}

function PanelShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col bg-zinc-900">
      <div className="border-b border-zinc-800 px-3 py-1.5 text-xs uppercase tracking-wide text-zinc-400">
        {title}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
