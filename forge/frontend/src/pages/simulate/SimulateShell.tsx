import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from "three";

import { useScene } from "../../api/hooks";
import { PageNav } from "../../components/layout/PageNav";
import {
  CameraVideoPlane,
  type CameraStreamConfig,
} from "../../components/sensors/CameraVideoPlane";
import {
  LidarPointCloud,
  type StreamConfig,
} from "../../components/sensors/LidarPointCloud";
import {
  entityCentroid,
  findEntityObject,
} from "../../components/viewport/sceneUtils";
import { SceneRenderer } from "../../components/viewport/SceneRenderer";
import { useSimulateStore } from "../../stores/simulateStore";

import { BindingsPanel } from "./BindingsPanel";

interface CameraIntrinsics {
  image_width?: number;
  image_height?: number;
  fov_h_deg?: number;
}

interface BindingsResp {
  bindings: {
    sensors: Record<
      string,
      {
        entity: string;
        stream_id: string;
        kind: "lidar" | "camera" | "imu";
        mount_rpy_deg?: [number, number, number];
        intrinsics?: CameraIntrinsics;
      }
    >;
  };
}

interface CameraDeviceStatus {
  stream_id: string;
  status: "idle" | "connecting" | "connected" | "error";
}

const STREAM_COLORS = ["#22d3ee", "#a78bfa", "#fb923c", "#34d399", "#f87171"];

