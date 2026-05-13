// Editor state: selection (single + multi), joint values, viewport prefs,
// modals, and the "joint pick" queue used by 3D mate-connector picking.

import { create } from "zustand";

import type { Vec3 } from "../types/model";

// "joint" is a special pick mode (click two surfaces, then a popover offers
// joint type). Translate/rotate are gizmo modes for the primary selection.
// "ik" enters inverse-kinematics mode: a draggable handle appears at the
// selected entity's world position; dragging it sends a throttled stream of
// IK requests that update jointValues live.
export type GizmoMode = "none" | "translate" | "rotate" | "joint" | "ik";

export interface JointPick {
  entityId: string;       // entity that owns the picked surface
  point: Vec3;             // pick point in WORLD space
  normal: Vec3;            // surface normal in WORLD space
}

interface EditorState {
  // Selection: `selectedId` is the primary (gizmo target, properties panel),
  // `selectedIds` is the full multi-selection set (primary always included).
  selectedId: string | null;
  selectedIds: string[];

  // Visibility: entities in this set (and their entire subtrees) are hidden.
  hiddenIds: string[];

  jointValues: Record<string, number>;
  showCollisions: boolean;
  showGrid: boolean;
  gizmoMode: GizmoMode;
  // While `gizmoMode === "ik"`, only ONE gizmo widget renders at a time —
  // either the translate arrows OR the rotate rings. Toggle via T / R keys.
  // Exclusive selection avoids the "I clicked translate but hit rotate"
  // problem when the two widgets share screen space.
  ikGizmoSubMode: "translate" | "rotate";
  assetPanelOpen: boolean;
  ikTrainingOpen: boolean;
  // How the scene tree groups entities: by parent/child kinematic structure
  // (default), or by category (metadata.tags[0]).
  treeGrouping: "hierarchy" | "category";
  // Collision-check toggle. When on, the viewport tints colliding entities
  // red and the IK solver returns the colliding pair list.
  collisionCheck: boolean;
  // Viewport lighting: scales every light in the canvas. 1.0 = default,
  // crank up if the imported meshes have dark materials.
  lightIntensity: number;
  // Sun (directional light) placement. Stored in radians.
  // Azimuth = angle in the XY plane from +X (CCW looking down −Z).
  // Elevation = angle above the XY plane (0 = horizontal, π/2 = up).
  sunAzimuth: number;
  sunElevation: number;
  // The set of entity IDs currently flagged as colliding (computed by the
  // backend; cached in the store for the renderer).
  collidingIds: string[];
  // Last IK status message (or null when not in an IK drag). The viewport
  // HUD subscribes to this to surface IK feedback.
  ikStatus: string | null;

  // Mate-pick queue. Cleared on cancel / on successful joint creation.
  jointPicks: JointPick[];

  // Hover snap (joint mode): every available candidate for the entity under
  // the cursor + the index of the one currently closest to the cursor (the
  // "active" snap that a click would commit).
  snapCandidates: SnapCandidate[];
  activeSnapIndex: number;

  // Bumped to trigger "frame view" in the viewport (all / selected).
  requestFrame: number;

  select: (id: string | null) => void;
  toggleSelect: (id: string) => void;     // for Ctrl/Shift+click
  clearSelection: () => void;
  toggleHidden: (id: string) => void;
  setJointValue: (jointId: string, value: number) => void;
  setJointValues: (values: Record<string, number>) => void;
  resetJointValues: () => void;
  toggleCollisions: () => void;
  toggleGrid: () => void;
  setGizmoMode: (mode: GizmoMode) => void;
  setIkGizmoSubMode: (mode: "translate" | "rotate") => void;
  setAssetPanelOpen: (open: boolean) => void;
  setIkTrainingOpen: (open: boolean) => void;
  setTreeGrouping: (mode: "hierarchy" | "category") => void;
  toggleCollisionCheck: () => void;
  setCollidingIds: (ids: string[]) => void;
  setLightIntensity: (v: number) => void;
  setSunAzimuth: (rad: number) => void;
  setSunElevation: (rad: number) => void;
  setIkStatus: (status: string | null) => void;
  addJointPick: (pick: JointPick) => void;
  clearJointPicks: () => void;
  setSnap: (candidates: SnapCandidate[], activeIndex: number) => void;
  clearSnap: () => void;
  bumpRequestFrame: () => void;
}

