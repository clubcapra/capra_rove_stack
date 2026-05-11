// Chain-picker dialog for File ▸ Export ▸ IK Engine…
//
// Lets the user pick (base, tip) for the chain to export. Pre-fills
// from a tuned IK profile if one exists for the chosen base. Triggers
// the export, downloads the resulting zip, closes.

import { useEffect, useMemo, useState } from "react";

import { api, downloadBlob } from "../../api/client";
import { useScene } from "../../api/hooks";
import type { Entity } from "../../types/model";

interface Props {
  open: boolean;
  projectName: string | null;
  onClose: () => void;
}

export function ExportIKEngineDialog({ open, projectName, onClose }: Props) {
  const sceneQ = useScene();
  const [base, setBase] = useState<string>("");
  const [tip, setTip] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<string[]>([]);

  // Pull tuned IK profiles so we can mark them and pre-select.
  useEffect(() => {
    if (!open) return;
    fetch("/api/v1/kinematics/ik/profiles")
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => setProfiles(Object.keys(d)))
      .catch(() => setProfiles([]));
  }, [open]);

  // Link entities are the only valid base/tip choices.
  const links: Entity[] = useMemo(() => {
    if (!sceneQ.data) return [];
    return Object.entries(sceneQ.data.entities)
      .map(([id, e]) => ({ ...e, id }))
      .filter((e) => (e.components as Record<string, unknown>)?.link)
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }, [sceneQ.data]);

  // Default base = first link with a tuned profile (if any), else first link.
  useEffect(() => {
    if (!open || links.length === 0) return;
    if (!base) {
      const tuned = links.find((l) => profiles.includes(l.id ?? ""));
      setBase(tuned?.id ?? links[0].id ?? "");
    }
    if (!tip) {
      // Default tip = last link (often the end-effector). User can pick.
      setTip(links[links.length - 1].id ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, links, profiles]);

  const onExport = async () => {
    if (!base || !tip) {
      setErr("Pick both base and tip.");
      return;
    }
    if (base === tip) {
      setErr("Base and tip must be different entities.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const blob = await api.exportFile("ik_engine", { base, tip });
      const stem =
        (projectName ?? "robot").replace(/\s+/g, "_") || "robot";
      downloadBlob(blob, `${stem}_ik_engine.zip`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[460px] rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-800 px-4 py-2 text-sm font-medium">
          Export IK Engine
        </div>
        <div className="space-y-3 px-4 py-3 text-xs">
          <p className="text-zinc-400 leading-snug">
            Picks one kinematic chain (base → tip) and bundles a runnable
            UDP-serving IK engine for it. The export ships the URDF, the
            chain spec, and{" "}
            <code className="text-zinc-200">ik_profile.json</code> tuned in{" "}
            <em>Pose ▸ Train IK…</em>. See the bundled README for the
            wire protocol.
          </p>

          <Field label="Base link">
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-xs focus:border-zinc-600 focus:outline-none"
            >
              {links.map((l) => (
                <option key={l.id} value={l.id}>
                  {(l.name ?? l.id) +
                    (profiles.includes(l.id ?? "") ? "  ✓ tuned" : "")}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Tip link (end-effector)">
            <select
              value={tip}
              onChange={(e) => setTip(e.target.value)}
              className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-xs focus:border-zinc-600 focus:outline-none"
            >
              {links.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name ?? l.id}
                </option>
              ))}
            </select>
          </Field>

          {!profiles.includes(base) && (
            <div className="rounded border border-amber-900/60 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-200">
              No tuned profile for this base. The engine will run with
              defaults — that's fine for evaluation, but for tracking
              quality run <em>Pose ▸ Train IK…</em> first.
            </div>
          )}

          {err && (
            <div className="rounded border border-red-900/60 bg-red-950/30 px-2 py-1.5 text-[11px] text-red-300 break-words">
              {err}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onExport}
            disabled={busy || !base || !tip}
            className="rounded bg-teal-700/40 px-3 py-1 text-xs text-teal-100 hover:bg-teal-700/60 disabled:opacity-40"
          >
            {busy ? "Exporting…" : "Export (.zip)"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      {children}
    </label>
  );
}
