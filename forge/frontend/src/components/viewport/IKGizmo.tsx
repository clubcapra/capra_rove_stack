import { TransformControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import { Matrix4, Object3D, Quaternion, Vector3 } from "three";

import { api } from "../../api/client";
import { useIkProfiles, useScene } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";

import { countMovableJoints, findIkBase } from "./ikChain";
import { entityCentroid, findEntityObject } from "./sceneUtils";

const THROTTLE_MS = 30;

const DEBUG_LOG = false;
function dlog(tag: string, payload: Record<string, unknown>) {
  if (!DEBUG_LOG) return;
  fetch("/api/v1/debug/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag, ...payload }),
  }).catch(() => {});
}

// Defaults used when no tuned profile exists for the chain. Jog-friendly,
// with a per-call cap on total joint motion so the chain catches up
// smoothly instead of exploding from a singular start. The mode flips
// based on which gizmo started the drag:
//
//   translate-drag → pose_locked  (orientation hard-locked; position
//                                   catches up over multiple calls)
//   rotate-drag    → pos_primary  (position hard-locked via task-priority
//                                   IK; orientation tracks what's
//                                   geometrically achievable in the null
//                                   space of position — i.e. "rotate in
//                                   place" wherever the chain allows it)
//
// This split fixes the "rotate translates the EE" bug for non-spherical
// wrist arms: with pose_locked, an rx/rz rotation could swing the EE
// 50-150mm because the chain has no way to pivot around the EE without
// translating. pos_primary stops that — the EE doesn't fully reach the
// requested orientation but it doesn't fly across the room either.
//
// Run "Train IK" from the Pose menu for per-arm tuned profiles.
const DEFAULT_REST_POSE_GAIN = 0.30;
const DEFAULT_ORIENT_WEIGHT = 5.0;
const DEFAULT_DAMPING = 0.05;
const DEFAULT_MAX_ITER = 60;
const DEFAULT_MAX_DQ_STEP = 0.05;
const DEFAULT_MAX_POS_STEP = 0.05;
const DEFAULT_MAX_TOTAL_DQ_STEP = 0.10;
const DEFAULT_TRANSLATE_MODE = "pose_locked" as const;
const DEFAULT_ROTATE_MODE = "pos_primary" as const;
const DEFAULT_ROTATE_OSG = 4.0;

interface PoseTarget {
  pos: [number, number, number];
  rot: [number, number, number, number];
}

function isEndEffectorTip(
  entities: Record<string, { children?: string[]; components?: { joint?: { type: string } } }>,
  tipId: string,
): boolean {
  const stack: string[] = [tipId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const e = entities[cur];
    if (!e) continue;
    for (const childId of e.children ?? []) {
      const child = entities[childId];
      if (!child) continue;
      const j = child.components?.joint;
      if (j && j.type !== "fixed") return false;
      stack.push(childId);
    }
  }
  return true;
}

function stepTowardPose(
  from: Matrix4,
  to: Matrix4,
  maxLinear: number,
  maxAngular: number,
): Matrix4 {
  const fp = new Vector3();
  const fq = new Quaternion();
  const fs = new Vector3();
  from.decompose(fp, fq, fs);
  const tp = new Vector3();
  const tq = new Quaternion();
  const ts = new Vector3();
  to.decompose(tp, tq, ts);

  const delta = tp.clone().sub(fp);
  const linDist = delta.length();
  let linT = 1;
  if (linDist > maxLinear) linT = maxLinear / linDist;
  const stepP = fp.clone().add(delta.multiplyScalar(linT));

  const dot = Math.min(1, Math.abs(fq.dot(tq)));
  const angDist = 2 * Math.acos(dot);
  let angT = 1;
  if (angDist > maxAngular) angT = maxAngular / angDist;
  const stepQ = fq.clone().slerp(tq, angT);

  const out = new Matrix4();
  out.compose(stepP, stepQ, fs);
  return out;
}

