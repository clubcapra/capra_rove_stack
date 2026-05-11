# ForgeBOT — Universal Automation Editor

> A universal editor for robots, assembly lines, shop floors, and industrial automation.
> One tool to model, connect, and export to every major robotics format.

---

## 1. Vision & Scope

### What This Is

ForgeBOT is a desktop/web application for designing and editing:

- **Robots** — articulated arms, mobile bases, humanoids, grippers, custom kinematic chains
- **Assembly Lines** — conveyors, stations, pick-and-place cells, buffers
- **Shop Floors** — machine layouts, work cells, safety zones, material flow
- **Interconnections** — signals between machines, I/O mappings, communication buses, data flow
- **Digital Twins** — sensor placements, actuator configs, control interfaces, simulation-ready models

### What It Solves

There is no single tool today that lets you visually build a robot model and export it to URDF, MJCF, SDF, and USD. ForgeBOT fills that gap with a clean editor and a universal intermediate format that round-trips losslessly to all major targets.

### Core Principles

- **One source of truth** — the `.forgebot` file is the canonical representation
- **Format-agnostic** — import from anything, export to everything
- **Visual-first** — 3D editing with real-time preview, not XML by hand
- **Automation-complete** — not just robots; entire production environments
- **Extensible** — plugin architecture for new entity types, formats, and tools

---

## 2. Architecture Overview

| Layer | Role | Language |
|-------|------|----------|
| **Core Library** | Data model, validation, kinematics, transforms, serialization | Python |
| **Format Adapters** | Import/export for each target format | Python |
| **Backend API** | FastAPI server exposing core to the frontend | Python |
| **3D Editor** | Visual editing, viewport, gizmos, interaction | TypeScript + Three.js |
| **Frontend UI** | Panels, property editors, scene tree, toolbar | React + TypeScript |
| **CLI** | Headless conversion, validation, batch ops | Python (Click) |

---

## 3. Core Data Model — `.forgebot` Format

### Design Philosophy

The `.forgebot` format uses a **ZIP container with TOML data files** and an **Entity-Component-System (ECS)** pattern. Every object in the scene is an Entity with a unique ID. Behavior and data are attached via Components.

**Why ZIP + TOML instead of JSON:**
- TOML supports inline comments — annotate joints, safety limits, calibration notes
- TOML has clean, readable syntax — far less visual noise than JSON braces/quotes
- TOML has strong typing — integers stay integers, floats stay floats
- ZIP bundles meshes and textures alongside data — single portable file
- ZIP allows partial reads — open a 500MB shop floor, only decompress what's needed
- Unzipped contents are git-diffable — track changes to individual TOML files
- Python stdlib has full support — `tomllib` (read), `tomli_w` (write), `zipfile`

### Archive Structure

```
my_robot.forgebot (ZIP archive)
├── manifest.toml              # Version, metadata, units, project info
├── scene.toml                 # Entity tree + all components
├── systems.toml               # Kinematic chains, signal graph, layout, flow paths
├── simulation.toml            # Physics config, controllers, gains
├── assets/
│   ├── materials.toml         # PBR material definitions
│   ├── meshes/
│   │   ├── base_visual.stl
│   │   ├── link1.glb
│   │   └── gripper.obj
│   └── textures/
│       └── steel_roughness.png
└── _source/                   # Optional: round-trip metadata from imports
    └── urdf_origin.toml
```

### manifest.toml

```toml
forgebot_version = "1.0.0"

[metadata]
name = "My 6DOF Arm"
author = "Jane Doe"
created = 2026-05-05T12:00:00Z
modified = 2026-05-05T14:30:00Z
description = "A 6-axis industrial arm with gripper"
tags = ["arm", "6dof", "industrial"]

[units]
length = "meters"
angle = "radians"
mass = "kilograms"

[storage]
scene_format = "toml"        # "toml" (default) or "msgpack" for large scenes
```

### scene.toml

