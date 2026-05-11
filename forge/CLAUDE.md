# ForgeBOT — Claude Code Instructions

## Project Overview
ForgeBOT is a universal robot and automation editor. Python backend (FastAPI) + React/Three.js frontend.
One tool to model robots, assembly lines, shop floors, and export to every major robotics format (URDF, MJCF, SDF, USD).

**Read FORGEBOT_PROJECT_SPEC.md for the complete architecture, data model, format mappings, and build phases.**

## Key Technical Decisions
- Entity-Component-System architecture for the data model
- `.forgebot` is a ZIP container with TOML data files inside — human-readable, commentable, meshes bundled
- Archive layout: `manifest.toml`, `scene.toml`, `systems.toml`, `simulation.toml`, `assets/` (meshes + textures)
- TOML read via stdlib `tomllib`, write via `tomli_w`, comment-preserving via `tomlkit` when available
- Optional MessagePack mode for large scenes (declared in `manifest.toml [storage]`)
- Pydantic v2 BaseModel for all components (validation + serialization for free)
- Component registry via `@register_component` decorator — new components need zero core changes
- Command pattern for undo/redo — every mutation is a reversible Command object
- Strategy pattern for importers/exporters — each is a standalone module implementing a base interface
- Zustand for frontend state, React Query for API calls, WebSocket for real-time sync
- `@react-three/fiber` for 3D viewport, `@react-three/drei` for gizmos and helpers

## Code Style
- Python: ruff for linting, black for formatting, strict type hints on every function
- TypeScript: strict mode, no `any` types, prefer interfaces over type aliases
- Test every importer/exporter with round-trip tests (import → export → reimport → compare)
- Every data structure must be a Pydantic model — no raw dicts for domain objects
- Serialization flow: Pydantic `.model_dump()` → TOML dict → `tomli_w.dumps()` → ZIP archive
- DRY: if you write the same 3 lines twice, extract a function
- KISS: prefer flat structures over deep nesting, TOML over custom binary, REST over GraphQL
- Single Responsibility: one file = one concern, one class = one job
- All entity IDs use format: `ent_{type}_{8hex}` (e.g., `ent_link_a3f2b1c0`)

## File Organization
```
backend/forgebot/core/model/       — Data model (entities, components, scene)
backend/forgebot/core/kinematics/  — FK, IK, DH conversion
backend/forgebot/core/validation/  — Scene and physics validators
backend/forgebot/core/commands/    — Undo/redo command objects
backend/forgebot/io/importers/     — One file per format (urdf_importer.py, etc.)
backend/forgebot/io/exporters/     — One file per format (urdf_exporter.py, etc.)
backend/forgebot/io/serializer/    — ZIP archive I/O, TOML codec, MessagePack codec, asset manager
backend/forgebot/api/              — FastAPI routes (thin — delegate to core)
backend/forgebot/cli/              — CLI commands
backend/tests/                     — Mirrors backend structure
backend/tests/fixtures/            — Real robot files for testing (URDF, MJCF, etc.)
frontend/src/components/viewport/  — All Three.js / R3F code lives here only
frontend/src/components/panels/    — UI panels (scene tree, properties, diagnostics)
frontend/src/components/layout/    — App shell, toolbar, status bar
frontend/src/stores/               — Zustand stores
frontend/src/api/                  — API client, WebSocket, React Query hooks
```

## How to Add Things

### New Component
1. Create `backend/forgebot/core/model/components/my_component.py`
2. Extend `BaseComponent`, add fields as Pydantic fields
3. Decorate with `@register_component("my_component")`
4. Add import to `components/__init__.py`
5. Frontend auto-generates property editor from schema — no extra UI code needed

### New Importer
1. Create `backend/forgebot/io/importers/xyz_importer.py`
2. Extend `BaseImporter`, implement `can_import()`, `import_file()`, `supported_extensions()`
3. Register in `importers/__init__.py`
4. Add fixture file to `tests/fixtures/`
5. Write round-trip test in `tests/io/test_xyz_roundtrip.py`

### New Exporter
1. Same pattern in `exporters/`
2. Always implement `validate_before_export()` — check for unsupported features
3. Log warnings for dropped data, never silently discard

### New API Route
1. Create in `backend/forgebot/api/routes/`
2. Keep routes thin: parse request, call core service, return response
3. Never put business logic in a route file

### New Viewport Feature
1. Create in `frontend/src/components/viewport/`
2. All Three.js imports must stay within the viewport directory
3. Communicate with panels through Zustand stores, not prop drilling

## Testing Requirements
- Every importer: load fixture → Project → export → reload → compare key properties
- Every component: `model_dump()` → `tomli_w.dumps()` → `tomllib.loads()` → constructor must be identical
- Every validator: test with valid input AND invalid input (expect correct Diagnostics)
- Every command: `execute()` then `undo()` must return scene to original state
- Run tests with: `cd backend && pytest`
- Minimum fixtures needed: Panda arm (URDF), Franka (MJCF), simple arm (SDF)

## Common Mistakes to Avoid
- Don't store computed data (FK results, derived transforms) in the model — compute on demand
- Don't import Three.js types anywhere outside `frontend/src/components/viewport/`
- Don't use mutable default arguments in Pydantic models (use `Field(default_factory=list)`)
- Don't skip validation in importers — always produce Diagnostics, even for warnings
- Don't hardcode unit conversions — use the `units` system in `core/model/units.py`
- Don't put XML/format-specific logic in core — that belongs in `io/`
- Don't make API routes that return the entire scene — use deltas via WebSocket
- Don't use `json.dumps()` for the .forgebot format — it's TOML inside ZIP, not JSON
- Don't read/write ZIP files manually — always go through `forgebot_file.py` which handles TOML/msgpack switching
- Don't forget: `tomllib` (stdlib) is read-only; use `tomli_w` for writing TOML

## Build Order (follow this sequence)
1. Core model: Entity, Scene, Project, components (transform, link, joint)
2. ZIP+TOML serializer (save/load .forgebot archives)
3. URDF importer + exporter (most common format, good test case)
4. Validators
5. CLI (convert, validate, inspect)
6. FastAPI server + basic routes
7. Frontend scaffold + viewport + scene tree
8. Properties panel + transform gizmo
9. More importers/exporters (MJCF, SDF, DH)
10. Command system (undo/redo)
11. Joint sliders + FK visualization
12. Automation components (conveyor, sensors, signal graph)
13. Shop floor layout tools
