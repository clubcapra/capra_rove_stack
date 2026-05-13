// Client-side hierarchical scene renderer.
//
// Renders entities as a tree: each EntityNode applies its local transform
// (from `transform` component) and, if it's a joint, an additional joint
// offset based on the live slider value in `editorStore.jointValues`.
// THREE's matrix propagation gives us world transforms automatically, so
// the transform gizmo and joint sliders update without backend round-trips.
//
// Backend FK is no longer required for rendering (it's still used by API
// consumers; this just makes the editor feel native).

import type { ThreeEvent } from "@react-three/fiber";
import { useMemo } from "react";

import { useScene } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";
import type {
  Entity,
  Geometry,
  JointComponent,
  JointType,
  TransformComponent,
  Vec3,
} from "../../types/model";

import { categoryColor, getCategory } from "../panels/category";

import { pickSnaps } from "./snap";
import { meshToObject, useMesh } from "./useMesh";

export function SceneRenderer() {
  const sceneQ = useScene();
  if (!sceneQ.data) return null;
  const entities = sceneQ.data.entities;
  const rootIds = Object.keys(entities).filter((eid) => !entities[eid].parent);
  return (
    <group>
      {rootIds.map((eid) => (
        <EntityNode key={eid} eid={eid} entities={entities} />
      ))}
    </group>
  );
}

interface NodeProps {
  eid: string;
  entities: Record<string, Entity>;
}

function EntityNode({ eid, entities }: NodeProps) {
  const entity = entities[eid];
  const transform = entity?.components?.transform as TransformComponent | undefined;
  const joint = entity?.components?.joint as JointComponent | undefined;
  const link = entity?.components?.link;
  const select = useEditorStore((s) => s.select);
  const toggleSelect = useEditorStore((s) => s.toggleSelect);
  const addJointPick = useEditorStore((s) => s.addJointPick);
  const setSnap = useEditorStore((s) => s.setSnap);
  const clearSnap = useEditorStore((s) => s.clearSnap);
  const isSelected = useEditorStore((s) => s.selectedIds.includes(eid));
  const isHidden = useEditorStore((s) => s.hiddenIds.includes(eid));
  const isColliding = useEditorStore((s) => s.collidingIds.includes(eid));
  const gizmoMode = useEditorStore((s) => s.gizmoMode);
  const showCollisions = useEditorStore((s) => s.showCollisions);
  const jointValue = useEditorStore((s) =>
    joint && joint.type !== "fixed" ? s.jointValues[eid] ?? 0 : 0,
  );

  const tPos = (transform?.position ?? [0, 0, 0]) as Vec3;
  const tRot = transform?.rotation ?? [0, 0, 0, 1];
  const tScale = transform?.scale ?? [1, 1, 1];

  // The joint offset (revolute angle or prismatic distance) is applied
  // *after* the static transform: parent -> [transform] -> [joint offset]
  // -> visuals + children.
  const jointOffset = useMemo(() => {
    if (!joint || joint.type === "fixed") return null;
    return computeJointOffset(joint.type, joint.axis, jointValue);
  }, [joint?.type, joint?.axis, jointValue]);

  if (!entity) return null;
  if (isHidden) return null; // hide whole subtree

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (gizmoMode === "joint") {
      // Use the active snap (closest candidate from pointer-move) if present;
      // otherwise fall back to the raw cursor hit.
      const { snapCandidates, activeSnapIndex } = useEditorStore.getState();
      const active =
        activeSnapIndex >= 0 && activeSnapIndex < snapCandidates.length
          ? snapCandidates[activeSnapIndex]
          : null;
      if (active && active.entityId === eid) {
        addJointPick({ entityId: active.entityId, point: active.point, normal: active.normal });
      } else {
        const point = e.point;
        let normal: [number, number, number] = [0, 0, 1];
        if (e.face && e.object) {
          const n = e.face.normal.clone();
          n.transformDirection(e.object.matrixWorld);
          normal = [n.x, n.y, n.z];
        }
        addJointPick({
          entityId: eid,
          point: [point.x, point.y, point.z],
          normal,
        });
      }
      clearSnap();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      toggleSelect(eid);
    } else {
      select(eid);
    }
  };

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (gizmoMode !== "joint") return;
    e.stopPropagation();
    const result = pickSnaps(e, eid);
    if (result) setSnap(result.candidates, result.activeIndex);
  };

  const handlePointerOut = () => {
    if (gizmoMode !== "joint") return;
    // Only clear if the snap belongs to this entity (otherwise we'd race
    // a sibling's pointer-move).
    const { snapCandidates } = useEditorStore.getState();
    if (snapCandidates.length > 0 && snapCandidates[0].entityId === eid) clearSnap();
  };

  const geoms = link ? (showCollisions ? link.collisions : link.visuals) : [];
  const tint = isColliding ? "#ef4444" : categoryColor(getCategory(entity));
  const innards = (
    <>
      <Geoms geoms={geoms} selected={isSelected} tint={tint} />
      {entity.children?.map((cid) => (
        <EntityNode key={cid} eid={cid} entities={entities} />
      ))}
    </>
  );

  return (
    <group
      position={tPos}
      quaternion={tRot}
      scale={tScale}
      userData={{ entity_id: eid, name: entity.name }}
      onClick={handleClick}
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
    >
      {jointOffset ? (
        <group position={jointOffset.pos} quaternion={jointOffset.quat}>
          {innards}
        </group>
      ) : (
        innards
      )}
    </group>
  );
}


