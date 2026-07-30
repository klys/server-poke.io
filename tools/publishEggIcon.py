#!/usr/bin/env python3
"""Publish the Venova egg party icon to the asset-storage server.

The source game ships the egg icon as `Graphics/Icons/iconEgg.png`, a
classic Essentials 2-frame icon strip (two 64x64 cells side by side). The
UI previously reused `Graphics/Pictures/summaryEgg.PNG` for eggs, but in
Venova that file is a PC-storage screen background, not an egg — so party
eggs rendered as a shrunken blue UI panel.

This slices the strip and writes two files to the asset-storage tree:

    <target>/iconEgg.png   first frame only (static fallback)
    <target>/iconEgg.gif   2-frame animated icon, matching the animated
                           species icons under pokemon_animation_gifs/icons

served as /migration_exports/pictures/iconEgg.{png,gif}. The client egg
render spots (TrainerCard EGG_ICON_SRC, AccountMenu party card) point at
the GIF.

Usage:
    python3 tools/publishEggIcon.py [<iconEgg.png>] [--target <dir>] [--dry-run]
    # remote upload instead of local copy (nginx upload-api):
    python3 tools/publishEggIcon.py [<iconEgg.png>] \
        --upload-url http://localhost:8090 --token $ASSET_UPLOAD_TOKEN

Re-running is safe: files are overwritten by name, nothing is deleted.
IMPORTANT: run this against prod asset storage too, or prod clients keep
showing the PC-screen picture for eggs.
"""
import argparse
import io
import os
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

EGG_ASSET_PATH = "migration_exports/pictures"
FRAME_COUNT = 2
FRAME_DURATION_MS = 400  # Essentials party icons toggle roughly twice a second
DEFAULT_SOURCE = os.path.expanduser(
    "~/Downloads/Venova Adventure/Graphics/Icons/iconEgg.png"
)


def slice_frames(strip: Image.Image) -> list[Image.Image]:
    rgba = strip.convert("RGBA")
    width, height = rgba.size
    cell_w = width // FRAME_COUNT
    return [
        rgba.crop((index * cell_w, 0, (index + 1) * cell_w, height))
        for index in range(FRAME_COUNT)
    ]


def encode_outputs(frames: list[Image.Image]) -> dict[str, bytes]:
    """Returns {filename: bytes} for the static PNG and animated GIF."""
    png_buffer = io.BytesIO()
    frames[0].save(png_buffer, format="PNG")

    # GIF has 1-bit transparency: quantize each RGBA frame and reserve a
    # transparent palette slot so the egg keeps its cutout background.
    gif_frames = []
    for frame in frames:
        alpha = frame.getchannel("A")
        quantized = frame.convert("RGB").quantize(colors=255)
        quantized.paste(255, mask=alpha.point(lambda a: 255 if a < 128 else 0))
        quantized.info["transparency"] = 255
        gif_frames.append(quantized)

    gif_buffer = io.BytesIO()
    gif_frames[0].save(
        gif_buffer,
        format="GIF",
        save_all=True,
        append_images=gif_frames[1:],
        duration=FRAME_DURATION_MS,
        loop=0,
        transparency=255,
        disposal=2,
    )
    return {"iconEgg.png": png_buffer.getvalue(), "iconEgg.gif": gif_buffer.getvalue()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish the egg party icon.")
    parser.add_argument("source", nargs="?", default=DEFAULT_SOURCE)
    parser.add_argument("--target")
    parser.add_argument("--upload-url")
    parser.add_argument("--token", default=os.environ.get("ASSET_UPLOAD_TOKEN"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = Path(args.source)
    if not source.is_file():
        sys.exit(f"Egg icon strip not found: {source}")

    frames = slice_frames(Image.open(source))
    outputs = encode_outputs(frames)
    print(f"Sliced {len(frames)} frames of {frames[0].size} from {source}")

    if args.dry_run:
        for name, data in outputs.items():
            print(f"  {name} {len(data)} bytes")
        return

    if args.upload_url:
        import urllib.request

        if not args.token:
            sys.exit("--upload-url requires --token or ASSET_UPLOAD_TOKEN.")
        base = args.upload_url.rstrip("/")
        for name, data in outputs.items():
            request = urllib.request.Request(
                f"{base}/api/upload/{EGG_ASSET_PATH}/{name}",
                data=data,
                method="PUT",
                headers={
                    "Authorization": f"Bearer {args.token}",
                    "Content-Type": "image/gif" if name.endswith(".gif") else "image/png",
                },
            )
            with urllib.request.urlopen(request) as response:
                if response.status not in (200, 201, 204):
                    sys.exit(f"Upload failed for {name}: {response.status}")
        print(f"Uploaded {len(outputs)} files to {base}/{EGG_ASSET_PATH}/")
        return

    target = Path(
        args.target
        or os.environ.get("EGG_ASSETS_DIR")
        or (Path.cwd() / ".." / "asset-storage" / "assets" / EGG_ASSET_PATH)
    ).resolve()
    target.mkdir(parents=True, exist_ok=True)
    for name, data in outputs.items():
        (target / name).write_bytes(data)
    print(f"Wrote {len(outputs)} files to {target}")


if __name__ == "__main__":
    main()
