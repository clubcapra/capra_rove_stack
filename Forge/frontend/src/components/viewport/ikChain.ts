// Shared kinematic-chain helpers for the IK and Transform gizmos.
//
// Why category-bounded: a robot arm is usually mounted to a chassis (Base
// link → mount-joint → Core). Walking up to the *true* root drags the
// mount joint into the IK chain — DLS then prefers to pitch the entire
// arm via that single high-leverage joint instead of bending the arm.
// Limiting the chain to the same category as the tip keeps IK confined
// to the user's logical assembly (the "arm" subtree).

import type { Entity } from "../../types/model";

import { getCategory } from "../panels/category";

type EntityMap = Record<string, Entity>;

/**
 * IK base = the topmost link ancestor reachable from `tip`. Walks up the
 * kinematic tree via parent pointers; tracks every link encountered and
 * returns the highest one (i.e., the root of the chain).
 *
 * No category gating: a chassis-mount joint between the arm and a
 * "base" link is exactly what the user wants in the IK chain so the
 * arm can yaw. If specific joints should be excluded, that's a future
 * concern (per-joint metadata flag).
 */
export function findIkBase(entities: EntityMap, tipId: string): string {
  const tipE = entities[tipId];
  if (!tipE) return tipId;
  let result = tipId;
  let cur: string | null | undefined = tipE.parent;
  for (let i = 0; i < 64 && cur; i++) {
    const e = entities[cur];
    if (!e) break;
    if (e.components?.link) result = cur;
    cur = e.parent;
  }
  return result;
}

/**
 * Count movable joints (revolute / continuous / prismatic) between `tip`
 * and the IK base. Used by the rotate gizmo to decide whether the chain
 * has enough DOFs to support TCP-offset rotation, or whether to fall
 * back to direct-link rotation (single-joint elements like flippers).
 */
export function countMovableJoints(entities: EntityMap, tipId: string): number {
  const baseId = findIkBase(entities, tipId);
  let count = 0;
  let cur: string | null | undefined = entities[tipId]?.parent;
  for (let i = 0; i < 64 && cur; i++) {
    if (cur === baseId) break;
    const e = entities[cur];
    if (!e) break;
    const j = (e.components as { joint?: { type: string } } | undefined)?.joint;
    if (j && j.type !== "fixed") count++;
    cur = e.parent;
  }
  return count;
}

/**
 * True if there's at least one movable joint between `tip` and the IK base
 * (using the category-bounded base). Used to decide whether translate
 * mode should run IK or rigid-body move.
 */
export function hasMovableJointInChain(entities: EntityMap, tipId: string): boolean {
  const baseId = findIkBase(entities, tipId);
  if (baseId === tipId) return false;
  let cur: string | null | undefined = entities[tipId]?.parent;
  for (let i = 0; i < 64 && cur; i++) {
    if (cur === baseId) return false;
    const e = entities[cur];
    if (!e) return false;
    const j = (e.components as { joint?: { type: string } } | undefined)?.joint;
    if (j && j.type !== "fixed") return true;
    cur = e.parent;
  }
  return false;
}
