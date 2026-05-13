"""Import/export routes: trigger format conversions on the in-memory project."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ...io.exporters import find_exporter
from ...io.exporters.base import ExportOptions
from ...io.importers import find_importer
from ..state import get_state

router = APIRouter(prefix="/api/v1/io", tags=["io"])


@router.post("/import")
async def import_file(file: UploadFile) -> dict:
    state = get_state()
    suffix = Path(file.filename or "uploaded").suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)
    try:
        importer = find_importer(tmp_path)
        if importer is None:
            raise HTTPException(status_code=400, detail=f"no importer for {file.filename}")
        result = importer.import_file(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)
    state.replace_project(result.project)
    return {
        "ok": True,
        "diagnostics": [
            {"severity": d.severity.value, "code": d.code, "message": d.message}
            for d in result.diagnostics
        ],
    }


@router.get("/export")
def export_file(
    fmt: str,
    base: str | None = None,
    tip: str | None = None,
) -> FileResponse:
    """Export the current project as a self-contained zip bundle.

    For URDF/MJCF/SDF, the bundle contains the format file and its
    referenced assets. For `ik_engine`, the bundle is a runnable Python
    UDP server with the chain + IK profile + URDF baked in — `base` and
    `tip` query params are required to pick the kinematic chain.
    """
    state = get_state()
    exporter = find_exporter(fmt)
    if exporter is None:
        raise HTTPException(status_code=400, detail=f"no exporter for format {fmt!r}")

    project = state.project
    name = (project.manifest.metadata.name or "robot").strip().replace(" ", "_") or "robot"

    # ik_engine writes to a *directory* (run.py at root, engine/, data/);
    # the other formats write a single file with siblings folders. Both
    # zip up cleanly from `work_dir`, but the path passed to the
    # exporter differs.
    options = None
    if fmt == "ik_engine":
        if not base or not tip:
            raise HTTPException(
                status_code=400,
                detail="fmt=ik_engine requires `base` and `tip` query params (entity IDs)",
            )
        options = ExportOptions(extras={"base": base, "tip": tip})

    work_dir = Path(tempfile.mkdtemp(prefix="forgebot_export_"))
    try:
        if fmt == "ik_engine":
            out_path = work_dir / f"{name}_ik_engine"
        else:
            suffix = f".{fmt}"
            out_path = work_dir / f"{name}{suffix}"
        result = exporter.export(project, out_path, options=options)
        if any(d.is_error for d in result.diagnostics):
            raise HTTPException(
                status_code=400,
                detail={
                    "errors": [
                        {"code": d.code, "message": d.message}
                        for d in result.diagnostics
                        if d.is_error
                    ]
                },
            )

        # Zip everything in `work_dir` (the format file + its sibling asset
        # folders). FileResponse takes the file path; tempfile cleanup
        # happens via mkdtemp's directory which we leave for FastAPI to
        # finish reading from before we'd remove it (the zip itself lives
        # outside `work_dir` so we can clean `work_dir` safely).
        zip_fd, zip_str = tempfile.mkstemp(prefix=f"{name}_{fmt}_", suffix=".zip")
        Path(zip_str).unlink()  # mkstemp creates the file; we want it fresh
        zip_path = Path(zip_str)
        with ZipFile(zip_path, "w", ZIP_DEFLATED) as zf:
            for f in sorted(work_dir.rglob("*")):
                if f.is_file():
                    zf.write(f, arcname=f.relative_to(work_dir))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
        # zip_fd was opened by mkstemp; close to release its handle.
        try:
            import os
            os.close(zip_fd)
        except (NameError, OSError):
            pass

    return FileResponse(
        zip_path,
        filename=f"{name}_{fmt}.zip",
        media_type="application/zip",
    )
