import { useScene, useSetCategory, useUpdateComponent } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";
import type {
  Entity,
  Geometry,
  JointComponent,
  LinkComponent,
  Quat,
  TransformComponent,
  Vec3,
} from "../../types/model";
import { NumberField } from "../shared/NumberField";
import { QuaternionInput } from "../shared/QuaternionInput";
import { Vec3Input } from "../shared/Vec3Input";

import { categoryColor, getCategory, PRESET_CATEGORIES } from "./category";

export function PropertiesPanel() {
  const sceneQ = useScene();
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectedIds = useEditorStore((s) => s.selectedIds);

  const entity = selectedId ? sceneQ.data?.entities[selectedId] : undefined;
  const multi = selectedIds.length > 1;

  return (
    <PanelShell title="Properties">
      {!selectedId && (
        <Empty>Select an entity in the scene tree or viewport.</Empty>
      )}
      {selectedId && !entity && <Empty>Entity {selectedId} not found.</Empty>}
      {entity && selectedId && (
        <div className="overflow-auto p-3 text-sm">
          <Header entity={entity} eid={selectedId} multiCount={multi ? selectedIds.length : 0} />
          <CategoryEditor
            primary={entity}
            primaryId={selectedId}
            allSelected={selectedIds}
          />
          {entity.components?.transform && (
            <TransformEditor
              eid={selectedId}
              transform={entity.components.transform as TransformComponent}
            />
          )}
          {entity.components?.joint && (
            <JointEditor eid={selectedId} joint={entity.components.joint as JointComponent} />
          )}
          {entity.components?.link && (
            <LinkEditor eid={selectedId} link={entity.components.link as LinkComponent} />
          )}
          <ComponentList components={entity.components ?? {}} />
        </div>
      )}
    </PanelShell>
  );
}

function Header({ entity, eid, multiCount }: { entity: Entity; eid: string; multiCount: number }) {
  return (
    <div className="mb-4">
      <div className="text-xs uppercase text-zinc-500">Entity</div>
      <div className="font-medium">{entity.name || "(unnamed)"}</div>
      <div className="text-[10px] text-zinc-500 break-all">{eid}</div>
      {multiCount > 1 && (
        <div className="mt-1 text-[10px] text-teal-400">
          {multiCount} entities selected — editing primary only
        </div>
      )}
    </div>
  );
}

function CategoryEditor({
  primary,
  primaryId,
  allSelected,
}: {
  primary: Entity;
  primaryId: string;
  allSelected: string[];
}) {
  const setCategory = useSetCategory();
  const current = getCategory(primary);
  const isPreset = (PRESET_CATEGORIES as readonly string[]).includes(current);
  const dropdownValue = isPreset ? current : "__custom__";

  const apply = (value: string) => {
    const ids = allSelected.length > 1 ? allSelected : [primaryId];
    setCategory.mutate({ entityIds: ids, category: value });
  };

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === "__custom__") {
      const name = window.prompt("Custom category name", isPreset ? "" : current);
      if (name) apply(name.trim());
      return;
    }
    apply(v);
  };

  return (
    <Section
      label={
        allSelected.length > 1
          ? `Category — applies to ${allSelected.length} selected`
          : "Category"
      }
    >
      <Row label="">
        <div className="flex items-center gap-2">
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: categoryColor(current) }}
          />
          <select
            value={dropdownValue}
            onChange={handleSelect}
            className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-100 focus:border-teal-500 focus:outline-none"
          >
            {PRESET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            {!isPreset && (
              <option value={dropdownValue}>{current} (custom)</option>
            )}
            <option value="__custom__">custom…</option>
          </select>
        </div>
      </Row>
      {!primary.components?.metadata && (
        <div className="text-[10px] text-zinc-500">
          auto-detected from components — pick one to override
        </div>
      )}
    </Section>
  );
}

