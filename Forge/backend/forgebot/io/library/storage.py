"""User-side overrides on top of the built-in library catalog.

The base `LIBRARY` list in `catalog.py` is shipped with the package.
This module adds a layer of user-mutable additions/removals persisted
in `~/.forgebot/library_overrides.json`. The effective catalog the API
serves is `(base - removed) + added`.

Schema:

    {
      "removed_ids": ["dji_mid360", ...],
      "added": [ <AssetEntry-shaped dicts> ]
    }

Loaders for added entries must already exist in `loaders.LOADERS` —
adding a new loader is still a code change. In practice, the
`remote_step` loader covers most "add this STEP url as a part" cases.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from .catalog import LIBRARY, AssetEntry

OVERRIDES_PATH = Path.home() / ".forgebot" / "library_overrides.json"


def _read_overrides() -> dict:
    if not OVERRIDES_PATH.is_file():
        return {"removed_ids": [], "added": []}
    try:
        with OVERRIDES_PATH.open("r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"removed_ids": [], "added": []}
    data.setdefault("removed_ids", [])
    data.setdefault("added", [])
    return data


def _write_overrides(data: dict) -> None:
    OVERRIDES_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OVERRIDES_PATH.open("w") as f:
        json.dump(data, f, indent=2, sort_keys=True)


def effective_library() -> list[AssetEntry]:
    """Base catalog minus removed-ids, with user-added entries appended."""
    overrides = _read_overrides()
    removed = set(overrides["removed_ids"])
    out: list[AssetEntry] = [e for e in LIBRARY if e.id not in removed]
    for raw in overrides["added"]:
        try:
            out.append(AssetEntry(**raw))
        except TypeError:
            continue
    return out


def find_effective_entry(asset_id: str) -> AssetEntry | None:
    for e in effective_library():
        if e.id == asset_id:
            return e
    return None


def add_entry(entry: AssetEntry) -> AssetEntry:
    if find_effective_entry(entry.id) is not None:
        raise ValueError(f"asset_id {entry.id!r} already exists")
    data = _read_overrides()
    # If it's a built-in marked-removed, un-remove instead of double-adding.
    if entry.id in data["removed_ids"] and any(b.id == entry.id for b in LIBRARY):
        data["removed_ids"].remove(entry.id)
    else:
        data["added"].append(asdict(entry))
    _write_overrides(data)
    return entry


def remove_entry(asset_id: str) -> bool:
    """Hide a built-in (mark removed) or drop a user-added entry. Returns
    True if anything actually changed."""
    data = _read_overrides()
    changed = False
    # User-added: drop from `added`.
    new_added = [e for e in data["added"] if e.get("id") != asset_id]
    if len(new_added) != len(data["added"]):
        data["added"] = new_added
        changed = True
    # Built-in: add to `removed_ids` so it's hidden from the effective list.
    if any(b.id == asset_id for b in LIBRARY) and asset_id not in data["removed_ids"]:
        data["removed_ids"].append(asset_id)
        changed = True
    if changed:
        _write_overrides(data)
    return changed
