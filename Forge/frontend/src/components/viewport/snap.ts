// Snap-to-feature for joint-mode picking.
//
// On hover, R3F gives us:
//   • event.object       → the leaf Mesh hit (= one CAD face thanks to
//                          cascadio's merge_primitives=False)
//   • event.face         → the specific triangle within that mesh (index a,b,c
//                          plus a face-space normal)
//   • event.eventObject  → the EntityNode <group> that bound onPointerMove
//                          (its descendants are every CAD face of the entity)
//
// We compute snap candidates in WORLD space:
//   • face centers — centroid of every leaf Mesh in the entity's subtree
//                    (one per CAD face)
//   • vertices    — three corners of the hovered triangle
//   • edges       — three edge midpoints of the hovered triangle
//
// pickSnaps returns the full list plus the index of the candidate closest to
// the cursor's actual hit point — that's the "active" candidate the click
// will commit. The popover and renderer use this list to show all options.

import type { ThreeEvent } from "@react-three/fiber";
import { BufferAttribute, BufferGeometry, Mesh, Object3D, Vector3 } from "three";

import type { SnapCandidate, SnapType } from "../../stores/editorStore";

export interface SnapResult {
  candidates: SnapCandidate[];
  activeIndex: number;
}

export function pickSnaps(
  event: ThreeEvent<PointerEvent>,
  entityId: string,
): SnapResult | null {
  if (!event.object) return null;

  const candidates: SnapCandidate[] = [];

  // 1) Face centers: centroid of every leaf Mesh under the listener-bound
  //    EntityNode group (one per CAD face).
  const root = (event.eventObject ?? event.object) as Object3D;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const center = computeMeshCentroid(m);
    if (!center) return;
    const normal = computeMeshAvgNormal(m);
    candidates.push({
      entityId,
      point: [center.x, center.y, center.z],
      normal: [normal.x, normal.y, normal.z],
      type: "face",
    });
  });

  // 2) Hovered triangle's 3 vertices and 3 edge midpoints.
  if (event.face) {
    const obj = event.object as Mesh;
    const geom = obj.geometry as BufferGeometry | undefined;
    const positions = geom?.getAttribute("position") as BufferAttribute | undefined;
    if (positions) {
      const a = new Vector3()
        .fromBufferAttribute(positions, event.face.a)
        .applyMatrix4(obj.matrixWorld);
      const b = new Vector3()
        .fromBufferAttribute(positions, event.face.b)
        .applyMatrix4(obj.matrixWorld);
      const c = new Vector3()
        .fromBufferAttribute(positions, event.face.c)
        .applyMatrix4(obj.matrixWorld);
      const normal = event.face.normal.clone().transformDirection(obj.matrixWorld).normalize();
      const n: [number, number, number] = [normal.x, normal.y, normal.z];

      const push = (type: SnapType, p: Vector3) =>
        candidates.push({ entityId, point: [p.x, p.y, p.z], normal: n, type });
      push("vertex", a);
      push("vertex", b);
      push("vertex", c);
      push("edge", new Vector3().addVectors(a, b).multiplyScalar(0.5));
      push("edge", new Vector3().addVectors(b, c).multiplyScalar(0.5));
      push("edge", new Vector3().addVectors(c, a).multiplyScalar(0.5));
    }
  }

  if (candidates.length === 0) return null;

  // Closest to the cursor's actual hit point — that's the active pick.
  const hit = event.point;
  let activeIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i].point;
    const d =
      (p[0] - hit.x) * (p[0] - hit.x) +
      (p[1] - hit.y) * (p[1] - hit.y) +
      (p[2] - hit.z) * (p[2] - hit.z);
    if (d < bestDist) {
      bestDist = d;
      activeIndex = i;
    }
  }
  return { candidates, activeIndex };
}

// ---- per-mesh geometry helpers (cached by matrixWorld signature) ----

const centroidCache = new WeakMap<Mesh, { sig: string; centroid: Vector3 }>();
const normalCache = new WeakMap<Mesh, { sig: string; normal: Vector3 }>();

function computeMeshCentroid(mesh: Mesh): Vector3 | null {
  const geom = mesh.geometry as BufferGeometry | undefined;
  if (!geom) return null;
  const positions = geom.getAttribute("position") as BufferAttribute | undefined;
  if (!positions) return null;

  const sig = matrixSignature(mesh);
  const cached = centroidCache.get(mesh);
  if (cached && cached.sig === sig) return cached.centroid.clone();

  const c = new Vector3();
  const tmp = new Vector3();
  for (let i = 0; i < positions.count; i++) {
    tmp.fromBufferAttribute(positions, i);
    c.add(tmp);
  }
  c.divideScalar(positions.count || 1).applyMatrix4(mesh.matrixWorld);

  centroidCache.set(mesh, { sig, centroid: c.clone() });
  return c;
}

function computeMeshAvgNormal(mesh: Mesh): Vector3 {
  const geom = mesh.geometry as BufferGeometry | undefined;
  const positions = geom?.getAttribute("position") as BufferAttribute | undefined;
  if (!geom || !positions) return new Vector3(0, 0, 1);

  const sig = matrixSignature(mesh);
  const cached = normalCache.get(mesh);
  if (cached && cached.sig === sig) return cached.normal.clone();

  // Average per-triangle normal (works well for planar CAD faces; for curved
  // faces like cylinders this trends toward the face's "general direction").
  const index = geom.getIndex();
  const triCount = index ? index.count / 3 : positions.count / 3;
  const acc = new Vector3();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  const n = new Vector3();
  for (let i = 0; i < triCount; i++) {
    const ia = index ? index.getX(i * 3) : i * 3;
    const ib = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    const ic = index ? index.getX(i * 3 + 2) : i * 3 + 2;
    a.fromBufferAttribute(positions, ia);
    b.fromBufferAttribute(positions, ib);
    c.fromBufferAttribute(positions, ic);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    n.crossVectors(e1, e2);
    if (n.lengthSq() > 1e-12) {
      n.normalize();
      acc.add(n);
    }
  }
  if (acc.lengthSq() < 1e-12) acc.set(0, 0, 1);
  acc.normalize().transformDirection(mesh.matrixWorld).normalize();
  normalCache.set(mesh, { sig, normal: acc.clone() });
  return acc;
}

function matrixSignature(mesh: Mesh): string {
  const e = mesh.matrixWorld.elements;
  return `${mesh.id}:${e[12].toFixed(4)},${e[13].toFixed(4)},${e[14].toFixed(4)}`;
}
