#!/usr/bin/env python3
"""Build the deterministic War Battles combat sheet from the pinned tutorial PNGs."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "defold" / "assets"
OUTPUT = ASSETS / "derived" / "tutorial-combat-sprites.png"
MANIFEST = ASSETS / "derived" / "tutorial-combat-sprites.json"
CELL = (128, 80)
GRID = (7, 2)
SHARED_ANCHOR = (64, 40)

SEQUENCES = (
    {
        "id": "tank-down",
        "paths": ("units/tank/down/1.png", "units/tank/down/2.png"),
        "anchor": (24, 24),
        "anchorMode": "vehicle-center",
        "playback": "PLAYBACK_LOOP_FORWARD",
        "fps": 8,
    },
    {
        "id": "rocket",
        "paths": (
            "buildings/turret-rocket/1.png",
            "buildings/turret-rocket/2.png",
            "buildings/turret-rocket/3.png",
        ),
        "anchor": (11, 6),
        "anchorMode": "projectile-center",
        "playback": "PLAYBACK_LOOP_FORWARD",
        "fps": 20,
    },
    {
        "id": "explosion",
        "paths": tuple(f"fx/explosion/{index}.png" for index in range(1, 10)),
        "anchor": (61, 35),
        "anchorMode": "effect-center",
        "playback": "PLAYBACK_ONCE_FORWARD",
        "fps": 16,
    },
)


def rgba_bbox(image: Image.Image) -> list[int] | None:
    bbox = image.getchannel("A").getbbox()
    return list(bbox) if bbox else None


def build() -> tuple[Image.Image, dict[str, object]]:
    sheet = Image.new("RGBA", (CELL[0] * GRID[0], CELL[1] * GRID[1]), (0, 0, 0, 0))
    animations: dict[str, object] = {}
    tile = 1
    edge_contacts: list[dict[str, object]] = []

    for sequence in SEQUENCES:
        start_tile = tile
        frames: list[dict[str, object]] = []
        for relative_path in sequence["paths"]:
            path = ASSETS / str(relative_path)
            with Image.open(path) as opened:
                image = opened.convert("RGBA")
            if image.width > CELL[0] or image.height > CELL[1]:
                raise ValueError(f"{relative_path} does not fit {CELL[0]}x{CELL[1]} cell")
            source_anchor = tuple(sequence["anchor"])
            paste_x = SHARED_ANCHOR[0] - source_anchor[0]
            paste_y = SHARED_ANCHOR[1] - source_anchor[1]
            column = (tile - 1) % GRID[0]
            row = (tile - 1) // GRID[0]
            sheet.alpha_composite(image, (column * CELL[0] + paste_x, row * CELL[1] + paste_y))
            bbox = rgba_bbox(image)
            contacts = None
            if bbox:
                contacts = {
                    "left": bbox[0] == 0,
                    "top": bbox[1] == 0,
                    "right": bbox[2] == image.width,
                    "bottom": bbox[3] == image.height,
                }
                if any(contacts.values()):
                    edge_contacts.append({"source": str(relative_path), "contacts": contacts})
            frames.append({
                "tile": tile,
                "source": str(relative_path),
                "sourceRect": [0, 0, image.width, image.height],
                "sourceAnchor": list(source_anchor),
                "opaqueBbox": bbox,
                "edgeContacts": contacts,
                "packedCell": [column * CELL[0], row * CELL[1], CELL[0], CELL[1]],
                "packedOffset": [paste_x, paste_y],
            })
            tile += 1
        animations[str(sequence["id"])] = {
            "startTile": start_tile,
            "endTile": tile - 1,
            "playback": sequence["playback"],
            "fps": sequence["fps"],
            "anchorMode": sequence["anchorMode"],
            "frames": frames,
        }

    manifest: dict[str, object] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "schemaVersion": 1,
        "source": {
            "tutorial": "defold/tutorial-war-battles",
            "licensedRevision": "645d9a1bc6c164237116e685694fca94021fc001",
            "resourceReference": "ts-defold/tsd-template-war-battles",
            "referenceRevision": "a3e6b8d066110d8607bada4cc7f456eefc529218",
            "artistCredit": "Luis Zuno",
            "license": "../../licenses/defold-tutorial-war-battles-MIT.txt",
        },
        "nativeTileSize": 16,
        "sheetSize": [sheet.width, sheet.height],
        "atlasCellSize": list(CELL),
        "grid": list(GRID),
        "sharedAnchor": list(SHARED_ANCHOR),
        "sampling": "nearest-neighbor",
        "padding": {
            "mode": "transparent-cell",
            "edgeExtrusion": 0,
            "reason": "The runtime uses nearest-neighbor sampling; transparent cell padding prevents animation bleed.",
        },
        "pixelCorrection": {
            "applied": False,
            "tool": None,
            "reason": "Pinned source files are native transparent pixel-art frames, not presentation-sheet crops; correction would alter source art without evidence of a defect.",
        },
        "animations": animations,
        "qa": {
            "edgeContacts": edge_contacts,
            "finding": "Explosion frames 5 and 6 touch the top of their authored 122x71 source canvases. They are preserved exactly and gain four pixels of transparent top padding in the runtime sheet.",
        },
    }
    return sheet, manifest


def encoded_png(image: Image.Image, path: Path) -> bytes:
    from io import BytesIO

    output = BytesIO()
    image.save(output, "PNG", optimize=False, compress_level=9)
    return output.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    sheet, manifest = build()
    png = encoded_png(sheet, OUTPUT)
    manifest["output"] = {
        "png": "tutorial-combat-sprites.png",
        "sha256": hashlib.sha256(png).hexdigest(),
        "defoldTileSource": "/main/tutorial-combat-sprites.tilesource",
    }
    metadata = (json.dumps(manifest, indent=2) + "\n").encode()

    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_bytes() != png:
            raise SystemExit(f"stale generated art: {OUTPUT}")
        if not MANIFEST.is_file() or MANIFEST.read_bytes() != metadata:
            raise SystemExit(f"stale generated metadata: {MANIFEST}")
        print("war-battles-art:fresh")
        return

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(png)
    MANIFEST.write_bytes(metadata)
    print(f"wrote {OUTPUT.relative_to(ROOT)} and {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