export function IKGizmo() {
  const selectedId = useEditorStore((s) => s.selectedId);
  const setJointValue = useEditorStore((s) => s.setJointValue);
  const subMode = useEditorStore((s) => s.ikGizmoSubMode);
  const sceneQ = useScene();
  const profilesQ = useIkProfiles();
  const { scene } = useThree();

  const handleRef = useRef<Object3D | null>(null);
  const [target, setTarget] = useState<Object3D | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [boundaryMarker, setBoundaryMarker] = useState<{
    pos: [number, number, number];
    distance: number;
  } | null>(null);

  const inflightRef = useRef(false);
  const lastSentAtRef = useRef(0);
  const queuedRef = useRef<PoseTarget | null>(null);

  const tipFromHandleRef = useRef<Matrix4>(new Matrix4());

  const dragStartJointValuesRef = useRef<Record<string, number> | null>(null);
  // Which gizmo started the drag — flips the IK mode (see top-of-file note).
  const dragModeRef = useRef<"translate" | "rotate" | null>(null);
  // Link's drag-start world position. Rotate-mode IK keeps the TCP pinned
  // to this point (set to the centroid at drag-start) so the gripper
  // pivots around itself instead of swinging on a 1.4m arc.
  const dragStartCentroidRef = useRef<[number, number, number] | null>(null);
  // TCP offset = (centroid - link_pos) expressed in the link's local
  // frame, captured at drag-start. Constant during the drag; sent to the
  // solver so its position task targets the gripper centroid rather than
  // the link origin.
  const tcpOffsetLocalRef = useRef<[number, number, number] | null>(null);

  const tipId = selectedId;
  const baseId = tipId && sceneQ.data ? findIkBase(sceneQ.data.entities, tipId) : null;
  const isLeafTip =
    tipId && sceneQ.data ? isEndEffectorTip(sceneQ.data.entities, tipId) : false;
  // Chains shorter than 6 DOFs can't satisfy a 6-DOF pose (3 position +
  // 3 orientation). For these (typical for flippers, drums — single
  // revolute joint), TCP-offset rotate IK locks them in place because
  // pos_primary holds position too tightly relative to the available
  // joint freedom. Fall back to direct-link rotate IK so the joint
  // can actually move.
  const chainDof =
    tipId && sceneQ.data ? countMovableJoints(sceneQ.data.entities, tipId) : 0;
  const useTcpOffset = chainDof >= 3;

  useEffect(() => {
    setTarget(null);
    if (!tipId || !handleRef.current || !sceneQ.data) return;
    const tipObj = findEntityObject(scene, tipId);
    if (!tipObj) return;
    tipObj.updateMatrixWorld(true);

    // Anchor: long chains use the mesh centroid (visual EE), short
    // chains use the parent joint world position (the actual rotation
    // axis). See `handleAnchor()` for details.
    let anchor = entityCentroid(scene, tipId);
    if (chainDof < 3) {
      const tipE = sceneQ.data.entities[tipId];
      const parentJointId = tipE?.parent;
      if (parentJointId) {
        const parentE = sceneQ.data.entities[parentJointId];
        const isJoint = parentE && (parentE.components as { joint?: unknown })?.joint;
        if (isJoint) {
          const jointObj = findEntityObject(scene, parentJointId);
          if (jointObj) {
            jointObj.updateMatrixWorld(true);
            anchor = new Vector3().setFromMatrixPosition(jointObj.matrixWorld);
          }
        }
      }
    }
    if (!anchor) return;

    const tipQuat = new Quaternion();
    tipObj.matrixWorld.decompose(new Vector3(), tipQuat, new Vector3());

    handleRef.current.position.copy(anchor);
    handleRef.current.quaternion.copy(tipQuat);
    handleRef.current.scale.set(1, 1, 1);
    handleRef.current.updateMatrixWorld(true);

    tipFromHandleRef.current
      .copy(handleRef.current.matrixWorld)
      .invert()
      .multiply(tipObj.matrixWorld);

    setTarget(handleRef.current);
  }, [tipId, scene, sceneQ.dataUpdatedAt, sceneQ.data]);

  if (!tipId || !baseId) return <object3D ref={handleRef} />;
  if (baseId === tipId) return <object3D ref={handleRef} />;

  const sendIK = async (t: PoseTarget) => {
    inflightRef.current = true;
    lastSentAtRef.current = performance.now();
    try {
      const ed = useEditorStore.getState();
      const restPose = dragStartJointValuesRef.current ?? ed.jointValues;
      // Pull the tuned profile for this base (if one exists). Falls back to
      // jog-friendly defaults — see constants at the top of this file.
      const profile = profilesQ.data?.[baseId];

      const isRotate = subMode === "rotate";
      // Translate sub-mode: pose_locked.
      // Rotate sub-mode + long chain: pos_primary + TCP offset (pivot
      // around gripper centroid).
      // Rotate sub-mode + short chain (flippers, drums — 1-2 DOF): also
      // pose_locked, since pos_primary would lock the only joint
      // available; we want orientation to drive the joint.
      const mode = isRotate && useTcpOffset
        ? DEFAULT_ROTATE_MODE
        : (profile?.mode ?? DEFAULT_TRANSLATE_MODE);
      const osg = isRotate && useTcpOffset
        ? DEFAULT_ROTATE_OSG
        : (profile?.orientation_secondary_gain ?? 0.5);

      const callIK = () =>
        api.ik({
          base: baseId,
          tip: tipId,
          target_world: t.pos,
          // Always feed the full pose target on a leaf tip; the solver mode
          // decides how to weight orientation.
          target_rotation: isLeafTip ? t.rot : undefined,
          initial_joint_values: ed.jointValues,
          rest_pose: restPose,
          rest_pose_gain: profile?.rest_pose_gain ?? DEFAULT_REST_POSE_GAIN,
          joint_weight_strength:
            profile?.joint_weight_strength ?? (isLeafTip ? 0.0 : 1.0),
          max_iter: profile?.max_iter ?? DEFAULT_MAX_ITER,
          damping: profile?.damping ?? DEFAULT_DAMPING,
          orientation_weight: profile?.orientation_weight ?? DEFAULT_ORIENT_WEIGHT,
          mode,
          orientation_secondary_gain: osg,
          max_dq_step: profile?.max_dq_step ?? DEFAULT_MAX_DQ_STEP,
          max_pos_step: profile?.max_pos_step ?? DEFAULT_MAX_POS_STEP,
          max_total_dq_step:
            profile?.max_total_dq_step ?? DEFAULT_MAX_TOTAL_DQ_STEP,
          // Rotate-mode: tell the solver the position target is the
          // gripper centroid (TCP), so the chain pivots around the
          // visible gripper instead of around the link origin. Skip
          // for short chains (< 3 DOF, e.g. flippers) where pos_primary
          // would lock the joint instead of letting it drive the
          // rotation.
          tcp_offset_local:
            isRotate && useTcpOffset && tcpOffsetLocalRef.current
              ? tcpOffsetLocalRef.current
              : undefined,
          check_collisions: ed.collisionCheck,
          respect_collisions: ed.collisionCheck,
        });

      dlog("ik_send", {
        mode,
        sub_mode: subMode,
        target_pos: t.pos,
        target_rot: t.rot,
        osg,
      });
      const resp = await callIK();
      dlog("ik_resp", {
        mode,
        pos_res_mm: resp.pos_residual * 1000,
        rot_res_deg: (resp.rot_residual * 180) / Math.PI,
        iterations: resp.iterations,
        converged: resp.converged,
      });
      for (const [jid, v] of Object.entries(resp.joint_values)) {
        if (Number.isFinite(v)) setJointValue(jid, v);
      }
      if (ed.collisionCheck) {
        const ids = new Set<string>();
        for (const p of resp.collisions) {
          ids.add(p.a);
          ids.add(p.b);
        }
        ed.setCollidingIds(Array.from(ids));
      }
      const colTag = ed.collisionCheck
        ? ` · ${resp.collisions.length} coll`
        : "";
      const posM = Number.isFinite(resp.pos_residual)
        ? resp.pos_residual
        : resp.residual;
      const rotR = Number.isFinite(resp.rot_residual) ? resp.rot_residual : 0;
      const posMm = posM * 1000;
      const rotDeg = (rotR * 180) / Math.PI;
      const posStr =
        posMm < 1 ? `${posMm.toFixed(2)} mm` : `${posMm.toFixed(1)} mm`;
      const rotStr = isLeafTip ? ` · ${rotDeg.toFixed(2)}°` : "";
      setStatus(
        `IK ${resp.converged ? "✓" : "≈"} · ${Object.keys(resp.joint_values).length} joints · ${posStr}${rotStr}${colTag}`,
      );

      if (resp.pos_residual > 0.03) {
        const tipObj = findEntityObject(scene, tipId);
        if (tipObj) {
          tipObj.updateMatrixWorld(true);
          const eePos = new Vector3().setFromMatrixPosition(tipObj.matrixWorld);
          const dragPos = new Vector3(...t.pos);
          setBoundaryMarker({
            pos: [eePos.x, eePos.y, eePos.z],
            distance: eePos.distanceTo(dragPos),
          });
        }
      } else {
        setBoundaryMarker(null);
      }
    } catch (e) {
      setStatus(`IK error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inflightRef.current = false;
      const queued = queuedRef.current;
      queuedRef.current = null;
      if (queued) sendIK(queued);
    }
  };

  // Anchor point for the gizmo. Long chains (≥ 3 DOFs, e.g. arm) use the
  // mesh centroid so the rotate gizmo pivots around the gripper visual.
  // Short chains (1-2 DOFs, e.g. flippers) use the parent joint's world
  // position — that's the actual rotation axis, so the gizmo aligns with
  // what the joint can physically do.
  const handleAnchor = (): Vector3 | null => {
    if (!tipId || !sceneQ.data) return null;
    if (chainDof < 3) {
      const tipE = sceneQ.data.entities[tipId];
      const parentJointId = tipE?.parent;
      if (parentJointId) {
        const parentE = sceneQ.data.entities[parentJointId];
        const isJoint = parentE && (parentE.components as { joint?: unknown })?.joint;
        if (isJoint) {
          const jointObj = findEntityObject(scene, parentJointId);
          if (jointObj) {
            jointObj.updateMatrixWorld(true);
            return new Vector3().setFromMatrixPosition(jointObj.matrixWorld);
          }
        }
      }
    }
    return entityCentroid(scene, tipId);
  };

  // Re-snap the gizmo handle to its anchor + tip rotation, recomputing
  // tipFromHandle as inverse(handle) * tip (the constant anchor→link
  // offset). Used at drag-start and drag-end.
  const placeHandleAtCentroid = () => {
    if (!handleRef.current || !tipId || !sceneQ.data) return;
    const tipObj = findEntityObject(scene, tipId);
    if (!tipObj) return;
    tipObj.updateMatrixWorld(true);
    const anchor = handleAnchor();
    if (!anchor) return;
    const tipQuat = new Quaternion();
    tipObj.matrixWorld.decompose(new Vector3(), tipQuat, new Vector3());
    handleRef.current.position.copy(anchor);
    handleRef.current.quaternion.copy(tipQuat);
    handleRef.current.updateMatrixWorld(true);
    tipFromHandleRef.current
      .copy(handleRef.current.matrixWorld)
      .invert()
      .multiply(tipObj.matrixWorld);
  };

  const onDragStart = (mode: "translate" | "rotate") => () => {
    dragStartJointValuesRef.current = { ...useEditorStore.getState().jointValues };
    dragModeRef.current = mode;
    placeHandleAtCentroid();
    dragStartCentroidRef.current = null;
    tcpOffsetLocalRef.current = null;
    if (handleRef.current) {
      handleRef.current.updateMatrixWorld(true);
      const hp = new Vector3();
      const hq = new Quaternion();
      handleRef.current.matrixWorld.decompose(hp, hq, new Vector3());
      const tipObj = tipId ? findEntityObject(scene, tipId) : null;
      let tipPos: number[] | null = null;
      let tipRot: number[] | null = null;
      if (tipObj) {
        tipObj.updateMatrixWorld(true);
        const tp = new Vector3();
        const tq = new Quaternion();
        tipObj.matrixWorld.decompose(tp, tq, new Vector3());
        tipPos = [tp.x, tp.y, tp.z];
        tipRot = [tq.x, tq.y, tq.z, tq.w];
        // TCP target = the gizmo's world position at drag-start (= centroid).
        dragStartCentroidRef.current = [hp.x, hp.y, hp.z];
        // TCP offset in link's LOCAL frame = link_R^-1 @ (centroid_world - link_pos).
        const offsetWorld = new Vector3(hp.x - tp.x, hp.y - tp.y, hp.z - tp.z);
        const linkRotInv = tq.clone().invert();
        const offsetLocal = offsetWorld.applyQuaternion(linkRotInv);
        tcpOffsetLocalRef.current = [offsetLocal.x, offsetLocal.y, offsetLocal.z];
      }
      const tfh = tipFromHandleRef.current.elements;
      dlog("drag_start", {
        mode,
        handle_pos: [hp.x, hp.y, hp.z],
        handle_rot: [hq.x, hq.y, hq.z, hq.w],
        tip_pos: tipPos,
        tip_rot: tipRot,
        tipFromHandle: Array.from(tfh),
        tcp_offset_local: tcpOffsetLocalRef.current,
        drag_start_centroid: dragStartCentroidRef.current,
      });
    }
  };

  const onDragEnd = () => {
    dlog("drag_end", { mode: dragModeRef.current });
    dragStartJointValuesRef.current = null;
    dragModeRef.current = null;
    dragStartCentroidRef.current = null;
    tcpOffsetLocalRef.current = null;
    setBoundaryMarker(null);
    placeHandleAtCentroid();
  };

  const onObjectChange = () => {
    if (!handleRef.current || !tipId) return;
    handleRef.current.updateMatrixWorld(true);

    const intentTip = new Matrix4()
      .copy(handleRef.current.matrixWorld)
      .multiply(tipFromHandleRef.current);

    const tipObj = findEntityObject(scene, tipId);
    let targetTip = intentTip;
    let currentTipPos: number[] | null = null;
    if (tipObj) {
      tipObj.updateMatrixWorld(true);
      const currentTip = tipObj.matrixWorld;
      const cp = new Vector3();
      currentTip.decompose(cp, new Quaternion(), new Vector3());
      currentTipPos = [cp.x, cp.y, cp.z];
      targetTip = stepTowardPose(currentTip, intentTip, 0.05, 0.087);
    }

    const tp = new Vector3();
    const tq = new Quaternion();
    targetTip.decompose(tp, tq, new Vector3());

    const t: PoseTarget = {
      pos: [tp.x, tp.y, tp.z],
      rot: [tq.x, tq.y, tq.z, tq.w],
    };

    // Rotate mode + long chain: target the TCP (= the gripper centroid
    // at drag-start), not the link origin. Combined with the
    // `tcp_offset_local` sent in sendIK, this makes the solver pivot
    // around the visible gripper instead of around the link origin
    // (which can be 1.4m away on cancelling-offset imports).
    // Short-chain rotate (e.g. flippers, single-DOF elements): leave
    // t.pos at the natural intent so pose_locked can move the joint;
    // pinning the position would freeze the only DOF available.
    if (dragModeRef.current === "rotate" && useTcpOffset && dragStartCentroidRef.current) {
      t.pos = [...dragStartCentroidRef.current];
    }

    const hp = new Vector3();
    const hq = new Quaternion();
    handleRef.current.matrixWorld.decompose(hp, hq, new Vector3());
    const ip = new Vector3();
    const iq = new Quaternion();
    intentTip.decompose(ip, iq, new Vector3());
    dlog("on_change", {
      mode: dragModeRef.current,
      handle_pos: [hp.x, hp.y, hp.z],
      handle_rot: [hq.x, hq.y, hq.z, hq.w],
      intent_pos: [ip.x, ip.y, ip.z],
      intent_rot: [iq.x, iq.y, iq.z, iq.w],
      step_pos: t.pos,
      step_rot: t.rot,
      current_tip_pos: currentTipPos,
    });

    if (inflightRef.current) {
      queuedRef.current = t;
      return;
    }
    const elapsed = performance.now() - lastSentAtRef.current;
    if (elapsed < THROTTLE_MS) {
      queuedRef.current = t;
      setTimeout(() => {
        if (inflightRef.current) return;
        const q = queuedRef.current;
        if (!q) return;
        queuedRef.current = null;
        sendIK(q);
      }, THROTTLE_MS - elapsed);
      return;
    }
    sendIK(t);
  };

  return (
    <>
      <object3D ref={handleRef} />
      {target && (
        <>
          {subMode === "translate" && (
            <TransformControls
              object={target}
              mode="translate"
              size={0.7}
              space="world"
              onMouseDown={onDragStart("translate")}
              onMouseUp={onDragEnd}
              onObjectChange={onObjectChange}
            />
          )}
          {subMode === "rotate" && isLeafTip && (
            // Rotate rings live in the END-EFFECTOR's LOCAL frame so that
            // dragging the "X ring" rolls around the gripper's own roll
            // axis (not world X). Without this, rotating around world Z
            // forces the IK to use the base yaw — which swings the whole
            // arm around the chassis instead of spinning the gripper in
            // place.
            <TransformControls
              object={target}
              mode="rotate"
              size={0.7}
              space="local"
              onMouseDown={onDragStart("rotate")}
              onMouseUp={onDragEnd}
              onObjectChange={onObjectChange}
            />
          )}
        </>
      )}
      {boundaryMarker && (
        <mesh position={boundaryMarker.pos}>
          <sphereGeometry args={[0.025, 16, 12]} />
          <meshBasicMaterial color="#fb923c" transparent opacity={0.7} />
        </mesh>
      )}
      <IkStatusReporter status={status} />
    </>
  );
}

function IkStatusReporter({ status }: { status: string | null }) {
  useEffect(() => {
    useEditorStore.getState().setIkStatus(status);
  }, [status]);
  return null;
}
