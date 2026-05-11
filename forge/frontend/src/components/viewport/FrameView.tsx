// "Frame view" helper: when triggered, computes a bounding box over the
// rendered geometry (or the selected entity's subtree) and animates the
// camera + OrbitControls target to fit it in view.
//
// Triggered via:
//   • F key (frame all if nothing selected, frame selected otherwise)
//   • Toolbar button (defers to F)
//
// `requestFrame: number` in editorStore is incremented to fire a frame.

import { useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Box3, PerspectiveCamera, Sphere, Vector3 } from "three";

import { useEditorStore } from "../../stores/editorStore";

interface OrbitControlsLike {
  target: Vector3;
  update?: () => void;
}

export function FrameView() {
  const { scene, camera, controls } = useThree() as unknown as {
    scene: { traverse: (cb: (o: object) => void) => void };
    camera: PerspectiveCamera;
    controls: OrbitControlsLike | null;
  };
  const requestFrame = useEditorStore((s) => s.requestFrame);
  const lastFrameRef = useRef(0);

  useEffect(() => {
    if (requestFrame === 0 || requestFrame === lastFrameRef.current) return;
    lastFrameRef.current = requestFrame;

    const selectedIds = useEditorStore.getState().selectedIds;

    // Collect the world bounding box. If selection exists, only fit selected
    // subtree(s); otherwise everything visible under SceneRenderer.
    const scope: Set<string> | null = selectedIds.length > 0 ? new Set(selectedIds) : null;
    const box = new Box3();
    let inScope = scope === null;
    let foundAny = false;
    const stack: object[] = [];
    type T = {
      isMesh?: boolean;
      visible?: boolean;
      userData?: { entity_id?: string };
      geometry?: { boundingBox: Box3 | null; computeBoundingBox: () => void };
      matrixWorld?: unknown;
      children?: object[];
    };
    scene.traverse((o) => stack.push(o));
    // Walk the tree, tracking whether we're inside a scoped subtree.
    const walk = (root: T, inScopeSubtree: boolean) => {
      const eid = root.userData?.entity_id;
      const here = inScopeSubtree || (eid && scope?.has(eid)) || false;
      if (here && root.isMesh && root.visible !== false && root.geometry) {
        if (!root.geometry.boundingBox) root.geometry.computeBoundingBox();
        if (root.geometry.boundingBox) {
          const b = (root.geometry.boundingBox as Box3).clone();
          (b as Box3).applyMatrix4(root.matrixWorld as never);
          box.union(b);
          foundAny = true;
        }
      }
      for (const child of (root.children ?? []) as T[]) {
        walk(child, here);
      }
    };
    void inScope;
    walk(scene as unknown as T, scope === null);

    if (!foundAny || box.isEmpty()) return;

    const sphere = new Sphere();
    box.getBoundingSphere(sphere);
    const center = sphere.center;
    const radius = Math.max(sphere.radius, 0.01);

    // Pick a distance such that the bounding sphere is fully visible.
    const fov = (camera.fov * Math.PI) / 180;
    const aspect = camera.aspect;
    const distV = radius / Math.sin(fov / 2);
    const distH = radius / Math.sin(Math.atan(Math.tan(fov / 2) * aspect));
    const distance = Math.max(distV, distH) * 1.15;

    // Keep current view direction, just shift along it.
    const dir = new Vector3();
    camera.getWorldDirection(dir);
    const newPos = center.clone().sub(dir.multiplyScalar(distance));
    camera.position.copy(newPos);
    camera.near = Math.max(0.001, radius / 1000);
    camera.far = Math.max(100, radius * 1000);
    camera.updateProjectionMatrix();

    if (controls) {
      controls.target.copy(center);
      controls.update?.();
    }
  }, [requestFrame, scene, camera, controls]);

  return null;
}
