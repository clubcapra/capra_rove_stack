import { Canvas } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import { useEffect } from "react";

import { useEditorStore } from "../../stores/editorStore";

import { FrameView } from "./FrameView";
import { IKGizmo } from "./IKGizmo";
import { JointPickOverlay } from "./JointPickOverlay";
import { SceneRenderer } from "./SceneRenderer";
import { TransformGizmo } from "./TransformGizmo";

export function Viewport() {
  const showGrid = useEditorStore((s) => s.showGrid);
  const gizmoMode = useEditorStore((s) => s.gizmoMode);
  const setGizmoMode = useEditorStore((s) => s.setGizmoMode);
  const select = useEditorStore((s) => s.select);
  const clearJointPicks = useEditorStore((s) => s.clearJointPicks);
  const bumpRequestFrame = useEditorStore((s) => s.bumpRequestFrame);
  const lightIntensity = useEditorStore((s) => s.lightIntensity);
  const sunAzimuth = useEditorStore((s) => s.sunAzimuth);
  const sunElevation = useEditorStore((s) => s.sunElevation);
  // Place the directional light on a 7 m sphere around the world origin —
  // far enough that its shadow camera covers the whole scene. The R3F
  // canvas uses Z-up, so elevation contributes to z and azimuth swings
  // through xy.
  const sunDistance = 7;
  const sunPos: [number, number, number] = [
    sunDistance * Math.cos(sunElevation) * Math.cos(sunAzimuth),
    sunDistance * Math.cos(sunElevation) * Math.sin(sunAzimuth),
    sunDistance * Math.sin(sunElevation),
  ];

  // G/R/J/F/Escape keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        t?.isContentEditable
      ) {
        return;
      }
      // While in IK mode, G and R flip between the IK translate-arrows and
      // rotate-rings widgets (sub-mode), instead of swapping out of IK to
      // the global transform gizmo. Press I again — or Esc — to leave IK.
      const inIk = useEditorStore.getState().gizmoMode === "ik";
      if (e.key === "g") {
        if (inIk) useEditorStore.getState().setIkGizmoSubMode("translate");
        else setGizmoMode("translate");
      } else if (e.key === "r") {
        if (inIk) useEditorStore.getState().setIkGizmoSubMode("rotate");
        else setGizmoMode("rotate");
      } else if (e.key === "j") setGizmoMode("joint");
      else if (e.key === "i") setGizmoMode("ik");
      else if (e.key === "f") bumpRequestFrame();
      else if (e.key === "Escape") {
        clearJointPicks();
        setGizmoMode("none");
        select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setGizmoMode, select, clearJointPicks, bumpRequestFrame]);

  return (
    <div className="relative h-full w-full bg-zinc-900">
      <Canvas
        camera={{ position: [1.2, 1.0, 1.6], fov: 45, near: 0.01, far: 200, up: [0, 0, 1] }}
        dpr={[1, 2]}
        shadows
      >
        <color attach="background" args={["#18181b"]} />
        {/* Three-light setup, all scaled by `lightIntensity`:
            - Hemisphere fill: cool sky / warm ground for natural shading.
            - Ambient: small flat lift so dark materials still register.
            - Directional + shadow: primary key light. */}
        <hemisphereLight args={["#dbe7ff", "#3f3a2e", 0.6 * lightIntensity]} />
        <ambientLight intensity={0.55 * lightIntensity} />
        <directionalLight
          position={sunPos}
          intensity={1.4 * lightIntensity}
          castShadow
          shadow-mapSize={[2048, 2048]}
        />
        {showGrid && (
          <gridHelper args={[10, 20, 0x52525b, 0x3f3f46]} rotation={[Math.PI / 2, 0, 0]} />
        )}
        <SceneRenderer />
        {(gizmoMode === "translate" || gizmoMode === "rotate") && (
          <TransformGizmo mode={gizmoMode} />
        )}
        {gizmoMode === "ik" && <IKGizmo />}
        <JointPickOverlay />
        <FrameView />
        <axesHelper args={[1.0]} />
        <Text position={[1.08, 0, 0]} fontSize={0.08} color="#ef4444" anchorX="left" anchorY="middle">X</Text>
        <Text position={[0, 1.08, 0]} fontSize={0.08} color="#22c55e" anchorX="left" anchorY="middle">Y</Text>
        <Text position={[0, 0, 1.08]} fontSize={0.08} color="#3b82f6" anchorX="left" anchorY="middle">Z</Text>
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.12}
          minDistance={0.05}
          maxDistance={50}
          target={[0, 0, 0.2]}
        />
      </Canvas>
      <ViewportLegend gizmoMode={gizmoMode} />
      <IKStatusPill />
    </div>
  );
}

function IKStatusPill() {
  const status = useEditorStore((s) => s.ikStatus);
  if (!status) return null;
  return (
    <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-zinc-950/85 px-2 py-1 font-mono text-[11px] text-violet-300 backdrop-blur">
      {status}
    </div>
  );
}

function ViewportLegend({ gizmoMode }: { gizmoMode: string }) {
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-zinc-950/80 px-2 py-1 text-[11px] text-zinc-400 backdrop-blur">
      drag: orbit · shift+drag: pan · scroll: zoom
      {" · "}
      <kbd className="rounded bg-zinc-800 px-1">G</kbd> move ·{" "}
      <kbd className="rounded bg-zinc-800 px-1">R</kbd> rotate ·{" "}
      <kbd className="rounded bg-zinc-800 px-1">J</kbd> joint ·{" "}
      <kbd className="rounded bg-zinc-800 px-1">I</kbd> IK ·{" "}
      <kbd className="rounded bg-zinc-800 px-1">F</kbd> frame ·{" "}
      <kbd className="rounded bg-zinc-800 px-1">Esc</kbd> deselect ·{" "}
      <kbd className="rounded bg-zinc-800 px-1">Ctrl+Z</kbd> undo ·{" "}
      <kbd className="rounded bg-zinc-800 px-1">Ctrl+click</kbd> multi-select
      {gizmoMode === "joint" && (
        <span className="ml-2 text-yellow-400">
          mode: joint — click two surfaces to mate
        </span>
      )}
      {gizmoMode === "ik" && (
        <>
          <span className="ml-2 text-violet-400">mode: IK</span>
          <IkSubModeToggle />
        </>
      )}
      {(gizmoMode === "translate" || gizmoMode === "rotate") && (
        <span className="ml-2 text-teal-400">mode: {gizmoMode}</span>
      )}
    </div>
  );
}

function IkSubModeToggle() {
  const sub = useEditorStore((s) => s.ikGizmoSubMode);
  const set = useEditorStore((s) => s.setIkGizmoSubMode);
  const btn = (active: boolean) =>
    "pointer-events-auto rounded px-2 py-0.5 transition-colors " +
    (active
      ? "bg-violet-700/50 text-violet-100"
      : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200");
  return (
    <span className="ml-2 inline-flex gap-1">
      <button onClick={() => set("translate")} className={btn(sub === "translate")} title="IK translate (G)">
        translate
      </button>
      <button onClick={() => set("rotate")} className={btn(sub === "rotate")} title="IK rotate (R)">
        rotate
      </button>
    </span>
  );
}
