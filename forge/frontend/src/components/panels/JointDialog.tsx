// "Connect joint" modal: pick parent + child link, joint type, axis, then submit.
//
// Drives POST /api/v1/scene/connect (ConnectJointCommand), which creates
// the joint entity AND reparents child_link under it in one undoable op.

import { Cog, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useConnectJoint, useScene } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";
import { Vec3Input } from "../shared/Vec3Input";

const JOINT_TYPES = ["revolute", "continuous", "prismatic", "fixed", "planar", "ball"] as const;
type JointType = (typeof JOINT_TYPES)[number];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function JointDialog({ open, onClose }: Props) {
  const sceneQ = useScene();
  const connect = useConnectJoint();
  const selectedId = useEditorStore((s) => s.selectedId);
  const select = useEditorStore((s) => s.select);

  // Default the parent to the currently selected entity if it's a link.
  const linkEntries = useMemo(() => {
    if (!sceneQ.data) return [] as { id: string; name: string }[];
    return Object.entries(sceneQ.data.entities)
      .filter(([, e]) => !!e.components?.link)
      .map(([id, e]) => ({ id, name: e.name || id }));
  }, [sceneQ.data]);

  const [parentId, setParentId] = useState<string>("");
  const [childId, setChildId] = useState<string>("");
  const [jointType, setJointType] = useState<JointType>("revolute");
  const [axis, setAxis] = useState<[number, number, number]>([0, 0, 1]);
  const [name, setName] = useState<string>("joint_revolute");
  const [error, setError] = useState<string | null>(null);

  // When the dialog opens, seed parent from the current selection if applicable.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (selectedId && sceneQ.data?.entities[selectedId]?.components?.link) {
      setParentId((prev) => prev || selectedId);
    }
  }, [open, selectedId, sceneQ.data]);

  // Auto-rename the joint when the type changes (only if user hasn't typed something custom).
  useEffect(() => {
    if (name.startsWith("joint_")) setName(`joint_${jointType}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jointType]);

  if (!open) return null;

  const onSubmit = () => {
    setError(null);
    if (!parentId || !childId) {
      setError("pick both a parent and child link");
      return;
    }
    if (parentId === childId) {
      setError("parent and child must be different links");
      return;
    }
    connect.mutate(
      {
        parent_link: parentId,
        child_link: childId,
        joint_type: jointType,
        axis,
        name,
        position: [0, 0, 0],
        limits: jointType === "revolute" || jointType === "prismatic" ? [-3.14159, 3.14159] : null,
      },
      {
        onSuccess: (resp) => {
          select(resp.joint_id);
          onClose();
        },
        onError: (e) => setError(String(e)),
      }
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-teal-300">
            <Cog size={14} /> Connect joint
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <Field label="Parent link">
            <Select
              value={parentId}
              onChange={setParentId}
              options={linkEntries}
              placeholder="(pick a link)"
            />
          </Field>
          <Field label="Child link">
            <Select
              value={childId}
              onChange={setChildId}
              options={linkEntries.filter((l) => l.id !== parentId)}
              placeholder="(pick a link)"
            />
          </Field>
          <Field label="Type">
            <select
              value={jointType}
              onChange={(e) => setJointType(e.target.value as JointType)}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus:border-teal-500 focus:outline-none"
            >
              {JOINT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Axis">
            <Vec3Input value={axis} onChange={(v) => setAxis(v)} step={1} />
          </Field>
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus:border-teal-500 focus:outline-none"
            />
          </Field>

          {error && (
            <div className="rounded bg-red-950/40 px-2 py-1 text-xs text-red-300">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={onSubmit}
              disabled={connect.isPending}
              className="rounded bg-teal-700/40 px-3 py-1 text-xs text-teal-200 hover:bg-teal-700/60 disabled:opacity-50"
            >
              {connect.isPending ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
  placeholder?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus:border-teal-500 focus:outline-none"
    >
      <option value="">{placeholder ?? "(none)"}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
