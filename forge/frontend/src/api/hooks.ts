// React Query hooks. The WebSocket pushes mutations; we invalidate on every event.

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { invalidateMeshCache } from "../components/viewport/useMesh";
import { useEditorStore } from "../stores/editorStore";

import { api } from "./client";
import { eventStream } from "./ws";

export const QK = {
  summary: ["summary"] as const,
  scene: ["scene"] as const,
  validation: ["validation"] as const,
  history: ["history"] as const,
  fk: (jv: Record<string, number>) => ["fk", jv] as const,
  ikProfiles: ["ik-profiles"] as const,
};

export function useEventStreamSubscription() {
  const qc = useQueryClient();
  useEffect(() => {
    eventStream.start();
    const off = eventStream.on((event) => {
      // Any mutation invalidates everything except the live FK feed (which is
      // driven by joint sliders).
      qc.invalidateQueries({ queryKey: QK.summary });
      qc.invalidateQueries({ queryKey: QK.scene });
      qc.invalidateQueries({ queryKey: QK.validation });
      qc.invalidateQueries({ queryKey: QK.history });
      if (event.type === "ik_tune.done" || event.type === "ik_tune.profile_deleted" || event.type === "project.replaced") {
        qc.invalidateQueries({ queryKey: QK.ikProfiles });
      }
      // Project replacement (upload/import) means meshes change too.
      if (event.type === "project.replaced") {
        invalidateMeshCache();
      }
    });
    return off;
  }, [qc]);
}

export function useIkProfiles() {
  return useQuery({ queryKey: QK.ikProfiles, queryFn: api.listIkProfiles, staleTime: 30_000 });
}

export function useSummary() {
  return useQuery({ queryKey: QK.summary, queryFn: api.getSummary });
}

export function useScene() {
  return useQuery({ queryKey: QK.scene, queryFn: api.getScene });
}

export function useValidation() {
  return useQuery({ queryKey: QK.validation, queryFn: api.validate });
}

export function useHistory() {
  return useQuery({ queryKey: QK.history, queryFn: api.history });
}

export function useFK(jointValues: Record<string, number>) {
  return useQuery({
    queryKey: QK.fk(jointValues),
    queryFn: () => api.fk(jointValues),
    staleTime: 0,
  });
}

export function useImportFile() {
  return useMutation({
    mutationFn: (file: File) => api.importFile(file),
    onSuccess: () => {
      useEditorStore.getState().select(null);
      useEditorStore.getState().resetJointValues();
      invalidateMeshCache();
      frameAfterChange();
    },
  });
}

export function useUndo() {
  return useMutation({ mutationFn: api.undo });
}

export function useRedo() {
  return useMutation({ mutationFn: api.redo });
}

export function useUpdateComponent() {
  return useMutation({
    mutationFn: ({
      entityId,
      key,
      updates,
    }: {
      entityId: string;
      key: string;
      updates: Record<string, unknown>;
    }) => api.updateComponent(entityId, key, updates),
  });
}

export function useAttachComponent() {
  return useMutation({
    mutationFn: ({
      entityId,
      key,
      data,
    }: {
      entityId: string;
      key: string;
      data: Record<string, unknown>;
    }) => api.attachComponent(entityId, key, data),
  });
}

// Set the (first) category tag on one or more entities. Always re-attaches
// metadata so it works whether or not the component already exists.
export function useSetCategory() {
  return useMutation({
    mutationFn: async ({ entityIds, category }: { entityIds: string[]; category: string }) => {
      // Sequential to keep semantics simple; the calls are tiny.
      for (const eid of entityIds) {
        await api.attachComponent(eid, "metadata", { tags: [category] });
      }
    },
  });
}

export function useDeleteEntity() {
  return useMutation({
    mutationFn: (entityId: string) => api.deleteEntity(entityId),
    onSuccess: (_, entityId) => {
      // Drop selection / joint sliders tied to the deleted entity.
      const ed = useEditorStore.getState();
      if (ed.selectedId === entityId) ed.select(null);
      const { [entityId]: _drop, ...rest } = ed.jointValues;
      useEditorStore.setState({ jointValues: rest });
    },
  });
}

export function useConnectJoint() {
  return useMutation({
    mutationFn: (body: Parameters<typeof api.connectJoint>[0]) => api.connectJoint(body),
  });
}

export function useLibrary() {
  return useQuery({ queryKey: ["library"], queryFn: api.listLibrary, staleTime: 60_000 });
}

function frameAfterChange() {
  // The mesh GLBs need a beat to load before bounding boxes are valid.
  setTimeout(() => useEditorStore.getState().bumpRequestFrame(), 400);
}

export function useUploadParts() {
  return useMutation({
    mutationFn: ({ files, parentId }: { files: File[]; parentId: string | null }) =>
      api.uploadParts(files, parentId),
    onSuccess: () => {
      invalidateMeshCache();
      frameAfterChange();
    },
  });
}

export function useLoadLibraryEntry() {
  return useMutation({
    mutationFn: ({
      id,
      mode,
      parentId,
    }: {
      id: string;
      mode: "merge" | "replace";
      parentId: string | null;
    }) => api.loadLibraryEntry(id, mode, parentId),
    onSuccess: () => {
      invalidateMeshCache();
      frameAfterChange();
    },
  });
}

// ----- Named project persistence -----

export function useSavedProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: api.listProjects, staleTime: 10_000 });
}

export function useOpenProject() {
  return useMutation({
    mutationFn: (name: string) => api.openProject(name),
    onSuccess: () => {
      useEditorStore.getState().select(null);
      useEditorStore.getState().resetJointValues();
      invalidateMeshCache();
      frameAfterChange();
    },
  });
}

export function useSaveProjectAs() {
  return useMutation({ mutationFn: (name: string) => api.saveProjectAs(name) });
}

export function useDeleteProject() {
  return useMutation({ mutationFn: (name: string) => api.deleteProject(name) });
}

// Watches joint values + the collision-check toggle. When enabled, runs a
// throttled collision check and pushes the colliding entity ids into the
// editor store so the viewport can tint them.
export function useCollisionWatcher() {
  const enabled = useEditorStore((s) => s.collisionCheck);
  const jointValues = useEditorStore((s) => s.jointValues);
  const setCollidingIds = useEditorStore((s) => s.setCollidingIds);
  // Re-run when scene structure changes (entities added/removed).
  const sceneTimestamp = useQuery({ queryKey: QK.scene, queryFn: api.getScene }).dataUpdatedAt;

  useEffect(() => {
    if (!enabled) {
      setCollidingIds([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const pairs = await api.checkCollisions(jointValues);
        if (cancelled) return;
        const ids = new Set<string>();
        for (const p of pairs) {
          ids.add(p.a);
          ids.add(p.b);
        }
        setCollidingIds(Array.from(ids));
      } catch {
        if (!cancelled) setCollidingIds([]);
      }
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [enabled, jointValues, sceneTimestamp, setCollidingIds]);
}

export function useNewProject() {
  return useMutation({
    mutationFn: () => api.newProject(),
    onSuccess: () => {
      useEditorStore.getState().select(null);
      useEditorStore.getState().resetJointValues();
      invalidateMeshCache();
    },
  });
}
