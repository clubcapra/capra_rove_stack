import {
  ChevronDown,
  ChevronRight,
  Cog,
  Eye,
  EyeOff,
  FolderTree,
  Link2,
  Tag,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useDeleteEntity, useScene } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";
import type { Entity, JointComponent } from "../../types/model";

import { categoryColor, getCategory } from "./category";

export function SceneTreePanel() {
  const sceneQ = useScene();
  const selectedId = useEditorStore((s) => s.selectedId);
  const treeGrouping = useEditorStore((s) => s.treeGrouping);
  const setTreeGrouping = useEditorStore((s) => s.setTreeGrouping);
  const deleteEntity = useDeleteEntity();

  // Delete key = remove primary selection (skip in text fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId) return;
      const t = e.target as HTMLElement | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        t?.isContentEditable
      ) {
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteEntity.mutate(selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, deleteEntity]);

  const headerAction = (
    <button
      onClick={() => setTreeGrouping(treeGrouping === "hierarchy" ? "category" : "hierarchy")}
      title={
        treeGrouping === "hierarchy"
          ? "Group by category"
          : "Show kinematic hierarchy"
      }
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
    >
      {treeGrouping === "hierarchy" ? (
        <>
          <FolderTree size={10} /> Hierarchy
        </>
      ) : (
        <>
          <Tag size={10} /> Category
        </>
      )}
    </button>
  );

  if (!sceneQ.data) {
    return (
      <PanelShell title="Scene" action={headerAction}>
        <div className="p-3 text-xs text-zinc-500">No project loaded</div>
      </PanelShell>
    );
  }
  const entities = sceneQ.data.entities;

  return (
    <PanelShell title="Scene" action={headerAction}>
      <div className="overflow-auto p-1 text-sm">
        {treeGrouping === "hierarchy" ? (
          <HierarchyView entities={entities} />
        ) : (
          <CategoryView entities={entities} />
        )}
      </div>
    </PanelShell>
  );
}

// -------------------- hierarchy view (kinematic tree) --------------------

function HierarchyView({ entities }: { entities: Record<string, Entity> }) {
  const roots = Object.keys(entities).filter((eid) => !entities[eid].parent);
  return (
    <>
      {roots.map((eid) => (
        <TreeNode
          key={eid}
          eid={eid}
          entities={entities}
          depth={0}
          ancestorHidden={false}
          renderChildren
        />
      ))}
    </>
  );
}

// -------------------- category view (grouped flat list) --------------------

function CategoryView({ entities }: { entities: Record<string, Entity> }) {
  const groups = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [eid, e] of Object.entries(entities)) {
      const cat = getCategory(e);
      (out[cat] ??= []).push(eid);
    }
    // Stable sort entities within each group by name.
    for (const ids of Object.values(out)) {
      ids.sort((a, b) =>
        (entities[a].name || a).localeCompare(entities[b].name || b),
      );
    }
    return out;
  }, [entities]);

  // Group order: standard preset first, then any custom categories.
  const order = [
    "arm",
    "sensor",
    "tool",
    "conveyor",
    "controller",
    "fixture",
    "other",
  ];
  const seen = new Set(order);
  const orderedKeys = [
    ...order.filter((k) => k in groups),
    ...Object.keys(groups).filter((k) => !seen.has(k)),
  ];

  return (
    <>
      {orderedKeys.map((cat) => (
        <CategoryGroup
          key={cat}
          category={cat}
          eids={groups[cat]}
          entities={entities}
        />
      ))}
    </>
  );
}

