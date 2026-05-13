// Categorization helpers for the scene tree.
//
// A category is whatever string sits at metadata.tags[0]. If no metadata
// component is attached, we auto-detect a sensible default from the
// entity's other components (e.g. a link with a `lidar` component is a
// "Sensor"). Users override by editing the category in the Properties
// panel; the change writes metadata.tags = [chosen] via attachComponent.

import type { Entity } from "../../types/model";

export const PRESET_CATEGORIES = [
  "arm",
  "sensor",
  "tool",
  "conveyor",
  "controller",
  "fixture",
  "other",
] as const;

export type PresetCategory = (typeof PRESET_CATEGORIES)[number];

const SENSOR_KEYS = new Set(["sensor", "camera", "lidar", "imu", "force_torque"]);

export function getCategory(entity: Entity): string {
  const components = entity.components as Record<string, unknown> | undefined;
  // 1. Explicit user-set tag wins.
  const meta = components?.metadata as { tags?: string[] } | undefined;
  if (meta?.tags && meta.tags.length > 0 && meta.tags[0]) {
    return meta.tags[0];
  }
  // 2. Auto-detect from components.
  return detectCategory(components ?? {});
}

function detectCategory(components: Record<string, unknown>): string {
  // Order matters: sensor / tool / conveyor before generic link.
  for (const key of Object.keys(components)) {
    if (SENSOR_KEYS.has(key)) return "sensor";
  }
  if ("end_effector" in components) return "tool";
  if ("conveyor" in components) return "conveyor";
  if ("controller" in components) return "controller";
  if ("safety_zone" in components || "signal_port" in components) return "other";
  if ("joint" in components) return "arm";
  if ("link" in components) return "arm";
  return "other";
}

export function categoryColor(category: string): string {
  switch (category) {
    case "arm":
      return "#22d3ee"; // cyan
    case "sensor":
      return "#a78bfa"; // violet
    case "tool":
      return "#f59e0b"; // amber
    case "conveyor":
      return "#34d399"; // emerald
    case "controller":
      return "#f472b6"; // pink
    case "fixture":
      return "#94a3b8"; // slate
    default:
      return "#a1a1aa"; // zinc
  }
}