function TransformEditor({ eid, transform }: { eid: string; transform: TransformComponent }) {
  const update = useUpdateComponent();
  const pos = (transform.position ?? [0, 0, 0]) as Vec3;
  const rot = (transform.rotation ?? [0, 0, 0, 1]) as Quat;
  const setPos = (position: Vec3) =>
    update.mutate({ entityId: eid, key: "transform", updates: { position } });
  const setRot = (rotation: Quat) =>
    update.mutate({ entityId: eid, key: "transform", updates: { rotation } });
  const resetRot = () => setRot([0, 0, 0, 1]);
  return (
    <>
      <Section label="Transform · position">
        <Vec3Input value={pos} onChange={setPos} step={0.01} />
      </Section>
      <Section
        label="Transform · rotation (RPY, deg)"
        action={
          <button
            onClick={resetRot}
            className="text-[10px] text-zinc-500 hover:text-zinc-300"
            title="Reset rotation to identity"
          >
            reset
          </button>
        }
      >
        <QuaternionInput value={rot} onChange={setRot} step={1} />
      </Section>
    </>
  );
}

function JointEditor({ eid, joint }: { eid: string; joint: JointComponent }) {
  const update = useUpdateComponent();
  const sceneQ = useScene();
  const upd = (updates: Record<string, unknown>) =>
    update.mutate({ entityId: eid, key: "joint", updates });

  // Whether this joint type uses a movement axis at all.
  const hasAxis = joint.type !== "fixed" && joint.type !== "ball";
  const hasLimits = joint.type === "revolute" || joint.type === "prismatic";

  // Available link entities for parent / child selection.
  const linkEntries = sceneQ.data
    ? Object.entries(sceneQ.data.entities)
        .filter(([, e]) => Boolean(e.components?.link))
        .map(([id, e]) => ({ id, name: e.name || id }))
    : [];

  return (
    <>
      <Section label={`Joint · ${joint.type}`}>
        <Row label="type">
          <select
            value={joint.type}
            onChange={(e) => upd({ type: e.target.value })}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-100 focus:border-teal-500 focus:outline-none"
          >
            {["revolute", "continuous", "prismatic", "fixed", "planar", "ball"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Row>
        <Row label="parent">
          <LinkSelect
            value={joint.parent_link}
            options={linkEntries}
            placeholder="(none)"
            onChange={(parent_link) => upd({ parent_link })}
          />
        </Row>
        <Row label="child">
          <LinkSelect
            value={joint.child_link}
            options={linkEntries.filter((l) => l.id !== joint.parent_link)}
            placeholder="(none)"
            onChange={(child_link) => upd({ child_link })}
          />
        </Row>
        {hasAxis && (
          <>
            <Row label="axis">
              <Vec3Input value={joint.axis} onChange={(axis) => upd({ axis })} step={1} />
            </Row>
            <Row label="">
              <div className="flex gap-1">
                <AxisPreset onClick={() => upd({ axis: [1, 0, 0] })} active={isAxis(joint.axis, [1, 0, 0])}>
                  X
                </AxisPreset>
                <AxisPreset onClick={() => upd({ axis: [0, 1, 0] })} active={isAxis(joint.axis, [0, 1, 0])}>
                  Y
                </AxisPreset>
                <AxisPreset onClick={() => upd({ axis: [0, 0, 1] })} active={isAxis(joint.axis, [0, 0, 1])}>
                  Z
                </AxisPreset>
                <AxisPreset onClick={() => upd({ axis: negate(joint.axis) })}>±</AxisPreset>
              </div>
            </Row>
            <Row label="offset">
              <NumberField
                value={joint.offset ?? 0}
                onCommit={(offset) => upd({ offset })}
              />
            </Row>
          </>
        )}
      </Section>
      {hasLimits && (
        <Section
          label="Joint · limits"
          action={
            joint.limits ? (
              <button
                onClick={() => upd({ limits: null })}
                className="text-[10px] text-zinc-500 hover:text-zinc-300"
                title="Remove limits (continuous motion)"
              >
                remove
              </button>
            ) : (
              <button
                onClick={() =>
                  upd({ limits: { lower: -3.14159, upper: 3.14159, effort: 10, velocity: 1 } })
                }
                className="text-[10px] text-zinc-500 hover:text-zinc-300"
              >
                add
              </button>
            )
          }
        >
          {joint.limits && (
            <>
              <Row label="lower">
                <NumberField
                  value={joint.limits.lower}
                  onCommit={(lower) => upd({ limits: { ...joint.limits, lower } })}
                />
              </Row>
              <Row label="upper">
                <NumberField
                  value={joint.limits.upper}
                  onCommit={(upper) => upd({ limits: { ...joint.limits, upper } })}
                />
              </Row>
              <Row label="effort">
                <NumberField
                  value={joint.limits.effort}
                  onCommit={(effort) => upd({ limits: { ...joint.limits, effort } })}
                />
              </Row>
              <Row label="velocity">
                <NumberField
                  value={joint.limits.velocity}
                  onCommit={(velocity) => upd({ limits: { ...joint.limits, velocity } })}
                />
              </Row>
            </>
          )}
        </Section>
      )}
    </>
  );
}

function LinkSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: { id: string; name: string }[];
  placeholder?: string;
  onChange: (id: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-100 focus:border-teal-500 focus:outline-none"
    >
      <option value="">{placeholder ?? "(none)"}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

function AxisPreset({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded px-2 py-0.5 text-[11px] font-mono transition-colors " +
        (active
          ? "bg-teal-700/40 text-teal-200"
          : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800")
      }
    >
      {children}
    </button>
  );
}

function isAxis(actual: Vec3, target: Vec3): boolean {
  const tol = 1e-3;
  return (
    Math.abs(actual[0] - target[0]) < tol &&
    Math.abs(actual[1] - target[1]) < tol &&
    Math.abs(actual[2] - target[2]) < tol
  );
}

function negate(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

function LinkEditor({ eid, link }: { eid: string; link: LinkComponent }) {
  const update = useUpdateComponent();
  const i = link.inertial.inertia;

  const setMass = (mass: number) =>
    update.mutate({
      entityId: eid,
      key: "link",
      updates: { inertial: { ...link.inertial, mass } },
    });

  const writeCollisions = (collisions: Geometry[]) =>
    update.mutate({ entityId: eid, key: "link", updates: { collisions } });

  const addPrimitive = (kind: "box" | "sphere" | "cylinder") => {
    const def: Geometry =
      kind === "box"
        ? { primitive: "box", primitive_params: { x: 0.1, y: 0.1, z: 0.1 } }
        : kind === "sphere"
        ? { primitive: "sphere", primitive_params: { radius: 0.05 } }
        : { primitive: "cylinder", primitive_params: { radius: 0.05, length: 0.2 } };
    def.origin = [0, 0, 0];
    def.origin_rotation = [0, 0, 0, 1];
    writeCollisions([...link.collisions, def]);
  };

  return (
    <>
      <Section label="Link · inertial">
        <Row label="mass">
          <NumberField value={link.inertial.mass} step={0.1} onCommit={setMass} />
        </Row>
        <Row label="diag">
          <div className="grid grid-cols-3 gap-1 text-[11px]">
            <span className="text-zinc-500">ixx={fmt(i.ixx)}</span>
            <span className="text-zinc-500">iyy={fmt(i.iyy)}</span>
            <span className="text-zinc-500">izz={fmt(i.izz)}</span>
          </div>
        </Row>
        <Row label="visuals">
          <span className="text-zinc-500 text-xs">{link.visuals.length}</span>
        </Row>
      </Section>
      <Section
        label="Collision shapes"
        action={
          <div className="flex gap-1">
            <AddShapeBtn onClick={() => addPrimitive("box")}>+ box</AddShapeBtn>
            <AddShapeBtn onClick={() => addPrimitive("sphere")}>+ sphere</AddShapeBtn>
            <AddShapeBtn onClick={() => addPrimitive("cylinder")}>+ cyl</AddShapeBtn>
          </div>
        }
      >
        {link.collisions.length === 0 && (
          <div className="px-2 py-1 text-[11px] italic text-zinc-500">
            none — backend collision check uses meshes when no shapes are set
          </div>
        )}
        {link.collisions.map((geom, idx) => (
          <CollisionShapeRow
            key={idx}
            geom={geom}
            index={idx}
            onChange={(updated) => {
              const next = [...link.collisions];
              next[idx] = updated;
              writeCollisions(next);
            }}
            onRemove={() => writeCollisions(link.collisions.filter((_, i) => i !== idx))}
          />
        ))}
      </Section>
    </>
  );
}

function AddShapeBtn({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700"
    >
      {children}
    </button>
  );
}

function CollisionShapeRow({
  geom,
  index,
  onChange,
  onRemove,
}: {
  geom: Geometry;
  index: number;
  onChange: (g: Geometry) => void;
  onRemove: () => void;
}) {
  const kind = geom.primitive ?? (geom.mesh ? "mesh" : "?");
  const params = geom.primitive_params ?? {};

  const setParam = (k: string, v: number) =>
    onChange({ ...geom, primitive_params: { ...params, [k]: v } });
  const setOrigin = (origin: Vec3) => onChange({ ...geom, origin });

  return (
    <div className="rounded border border-zinc-800 px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-zinc-300">
          {index + 1}. {kind}
        </span>
        <button
          onClick={onRemove}
          className="text-[10px] text-zinc-500 hover:text-red-400"
          title="Remove this shape"
        >
          remove
        </button>
      </div>
      {kind === "box" && (
        <div className="grid grid-cols-3 gap-1">
          <NumberField value={params.x ?? 0.1} step={0.01} onCommit={(v) => setParam("x", v)} />
          <NumberField value={params.y ?? 0.1} step={0.01} onCommit={(v) => setParam("y", v)} />
          <NumberField value={params.z ?? 0.1} step={0.01} onCommit={(v) => setParam("z", v)} />
        </div>
      )}
      {kind === "sphere" && (
        <Row label="radius">
          <NumberField
            value={params.radius ?? 0.05}
            step={0.01}
            onCommit={(v) => setParam("radius", v)}
          />
        </Row>
      )}
      {kind === "cylinder" && (
        <>
          <Row label="radius">
            <NumberField
              value={params.radius ?? 0.05}
              step={0.01}
              onCommit={(v) => setParam("radius", v)}
            />
          </Row>
          <Row label="length">
            <NumberField
              value={params.length ?? 0.2}
              step={0.01}
              onCommit={(v) => setParam("length", v)}
            />
          </Row>
        </>
      )}
      <Row label="origin">
        <Vec3Input
          value={(geom.origin ?? [0, 0, 0]) as Vec3}
          onChange={setOrigin}
          step={0.01}
        />
      </Row>
    </div>
  );
}

function ComponentList({ components }: { components: Record<string, unknown> }) {
  const keys = Object.keys(components).filter(
    (k) => !["transform", "joint", "link"].includes(k)
  );
  if (keys.length === 0) return null;
  return (
    <Section label="Other components">
      {keys.map((k) => (
        <div key={k} className="text-xs text-zinc-400">
          {k}
        </div>
      ))}
    </Section>
  );
}

function Section({
  label,
  children,
  action,
}: {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
        {action}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-center gap-2">
      <span className="text-[11px] text-zinc-400">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-3 text-xs text-zinc-500">{children}</div>;
}

function PanelShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col bg-zinc-900">
      <div className="border-b border-zinc-800 px-3 py-1.5 text-xs uppercase tracking-wide text-zinc-400">
        {title}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

function fmt(v: number): string {
  if (v === 0) return "0";
  if (Math.abs(v) < 0.001) return v.toExponential(2);
  return v.toFixed(4);
}