function CategoryGroup({
  category,
  eids,
  entities,
}: {
  category: string;
  eids: string[];
  entities: Record<string, Entity>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div
        className="flex cursor-pointer items-center gap-1 rounded px-1 py-1 hover:bg-zinc-800"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown size={12} className="text-zinc-400" />
        ) : (
          <ChevronRight size={12} className="text-zinc-400" />
        )}
        <span
          className="h-2.5 w-2.5 rounded-sm"
          style={{ backgroundColor: categoryColor(category) }}
        />
        <span className="text-[11px] uppercase tracking-wide text-zinc-300">
          {category}
        </span>
        <span className="ml-1 text-[10px] text-zinc-500">{eids.length}</span>
      </div>
      {open && (
        <div>
          {eids.map((eid) => (
            <TreeNode
              key={eid}
              eid={eid}
              entities={entities}
              depth={1}
              ancestorHidden={false}
              renderChildren={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// -------------------- shared tree row --------------------

function TreeNode({
  eid,
  entities,
  depth,
  ancestorHidden,
  renderChildren,
}: {
  eid: string;
  entities: Record<string, Entity>;
  depth: number;
  ancestorHidden: boolean;
  renderChildren: boolean;
}) {
  const [open, setOpen] = useState(true);
  const e = entities[eid];
  const inSelection = useEditorStore((s) => s.selectedIds.includes(eid));
  const isPrimary = useEditorStore((s) => s.selectedId === eid);
  const isHidden = useEditorStore((s) => s.hiddenIds.includes(eid));
  const select = useEditorStore((s) => s.select);
  const toggleSelect = useEditorStore((s) => s.toggleSelect);
  const toggleHidden = useEditorStore((s) => s.toggleHidden);
  const deleteEntity = useDeleteEntity();
  if (!e) return null;
  const hasChildren = renderChildren && (e.children?.length ?? 0) > 0;
  const effectivelyHidden = ancestorHidden || isHidden;

  const joint = e.components?.joint as JointComponent | undefined;
  const link = e.components?.link;
  const category = getCategory(e);

  const onRowClick = (ev: React.MouseEvent) => {
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
      toggleSelect(eid);
    } else {
      select(eid);
    }
  };
  const onDelete = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (window.confirm(`Delete '${e.name || eid}' and all its descendants?`)) {
      deleteEntity.mutate(eid);
    }
  };
  const onToggleHidden = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    toggleHidden(eid);
  };

  const rowClass = (() => {
    let base = "group flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer ";
    if (isPrimary) base += "bg-teal-700/30 text-teal-200";
    else if (inSelection) base += "bg-teal-900/30 text-teal-300";
    else base += "hover:bg-zinc-800";
    if (effectivelyHidden) base += " opacity-40";
    return base;
  })();

  return (
    <div>
      <div
        className={rowClass}
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={onRowClick}
      >
        {hasChildren ? (
          <button
            onClick={(ev) => {
              ev.stopPropagation();
              setOpen((o) => !o);
            }}
            className="p-0.5 text-zinc-400 hover:text-zinc-200"
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: categoryColor(category) }}
          title={`category: ${category}`}
        />
        {joint ? (
          <Cog size={12} className="text-yellow-400" />
        ) : link ? (
          <Link2 size={12} className="text-cyan-400" />
        ) : (
          <span className="h-3 w-3 rounded-sm bg-zinc-600" />
        )}
        <span className="truncate">{e.name || eid}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {joint && (
            <span className="text-[10px] uppercase text-zinc-500">{joint.type}</span>
          )}
          <button
            onClick={onToggleHidden}
            title={isHidden ? "Show" : "Hide"}
            className={
              "rounded p-0.5 transition-opacity " +
              (isHidden
                ? "text-zinc-500 hover:text-zinc-300"
                : "text-zinc-500 opacity-0 hover:text-zinc-300 group-hover:opacity-100")
            }
          >
            {isHidden ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
          <button
            onClick={onDelete}
            title={`Delete ${e.name || eid}`}
            className="rounded p-0.5 text-zinc-500 opacity-0 transition-opacity hover:bg-red-900/40 hover:text-red-300 group-hover:opacity-100"
          >
            <Trash2 size={11} />
          </button>
        </span>
      </div>
      {hasChildren && open && (
        <div>
          {(e.children ?? []).map((cid) => (
            <TreeNode
              key={cid}
              eid={cid}
              entities={entities}
              depth={depth + 1}
              ancestorHidden={effectivelyHidden}
              renderChildren
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PanelShell({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <div className="text-xs uppercase tracking-wide text-zinc-400">{title}</div>
        {action}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </div>
  );
}
