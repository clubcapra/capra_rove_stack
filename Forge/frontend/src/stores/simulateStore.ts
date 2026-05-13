// Simulate-page UI state shared between the panel and the viewport.
//
// Used for live lidar/camera alignment:
//   - lockedCameraStreamId: when set, the viewport camera is driven by
//     the bound entity's centroid + the camera's intrinsics (FOV).
//     OrbitControls is disabled. The video shows as a full-screen HTML
//     overlay behind the canvas; the canvas renders with a transparent
//     background so lidar points overlay directly on the image.
//   - videoOpacity: 0..1 — the HTML <video> overlay's opacity in lock
//     mode. Drag toward 0 to "hide" the video and see only lidar; drag
//     toward 1 to see only video. Stored in UI state (not persisted)
//     because it's a debugging dial, not a calibration parameter.
//   - hideModels: when true, SceneRenderer is suppressed so only lidar
//     + camera show — lets the user verify lidar/camera alignment
//     without the URDF mesh getting in the way.

import { create } from "zustand";

interface SimulateState {
  lockedCameraStreamId: string | null;
  videoOpacity: number;
  hideModels: boolean;
  lockToCamera: (streamId: string | null) => void;
  setVideoOpacity: (v: number) => void;
  setHideModels: (v: boolean) => void;
}

export const useSimulateStore = create<SimulateState>((set) => ({
  lockedCameraStreamId: null,
  videoOpacity: 0.6,
  hideModels: false,
  lockToCamera: (lockedCameraStreamId) => set({ lockedCameraStreamId }),
  setVideoOpacity: (videoOpacity) =>
    set({ videoOpacity: Math.min(1, Math.max(0, videoOpacity)) }),
  setHideModels: (hideModels) => set({ hideModels }),
}));
