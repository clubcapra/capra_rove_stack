// Edit a quaternion (xyzw) via roll/pitch/yaw inputs in degrees.
//
// Conversion convention matches the URDF/ROS RPY ↔ quaternion math used in
// the backend importer/exporter: quat ← Rz(yaw) · Ry(pitch) · Rx(roll).

import { useEffect, useState } from "react";

import type { Quat } from "../../types/model";

import { NumberField } from "./NumberField";

interface Props {
  value: Quat;
  onChange: (q: Quat) => void;
  step?: number; // degrees
}

export function QuaternionInput({ value, onChange, step = 1 }: Props) {
  const [rpy, setRpy] = useState<[number, number, number]>(quatToRpyDeg(value));

  // Stay in sync with external value changes (e.g. backend updates after gizmo drag).
  useEffect(() => {
    setRpy(quatToRpyDeg(value));
  }, [value[0], value[1], value[2], value[3]]);

  const commit = (next: [number, number, number]) => {
    setRpy(next);
    onChange(rpyDegToQuat(next));
  };

  return (
    <div className="grid grid-cols-3 gap-1">
      <NumberField
        label="r"
        value={rpy[0]}
        step={step}
        onCommit={(v) => commit([v, rpy[1], rpy[2]])}
      />
      <NumberField
        label="p"
        value={rpy[1]}
        step={step}
        onCommit={(v) => commit([rpy[0], v, rpy[2]])}
      />
      <NumberField
        label="y"
        value={rpy[2]}
        step={step}
        onCommit={(v) => commit([rpy[0], rpy[1], v])}
      />
    </div>
  );
}

// ---- conversion helpers (deg ↔ quat) ----

function rpyDegToQuat([rDeg, pDeg, yDeg]: [number, number, number]): Quat {
  const r = (rDeg * Math.PI) / 180;
  const p = (pDeg * Math.PI) / 180;
  const y = (yDeg * Math.PI) / 180;
  const cy = Math.cos(y * 0.5);
  const sy = Math.sin(y * 0.5);
  const cp = Math.cos(p * 0.5);
  const sp = Math.sin(p * 0.5);
  const cr = Math.cos(r * 0.5);
  const sr = Math.sin(r * 0.5);
  const w = cr * cp * cy + sr * sp * sy;
  const qx = sr * cp * cy - cr * sp * sy;
  const qy = cr * sp * cy + sr * cp * sy;
  const qz = cr * cp * sy - sr * sp * cy;
  return [qx, qy, qz, w];
}

function quatToRpyDeg(q: Quat): [number, number, number] {
  const [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w) || 1;
  const xn = x / n,
    yn = y / n,
    zn = z / n,
    wn = w / n;
  const sinr = 2 * (wn * xn + yn * zn);
  const cosr = 1 - 2 * (xn * xn + yn * yn);
  const roll = Math.atan2(sinr, cosr);
  let pitch: number;
  const sinp = 2 * (wn * yn - zn * xn);
  if (Math.abs(sinp) >= 1) pitch = (Math.PI / 2) * Math.sign(sinp);
  else pitch = Math.asin(sinp);
  const siny = 2 * (wn * zn + xn * yn);
  const cosy = 1 - 2 * (yn * yn + zn * zn);
  const yaw = Math.atan2(siny, cosy);
  return [(roll * 180) / Math.PI, (pitch * 180) / Math.PI, (yaw * 180) / Math.PI];
}
