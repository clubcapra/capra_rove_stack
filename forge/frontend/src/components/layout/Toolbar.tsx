import { useEffect, useRef, useState } from "react";

import { Menu, MenuItem, MenuSeparator, MenuSubmenu, MenuToggle } from "./Menu";
import {
  Activity,
  Cog,
  Download,
  FileSearch,
  Focus,
  Grid3x3,
  Hand,
  Home,
  Library as LibraryIcon,
  MousePointer2,
  Move,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  ShieldAlert,
  Sun,
  Undo2,
  Upload,
} from "lucide-react";

import { api, downloadBlob } from "../../api/client";
import { useImportFile, useRedo, useSaveProjectAs, useUndo, useUploadParts } from "../../api/hooks";
import { useAppStore } from "../../stores/appStore";
import { useEditorStore } from "../../stores/editorStore";
import { ExportIKEngineDialog } from "../dialogs/ExportIKEngineDialog";

// Files that replace the whole project; everything else is treated as a part.
const PROJECT_EXTS = [".urdf", ".mjcf", ".sdf", ".world", ".xml", ".forgebot"];

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importMutation = useImportFile();
  const undo = useUndo();
  const redo = useRedo();
  const showGrid = useEditorStore((s) => s.showGrid);
  const showCollisions = useEditorStore((s) => s.showCollisions);
  const toggleGrid = useEditorStore((s) => s.toggleGrid);
  const toggleCollisions = useEditorStore((s) => s.toggleCollisions);
  const resetJoints = useEditorStore((s) => s.resetJointValues);
  const setJointValues = useEditorStore((s) => s.setJointValues);
  const onSetHome = async () => {
    const current = useEditorStore.getState().jointValues;
    await api.setHomePose(current);
  };
  const onGoHome = async () => {
    const pose = await api.getHomePose();
    setJointValues(pose);
  };
  const gizmoMode = useEditorStore((s) => s.gizmoMode);
  const setGizmoMode = useEditorStore((s) => s.setGizmoMode);
  const setAssetPanelOpen = useEditorStore((s) => s.setAssetPanelOpen);
  const setIkTrainingOpen = useEditorStore((s) => s.setIkTrainingOpen);
  const bumpRequestFrame = useEditorStore((s) => s.bumpRequestFrame);
  const collisionCheck = useEditorStore((s) => s.collisionCheck);
  const toggleCollisionCheck = useEditorStore((s) => s.toggleCollisionCheck);
  const collidingCount = useEditorStore((s) => s.collidingIds.length);
  const goHome = useAppStore((s) => s.goHome);
  const projectName = useAppStore((s) => s.projectName);
  const setProjectName = useAppStore((s) => s.setProjectName);
  const saveAs = useSaveProjectAs();
  const onSave = () => {
    const proposed = projectName ?? "untitled";
    const name = window.prompt("Save project as…", proposed);
    if (!name) return;
    saveAs.mutate(name, {
      onSuccess: () => setProjectName(name),
    });
  };

  // Ctrl+S to save, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z to undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        t?.isContentEditable;

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      if (key === "s") {
        e.preventDefault();
        onSave();
        return;
      }
      // Skip undo/redo when typing in fields — let the browser handle native
      // text undo there.
      if (inField) return;
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo.mutate();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName]);

  const upload = useUploadParts();
  const onImportClick = () => fileInputRef.current?.click();
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 0) return;
    // Single project file (URDF/MJCF/SDF/.forgebot) -> replace project.
    // Anything else (STEP/STL/OBJ/GLB/...) -> add as part(s) to current project.
    const isProjectFile = (f: File) =>
      PROJECT_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext));
    const projectFiles = files.filter(isProjectFile);
    const partFiles = files.filter((f) => !isProjectFile(f));
    if (projectFiles.length > 0) importMutation.mutate(projectFiles[0]);
    if (partFiles.length > 0) upload.mutate({ files: partFiles, parentId: null });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  const [ikEngineDialogOpen, setIkEngineDialogOpen] = useState(false);
  const onExport = async (fmt: string) => {
    try {
      const blob = await api.exportFile(fmt);
      // Backend bundles assets alongside the format file and returns a zip
      // — see io/export route. Save with .zip so the user can unpack it.
      const base = (projectName ?? "robot").replace(/\s+/g, "_");
      downloadBlob(blob, `${base}_${fmt}.zip`);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px]">
      {/* Brand / project name */}
      <button
        onClick={goHome}
        title="Go to home screen"
        className="flex items-center gap-1.5 rounded px-2 py-1 font-semibold tracking-tight text-teal-300 hover:bg-zinc-800"
      >
        <Home size={14} /> ForgeBOT
      </button>
      {projectName && (
        <span className="text-xs text-zinc-500">/ {projectName}</span>
      )}

      <Sep />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        accept=".urdf,.mjcf,.sdf,.world,.xml,.forgebot,.stl,.obj,.glb,.gltf,.ply,.step,.stp,.iges,.igs"
        onChange={onFileChange}
      />

      <Menu label="File">
        <MenuItem onClick={onSave} icon={<Save size={13} />} shortcut="Ctrl+S">
          Save…
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onImportClick} icon={<Upload size={13} />}>
          Import…
        </MenuItem>
        <MenuItem
          onClick={() => setAssetPanelOpen(true)}
          icon={<LibraryIcon size={13} />}
        >
          Asset library…
        </MenuItem>
        <MenuSeparator />
        <MenuSubmenu label="Export" icon={<Download size={13} />}>
          <MenuItem onClick={() => onExport("urdf")}>URDF (.zip)</MenuItem>
          <MenuItem onClick={() => onExport("mjcf")}>MJCF (.zip)</MenuItem>
          <MenuItem onClick={() => onExport("sdf")}>SDF (.zip)</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => setIkEngineDialogOpen(true)}>
            IK Engine… (UDP/Protobuf .zip)
          </MenuItem>
        </MenuSubmenu>
        <MenuSeparator />
        <MenuItem onClick={goHome} icon={<Home size={13} />}>
          Back to home screen
        </MenuItem>
      </Menu>

      <Menu label="Edit">
        <MenuItem onClick={() => undo.mutate()} icon={<Undo2 size={13} />} shortcut="Ctrl+Z">
          Undo
        </MenuItem>
        <MenuItem onClick={() => redo.mutate()} icon={<Redo2 size={13} />} shortcut="Ctrl+Y">
          Redo
        </MenuItem>
      </Menu>

      <Menu label="View">
        <MenuToggle
          checked={showGrid}
          onClick={toggleGrid}
          icon={<Grid3x3 size={13} />}
        >
          Ground grid
        </MenuToggle>
        <MenuToggle
          checked={showCollisions}
          onClick={toggleCollisions}
          icon={<FileSearch size={13} />}
        >
          Collision geometry
        </MenuToggle>
        <MenuSeparator />
        <MenuItem
          onClick={bumpRequestFrame}
          icon={<Focus size={13} />}
          shortcut="F"
        >
          Frame all / selected
        </MenuItem>
      </Menu>

      <Menu label="Pose">
        <MenuItem onClick={resetJoints} icon={<RotateCcw size={13} />}>
          Zero all joints
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onGoHome} icon={<Home size={13} />}>
          Go to home pose
        </MenuItem>
        <MenuItem onClick={onSetHome} icon={<Hand size={13} />}>
          Set current as home pose
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() => setIkTrainingOpen(true)}
          icon={<Activity size={13} />}
        >
          Train IK for selected chain…
        </MenuItem>
        <MenuSeparator />
        <MenuToggle
          checked={collisionCheck}
          onClick={toggleCollisionCheck}
          icon={<ShieldAlert size={13} />}
        >
          Live collision check
          {collisionCheck && collidingCount > 0 ? ` · ${collidingCount}` : ""}
        </MenuToggle>
      </Menu>

      <Sep />

      {/* Quick-access mode pills (constantly used; not buried in a menu). */}
      <ModeBtn
        onClick={() => setGizmoMode("none")}
        icon={<MousePointer2 size={14} />}
        active={gizmoMode === "none"}
        title="Select (Esc)"
      />
      <ModeBtn
        onClick={() => setGizmoMode("translate")}
        icon={<Move size={14} />}
        active={gizmoMode === "translate"}
        title="Move (G)"
      />
      <ModeBtn
        onClick={() => setGizmoMode("rotate")}
        icon={<RotateCw size={14} />}
        active={gizmoMode === "rotate"}
        title="Rotate (R)"
      />
      <ModeBtn
        onClick={() => setGizmoMode("joint")}
        icon={<Cog size={14} />}
        active={gizmoMode === "joint"}
        title="Joint mode (J)"
      />
      <ModeBtn
        onClick={() => setGizmoMode("ik")}
        icon={<Hand size={14} />}
        active={gizmoMode === "ik"}
        title="IK mode (I)"
      />

      <Sep />

      <LightControl />

      {/* Right-aligned status: collision count when active. */}
      <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
        {collisionCheck && (
          <span
            className={
              collidingCount > 0 ? "text-red-400" : "text-zinc-500"
            }
            title="Live collision check is on"
          >
            <ShieldAlert size={12} className="inline align-text-top" />
            {collidingCount > 0 ? ` ${collidingCount} colliding` : " no collisions"}
          </span>
        )}
      </div>

      <ExportIKEngineDialog
        open={ikEngineDialogOpen}
        projectName={projectName}
        onClose={() => setIkEngineDialogOpen(false)}
      />
    </div>
  );
}