```toml
[entities.ent_base_link]
name = "base_link"
children = ["ent_joint_1"]

[entities.ent_base_link.components.transform]
position = [0.0, 0.0, 0.0]
rotation = [0.0, 0.0, 0.0, 1.0]   # quaternion (x, y, z, w)
scale = [1.0, 1.0, 1.0]

[entities.ent_base_link.components.link.inertial]
mass = 5.0
origin = [0.0, 0.0, 0.05]

[entities.ent_base_link.components.link.inertial.inertia]
ixx = 0.01
iyy = 0.01
izz = 0.005
ixy = 0.0
ixz = 0.0
iyz = 0.0

[[entities.ent_base_link.components.link.visuals]]
mesh = "base_visual"
material = "steel"
origin = [0.0, 0.0, 0.0]

[[entities.ent_base_link.components.link.collisions]]
mesh = "base_collision"
origin = [0.0, 0.0, 0.0]

[entities.ent_joint_1]
name = "shoulder_pan"
parent = "ent_base_link"
children = ["ent_link_1"]

[entities.ent_joint_1.components.transform]
position = [0.0, 0.0, 0.1]
rotation = [0.0, 0.0, 0.0, 1.0]

[entities.ent_joint_1.components.joint]
type = "revolute"
axis = [0, 0, 1]
parent_link = "ent_base_link"
child_link = "ent_link_1"

[entities.ent_joint_1.components.joint.limits]
lower = -3.14
upper = 3.14
effort = 100.0
velocity = 1.5

[entities.ent_joint_1.components.joint.dynamics]
damping = 0.5
friction = 0.1
```

### Component Registry

Built-in components:

| Component | Purpose | Attached To |
|-----------|---------|-------------|
| `transform` | Position, rotation, scale in parent frame | All entities |
| `link` | Rigid body: mass, inertia, visuals, collisions | Links |
| `joint` | Kinematic connection: type, axis, limits, dynamics | Joints |
| `sensor` | Sensor model: type, range, noise, update rate | Sensors |
| `actuator` | Motor/cylinder: type, force/torque limits, driver | Actuators |
| `end_effector` | Gripper/tool: type, grasp width, payload | Tools |
| `conveyor` | Belt/roller: speed, width, length, direction | Conveyors |
| `signal_port` | I/O interface: direction, data type, protocol | Any |
| `controller` | Control logic reference: type, gains, target | Controllers |
| `safety_zone` | Bounding region: class, speed limits, behavior | Zones |
| `metadata` | User-defined key-value pairs, tags, notes | Any |

### ID Convention

All entity IDs use a prefixed UUID-short format: `ent_{type}_{8hex}` (e.g., `ent_link_a3f2b1c0`).

---

## 4. Module Breakdown

### `forgebot.core.model`

Defines all data structures.

- `entity.py` — Base Entity class
- `scene.py` — Scene graph: entity tree, lookup, traversal
- `project.py` — Project file: metadata, assets, scene, sim config
- `units.py` — Unit system and conversion
- `components/` — One file per component, registered via decorator

### `forgebot.core.kinematics`

- `chain.py` — KinematicChain extraction from scene graph
- `forward.py` — FK solver (transform-based)
- `inverse.py` — IK solver (numerical, Jacobian-based) [phase 2]
- `dh.py` — DH parameter extraction and conversion

### `forgebot.core.validation`

- `scene_validator.py` — Tree integrity, no cycles, connected graph
- `physics_validator.py` — Mass > 0, valid inertia tensors, sane limits
- `kinematic_validator.py` — Chain continuity, joint-link pairing
- `rules.py` — Diagnostic types: Warning vs Error vs Info

### `forgebot.io.serializer`

- `forgebot_file.py` — `.forgebot` ZIP archive read/write (top-level API)
- `toml_codec.py` — TOML read (tomllib) / write (tomli_w)
- `msgpack_codec.py` — MessagePack codec for large scenes
- `versioning.py` — Schema migration between `.forgebot` versions
- `asset_manager.py` — Mesh/texture packing into ZIP

**File I/O strategy:**
- `.forgebot` is always a ZIP archive
- On save: serialize Project → TOML strings → write into ZIP
- On load: open ZIP → read `manifest.toml` → load scene in declared format → resolve mesh refs

### `forgebot.io.importers` / `forgebot.io.exporters`

Each is a standalone module implementing `BaseImporter` / `BaseExporter`.

```python
class BaseImporter(ABC):
    @abstractmethod
    def can_import(self, file_path: Path) -> bool: ...

    @abstractmethod
    def import_file(self, file_path: Path, options: ImportOptions) -> Project: ...

    @abstractmethod
    def supported_extensions(self) -> list[str]: ...
```

