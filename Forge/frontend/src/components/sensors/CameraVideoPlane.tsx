// Camera video plane — renders a live RTSP-bridged WebRTC stream as a
// textured plane in 3D, sized by the camera's H-FOV at a fixed preview
// distance, and positioned at the bound entity's *visible mesh
// centroid* (not its raw transform — see the lidar fix in commit
// history; cancelling-offset CAD imports leave the entity transform at
// origin and bake the location into the mesh vertices).
//
// Convention (matches the lidar plane and the lock-view camera):
//   - sensor +X = forward (where the camera looks)
//   - sensor +Z = up in image
// The plane is positioned at +X = previewDistance in sensor frame and
// faces back toward the optical center, so a Three.js camera placed at
// the entity centroid and looking down sensor +X sees the image
// right-side-up.
//
// Mount RPY is applied as an XYZ Euler in WORLD frame (independent of
// the entity's URDF/STEP rotation, which orients the visual mesh and
// is irrelevant to the sensor's data frame — same reasoning as the
// lidar pipeline).

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Texture,
  Vector3,
} from "three";

import { createCameraStream, type CameraStream } from "../../api/cameraStream";
import { entityCentroid, findEntityObject } from "../viewport/sceneUtils";

export interface CameraStreamConfig {
  streamId: string;
  mountEntityId?: string;
  mountRpyDeg?: [number, number, number];
  fovHDeg?: number;
  aspect?: number; // image_width / image_height
  previewDistance?: number; // meters; cosmetic
  opacity?: number; // 0..1; lets the user see lidar through the video
}

const DEG2RAD = Math.PI / 180;

export function CameraVideoPlane({ streams }: { streams: CameraStreamConfig[] }) {
  const { scene } = useThree();
  const containers = useRef(new Map<string, RenderState>());

  // Mount / unmount per-stream resources to match the active set.
  for (const cfg of streams) {
    if (!containers.current.has(cfg.streamId)) {
      containers.current.set(cfg.streamId, createRenderState(cfg));
    }
  }
  for (const sid of Array.from(containers.current.keys())) {
    if (!streams.find((s) => s.streamId === sid)) {
      const st = containers.current.get(sid)!;
      disposeRenderState(st);
      containers.current.delete(sid);
    }
  }

  // Apply config changes (FOV, aspect, mount, opacity) every render so
  // the user can tune intrinsics live.
  for (const cfg of streams) {
    const st = containers.current.get(cfg.streamId);
    if (!st) continue;
    st.cfg = cfg;
    resizePlane(st);
    const op = cfg.opacity ?? 1;
    const mat = st.plane.material as MeshBasicMaterial;
    mat.opacity = op;
    mat.transparent = op < 1;
    mat.needsUpdate = true;
  }

  const tmpDir = useRef(new Vector3());
  const tmpUp = useRef(new Vector3(0, 0, 1));
  const tmpEuler = useRef(new Euler());
  const tmpQuat = useRef(new Quaternion());
  const tmpForwardLocal = useRef(new Vector3());

  useFrame(() => {
    for (const st of containers.current.values()) {
      // MJPEG re-upload every frame (see createRenderState comment).
      st.texture.needsUpdate = true;
      const eid = st.cfg.mountEntityId;
      if (!eid) continue;
      // Position: visible mesh centroid (handles cancelling-offset
      // imports). Falls back to the entity root world position if the
      // entity has no geometry.
      const center = entityCentroid(scene, eid);
      const obj = findEntityObject(scene, eid);
      if (!center || !obj) continue;
      st.group.position.copy(center);

      // Orientation: rotate the group so its local +X (sensor forward)
      // points along the mount RPY (world frame). lookAt(target, up)
      // makes -Z look at target; we want +X forward, so we compute
      // the desired forward, then build a quaternion that aligns
      // world +X to that forward. Then up vector = world +Z.
      const [r, p, y] = st.cfg.mountRpyDeg ?? [0, 0, 0];
      tmpEuler.current.set(r * DEG2RAD, p * DEG2RAD, y * DEG2RAD, "XYZ");
      tmpQuat.current.setFromEuler(tmpEuler.current);
      // Forward direction in world after applying mount RPY to base +X.
      tmpForwardLocal.current.set(1, 0, 0).applyQuaternion(tmpQuat.current);
      tmpDir.current.copy(st.group.position).add(tmpForwardLocal.current);
      st.group.up.copy(tmpUp.current);
      st.group.lookAt(tmpDir.current);
      // lookAt orients local -Z toward target. Our plane convention
      // expects +X forward, so apply a fixed correction: rotate -90°
      // around local Y so that local +X becomes the forward direction
      // (was -Z) and +Z stays as image up.
      st.group.rotateY(Math.PI / 2);
    }
  });

  useEffect(() => () => {
    for (const st of containers.current.values()) disposeRenderState(st);
    containers.current.clear();
  }, []);

  return (
    <>
      {streams.map((s) => {
        const st = containers.current.get(s.streamId);
        if (!st) return null;
        return <primitive key={s.streamId} object={st.group} />;
      })}
    </>
  );
}

