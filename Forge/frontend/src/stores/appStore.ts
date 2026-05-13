// App-level state: which top-level view is showing, current project name, etc.

import { create } from "zustand";

export type AppView = "home" | "create" | "simulate" | "map" | "lidar-debug";

interface AppState {
  view: AppView;
  projectName: string | null; // last opened/saved name (for "Save" without renaming)

  setView: (view: AppView) => void;
  setProjectName: (name: string | null) => void;
  goHome: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "home",
  projectName: null,

  setView: (view) => set({ view }),
  setProjectName: (projectName) => set({ projectName }),
  goHome: () => set({ view: "home" }),
}));