export type SnapType = "vertex" | "edge" | "face" | "raw";
export interface SnapCandidate {
  entityId: string;
  point: Vec3;       // WORLD space
  normal: Vec3;      // WORLD space
  type: SnapType;
}

export const useEditorStore = create<EditorState>((set) => ({
  selectedId: null,
  selectedIds: [],
  hiddenIds: [],
  jointValues: {},
  showCollisions: false,
  showGrid: true,
  gizmoMode: "none",
  ikGizmoSubMode: "translate",
  assetPanelOpen: false,
  ikTrainingOpen: false,
  treeGrouping: "hierarchy",
  collisionCheck: false,
  collidingIds: [],
  lightIntensity: 1.0,
  sunAzimuth: Math.atan2(4, 3),  // matches the historical [3, 4, 5] direction
  sunElevation: Math.atan2(5, Math.hypot(3, 4)),
  ikStatus: null,
  jointPicks: [],
  snapCandidates: [],
  activeSnapIndex: -1,
  requestFrame: 0,

  select: (id) =>
    set({ selectedId: id, selectedIds: id ? [id] : [] }),
  toggleSelect: (id) =>
    set((s) => {
      const set_ = new Set(s.selectedIds);
      if (set_.has(id)) {
        set_.delete(id);
      } else {
        set_.add(id);
      }
      const ids = Array.from(set_);
      // Primary = the toggled id if added, else the last remaining selection (or null).
      const primary = set_.has(id) ? id : ids[ids.length - 1] ?? null;
      return { selectedIds: ids, selectedId: primary };
    }),
  clearSelection: () => set({ selectedId: null, selectedIds: [] }),

  toggleHidden: (id) =>
    set((s) => {
      const set_ = new Set(s.hiddenIds);
      if (set_.has(id)) set_.delete(id);
      else set_.add(id);
      return { hiddenIds: Array.from(set_) };
    }),

  setJointValue: (jointId, value) =>
    set((s) => ({ jointValues: { ...s.jointValues, [jointId]: value } })),
  setJointValues: (values) => set({ jointValues: { ...values } }),
  resetJointValues: () => set({ jointValues: {} }),
  toggleCollisions: () => set((s) => ({ showCollisions: !s.showCollisions })),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  setGizmoMode: (gizmoMode) =>
    set((s) => ({
      gizmoMode,
      // Leaving joint mode discards in-flight picks.
      jointPicks: gizmoMode === "joint" ? s.jointPicks : [],
    })),
  setIkGizmoSubMode: (ikGizmoSubMode) => set({ ikGizmoSubMode }),
  setAssetPanelOpen: (assetPanelOpen) => set({ assetPanelOpen }),
  setIkTrainingOpen: (ikTrainingOpen) => set({ ikTrainingOpen }),
  setTreeGrouping: (treeGrouping) => set({ treeGrouping }),
  toggleCollisionCheck: () =>
    set((s) => ({
      collisionCheck: !s.collisionCheck,
      collidingIds: s.collisionCheck ? [] : s.collidingIds,
    })),
  setCollidingIds: (collidingIds) => set({ collidingIds }),
  setLightIntensity: (v) => set({ lightIntensity: Math.max(0, v) }),
  setSunAzimuth: (rad) => set({ sunAzimuth: rad }),
  setSunElevation: (rad) =>
    set({ sunElevation: Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, rad)) }),
  setIkStatus: (ikStatus) => set({ ikStatus }),

  addJointPick: (pick) =>
    set((s) => ({ jointPicks: [...s.jointPicks, pick].slice(-2) })),
  clearJointPicks: () => set({ jointPicks: [] }),
  setSnap: (snapCandidates, activeSnapIndex) =>
    set({ snapCandidates, activeSnapIndex }),
  clearSnap: () => set({ snapCandidates: [], activeSnapIndex: -1 }),
  bumpRequestFrame: () => set((s) => ({ requestFrame: s.requestFrame + 1 })),
}));