function Geoms({ geoms, selected, tint }: { geoms: Geometry[]; selected: boolean; tint: string }) {
  if (geoms.length === 0) {
    return (
      <mesh>
        <sphereGeometry args={[0.01, 12, 12]} />
        <meshStandardMaterial color={selected ? "#2dd4bf" : tint} />
      </mesh>
    );
  }
  return (
    <>
      {geoms.map((g, i) => (
        <GeometryMesh key={i} g={g} selected={selected} tint={tint} />
      ))}
    </>
  );
}

function GeometryMesh({
  g,
  selected,
  tint,
}: {
  g: Geometry;
  selected: boolean;
  tint: string;
}) {
  const pos = g.origin ?? [0, 0, 0];
  const quat = g.origin_rotation ?? [0, 0, 0, 1];
  const color = selected ? "#2dd4bf" : tint;

  let inner: React.ReactElement;
  if (g.primitive === "box") {
    const p = g.primitive_params ?? {};
    inner = (
      <mesh castShadow receiveShadow>
        <boxGeometry args={[p.x ?? 1, p.y ?? 1, p.z ?? 1]} />
        <Mat color={color} selected={selected} />
      </mesh>
    );
  } else if (g.primitive === "sphere") {
    inner = (
      <mesh castShadow receiveShadow>
        <sphereGeometry args={[g.primitive_params?.radius ?? 1, 24, 24]} />
        <Mat color={color} selected={selected} />
      </mesh>
    );
  } else if (g.primitive === "cylinder") {
    const r = g.primitive_params?.radius ?? 0.5;
    const l = g.primitive_params?.length ?? 1.0;
    inner = (
      <mesh rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[r, r, l, 32]} />
        <Mat color={color} selected={selected} />
      </mesh>
    );
  } else if (g.mesh) {
    inner = <ExternalMesh stem={g.mesh} selected={selected} tint={tint} />;
  } else {
    inner = (
      <mesh>
        <sphereGeometry args={[0.02, 12, 12]} />
        <Mat color={color} selected={selected} />
      </mesh>
    );
  }

  return (
    <group
      position={pos as [number, number, number]}
      quaternion={[quat[0], quat[1], quat[2], quat[3]]}
    >
      {inner}
    </group>
  );
}

function ExternalMesh({
  stem,
  selected,
  tint,
}: {
  stem: string;
  selected: boolean;
  tint: string;
}) {
  const { object, geometry, loading, error } = useMesh(stem);
  const obj = useMemo(
    () => meshToObject(geometry, object, selected, tint),
    [geometry, object, selected, tint],
  );

  if (loading) {
    return (
      <mesh>
        <boxGeometry args={[0.04, 0.04, 0.04]} />
        <meshBasicMaterial color="#3f3f46" wireframe />
      </mesh>
    );
  }
  if (error || !obj) {
    return (
      <mesh>
        <boxGeometry args={[0.04, 0.04, 0.04]} />
        <meshStandardMaterial color="#7f1d1d" />
      </mesh>
    );
  }
  return <primitive object={obj} />;
}

function Mat({ color, selected }: { color: string; selected: boolean }) {
  return (
    <meshStandardMaterial
      color={color}
      roughness={0.6}
      metalness={selected ? 0.4 : 0.1}
      emissive={selected ? "#0d9488" : "#000000"}
      emissiveIntensity={selected ? 0.25 : 0}
    />
  );
}

// ---------------- joint offset math (axis-angle / translation) ----------------

function computeJointOffset(
  type: JointType,
  axis: Vec3,
  value: number,
): { pos: [number, number, number]; quat: [number, number, number, number] } {
  if (type === "revolute" || type === "continuous") {
    const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const half = value * 0.5;
    const s = Math.sin(half) / n;
    return {
      pos: [0, 0, 0],
      quat: [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)],
    };
  }
  if (type === "prismatic") {
    const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    return {
      pos: [(axis[0] / n) * value, (axis[1] / n) * value, (axis[2] / n) * value],
      quat: [0, 0, 0, 1],
    };
  }
  return { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
}
