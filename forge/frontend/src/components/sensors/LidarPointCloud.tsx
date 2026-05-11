import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  Points,
  PointsMaterial,
  Quaternion,
  Vector3,
} from "three";

import { useLidarFrames } from "../../api/lidarStream";
import { findEntityObject } from "../viewport/sceneUtils";

export interface StreamConfig {
  streamId: string;
  mountEntityId?: string;
  // Sensor broadcast-frame rotation in WORLD frame (degrees, URDF-style
  // intrinsic XYZ — roll, pitch, yaw). Default [0,0,0] = sensor +Z = world +Z.
  // This is *independent* of the mount entity's rotation, which orients
  // the visual mesh (CAD/URDF) and is unrelated to the lidar's data frame.
  mountRpyDeg?: [number, number, number];
  color?: string;
  maxPoints?: number;
}

const DEG2RAD = Math.PI / 180;

export function LidarPointCloud({ streams }: { streams: StreamConfig[] }) {
  const containers = useRef(new Map<string, StreamRenderState>());
  const { scene } = useThree();

  for (const cfg of streams) {
    if (!containers.current.has(cfg.streamId)) {
      const cap = cfg.maxPoints ?? 200_000;
      const positions = new Float32Array(cap * 3);
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(positions, 3));
      geometry.setDrawRange(0, 0);
      const material = new PointsMaterial({
        size: 3.0,
        sizeAttenuation: false,
        color: new Color(cfg.color ?? "#22d3ee"),
      });
      const points = new Points(geometry, material);
      points.frustumCulled = false;
      containers.current.set(cfg.streamId, {
        points,
        positions,
        capacity: cap,
        writeIdx: 0,
        filled: 0,
        mountEntityId: cfg.mountEntityId,
        mountRpyDeg: cfg.mountRpyDeg ?? [0, 0, 0],
      });
    }
  }
  for (const sid of Array.from(containers.current.keys())) {
    if (!streams.find((s) => s.streamId === sid)) {
      const st = containers.current.get(sid)!;
      st.points.geometry.dispose();
      (st.points.material as PointsMaterial).dispose();
      containers.current.delete(sid);
    }
  }

  for (const cfg of streams) {
    const st = containers.current.get(cfg.streamId);
    if (!st) continue;
    st.mountEntityId = cfg.mountEntityId;
    st.mountRpyDeg = cfg.mountRpyDeg ?? [0, 0, 0];
    if (cfg.color) (st.points.material as PointsMaterial).color.set(cfg.color);
  }

  // The lidar's broadcast frame is *not* the mount entity's frame: the
  // entity's quaternion orients the visual mesh (CAD/URDF), while the
  // sensor's data frame is fixed by the manufacturer. Applying the
  // entity rotation to point data tilts the floor and breaks the scan
  // cone. So: take only the entity's world *position*, and use the
  // binding's mount_rpy_deg as the data-frame rotation in world frame.
  // Default mount_rpy_deg [0,0,0] = sensor +Z aligned with world +Z.
  const tmpPos = useRef(new Vector3());
  const tmpQuat = useRef(new Quaternion());
  const tmpEuler = useRef(new Euler());
  useFrame(() => {
    for (const st of containers.current.values()) {
      if (!st.mountEntityId) continue;
      const obj = findEntityObject(scene, st.mountEntityId);
      if (!obj) continue;
      obj.updateMatrixWorld(true);
      tmpPos.current.setFromMatrixPosition(obj.matrixWorld);
      const [r, p, y] = st.mountRpyDeg;
      tmpEuler.current.set(r * DEG2RAD, p * DEG2RAD, y * DEG2RAD, "XYZ");
      tmpQuat.current.setFromEuler(tmpEuler.current);
      st.points.position.copy(tmpPos.current);
      st.points.quaternion.copy(tmpQuat.current);
      st.points.scale.set(1, 1, 1);
    }
  });

  useLidarFrames((frame) => {
    const st = containers.current.get(frame.streamId);
    if (!st) return;
    const nPts = frame.xyzi.length / 4;
    if (nPts === 0) return;
    const cap = st.capacity;
    const dst = st.positions;
    let w = st.writeIdx;
    for (let i = 0; i < nPts; i++) {
      const j = i * 4;
      const k = w * 3;
      dst[k] = frame.xyzi[j];
      dst[k + 1] = frame.xyzi[j + 1];
      dst[k + 2] = frame.xyzi[j + 2];
      w = (w + 1) % cap;
    }
    st.writeIdx = w;
    st.filled = Math.min(cap, st.filled + nPts);
    const attr = st.points.geometry.getAttribute("position") as BufferAttribute;
    attr.needsUpdate = true;
    st.points.geometry.setDrawRange(0, st.filled);
  });

  useEffect(() => () => {
    for (const st of containers.current.values()) {
      st.points.geometry.dispose();
      (st.points.material as PointsMaterial).dispose();
    }
    containers.current.clear();
  }, []);

  const list = useMemo(() => streams.map((s) => s.streamId), [streams]);
  return (
    <>
      {list.map((sid) => {
        const st = containers.current.get(sid);
        if (!st) return null;
        return <primitive key={sid} object={st.points} />;
      })}
    </>
  );
}

interface StreamRenderState {
  points: Points;
  positions: Float32Array;
  capacity: number;
  writeIdx: number;
  filled: number;
  mountEntityId?: string;
  mountRpyDeg: [number, number, number];
}
