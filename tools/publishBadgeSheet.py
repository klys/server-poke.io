#!/usr/bin/env python3
"""Publish Venova gym-badge icons to the asset-storage server.

The source game ships all badges as a single strip
`Graphics/Pictures/badges.png` (256x64) laid out as a 4x2 grid (four badges
per row, two rows), each cell 64x32. Badge indices are row-major:

    0 1 2 3
    4 5 6 7

matching the Essentials `$Trainer.badges[N]` indices the maps already use.
This slices the strip into eight tight PNGs and writes them to the
asset-storage tree so the Trainer Card can render each earned medal.

Icons land at <target>/badge-<N>.png and are served as
    /migration_exports/badges/venova/badge-<N>.png

Usage:
    python3 tools/publishBadgeSheet.py [<badges.png>] [--target <dir>] [--dry-run]
    # remote upload instead of local copy (nginx upload-api):
    python3 tools/publishBadgeSheet.py [<badges.png>] \
        --upload-url http://localhost:8090 --token $ASSET_UPLOAD_TOKEN

Re-running is safe: files are overwritten by name, nothing is deleted.
IMPORTANT: run this against prod asset storage too, or prod clients show the
numbered-medallion fallback instead of the real badge art.
"""
import argparse
import os
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

BADGE_ASSET_PATH = "migration_exports/badges/venova"
COLS, ROWS = 4, 2
BADGE_COUNT = COLS * ROWS
DEFAULT_SOURCE = os.path.expanduser(
    "~/Downloads/Venova Adventure/Graphics/Pictures/badges.png"
)


def slice_badges(sheet: Image.Image) -> list[Image.Image]:
    sheet = sheet.convert("RGBA")
    width, height = sheet.size
    cell_w, cell_h = width // COLS, height // ROWS
    icons: list[Image.Image] = []
    for index in range(BADGE_COUNT):
        col, row = index % COLS, index // COLS
        cell = sheet.crop(
            (col * cell_w, row * cell_h, col * cell_w + cell_w, row * cell_h + cell_h)
        )
        # Tighten to the badge's own pixels so every icon centers cleanly.
        bbox = cell.getbbox()
        icons.append(cell.crop(bbox) if bbox else cell)
    return icons


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish gym-badge icons.")
    parser.add_argument("source", nargs="?", default=DEFAULT_SOURCE)
    parser.add_argument("--target")
    parser.add_argument("--upload-url")
    parser.add_argument("--token", default=os.environ.get("ASSET_UPLOAD_TOKEN"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = Path(args.source)
    if not source.is_file():
        sys.exit(f"Badge strip not found: {source}")

    icons = slice_badges(Image.open(source))
    print(f"Sliced {len(icons)} badges from {source}")

    if args.dry_run:
        for index, icon in enumerate(icons):
            print(f"  badge-{index}.png {icon.size}")
        return

    if args.upload_url:
        import io
        import urllib.request

        if not args.token:
            sys.exit("--upload-url requires --token or ASSET_UPLOAD_TOKEN.")
        base = args.upload_url.rstrip("/")
        for index, icon in enumerate(icons):
            buffer = io.BytesIO()
            icon.save(buffer, format="PNG")
            request = urllib.request.Request(
                f"{base}/api/upload/{BADGE_ASSET_PATH}/badge-{index}.png",
                data=buffer.getvalue(),
                method="PUT",
                headers={
                    "Authorization": f"Bearer {args.token}",
                    "Content-Type": "image/png",
                },
            )
            with urllib.request.urlopen(request) as response:
                if response.status not in (200, 201, 204):
                    sys.exit(f"Upload failed for badge-{index}.png: {response.status}")
        print(f"Uploaded {len(icons)} badge icons to {base}/{BADGE_ASSET_PATH}/")
        return

    target = Path(
        args.target
        or os.environ.get("BADGE_ASSETS_DIR")
        or (Path.cwd() / ".." / "asset-storage" / "assets" / BADGE_ASSET_PATH)
    ).resolve()
    target.mkdir(parents=True, exist_ok=True)
    for index, icon in enumerate(icons):
        icon.save(target / f"badge-{index}.png")
    print(f"Wrote {len(icons)} badge icons to {target}")


if __name__ == "__main__":
    main()
