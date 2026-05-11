# ForgeBOT

Universal editor for robots, assembly lines, and shop floors. One canonical format that round-trips to URDF, MJCF, SDF, USD.

## Status

Phase 1 (foundation) — backend in progress. See `FORGEBOT_PROJECT_SPEC.md` for the full plan.

## Layout

```
backend/    Python core: data model, serializer, importers/exporters, CLI, API
frontend/   React + Three.js editor (planned)
docs/       Documentation
```

## Quick Start (backend)

```sh
cd backend
pip install -e ".[dev,mesh]"
pytest
forgebot --help
```

## CLI

```sh
forgebot convert panda.urdf -o panda.forgebot
forgebot convert panda.forgebot -o panda_out.urdf
forgebot validate panda.urdf
forgebot inspect panda.urdf
```

## License

MIT
