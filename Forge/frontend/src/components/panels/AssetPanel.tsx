// Asset panel: modal dialog with three tabs.
//
// 1. "Parts (Local)" — multi-file picker. Each file uploads to /api/v1/parts/upload
//    and becomes one link entity in the current project. STEP/IGES are
//    converted server-side to GLB via cascadio. Other formats (.stl/.obj/
//    .glb/.ply) pass through.
//
// 2. "Library" — curated catalog from /api/v1/library. Click "Add" to merge
//    into the current project (creates new entities under the selected
//    parent, or as new roots).
//
// 3. "Manage" — list every mesh / texture in the active project, see
//    usage counts, delete or prune unused.

import {
  FileUp,
  Folder,
  Library,
  Boxes,
  X,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { useRef, useState } from "react";

import { type LibraryEntry } from "../../api/client";
import { useLibrary, useLoadLibraryEntry, useUploadParts } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";

import { ManageTab } from "./asset/ManageTab";

type Tab = "parts" | "library" | "manage";

export function AssetPanel() {
  const open = useEditorStore((s) => s.assetPanelOpen);
  const setOpen = useEditorStore((s) => s.setAssetPanelOpen);
  const [tab, setTab] = useState<Tab>("parts");

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex h-[80vh] w-[90vw] max-w-5xl flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl">
        <Header onClose={() => setOpen(false)} tab={tab} setTab={setTab} />
        <div className="flex-1 min-h-0 overflow-auto">
          {tab === "parts" && <PartsTab />}
          {tab === "library" && <LibraryTab />}
          {tab === "manage" && <ManageTab />}
        </div>
      </div>
    </div>
  );
}

function Header({ onClose, tab, setTab }: { onClose: () => void; tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
      <div className="flex items-center gap-1">
        <TabButton icon={<Folder size={14} />} active={tab === "parts"} onClick={() => setTab("parts")}>
          Parts (Local Files)
        </TabButton>
        <TabButton icon={<Library size={14} />} active={tab === "library"} onClick={() => setTab("library")}>
          Library
        </TabButton>
        <TabButton icon={<Boxes size={14} />} active={tab === "manage"} onClick={() => setTab("manage")}>
          Manage
        </TabButton>
      </div>
      <button
        onClick={onClose}
        className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      >
        <X size={16} />
      </button>
    </div>
  );
}

function TabButton({
  children,
  icon,
  active,
  onClick,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center gap-1.5 rounded px-3 py-1 text-sm transition-colors " +
        (active
          ? "bg-teal-700/40 text-teal-200"
          : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200")
      }
    >
      {icon}
      {children}
    </button>
  );
}

// --------------------- Parts tab ---------------------

