// Launcher screen: pick how to start a session.
//
// Routes by user choice:
//   - New Project        → POST /projects/new                → editor (empty)
//   - Open File          → file picker → POST /io/import     → editor
//   - Browse Library     → editor + AssetPanel (Library tab) opened
//   - Recent (per row)   → POST /projects/{name}/open        → editor

import { FileUp, FolderOpen, Library as LibraryIcon, Plus, Trash2 } from "lucide-react";
import { useRef } from "react";

import { useImportFile, useNewProject, useOpenProject, useSavedProjects, useDeleteProject } from "../../api/hooks";
import { useAppStore } from "../../stores/appStore";
import { useEditorStore } from "../../stores/editorStore";

export function HomeScreen() {
  const setView = useAppStore((s) => s.setView);
  const setProjectName = useAppStore((s) => s.setProjectName);
  const setAssetPanelOpen = useEditorStore((s) => s.setAssetPanelOpen);

  const newProj = useNewProject();
  const importMutation = useImportFile();
  const openProj = useOpenProject();
  const deleteProj = useDeleteProject();
  const recents = useSavedProjects();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const onNewProject = () => {
    newProj.mutate(undefined, {
      onSuccess: () => {
        setProjectName(null);
        setView("create");
      },
    });
  };

  const onOpenFile = () => fileInputRef.current?.click();
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importMutation.mutate(file, {
      onSuccess: () => {
        setProjectName(file.name.replace(/\.[^.]+$/, ""));
        setView("create");
      },
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onLibrary = () => {
    newProj.mutate(undefined, {
      onSuccess: () => {
        setProjectName(null);
        setView("create");
        setAssetPanelOpen(true);
      },
    });
  };

  const onOpenRecent = (name: string) => {
    openProj.mutate(name, {
      onSuccess: () => {
        setProjectName(name);
        setView("create");
      },
    });
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="grid w-[min(1100px,90vw)] grid-cols-1 gap-6 lg:grid-cols-[2fr_3fr]">
        {/* Left: title + primary actions */}
        <div className="flex flex-col">
          <div className="mb-8">
            <div className="text-4xl font-bold tracking-tight text-teal-300">ForgeBOT</div>
            <div className="mt-1 text-sm text-zinc-400">
              Universal robot &amp; automation editor — model anything, export to URDF, MJCF, SDF, USD.
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".urdf,.mjcf,.sdf,.world,.xml,.forgebot"
            onChange={onFile}
          />

          <div className="space-y-3">
            <BigCard
              title="New project"
              description="Start with an empty scene"
              icon={<Plus size={22} />}
              onClick={onNewProject}
            />
            <BigCard
              title="Open file…"
              description=".urdf, .mjcf, .sdf, .forgebot"
              icon={<FileUp size={22} />}
              onClick={onOpenFile}
            />
            <BigCard
              title="Browse library"
              description="Robotiq, DJI Mid-360, more"
              icon={<LibraryIcon size={22} />}
              onClick={onLibrary}
            />
          </div>
        </div>

        {/* Right: recent projects */}
        <div className="flex flex-col">
          <div className="mb-3 text-xs uppercase tracking-wide text-zinc-500">Recent projects</div>
          <div className="flex-1 overflow-auto rounded border border-zinc-800 bg-zinc-900/40">
            {recents.isLoading && (
              <div className="p-4 text-xs text-zinc-500">Loading…</div>
            )}
            {recents.data && recents.data.length === 0 && (
              <div className="p-4 text-sm text-zinc-500">
                No saved projects yet. Use{" "}
                <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]">Ctrl+S</kbd>{" "}
                in the editor to save under a name.
              </div>
            )}
            {recents.data && recents.data.length > 0 && (
              <ul className="divide-y divide-zinc-800">
                {recents.data.map((p) => (
                  <li
                    key={p.name}
                    className="group flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-800/50"
                  >
                    <FolderOpen size={14} className="text-zinc-500" />
                    <button
                      onClick={() => onOpenRecent(p.name)}
                      className="flex-1 text-left text-sm text-zinc-200 hover:text-teal-300"
                    >
                      <div className="font-medium">{p.name}</div>
                      <div className="text-[10px] text-zinc-500">
                        {(p.size_bytes / 1024).toFixed(1)} KB · saved {fmtRelative(p.modified)}
                      </div>
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete saved project '${p.name}'?`))
                          deleteProj.mutate(p.name, {
                            onSuccess: () => recents.refetch(),
                          });
                      }}
                      className="rounded p-1 text-zinc-500 opacity-0 hover:bg-red-900/30 hover:text-red-300 group-hover:opacity-100"
                      title="Delete"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BigCard({
  title,
  description,
  icon,
  onClick,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-left transition-colors hover:border-teal-700 hover:bg-zinc-900"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-teal-700/20 text-teal-300 group-hover:bg-teal-700/40">
        {icon}
      </div>
      <div>
        <div className="text-base font-semibold text-zinc-100">{title}</div>
        <div className="text-xs text-zinc-400">{description}</div>
      </div>
    </button>
  );
}

function fmtRelative(epoch: number): string {
  const seconds = Math.floor(Date.now() / 1000 - epoch);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} d ago`;
  return new Date(epoch * 1000).toLocaleDateString();
}
