// Transform gizmo. Two behaviors picked from context, unified into one
// centroid handle:
//
//   • If the selected entity sits at the tip of a kinematic chain (has
//     at least one joint ancestor), translate-mode dragging runs IK on
//     each drag tick — chain bends to bring the tip to the handle. (Most
//     CAD/robotics tools work this way.)
//   • Otherwise, dragging mutates the entity's local pose directly and
//     three.js matrix propagation cascades to descendants.
//
// Multi-selection always uses the rigid-body delta path (no per-entity
// IK, since "IK on a multi-selection" is ill-defined).
//
// The handle sits at the world-space center of the selection's bounding
// box (so the gizmo is on the visible part, not at the link's local
// origin which can be far away after a CAD import).
//
// On release, every entity that was rewritten gets a single PATCH so the
// change is undoable via the command stack.

import { TransformControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import { Box3, Matrix4, Object3D, Vector3 } from "three";

import { api } from "../../api/client";
import { useScene, useUpdateComponent } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";

import { findIkBase, hasMovableJointInChain } from "./ikChain";

interface Props {
  mode: "translate" | "rotate";
}

const IK_THROTTLE_MS = 30;

function findEntityObject(scene: Object3D, eid: string): Object3D | null {
  let found: Object3D | null = null;
  scene.traverse((obj) => {
    if (!found && obj.userData?.entity_id === eid) found = obj;
  });
  return found;
}

function selectionCentroid(scene: Object3D, ids: string[]): Vector3 | null {
  const aggregate = new Box3();
  let foundBox = false;
  const originSum = new Vector3();
  let originCount = 0;
  const tmp = new Vector3();
  for (const eid of ids) {
    const obj = findEntityObject(scene, eid);
    if (!obj) continue;
    obj.updateMatrixWorld(true);
    const box = new Box3().setFromObject(obj);
    if (!box.isEmpty() && Number.isFinite(box.min.x) && Number.isFinite(box.max.x)) {
      aggregate.union(box);
      foundBox = true;
    }
    tmp.setFromMatrixPosition(obj.matrixWorld);
    originSum.add(tmp);
    originCount++;
  }
  if (foundBox && !aggregate.isEmpty()) {
    const c = new Vector3();
    aggregate.getCenter(c);
    return c;
  }
  if (originCount > 0) return originSum.divideScalar(originCount);
  return null;
}

export function TransformGizmo({ mode }: Props) {
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const setJointValue = useEditorStore((s) => s.setJointValue);
  const sceneQ = useScene();
  const update = useUpdateComponent();
  const { scene } = useThree();

  const [target, setTarget] = useState<Object3D | null>(null);
  const handleRef = useRef<Object3D | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // For rigid-body drag (no IK).
  const handleStartWorld = useRef<Matrix4>(new Matrix4());
  const startSnapshots = useRef<Map<string, Matrix4>>(new Map());

  // For IK drag.
  const ikInflightRef = useRef(false);
  const ikLastSentAtRef = useRef(0);
  const ikQueuedRef = useRef<[number, number, number] | null>(null);

  // Decide IK vs rigid-body based on selection.
  const ikActive =
    mode === "translate" &&
    selectedIds.length === 1 &&
    Boolean(sceneQ.data) &&
    hasMovableJointInChain(sceneQ.data!.entities, selectedIds[0]);

  const tipId = ikActive ? selectedIds[0] : null;
  const baseId =
    ikActive && tipId && sceneQ.data ? findIkBase(sceneQ.data.entities, tipId) : null;

  // Place the handle.
  //
  //   • IK active   → handle at the tip's local origin in world. IK target
  //                   = handle.position directly (no offset math).
  //   • Otherwise   → handle at the selection's visible centroid (rigid
  //                   translate / rotate users want the gizmo on the part).
  useEffect(() => {
    setTarget(null);
    if (selectedIds.length === 0 || !handleRef.current) return;
    let placement: Vector3 | null = null;
    if (ikActive && tipId) {
      const tipObj = findEntityObject(scene, tipId);
      if (tipObj) {
        tipObj.updateMatrixWorld(true);
        placement = new Vector3().setFromMatrixPosition(tipObj.matrixWorld);
      }
    }
    if (!placement) {
      placement = selectionCentroid(scene, selectedIds);
    }
    if (!placement) return;
    handleRef.current.position.copy(placement);
    handleRef.current.quaternion.set(0, 0, 0, 1);
    handleRef.current.scale.set(1, 1, 1);
    handleRef.current.updateMatrixWorld(true);
    setTarget(handleRef.current);
  }, [selectedIds, scene, sceneQ.dataUpdatedAt, ikActive, tipId]);

  if (selectedIds.length === 0) return null;
  if (!target) return <object3D ref={handleRef} />;

  // ---------- IK drag path ----------

  const sendIK = async (targetWorld: [number, number, number]) => {
    if (!tipId || !baseId || tipId === baseId) return;
    ikInflightRef.current = true;
    ikLastSentAtRef.current = performance.now();
    try {
      const ed = useEditorStore.getState();
      const seed = ed.jointValues;
      const resp = await api.ik({
        base: baseId,
        tip: tipId,
        target_world: targetWorld,
        initial_joint_values: seed,
        max_iter: 20,
        damping: 0.03,
        check_collisions: ed.collisionCheck,
      });
      for (const [jid, v] of Object.entries(resp.joint_values)) {
        setJointValue(jid, v);
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
      setStatus(
        `IK ${resp.converged ? "✓" : "≈"} · ${Object.keys(resp.joint_values).length} joints · err ${(resp.residual * 1000).toFixed(1)} mm${colTag}`,
      );
    } catch (e) {
      setStatus(`IK error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      ikInflightRef.current = false;
      const queued = ikQueuedRef.current;
      ikQueuedRef.current = null;
      if (queued) sendIK(queued);
    }
  };

  // ---------- Drag handlers ----------

  const onMouseDown = () => {
    if (!handleRef.current) return;
    if (ikActive) {
      // No snapshots needed for IK: handle.position is already the target.
      return;
    }
    // Rigid-body path: snapshot every selected entity's start world matrix.
    handleRef.current.updateMatrixWorld(true);
    handleStartWorld.current.copy(handleRef.current.matrixWorld);
    startSnapshots.current.clear();
    for (const eid of selectedIds) {
      const obj = findEntityObject(scene, eid);
      if (!obj) continue;
      obj.updateMatrixWorld(true);
      startSnapshots.current.set(eid, obj.matrixWorld.clone());
    }
  };

  const onObjectChange = () => {
    if (!handleRef.current) return;

    if (ikActive) {
      // The handle is anchored at the tip's local origin (in world); its
      // current position is the IK target directly.
      const p = handleRef.current.position;
      const t: [number, number, number] = [p.x, p.y, p.z];
      if (ikInflightRef.current) {
        ikQueuedRef.current = t;
        return;
      }
      const elapsed = performance.now() - ikLastSentAtRef.current;
      if (elapsed < IK_THROTTLE_MS) {
        ikQueuedRef.current = t;
        setTimeout(() => {
          const q = ikQueuedRef.current;
          ikQueuedRef.current = null;
          if (q && !ikInflightRef.current) sendIK(q);
        }, IK_THROTTLE_MS - elapsed);
        return;
      }
      sendIK(t);
      return;
    }

    // Rigid-body delta: apply to each entity.
    handleRef.current.updateMatrixWorld(true);
    const delta = new Matrix4().copy(handleStartWorld.current).invert();
    delta.premultiply(handleRef.current.matrixWorld);
    for (const eid of selectedIds) {
      const oldWorld = startSnapshots.current.get(eid);
      if (!oldWorld) continue;
      const obj = findEntityObject(scene, eid);
      if (!obj) continue;
      const newWorld = oldWorld.clone().premultiply(delta);
      const parent = obj.parent;
      const parentInv = new Matrix4();
      if (parent) {
        parent.updateMatrixWorld(true);
        parentInv.copy(parent.matrixWorld).invert();
      }
      const newLocal = parentInv.multiply(newWorld);
      newLocal.decompose(obj.position, obj.quaternion, obj.scale);
    }
  };

  const onMouseUp = () => {
    if (ikActive) {
      // IK already pushed joint values into the store on every tick;
      // joint values are runtime state (not persisted). No PATCH needed.
      return;
    }
    // Rigid: PATCH each entity's new local pose.
    for (const eid of selectedIds) {
      const obj = findEntityObject(scene, eid);
      if (!obj) continue;
      const updates: Record<string, unknown> =
        mode === "translate"
          ? { position: [obj.position.x, obj.position.y, obj.position.z] }
          : {
              rotation: [
                obj.quaternion.x,
                obj.quaternion.y,
                obj.quaternion.z,
                obj.quaternion.w,
              ],
            };
      update.mutate({ entityId: eid, key: "transform", updates });
    }
  };

  return (
    <>
      <object3D ref={handleRef} />
      <TransformControls
        object={target}
        mode={mode}
        size={0.6}
        onMouseDown={onMouseDown}
        onObjectChange={onObjectChange}
        onMouseUp={onMouseUp}
      />
      <GizmoStatus active={ikActive} status={status} />
    </>
  );
}

function GizmoStatus({
  active,
  status,
}: {
  active: boolean;
  status: string | null;
}) {
  // Pushes the active mode + last status string into the editor store so
  // the viewport's HUD strip can render it. The HUD lives outside the
  // R3F canvas so we can't render DOM here directly.
  useEffect(() => {
    useEditorStore.getState().setIkStatus(active ? status : null);
  }, [active, status]);
  return null;
}