function ModeBtn({
  onClick,
  icon,
  active,
  title,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={
        "flex h-7 w-7 items-center justify-center rounded transition-colors " +
        (active
          ? "bg-teal-700/40 text-teal-200"
          : "text-zinc-300 hover:bg-zinc-800")
      }
    >
      {icon}
    </button>
  );
}

function Sep() {
  return <div className="mx-1 h-5 w-px bg-zinc-800" />;
}

function LightControl() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const lightIntensity = useEditorStore((s) => s.lightIntensity);
  const setLightIntensity = useEditorStore((s) => s.setLightIntensity);
  const sunAzimuth = useEditorStore((s) => s.sunAzimuth);
  const sunElevation = useEditorStore((s) => s.sunElevation);
  const setSunAzimuth = useEditorStore((s) => s.setSunAzimuth);
  const setSunElevation = useEditorStore((s) => s.setSunElevation);
  const RAD = 180 / Math.PI;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Lighting (intensity, sun azimuth/elevation)"
        className={
          "flex items-center gap-1.5 rounded px-2 py-1 transition-colors " +
          (open
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-300 hover:bg-zinc-800")
        }
      >
        <Sun size={14} />
        Light
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded border border-zinc-800 bg-zinc-950/95 p-3 text-[11px] shadow-xl">
          <LightSlider
            label="intensity"
            value={lightIntensity}
            onChange={setLightIntensity}
            min={0}
            max={3}
            step={0.05}
            display={(v) => v.toFixed(2)}
          />
          <LightSlider
            label="azimuth"
            value={sunAzimuth}
            onChange={setSunAzimuth}
            min={-Math.PI}
            max={Math.PI}
            step={0.02}
            display={(v) => `${(v * RAD).toFixed(0)}°`}
          />
          <LightSlider
            label="elevation"
            value={sunElevation}
            onChange={setSunElevation}
            min={-Math.PI / 2 + 0.01}
            max={Math.PI / 2 - 0.01}
            step={0.02}
            display={(v) => `${(v * RAD).toFixed(0)}°`}
          />
          <div className="mt-2 flex gap-1">
            <LightPreset
              onClick={() => {
                setSunElevation(Math.PI / 2 - 0.05);
                setSunAzimuth(0);
              }}
            >
              top
            </LightPreset>
            <LightPreset
              onClick={() => {
                setSunElevation(Math.atan2(5, Math.hypot(3, 4)));
                setSunAzimuth(Math.atan2(4, 3));
              }}
            >
              3/4
            </LightPreset>
            <LightPreset
              onClick={() => {
                setSunElevation(0.2);
                setSunAzimuth(Math.PI);
              }}
            >
              back
            </LightPreset>
            <LightPreset
              onClick={() => {
                setLightIntensity(1.0);
                setSunElevation(Math.atan2(5, Math.hypot(3, 4)));
                setSunAzimuth(Math.atan2(4, 3));
              }}
            >
              reset
            </LightPreset>
          </div>
        </div>
      )}
    </div>
  );
}

function LightSlider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  display,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  display: (v: number) => string;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="w-16 text-zinc-400">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-teal-500"
      />
      <span className="w-10 text-right tabular-nums text-zinc-400">
        {display(value)}
      </span>
    </div>
  );
}

function LightPreset({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex-1 rounded bg-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-700"
    >
      {children}
    </button>
  );
}