```python
class BaseExporter(ABC):
    @abstractmethod
    def export(self, project: Project, output_path: Path, options: ExportOptions) -> ExportResult: ...

    @abstractmethod
    def supported_formats(self) -> list[str]: ...

    @abstractmethod
    def validate_before_export(self, project: Project) -> list[Diagnostic]: ...
```

### `forgebot.api`

FastAPI backend. Routes are thin — parse, delegate to core, return.

### `forgebot.cli`

`convert`, `validate`, `inspect`, `create`, `editor`.

---

## 5. Format Capability Matrix

| Feature | URDF | MJCF | SDF | USD | .forgebot |
|---------|------|------|-----|-----|-----------|
| Kinematic tree | ✓ | ✓ | ✓ | ✓ | ✓ |
| Closed-loop chains | ✗ | ✓ | ✓ | ✓ | ✓ |
| Multiple robots | ✗ | ✓ | ✓ | ✓ | ✓ |
| Sensors | ✗ | ✓ | ✓ | partial | ✓ |
| Actuator models | partial | ✓ | ✓ | ✗ | ✓ |
| Materials (PBR) | partial | partial | partial | ✓ | ✓ |
| Physics config | ✗ | ✓ | ✓ | ✓ | ✓ |
| Assembly/layout | ✗ | ✗ | ✓ | ✓ | ✓ |
| Signal graph | ✗ | ✗ | ✗ | ✗ | ✓ |
| Flow paths | ✗ | ✗ | ✗ | ✗ | ✓ |

When exporting to a format that doesn't support a feature, the exporter:
1. Logs a warning via `Diagnostic`
2. Drops the unsupported data gracefully
3. Adds comments in the output noting what was omitted

### Lossless Round-Trip Strategy

`.forgebot` stores a `_source` field on each component tracking which importer created it and the original element name/attributes.

---

## 6. 3D Editor (Frontend)

### Tech Stack

- **Three.js** via `@react-three/fiber` (R3F)
- **@react-three/drei** for gizmos, orbit controls, grids
- **React** for all UI panels
- **Zustand** for editor state
- **React Query** for API calls

### Layout

- Left: Scene tree panel
- Center: 3D viewport (R3F Canvas)
- Right: Properties panel (auto-generated from component schemas)
- Bottom: Tabbed (Joint sliders, Diagnostics, Console, Import/Export log)
- Top: Toolbar

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `G` / `R` / `S` | Grab/Rotate/Scale selected |
| `X/Y/Z` | Constrain to axis |
| `Delete` | Delete selected |
| `Ctrl+D` | Duplicate |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `F` | Frame selected |
| `1/2/3` | Front/Right/Top ortho views |
| `Ctrl+S` / `Ctrl+E` / `Ctrl+I` | Save / Export / Import |

---

## 7. Design Patterns

| Pattern | Where | Why |
|---------|-------|-----|
| **ECS** | Core model | Composition over inheritance |
| **Registry** | Components, importers, exporters | Plugin auto-discovery |
| **Strategy** | Format adapters | Swap formats without core changes |
| **Observer** | Scene change → UI | Decoupled model-view sync |
| **Command** | Undo/redo | Every edit is a reversible object |
| **Visitor** | Validators, exporters | Separate traversal from operations |
| **Factory** | Entity templates | Create complex entities by name |
| **Facade** | API routes | Clean interface over core |
| **Adapter** | Format converters | Translate incompatible interfaces |
| **Mediator** | Signal graph | Entities communicate through graph |

### Undo/Redo

```python
class Command(ABC):
    @abstractmethod
    def execute(self, scene: Scene) -> None: ...

    @abstractmethod
    def undo(self, scene: Scene) -> None: ...

    @property
    @abstractmethod
    def description(self) -> str: ...
```

---

## 8. Tech Stack

### Backend (Python)

| Package | Purpose |
|---------|---------|
| `pydantic` v2 | Data models, validation, serialization |
| `fastapi` | REST + WebSocket API |
| `uvicorn` | ASGI server |
| `tomli_w` | TOML writing (read via stdlib `tomllib`) |
| `tomlkit` | Comment-preserving TOML round-trip (optional) |
| `msgpack` | MessagePack codec for large scenes |
| `spatialmath-python` | SE3, SO3, transforms, kinematics |
| `numpy` | Numeric computation |
| `trimesh` | Mesh loading, inertia computation |
| `lxml` | XML parsing for URDF, MJCF, SDF |
| `typer` | CLI framework |
| `pytest` | Testing |