export function SimulateShell() {
  const sceneQ = useScene();
  const [bindings, setBindings] = useState<BindingsResp["bindings"] | null>(null);
  const [cameraDevices, setCameraDevices] = useState<CameraDeviceStatus[]>([]);
  const lockedStreamId = useSimulateStore((s) => s.lockedCameraStreamId);
  const videoOpacity = useSimulateStore((s) => s.videoOpacity);
  const setVideoOpacity = useSimulateStore((s) => s.setVideoOpacity);
  const hideModels = useSimulateStore((s) => s.hideModels);
  const setHideModels = useSimulateStore((s) => s.setHideModels);
  const lockToCamera = useSimulateStore((s) => s.lockToCamera);

  useEffect(() => {
    let cancelled = false;
    const refetch = async () => {
      try {
        const [b, c] = await Promise.all([
          fetch("/api/v1/bindings").then((r) => r.json()),
          fetch("/api/v1/cameras/devices").then((r) => r.json()),
        ]);
        if (!cancelled) {
          setBindings((b as BindingsResp).bindings);
          setCameraDevices(c as CameraDeviceStatus[]);
        }
      } catch {
        /* transient — retry next tick */
      }
    };
    refetch();
    const id = setInterval(refetch, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sceneQ.dataUpdatedAt]);

  const connectedStreamIds = useMemo(
    () =>
      new Set(
        cameraDevices.filter((d) => d.status === "connected").map((d) => d.stream_id),
      ),
    [cameraDevices],
  );

  const lidarStreams: StreamConfig[] = useMemo(() => {
    if (!bindings) return [];
    const out: StreamConfig[] = [];
    let i = 0;
    const sensors = Object.values(bindings.sensors)
      .filter((s) => s.kind === "lidar")
      .sort((a, b) => a.stream_id.localeCompare(b.stream_id));
    for (const cfg of sensors) {
      out.push({
        streamId: cfg.stream_id,
        mountEntityId: cfg.entity,
        mountRpyDeg: cfg.mount_rpy_deg ?? [0, 0, 0],
        color: STREAM_COLORS[i++ % STREAM_COLORS.length],
      });
    }
    return out;
  }, [bindings]);

  const cameraStreams: CameraStreamConfig[] = useMemo(() => {
    if (!bindings) return [];
    const out: CameraStreamConfig[] = [];
    const sensors = Object.values(bindings.sensors)
      .filter((s) => s.kind === "camera")
      .sort((a, b) => a.stream_id.localeCompare(b.stream_id));
    for (const cfg of sensors) {
      // When locked to a camera, we don't render that camera's plane —
      // the same stream becomes the full-screen overlay instead.
      if (cfg.stream_id === lockedStreamId) continue;
      if (!connectedStreamIds.has(cfg.stream_id)) continue;
      const intr = cfg.intrinsics ?? {};
      const w = intr.image_width ?? 1920;
      const h = intr.image_height ?? 1080;
      out.push({
        streamId: cfg.stream_id,
        mountEntityId: cfg.entity,
        mountRpyDeg: cfg.mount_rpy_deg ?? [0, 0, 0],
        fovHDeg: intr.fov_h_deg ?? 90,
        aspect: w > 0 && h > 0 ? w / h : 16 / 9,
        previewDistance: 1.0,
        opacity: 0.85,
      });
    }
    return out;
  }, [bindings, lockedStreamId, connectedStreamIds]);

  const lockedBinding = useMemo(() => {
    if (!bindings || !lockedStreamId) return null;
    if (!connectedStreamIds.has(lockedStreamId)) return null;
    for (const v of Object.values(bindings.sensors)) {
      if (v.kind === "camera" && v.stream_id === lockedStreamId) return v;
    }
    return null;
  }, [bindings, lockedStreamId, connectedStreamIds]);

  return (
    <div className="h-screen flex flex-col bg-zinc-900 text-zinc-200">
      <PageNav current="simulate" />
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 relative">
          {/* HTML video overlay for lock mode. Renders BEHIND the canvas
              and lets the user dial its opacity 0..1 to fade between
              live image and lidar overlay. We use a separate <video>
              here (not the same one feeding the WebRTC stream into
              CameraVideoPlane) so locking doesn't fight the plane's
              VideoTexture for the video element. */}
          {lockedStreamId && (
            <LockedVideoOverlay streamId={lockedStreamId} opacity={videoOpacity} />
          )}
          <Canvas
            shadows={!lockedStreamId}
            camera={{ position: [3, -3, 2.4], up: [0, 0, 1], fov: 45 }}
            gl={{ antialias: true, alpha: true }}
            // Transparent canvas in lock mode so the HTML <video> below
            // shows through. In free mode we set a dark BG so the page
            // doesn't bleed the parent's color.
            style={{ background: lockedStreamId ? "transparent" : "#18181b" }}
          >
            {!lockedStreamId && (
              <color attach="background" args={["#18181b"]} />
            )}
            <hemisphereLight args={["#dbe7ff", "#3f3a2e", 0.6]} />
            <ambientLight intensity={0.55} />
            <directionalLight position={[5, 5, 5]} intensity={1.2} />
            {!lockedStreamId && !hideModels && (
              <>
                <gridHelper
                  args={[40, 40, 0x52525b, 0x3f3f46]}
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
              </>
            )}
            {!hideModels && <SceneRenderer />}
            <LidarPointCloud streams={lidarStreams} />
            <CameraVideoPlane streams={cameraStreams} />
            {lockedBinding && (
              <CameraLockController
                streamId={lockedBinding.stream_id}
                mountEntityId={lockedBinding.entity}
                mountRpyDeg={lockedBinding.mount_rpy_deg ?? [0, 0, 0]}
                fovHDeg={lockedBinding.intrinsics?.fov_h_deg ?? 90}
              />
            )}
            {!lockedStreamId && (
              <OrbitControls
                makeDefault
                enableDamping
                dampingFactor={0.12}
                minDistance={0.05}
                maxDistance={50}
                target={[0, 0, 0.2]}
              />
            )}
          </Canvas>

          <ViewportHUD
            locked={!!lockedStreamId}
            videoOpacity={videoOpacity}
            onVideoOpacity={setVideoOpacity}
            hideModels={hideModels}
            onHideModels={setHideModels}
            onUnlock={() => lockToCamera(null)}
          />
        </div>
        <BindingsPanel />
      </div>
    </div>
  );
}

// Drives the Three.js perspective camera from the locked camera's
// optical center + intrinsics. Uses entity *centroid* (mesh-aware) so
// CAD/STEP imports with cancelling-offset transforms still land at the
// visible mesh location. Mount RPY is applied in WORLD frame, same
// convention as the lidar and the camera plane.
function CameraLockController({
  streamId: _streamId,
  mountEntityId,
  mountRpyDeg,
  fovHDeg,
}: {
  streamId: string;
  mountEntityId: string;
  mountRpyDeg: [number, number, number];
  fovHDeg: number;
}) {
  const { camera, scene, size } = useThree();
  const [rDeg, pDeg, yDeg] = mountRpyDeg;

  // Three.js camera FOV is *vertical*. Map H-FOV → V-FOV using the
  // canvas aspect (so what the user sees fills the canvas correctly,
  // even if it's not a perfect match to the sensor aspect — the HTML
  // video overlay will be letterboxed by `object-fit: contain`).
  const canvasAspect = size.width / Math.max(1, size.height);
  const fovV = useMemo(() => {
    const halfH = (fovHDeg * Math.PI) / 360;
    const halfV = Math.atan(Math.tan(halfH) / canvasAspect);
    return (halfV * 360) / Math.PI;
  }, [fovHDeg, canvasAspect]);

  useEffect(() => {
    const persp = camera as PerspectiveCamera;
    if (typeof persp.fov === "number") {
      persp.fov = fovV;
      persp.aspect = canvasAspect;
      persp.near = 0.05;
      persp.far = 200;
      persp.updateProjectionMatrix();
    }
  }, [camera, fovV, canvasAspect]);

  // Each frame, snap camera to the entity's mesh centroid and aim it
  // along the mount-RPY-rotated +X axis (sensor forward).
  useFrame(() => {
    const obj = findEntityObject(scene, mountEntityId);
    if (!obj) return;
    const center = entityCentroid(scene, mountEntityId);
    if (!center) return;
    camera.position.copy(center);

    const mountQuat = new Quaternion().setFromEuler(
      new Euler(
        (rDeg * Math.PI) / 180,
        (pDeg * Math.PI) / 180,
        (yDeg * Math.PI) / 180,
        "XYZ",
      ),
    );
    const forward = new Vector3(1, 0, 0).applyQuaternion(mountQuat);
    const target = center.clone().add(forward);
    camera.up.set(0, 0, 1);
    camera.lookAt(target);
  });

  return null;
}

// Full-screen MJPEG <img> behind the canvas — the lock-view background.
// Same stream that the in-scene plane is rendering elsewhere; the
// browser handles multipart MJPEG inside <img> automatically. Opacity
// on the parent <div> so dragging the slider animates cleanly.
function LockedVideoOverlay({
  streamId,
  opacity,
}: {
  streamId: string;
  opacity: number;
}) {
  return (
    <div
      className="absolute inset-0 pointer-events-none bg-black"
      style={{ opacity }}
    >
      <img
        src={`/api/v1/cameras/stream/${encodeURIComponent(streamId)}.mjpeg?_t=lock`}
        alt=""
        className="absolute inset-0 w-full h-full"
        style={{ objectFit: "contain", pointerEvents: "none" }}
      />
    </div>
  );
}

function ViewportHUD({
  locked,
  videoOpacity,
  onVideoOpacity,
  hideModels,
  onHideModels,
  onUnlock,
}: {
  locked: boolean;
  videoOpacity: number;
  onVideoOpacity: (v: number) => void;
  hideModels: boolean;
  onHideModels: (v: boolean) => void;
  onUnlock: () => void;
}) {
  return (
    <div className="absolute top-2 left-2 flex flex-col gap-1.5 pointer-events-none">
      {locked && (
        <div className="bg-amber-950/90 border border-amber-800/60 rounded px-2 py-1 text-[10px] text-amber-200 font-mono pointer-events-auto flex items-center gap-2">
          <span>View locked · adjust FOV / Mount RPY in panel</span>
          <button
            onClick={onUnlock}
            className="ml-1 underline hover:text-amber-100"
          >
            unlock
          </button>
        </div>
      )}
      {locked && (
        <div className="bg-zinc-950/85 border border-zinc-800 rounded px-2 py-1.5 text-[10px] text-zinc-300 font-mono pointer-events-auto flex items-center gap-2 w-64">
          <span className="w-12 shrink-0">Video</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={videoOpacity}
            onChange={(e) => onVideoOpacity(parseFloat(e.target.value))}
            className="flex-1"
          />
          <span className="w-7 text-right tabular-nums">
            {(videoOpacity * 100).toFixed(0)}%
          </span>
        </div>
      )}
      <label className="bg-zinc-950/85 border border-zinc-800 rounded px-2 py-1 text-[10px] text-zinc-300 font-mono pointer-events-auto flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={hideModels}
          onChange={(e) => onHideModels(e.target.checked)}
        />
        Hide 3D models
      </label>
    </div>
  );
}
