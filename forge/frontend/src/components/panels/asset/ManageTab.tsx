// Asset management tab: list/delete/prune meshes and textures in the
// active project. Each row shows size + usage count; deleting an
// in-use mesh requires confirming a force-drop that also strips the
// references from any link's visuals/collisions.

import { Trash2, AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useScene } from "../../../api/hooks";

interface MeshInfo {
  suffix: string;
  size_bytes: number;
  usage: string[];
}

interface TextureInfo {
  suffix: string;
  size_bytes: number;
}

export function ManageTab() {
  const sceneQ = useScene();
  const [meshes, setMeshes] = useState<Record<string, MeshInfo> | null>(null);
  const [textures, setTextures] = useState<Record<string, TextureInfo> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const [m, t] = await Promise.all([
        fetch("/api/v1/assets/meshes").then((r) => r.json()),
        fetch("/api/v1/assets/textures").then((r) => r.json()),
      ]);
      setMeshes(m);
      setTextures(t);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, [sceneQ.dataUpdatedAt]);

  const meshTotalBytes = useMemo(() => {
    return meshes
      ? Object.values(meshes).reduce((s, m) => s + m.size_bytes, 0)
      : 0;
  }, [meshes]);
  const unusedMeshes = useMemo(
    () =>
      meshes
        ? Object.entries(meshes).filter(([, info]) => info.usage.length === 0)
        : [],
    [meshes],
  );

  const deleteMesh = async (stem: string, force: boolean) => {
    setBusy(`mesh:${stem}`);
    setError(null);
    try {
      const r = await fetch(
        `/api/v1/assets/mesh/${encodeURIComponent(stem)}${force ? "?force=true" : ""}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        if (
          r.status === 409 &&
          detail?.detail?.code === "in_use" &&
          window.confirm(
            `${stem} is referenced by ${detail.detail.entities.length} entity(s). Drop refs and delete?`,
          )
        ) {
          await deleteMesh(stem, true);
          return;
        }
        setError(detail?.detail?.message ?? r.statusText);
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const deleteTexture = async (stem: string) => {
    setBusy(`tex:${stem}`);
    setError(null);
    try {
      const r = await fetch(
        `/api/v1/assets/texture/${encodeURIComponent(stem)}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        setError(`failed: ${r.status}`);
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const pruneUnused = async () => {
    if (
      !window.confirm(
        `Drop ${unusedMeshes.length} unreferenced mesh(es) from the project?`,
      )
    ) {
      return;
    }
    setBusy("prune");
    setError(null);
    try {
      const r = await fetch("/api/v1/assets/meshes/prune", { method: "POST" });
      if (!r.ok) {
        setError(`failed: ${r.status}`);
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4 space-y-6 text-sm">
      {error && (
        <div className="flex items-start gap-2 rounded border border-red-900 bg-red-950/50 p-2 text-xs text-red-200">
          <AlertTriangle size={14} className="mt-0.5" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <div className="text-zinc-200 font-medium">Meshes</div>
          <div className="text-xs text-zinc-500">
            {meshes ? Object.keys(meshes).length : 0} total ·{" "}
            {formatBytes(meshTotalBytes)} ·{" "}
            <span className="text-zinc-400">
              {unusedMeshes.length} unused
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <button
            onClick={pruneUnused}
            disabled={unusedMeshes.length === 0 || busy === "prune"}
            className="flex items-center gap-1.5 rounded border border-amber-900 bg-amber-950/40 px-2 py-1 text-xs text-amber-200 hover:bg-amber-950/70 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Trash2 size={12} /> Prune unused
          </button>
        </div>
      </div>

      <div className="rounded border border-zinc-800 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-zinc-950 text-zinc-400">
            <tr>
              <th className="text-left px-3 py-1.5 font-normal">Mesh</th>
              <th className="text-left px-3 py-1.5 font-normal">Format</th>
              <th className="text-right px-3 py-1.5 font-normal">Size</th>
              <th className="text-right px-3 py-1.5 font-normal">Used by</th>
              <th className="px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {meshes &&
              Object.entries(meshes)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([stem, info]) => (
                  <tr
                    key={stem}
                    className="border-t border-zinc-900 hover:bg-zinc-950/60"
                  >
                    <td className="px-3 py-1.5 font-mono text-zinc-200">
                      {stem}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-500">
                      {info.suffix}
                    </td>
                    <td className="px-3 py-1.5 text-right text-zinc-400 tabular-nums">
                      {formatBytes(info.size_bytes)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {info.usage.length === 0 ? (
                        <span className="text-zinc-600">unused</span>
                      ) : (
                        <span className="text-zinc-300">
                          {info.usage.length}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        onClick={() => deleteMesh(stem, false)}
                        disabled={busy === `mesh:${stem}`}
                        title="Delete mesh"
                        className="text-zinc-500 hover:text-red-400 disabled:opacity-30"
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
            {meshes && Object.keys(meshes).length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-zinc-600">
                  No meshes in this project.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div>
        <div className="text-zinc-200 font-medium">Textures</div>
        <div className="text-xs text-zinc-500">
          {textures ? Object.keys(textures).length : 0} total
        </div>
      </div>
      <div className="rounded border border-zinc-800 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-zinc-950 text-zinc-400">
            <tr>
              <th className="text-left px-3 py-1.5 font-normal">Texture</th>
              <th className="text-left px-3 py-1.5 font-normal">Format</th>
              <th className="text-right px-3 py-1.5 font-normal">Size</th>
              <th className="px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {textures &&
              Object.entries(textures)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([stem, info]) => (
                  <tr
                    key={stem}
                    className="border-t border-zinc-900 hover:bg-zinc-950/60"
                  >
                    <td className="px-3 py-1.5 font-mono text-zinc-200">
                      {stem}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-500">
                      {info.suffix}
                    </td>
                    <td className="px-3 py-1.5 text-right text-zinc-400 tabular-nums">
                      {formatBytes(info.size_bytes)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        onClick={() => deleteTexture(stem)}
                        disabled={busy === `tex:${stem}`}
                        title="Delete texture"
                        className="text-zinc-500 hover:text-red-400 disabled:opacity-30"
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
            {textures && Object.keys(textures).length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-zinc-600">
                  No textures.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
