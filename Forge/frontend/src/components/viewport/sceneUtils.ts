import { Box3, Object3D, Vector3 } from "three";

// Walk the scene graph for the Object3D tagged with this entity_id.
// SceneRenderer stamps userData.entity_id and userData.name on every
// entity root. We accept either match so callers that have a name
// (e.g. a binding persisted before we tightened the entity-ID handling)
// still resolve to the right object.
export function findEntityObject(root: Object3D, key: string): Object3D | null {
  let foundById: Object3D | null = null;
  let foundByName: Object3D | null = null;
  root.traverse((o) => {
    if (!foundById && o.userData?.entity_id === key) foundById = o;
    else if (!foundByName && o.userData?.name === key) foundByName = o;
  });
  return foundById ?? foundByName;
}

// Bounding box in world of meshes that belong to *this* entity only —
// children that are themselves entities are excluded so we don't pull
// in downstream links. Returns null if the entity has no mesh geometry.
export function entityOwnBox(scene: Object3D, eid: string): Box3 | null {
  const root = findEntityObject(scene, eid);
  if (!root) return null;
  root.updateMatrixWorld(true);
  const box = new Box3();
  const stack: Object3D[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      node !== root &&
      node.userData?.entity_id != null &&
      node.userData.entity_id !== eid
    ) {
      continue;
    }
    const mesh = node as Object3D & {
      isMesh?: boolean;
      geometry?: { boundingBox?: Box3 | null; computeBoundingBox?: () => void };
    };
    if (mesh.isMesh && mesh.geometry) {
      if (!mesh.geometry.boundingBox && mesh.geometry.computeBoundingBox) {
        mesh.geometry.computeBoundingBox();
      }
      if (mesh.geometry.boundingBox) {
        const local = mesh.geometry.boundingBox.clone();
        local.applyMatrix4(node.matrixWorld);
        if (
          Number.isFinite(local.min.x) &&
          Number.isFinite(local.max.x)
        ) {
          box.union(local);
        }
      }
    }
    for (const c of node.children) stack.push(c);
  }
  return box.isEmpty() ? null : box;
}

// World-space centroid of an entity's own meshes. For cancelling-offset
// imports (link world = identity, vertices at absolute coords), this is
// the only way to recover the visible mesh's actual location — the link
// transform itself is at world origin.
export function entityCentroid(scene: Object3D, eid: string): Vector3 | null {
  const box = entityOwnBox(scene, eid);
  if (box) return box.getCenter(new Vector3());
  const obj = findEntityObject(scene, eid);
  if (!obj) return null;
  obj.updateMatrixWorld(true);
  return new Vector3().setFromMatrixPosition(obj.matrixWorld);
}
