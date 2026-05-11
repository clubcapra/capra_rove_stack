"""CAD/mesh format converters.

  - STEP/IGES -> GLB via `cascadio` (lightweight OCCT wrapper).
    cascadio reads the STEP unit declaration internally and emits GLB in
    meters per glTF spec, so we don't need to post-scale.
  - All mesh formats already supported by trimesh pass through unchanged.

`merge_primitives=False` keeps each CAD face as its own Mesh primitive in
the GLB, which the editor's snap-to-feature workflow relies on (it treats
each leaf Mesh as one CAD face for centroid / edge / vertex picking).
"""

from __future__ import annotations

import tempfile
from pathlib import Path

# Suffixes the browser already handles natively via three.js loaders.
NATIVE_SUFFIXES = {".stl", ".obj", ".glb", ".gltf", ".ply"}
# Suffixes we convert server-side to GLB.
CAD_SUFFIXES = {".step", ".stp", ".iges", ".igs"}


class ConversionError(RuntimeError):
    pass


def supported_suffixes() -> set[str]:
    return NATIVE_SUFFIXES | CAD_SUFFIXES


def convert_to_browser_mesh(data: bytes, suffix: str) -> tuple[bytes, str]:
    """Return `(out_bytes, out_suffix)` ready for the frontend mesh loaders."""
    sfx = suffix.lower()
    if not sfx.startswith("."):
        sfx = "." + sfx

    if sfx in NATIVE_SUFFIXES:
        return data, sfx

    if sfx in CAD_SUFFIXES:
        return _step_to_glb(data, sfx), ".glb"

    raise ConversionError(f"unsupported mesh suffix: {sfx}")


def _step_to_glb(step_data: bytes, suffix: str) -> bytes:
    try:
        import cascadio  # type: ignore[import-untyped]
    except ImportError as e:
        raise ConversionError(
            "cascadio is not installed; CAD conversion unavailable. "
            "Install with: pip install cascadio"
        ) from e

    with tempfile.TemporaryDirectory() as tmpd:
        in_path = Path(tmpd) / f"in{suffix}"
        out_path = Path(tmpd) / "out.glb"
        in_path.write_bytes(step_data)
        rc = cascadio.step_to_glb(
            str(in_path),
            str(out_path),
            tol_linear=0.5,        # mm in the STEP file's native units
            tol_angular=0.5,
            merge_primitives=False,  # keep per-face primitives for snap picking
            use_parallel=True,
        )
        if rc != 0 or not out_path.exists():
            raise ConversionError(f"cascadio failed (rc={rc})")
        return out_path.read_bytes()
