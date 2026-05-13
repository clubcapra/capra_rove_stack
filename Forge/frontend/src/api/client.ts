import type {
  ChainResponse,
  DiagnosticOut,
  FKResponse,
  ProjectSummary,
  SceneDoc,
} from "../types/model";

const BASE = "/api/v1";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; version: string }>("/health"),

  getSummary: () => request<ProjectSummary>(`${BASE}/project/summary`),
  getScene: () => request<SceneDoc>(`${BASE}/scene`),

  uploadProject: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/project/upload`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  importFile: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/io/import`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<{
      ok: boolean;
      diagnostics: DiagnosticOut[];
    }>;
  },

  exportFile: (
    fmt: string,
    extras?: Record<string, string>,
  ) => {
    const params = new URLSearchParams({ fmt });
    if (extras) for (const [k, v] of Object.entries(extras)) params.set(k, v);
    return fetch(`${BASE}/io/export?${params}`).then(async (r) => {
      if (!r.ok) throw new Error(await r.text());
      return r.blob();
    });
  },

  undo: () => request<{ ok: boolean; description?: string; reason?: string }>(
    `${BASE}/project/undo`,
    { method: "POST" }
  ),
  redo: () => request<{ ok: boolean; description?: string; reason?: string }>(
    `${BASE}/project/redo`,
    { method: "POST" }
  ),
  history: () =>
    request<{ undo: string[]; can_undo: boolean; can_redo: boolean }>(
      `${BASE}/project/history`
    ),

  validate: () => request<DiagnosticOut[]>(`${BASE}/validation`),

  fk: (joint_values: Record<string, number>) =>
    request<FKResponse>(`${BASE}/kinematics/fk`, {
      method: "POST",
      body: JSON.stringify({ joint_values }),
    }),

  chain: (base: string, tip: string) =>
    request<ChainResponse>(
      `${BASE}/kinematics/chain?base=${encodeURIComponent(base)}&tip=${encodeURIComponent(tip)}`
    ),

  ik: (body: {
    base: string;
    tip: string;
    target_world: [number, number, number];
    target_rotation?: [number, number, number, number];
    initial_joint_values?: Record<string, number>;
    rest_pose?: Record<string, number>;
    rest_pose_gain?: number;
    joint_weight_strength?: number;
    max_iter?: number;
    tol?: number;
    damping?: number;
    orientation_weight?: number;
    check_collisions?: boolean;
    respect_collisions?: boolean;
    mode?: "pose_locked" | "pos_primary";
    orientation_secondary_gain?: number;
    max_dq_step?: number;
    max_pos_step?: number;
    max_total_dq_step?: number;
    tcp_offset_local?: [number, number, number];
  }) =>
    request<{
      joint_values: Record<string, number>;
      iterations: number;
      residual: number;
      converged: boolean;
      pos_residual: number;
      rot_residual: number;
      collisions: CollisionPair[];
    }>(`${BASE}/kinematics/ik`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  checkCollisions: (joint_values: Record<string, number> = {}) =>
    request<CollisionPair[]>(`${BASE}/validation/collisions`, {
      method: "POST",
      body: JSON.stringify({ joint_values }),
    }),

  updateComponent: (entity_id: string, key: string, updates: Record<string, unknown>) =>
    request(`${BASE}/entities/${encodeURIComponent(entity_id)}/components/${key}`, {
      method: "PATCH",
      body: JSON.stringify({ updates }),
    }),

  attachComponent: (entity_id: string, key: string, data: Record<string, unknown>) =>
    request(`${BASE}/entities/${encodeURIComponent(entity_id)}/components/${key}`, {
      method: "PUT",
      body: JSON.stringify({ data }),
    }),

  deleteEntity: (entity_id: string) =>
    request(`${BASE}/entities/${encodeURIComponent(entity_id)}`, { method: "DELETE" }),

  reparent: (entity_id: string, new_parent: string | null) =>
    request(`${BASE}/scene/reparent/${encodeURIComponent(entity_id)}`, {
      method: "POST",
      body: JSON.stringify({ new_parent }),
    }),

  connectJoint: (body: {
    parent_link: string;
    child_link: string;
    joint_type: string;
    axis?: [number, number, number];
    position?: [number, number, number];
    // World-space inputs from the 3D mate-pick UI; server converts via FK.
    axis_world?: [number, number, number];
    position_world?: [number, number, number];
    name?: string | null;
    limits?: [number, number] | null;
  }) =>
    request<{ ok: boolean; joint_id: string }>(`${BASE}/scene/connect`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ----- Parts (multi-file upload, each file -> one link entity) -----
  uploadParts: async (files: File[], parentId: string | null = null) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    const url = parentId
      ? `${BASE}/parts/upload?parent_id=${encodeURIComponent(parentId)}`
      : `${BASE}/parts/upload`;
    const res = await fetch(url, { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<{
      added: { file: string; entity_id: string; mesh_stem: string; mesh_suffix: string; size_bytes: number }[];
      errors: { file: string; error: string }[];
    }>;
  },

  // ----- Library (curated catalog) -----
  listLibrary: () => request<LibraryEntry[]>(`${BASE}/library`),

  loadLibraryEntry: (id: string, mode: "merge" | "replace" = "merge", parentId: string | null = null) => {
    const params = new URLSearchParams({ mode });
    if (parentId) params.set("parent_id", parentId);
    return request<{
      ok: boolean;
      mode: string;
      new_root_ids?: string[];
      diagnostics?: DiagnosticOut[];
    }>(`${BASE}/library/${encodeURIComponent(id)}/load?${params}`, { method: "POST" });
  },

  // ----- Named projects (server-side persistence) -----
  listProjects: () => request<ProjectMeta[]>(`${BASE}/projects`),
  saveProjectAs: (name: string) =>
    request<{ ok: boolean; name: string; path: string }>(
      `${BASE}/projects/${encodeURIComponent(name)}/save`,
      { method: "POST" }
    ),
  openProject: (name: string) =>
    request<{ ok: boolean; name: string }>(
      `${BASE}/projects/${encodeURIComponent(name)}/open`,
      { method: "POST" }
    ),
  deleteProject: (name: string) =>
    request<{ ok: boolean }>(`${BASE}/projects/${encodeURIComponent(name)}`, { method: "DELETE" }),
  newProject: () =>
    request<{ ok: boolean }>(`${BASE}/projects/new`, { method: "POST" }),

  getHomePose: () =>
    request<Record<string, number>>(`${BASE}/project/home-pose`),
  setHomePose: (home_pose: Record<string, number>) =>
    request<{ ok: boolean; count: number }>(`${BASE}/project/home-pose`, {
      method: "PUT",
      body: JSON.stringify({ home_pose }),
    }),

  startIkTune: (body: { base: string; tip: string }) =>
    request<IKTuneStatus>(`${BASE}/kinematics/ik/tune/start`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getIkTune: (jobId: string) =>
    request<IKTuneStatus>(`${BASE}/kinematics/ik/tune/${encodeURIComponent(jobId)}`),
  cancelIkTune: (jobId: string) =>
    request<IKTuneStatus>(
      `${BASE}/kinematics/ik/tune/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" }
    ),
  listIkProfiles: () =>
    request<Record<string, IKTunedProfile>>(`${BASE}/kinematics/ik/profiles`),
  deleteIkProfile: (base: string) =>
    request<{ deleted: boolean }>(
      `${BASE}/kinematics/ik/profiles/${encodeURIComponent(base)}`,
      { method: "DELETE" }
    ),
};

export interface IKTunedProfile {
  mode: "pose_locked" | "pos_primary";
  damping: number;
  rest_pose_gain: number;
  max_iter: number;
  orientation_weight: number;
  joint_weight_strength: number;
  max_dq_step: number;
  max_pos_step: number;
  max_total_dq_step: number | null;
  orientation_secondary_gain: number;
  score: number;
  tuned_at: string;
  // Per-component breakdown of the score (lower is better for each).
  pos_err_max_mm: number;
  rot_drift_deg: number;
  max_jump_rad: number;
  total_motion_rad: number;
  saturated_joints: number;
  new_collision_pairs: number;
}

export interface IKTuneStatus {
  job_id: string;
  base: string;
  tip: string;
  done: number;
  total: number;
  started_at: number;
  elapsed_s: number;
  eta_s: number;
  best_score: number;
  best_profile: IKTunedProfile | null;
  finished: boolean;
  cancelled: boolean;
  error: string | null;
}

export interface CollisionPair {
  a: string;
  b: string;
  distance: number;
  penetration: number;
}

export interface ProjectMeta {
  name: string;
  path: string;
  size_bytes: number;
  modified: number;
}

export interface LibraryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  formats: string[];
  loader_id: string;
  source_url: string | null;
  source_label: string | null;
  supported: boolean;
  unsupported_reason: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