### Frontend (TypeScript)

| Package | Purpose |
|---------|---------|
| `react` | UI framework |
| `@react-three/fiber` | Three.js in React |
| `@react-three/drei` | Helpers |
| `three` | 3D engine |
| `zustand` | State management |
| `@tanstack/react-query` | API data fetching |
| `tailwindcss` | Styling |
| `vite` | Build tool |

---

## 9. Build Phases

### Phase 1 — Foundation (Weeks 1-3)

**Goal:** Core data model, URDF import/export, basic 3D viewer.

Backend:
- [x] Python project scaffold (pyproject.toml, ruff, black)
- [x] `Entity`, `Scene`, `Project` models
- [x] Core components: `transform`, `link`, `joint`
- [x] `.forgebot` ZIP+TOML save/load
- [x] URDF importer + exporter
- [x] Validators (scene, physics, kinematic)
- [x] FK solver
- [x] CLI: `convert`, `validate`, `inspect`
- [ ] FastAPI server

Frontend:
- [ ] React + Vite + Tailwind + R3F scaffold
- [ ] AppShell with resizable panels
- [ ] Viewport: grid, orbit, mesh rendering
- [ ] Scene tree panel
- [ ] Properties panel for transform + link + joint

**Deliverable:** Load a URDF, see it in 3D, edit joint limits, export back to URDF.

### Phase 2 — Multi-Format & Editing

- MJCF, SDF, DH importers/exporters
- Command system (undo/redo)
- IK solver
- Sensor and actuator components
- WebSocket real-time sync
- Scene tree drag-drop, keyboard shortcuts, IK drag in viewport

### Phase 3 — Automation & Layout

- Conveyor, signal graph, safety zone, flow path components
- USD, STEP, RTB exporters
- Floor plan mode, signal graph editor, multi-robot scenes
- Plugin system

### Phase 4 — Polish & Distribution

- Electron packaging
- Project templates
- Documentation site
- CI/CD

---

## Appendix A: Format Mappings

### URDF → ForgeBOT

| URDF | ForgeBOT |
|------|----------|
| `<link>` | Entity + `link` component |
| `<joint>` | Entity + `joint` component |
| `<visual>` | `link.visuals[]` |
| `<collision>` | `link.collisions[]` |
| `<inertial>` | `link.inertial` |
| `<material>` | Asset in `assets.materials` |
| `<mesh>` | Asset in `assets.meshes` |
| `<gazebo>` | `metadata` component |
| `<transmission>` | `actuator` component |

### MJCF → ForgeBOT

| MJCF | ForgeBOT |
|------|----------|
| `<body>` | Entity + `link` component |
| `<joint>` | Entity + `joint` component |
| `<geom>` | `link.visuals[]` + `link.collisions[]` |
| `<site>` | Entity + `transform` |
| `<sensor>` | Entity + sensor component |
| `<actuator>` | `actuator` component |
| `<option>` | `simulation.physics` |

### SDF → ForgeBOT

| SDF | ForgeBOT |
|-----|----------|
| `<model>` | Top-level entity group |
| `<link>` | Entity + `link` component |
| `<joint>` | Entity + `joint` component |
| `<sensor>` | Entity + sensor component |
| `<world>` | Project-level scene |
| `<plugin>` | `metadata` component |

---

## Appendix B: CLI Examples

```bash
# Convert URDF to MJCF
forgebot convert panda.urdf -o panda.mjcf

# Validate a file
forgebot validate panda.urdf

# Inspect tree
forgebot inspect panda.urdf --format tree

# Create from DH parameters
forgebot create arm --dh params.csv -o my_arm.forgebot

# Launch editor
forgebot editor my_project.forgebot
```

---

## Appendix C: Naming Conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Entity IDs | `ent_{type}_{8hex}` | `ent_link_a3f2b1c0` |
| Component keys | `snake_case` | `force_torque` |
| Python files | `snake_case.py` | `urdf_importer.py` |
| Python classes | `PascalCase` | `URDFImporter` |
| TypeScript files | `PascalCase.tsx` | `SceneTreePanel.tsx` |
| API routes | `/api/v1/{resource}` | `/api/v1/entities` |
| CLI commands | `kebab-case` | `forgebot convert` |
| Test files | `test_{module}.py` | `test_urdf_roundtrip.py` |
