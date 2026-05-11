import { useSummary, useValidation } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";

export function StatusBar() {
  const summary = useSummary();
  const validation = useValidation();
  const selectedId = useEditorStore((s) => s.selectedId);

  const errors = validation.data?.filter((d) => d.severity === "error").length ?? 0;
  const warns = validation.data?.filter((d) => d.severity === "warning").length ?? 0;

  return (
    <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-400">
      <div className="flex gap-4">
        <span>{summary.data ? summary.data.name : "—"}</span>
        <span>
          {summary.data?.entity_count ?? 0} entities
          {" · "}
          {summary.data?.link_count ?? 0} links
          {" · "}
          {summary.data?.joint_count ?? 0} joints
        </span>
        {selectedId && <span className="text-teal-400">selected: {selectedId}</span>}
      </div>
      <div className="flex gap-4">
        {errors > 0 && <span className="text-red-400">{errors} error(s)</span>}
        {warns > 0 && <span className="text-yellow-400">{warns} warning(s)</span>}
        {errors === 0 && warns === 0 && validation.data && <span>✓ no diagnostics</span>}
      </div>
    </div>
  );
}
