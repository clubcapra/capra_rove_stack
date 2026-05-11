// TypeScript mirrors of the Python core models. These match the JSON shape
// the API returns (which is the canonical TOML-shaped dict).

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // (x, y, z, w)

export interface TransformComponent {
  position?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
}

export interface InertiaTensor {
  ixx: number;
  iyy: number;
  izz: number;
  ixy: number;
  ixz: number;
  iyz: number;
}

export interface Inertial {
  mass: number;
  origin?: Vec3;
  origin_rotation?: Quat;
  inertia: InertiaTensor;
}

export interface Geometry {
  mesh?: string | null;
  primitive?: string | null;
  primitive_params?: Record<string, number>;
  material?: string | null;
  origin?: Vec3;
  origin_rotation?: Quat;
  scale?: Vec3;
}

export interface LinkComponent {
  inertial: Inertial;
  visuals: Geometry[];
  collisions: Geometry[];
}

export interface JointLimits {
  lower: number;
  upper: number;
  effort: number;
  velocity: number;
}

export interface JointDynamics {
  damping: number;
  friction: number;
}

export type JointType =
  | "revolute"
  | "continuous"
  | "prismatic"
  | "fixed"
  | "floating"
  | "planar"
  | "ball";

export interface JointComponent {
  type: JointType;
  axis: Vec3;
  parent_link: string;
  child_link: string;
  limits?: JointLimits | null;
  dynamics?: JointDynamics | null;
  // Flips rotation/translation direction. The exported engine and the
  // morpher both honour this so the velocity the IK emits matches what
  // the real arm expects.
  inverted?: boolean;
}

export interface Entity {
  id?: string;
  name: string;
  parent?: string | null;
  children?: string[];
  components?: {
    transform?: TransformComponent;
    link?: LinkComponent;
    joint?: JointComponent;
    [key: string]: unknown;
  };
}

export interface SceneDoc {
  entities: Record<string, Entity>;
}

export interface ProjectSummary {
  name: string;
  entity_count: number;
  link_count: number;
  joint_count: number;
  material_count: number;
  roots: string[];
}

export interface DiagnosticOut {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  entity_id: string | null;
}

export interface FKResponse {
  transforms: Record<string, number[][]>;
}

export interface ChainResponse {
  base: string;
  tip: string;
  joints: string[];
}