// ---- internals ----

interface RenderState {
  cfg: CameraStreamConfig;
  group: Group;
  plane: Mesh;
  frustum: LineSegments;
  stream: CameraStream;
  texture: Texture;
  appliedFovH: number;
  appliedAspect: number;
  appliedDistance: number;
}

function createRenderState(cfg: CameraStreamConfig): RenderState {
  const stream = createCameraStream(cfg.streamId);
  // MJPEG `<img>` updates its decoded pixels in place as new frames
  // arrive in the multipart stream. Three.js doesn't get told about
  // it, so we flip needsUpdate every render frame (in useFrame). It's
  // a re-upload per frame even when no new image data arrived; for
  // 30 fps streams on a 60 fps render loop we double the GPU upload
  // rate. Acceptable; if it ever bites we'll throttle via timestamp.
  const texture = new Texture(stream.image);
  texture.colorSpace = "srgb";
  texture.needsUpdate = true;

  const group = new Group();

  // Plane geometry XY, normal +Z by default. Move it to local +X (in
  // front of the optical center) and orient with lookAt back toward
  // origin so the image faces the camera-frame origin.
  const planeGeom = new PlaneGeometry(1, 1);
  const planeMat = new MeshBasicMaterial({
    map: texture,
    side: DoubleSide,
    transparent: true,
    opacity: cfg.opacity ?? 1,
    toneMapped: false,
    depthWrite: false, // so transparent overlay doesn't occlude lidar
  });
  const plane = new Mesh(planeGeom, planeMat);
  plane.frustumCulled = false;
  plane.position.set(cfg.previewDistance ?? 1.0, 0, 0);
  plane.up.set(0, 0, 1);
  plane.lookAt(0, 0, 0);

  const frustum = new LineSegments(
    new BufferGeometry(),
    new LineBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.7 }),
  );
  frustum.frustumCulled = false;

  group.add(plane);
  group.add(frustum);

  return {
    cfg,
    group,
    plane,
    frustum,
    stream,
    texture,
    appliedFovH: NaN,
    appliedAspect: NaN,
    appliedDistance: NaN,
  };
}

function resizePlane(st: RenderState): void {
  const fovH = st.cfg.fovHDeg ?? 90;
  const aspect = st.cfg.aspect ?? 16 / 9;
  const dist = st.cfg.previewDistance ?? 1.0;
  if (
    fovH === st.appliedFovH &&
    aspect === st.appliedAspect &&
    dist === st.appliedDistance
  ) {
    return;
  }
  // Plane size at distance d (in front of camera): width = 2*d*tan(H-FOV/2)
  const w = 2 * dist * Math.tan((fovH * DEG2RAD) / 2);
  const h = w / aspect;

  st.plane.geometry.dispose();
  st.plane.geometry = new PlaneGeometry(w, h);
  st.plane.position.set(dist, 0, 0);
  st.plane.up.set(0, 0, 1);
  st.plane.lookAt(0, 0, 0);

  // Frustum: 4 spokes from origin to the plane's four corners +
  // 4 edges of the rectangle, all in sensor-local frame.
  // Plane is at local +X = dist with normal -X (faces origin).
  // Image-right (image-X) = sensor +Y; image-up (image-Y) = sensor +Z.
  const halfW = w / 2;
  const halfH = h / 2;
  const corners: [number, number, number][] = [
    [dist, +halfW, +halfH],
    [dist, -halfW, +halfH],
    [dist, -halfW, -halfH],
    [dist, +halfW, -halfH],
  ];
  const verts: number[] = [];
  for (const c of corners) verts.push(0, 0, 0, c[0], c[1], c[2]);
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    verts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  st.frustum.geometry.dispose();
  const fg = new BufferGeometry();
  fg.setAttribute("position", new BufferAttribute(new Float32Array(verts), 3));
  st.frustum.geometry = fg;

  st.appliedFovH = fovH;
  st.appliedAspect = aspect;
  st.appliedDistance = dist;
}

function disposeRenderState(st: RenderState): void {
  try {
    st.stream.close();
  } catch {
    /* already closed */
  }
  st.texture.dispose();
  st.plane.geometry.dispose();
  (st.plane.material as MeshBasicMaterial).dispose();
  st.frustum.geometry.dispose();
  (st.frustum.material as LineBasicMaterial).dispose();
  st.group.clear();
}