function PartsTab() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadParts();
  const [parentId, setParentId] = useState<string | null>(null);
  const selectedId = useEditorStore((s) => s.selectedId);

  const onPickFiles = () => fileInputRef.current?.click();
  const onFilesChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 0) return;
    upload.mutate({ files, parentId });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="flex h-full flex-col p-4 text-sm">
      <div className="mb-4 rounded border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400">
        <p className="mb-1 text-zinc-300">Drop CAD or mesh files in. One file = one link entity.</p>
        <p>
          Supported: <code>.stl</code>, <code>.obj</code>, <code>.glb</code>, <code>.gltf</code>,{" "}
          <code>.ply</code>, <code>.step</code>/<code>.stp</code>, <code>.iges</code>/<code>.igs</code>.
          {" "}
          STEP/IGES are tessellated to GLB server-side via OpenCascade. SolidWorks <code>.SLDPRT</code>{" "}
          is not supported — convert to STEP or STL first.
        </p>
      </div>

      <div className="mb-3 flex items-end gap-3">
        <label className="flex flex-col text-xs">
          <span className="mb-1 text-zinc-400">Add under parent</span>
          <select
            value={parentId ?? ""}
            onChange={(e) => setParentId(e.target.value || null)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus:border-teal-500 focus:outline-none"
          >
            <option value="">(scene root)</option>
            {selectedId && <option value={selectedId}>selected: {selectedId}</option>}
          </select>
        </label>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".stl,.obj,.glb,.gltf,.ply,.step,.stp,.iges,.igs"
          onChange={onFilesChosen}
          className="hidden"
        />
        <button
          onClick={onPickFiles}
          disabled={upload.isPending}
          className="flex items-center gap-1.5 rounded bg-teal-700/40 px-3 py-1.5 text-teal-200 hover:bg-teal-700/60 disabled:opacity-50"
        >
          <FileUp size={14} />
          {upload.isPending ? "Uploading…" : "Choose files…"}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto rounded border border-zinc-800 bg-zinc-950/40">
        {!upload.data && !upload.isError && (
          <div className="p-4 text-xs text-zinc-500">
            Last upload result will appear here. Multi-select supported. Each file becomes one link
            entity in the current project (existing scene is not replaced).
          </div>
        )}
        {upload.isError && (
          <div className="p-4 text-xs text-red-400">
            <AlertTriangle className="inline" size={12} /> {String(upload.error)}
          </div>
        )}
        {upload.data && (
          <div className="p-3">
            {upload.data.added.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <Th>File</Th>
                    <Th>Format</Th>
                    <Th>Size</Th>
                    <Th>Entity</Th>
                  </tr>
                </thead>
                <tbody>
                  {upload.data.added.map((a) => (
                    <tr key={a.entity_id} className="border-b border-zinc-900">
                      <Td>{a.file}</Td>
                      <Td className="font-mono">{a.mesh_suffix}</Td>
                      <Td>{(a.size_bytes / 1024).toFixed(1)} KB</Td>
                      <Td className="font-mono text-[10px] text-zinc-500">{a.entity_id}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {upload.data.errors.length > 0 && (
              <div className="mt-3 rounded border border-red-900/60 bg-red-950/30 p-2">
                <div className="mb-1 text-xs font-semibold text-red-400">
                  <AlertTriangle className="inline" size={12} /> Errors
                </div>
                <ul className="ml-4 list-disc text-xs text-red-300">
                  {upload.data.errors.map((e, i) => (
                    <li key={i}>
                      <span className="font-mono">{e.file}</span>: {e.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --------------------- Library tab ---------------------

function LibraryTab() {
  const lib = useLibrary();
  const load = useLoadLibraryEntry();
  const selectedId = useEditorStore((s) => s.selectedId);
  const [parentId, setParentId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const removeEntry = async (id: string) => {
    if (!window.confirm(`Remove "${id}" from the library?`)) return;
    const r = await fetch(`/api/v1/library/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      window.alert(`Delete failed: ${r.status}`);
      return;
    }
    lib.refetch();
  };

  return (
    <div className="flex h-full flex-col p-4 text-sm">
      <div className="mb-3 flex items-end justify-between gap-3">
        <label className="flex flex-col text-xs">
          <span className="mb-1 text-zinc-400">Merge under parent</span>
          <select
            value={parentId ?? ""}
            onChange={(e) => setParentId(e.target.value || null)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus:border-teal-500 focus:outline-none"
          >
            <option value="">(scene root)</option>
            {selectedId && <option value={selectedId}>selected: {selectedId}</option>}
          </select>
        </label>
        <button
          onClick={() => setShowForm(true)}
          className="rounded border border-teal-700 bg-teal-900/30 px-3 py-1.5 text-xs text-teal-200 hover:bg-teal-900/60"
        >
          + Add library entry
        </button>
      </div>

      {lib.isLoading && <div className="p-4 text-xs text-zinc-500">Loading…</div>}
      {lib.data && (
        <div className="grid flex-1 min-h-0 grid-cols-1 gap-3 overflow-auto md:grid-cols-2 lg:grid-cols-3">
          {lib.data.map((e) => (
            <AssetCard
              key={e.id}
              entry={e}
              busy={load.isPending && load.variables?.id === e.id}
              onAdd={(mode) => load.mutate({ id: e.id, mode, parentId })}
              onRemove={() => removeEntry(e.id)}
            />
          ))}
        </div>
      )}

      {showForm && (
        <NewEntryDialog
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            lib.refetch();
          }}
        />
      )}
    </div>
  );
}

function AssetCard({
  entry,
  busy,
  onAdd,
  onRemove,
}: {
  entry: LibraryEntry;
  busy: boolean;
  onAdd: (mode: "merge" | "replace") => void;
  onRemove: () => void;
}) {
  return (
    <div className="group flex flex-col rounded border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-zinc-100">{entry.name}</div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">{entry.category}</div>
        </div>
        <div className="flex items-center gap-1">
          {!entry.supported && (
            <span className="rounded bg-yellow-900/40 px-2 py-0.5 text-[10px] uppercase text-yellow-300">
              unsupported
            </span>
          )}
          <button
            onClick={onRemove}
            title="Remove from library"
            className="rounded p-1 text-zinc-600 opacity-0 hover:bg-red-900/30 hover:text-red-300 group-hover:opacity-100"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {entry.formats.map((f) => (
          <span key={f} className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
            {f}
          </span>
        ))}
      </div>

      <p className="mb-3 flex-1 text-[11px] leading-relaxed text-zinc-400">{entry.description}</p>

      {entry.unsupported_reason && (
        <div className="mb-2 rounded bg-yellow-950/30 p-2 text-[10px] text-yellow-300">
          <AlertTriangle className="inline" size={10} /> {entry.unsupported_reason}
        </div>
      )}

      {entry.source_url && (
        <a
          href={entry.source_url}
          target="_blank"
          rel="noreferrer"
          className="mb-2 flex items-center gap-1 text-[10px] text-teal-400 hover:underline"
        >
          <ExternalLink size={10} /> {entry.source_label || "source"}
        </a>
      )}

      <div className="mt-auto flex gap-2">
        <button
          onClick={() => onAdd("merge")}
          disabled={!entry.supported || busy}
          className="flex-1 rounded bg-teal-700/40 px-2 py-1 text-xs text-teal-200 hover:bg-teal-700/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add to scene"}
        </button>
        <button
          onClick={() => onAdd("replace")}
          disabled={!entry.supported || busy}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          title="Replace the current project with this asset"
        >
          Replace
        </button>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2 py-1 text-left font-normal">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={"px-2 py-1 align-top " + (className ?? "")}>{children}</td>;
}

const CATEGORIES = [
  "robot",
  "gripper",
  "sensor",
  "actuator",
  "tool",
  "fixture",
  "conveyor",
  "controller",
  "misc",
] as const;

function NewEntryDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  // Add a 3D model file from disk to the library. The file is copied
  // into ~/.forgebot/library_assets/<id>/ on the server; the entry is
  // wired to the `local_file` loader so future loads read from there.
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] =
    useState<(typeof CATEGORIES)[number]>("sensor");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!file) {
      setError("Pick a file first");
      return;
    }
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", name.trim());
      fd.append("category", category);
      fd.append("description", description.trim());
      fd.append("tags", tags);
      const r = await fetch("/api/v1/library/upload", {
        method: "POST",
        body: fd,
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        setError(detail?.detail ?? `failed: ${r.status}`);
        return;
      }
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[90vw] max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-100">
            Add 3D model to library
          </h3>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-800">
            <X size={14} />
          </button>
        </div>

        <div className="space-y-3 text-xs">
          <Field label="3D model file" wide>
            <input
              type="file"
              accept=".stl,.obj,.glb,.gltf,.ply,.step,.stp,.iges,.igs,.dae"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !name) {
                  // Default the entry name to the file's stem.
                  setName(f.name.replace(/\.[^.]+$/, ""));
                }
              }}
              className={inputCls}
            />
            <span className="mt-1 text-[10px] text-zinc-500">
              STEP / IGES tessellate via cascadio. STL / OBJ / GLB / PLY pass through.
              File is stored under ~/.forgebot/library_assets/.
            </span>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="VectorNav VN-400"
                className={inputCls}
              />
            </Field>
            <Field label="category">
              <select
                value={category}
                onChange={(e) =>
                  setCategory(e.target.value as (typeof CATEGORIES)[number])
                }
                className={inputCls}
              >
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="tags (comma)" wide>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="imu, ins, vectornav"
              className={inputCls}
            />
          </Field>
          <Field label="description" wide>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        {error && (
          <div className="mt-3 rounded bg-red-950/50 p-2 text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !file}
            className="rounded bg-teal-700 px-3 py-1 text-xs text-teal-50 hover:bg-teal-600 disabled:opacity-40"
          >
            {busy ? "Uploading…" : "Add to library"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus:border-teal-500 focus:outline-none";

function Field({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={"flex flex-col gap-0.5 " + (wide ? "col-span-2" : "")}>
      <span className="text-zinc-500">{label}</span>
      {children}
    </label>
  );
}
