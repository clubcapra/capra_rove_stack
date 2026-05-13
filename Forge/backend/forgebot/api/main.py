"""FastAPI app entry point. Run with `uvicorn forgebot.api.main:app`."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .. import __version__
from .routes import (
    assets,
    bindings,
    camera,
    debug,
    entities,
    import_export,
    kinematics,
    library,
    lidar,
    parts,
    project,
    projects,
    scene,
    validation,
)
from .websocket import router as ws_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="ForgeBOT API",
        version=__version__,
        description="Universal robot and automation editor — backend",
    )

    # Permissive CORS for local dev; tighten before public deployment.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(project.router)
    app.include_router(scene.router)
    app.include_router(entities.router)
    app.include_router(validation.router)
    app.include_router(kinematics.router)
    app.include_router(import_export.router)
    app.include_router(assets.router)
    app.include_router(parts.router)
    app.include_router(library.router)
    app.include_router(projects.router)
    app.include_router(bindings.router)
    app.include_router(lidar.router)
    app.include_router(camera.router)
    app.include_router(debug.router)
    app.include_router(ws_router)

    @app.on_event("shutdown")
    async def _shutdown_go2rtc() -> None:
        # Best-effort: stop the bridge subprocess on app exit so
        # we don't leak it across uvicorn restarts.
        from ..integrations.camera.go2rtc_manager import get_manager
        await get_manager().shutdown()

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "version": __version__}

    return app


app = create_app()
