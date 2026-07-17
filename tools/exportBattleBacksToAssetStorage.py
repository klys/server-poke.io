#!/usr/bin/env python3
"""
Exports the designer battleBackgrounds section to static asset files.

The battleBackgrounds section stores every image as a data URI and is one of
the HEAVY designer sections (never synced to regular players), so the battle
scene cannot look battlebacks up client-side. This script writes each item's
components to the asset-storage tree:

  <asset-storage>/assets/migration_exports/battlebacks/<slug>_bg.png
  <asset-storage>/assets/migration_exports/battlebacks/<slug>_base0.png   (player)
  <asset-storage>/assets/migration_exports/battlebacks/<slug>_base1.png   (enemy)

plus a manifest.json mapping the normalized battleback name to root-relative
image paths. The client fetches the manifest once (see battleBackManifest.ts)
and resolves the battleBack name streamed in battle:state against it.

Backdrop-less variants (Essentials ships e.g. FieldGrass as bases only) fall
back to the parent backdrop by stripping known suffix tokens (fieldgrass ->
field, cavedarkwater -> cavedark -> cave).

Idempotent; re-run whenever the battleBackgrounds section changes.
"""

import base64
import json
import re
import subprocess
from pathlib import Path

OUTPUT_DIR = Path("/home/klys/Dev/pokecraft/asset-storage/assets/migration_exports/battlebacks")
PUBLIC_PREFIX = "/migration_exports/battlebacks"
SUFFIX_TOKENS = ["grass", "sand", "puddle", "water", "darker", "dark", "eve", "night"]


def normalize(name):
    return re.sub(r"[^a-z0-9]", "", name.strip().lower())


def write_data_uri(data_uri, path):
    match = re.match(r"^data:image/(\w+);base64,(.*)$", data_uri, re.DOTALL)
    if not match:
        return False
    path.write_bytes(base64.b64decode(match.group(2)))
    return True


def component_src(components, exact_role, pattern):
    for asset in components:
        if asset.get("role") == exact_role:
            return asset.get("dataUri") or asset.get("imageSrc") or ""
    for asset in components:
        haystack = f"{asset.get('role','')} {asset.get('filename','')} {asset.get('sourcePath','')}".lower()
        if re.search(pattern, haystack):
            return asset.get("dataUri") or asset.get("imageSrc") or ""
    return ""


def main():
    raw = subprocess.run(
        ["redis-cli", "GET", "designer:section:battleBackgrounds"],
        capture_output=True,
        check=True
    ).stdout.decode("utf-8")
    items = json.loads(raw)["state"]["items"]
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    manifest = {}
    for item in items:
        profile = item.get("battleBackgroundProfile") or {}
        slug = normalize(item.get("name", ""))
        if not slug:
            continue
        components = profile.get("componentAssets") or []

        entry = {}
        pieces = [
            ("backgroundSrc", "_bg", component_src(components, "background", r"bg|background")),
            ("playerBaseSrc", "_base0", component_src(components, "playerBase", r"player|base0|base_0")),
            ("enemyBaseSrc", "_base1", component_src(components, "opponentBase", r"enemy|opponent|base1|base_1"))
        ]
        for key, suffix, src in pieces:
            entry[key] = ""
            if src.startswith("data:") and write_data_uri(src, OUTPUT_DIR / f"{slug}{suffix}.png"):
                entry[key] = f"{PUBLIC_PREFIX}/{slug}{suffix}.png"

        manifest[slug] = entry

    # Backdrop fallback for bases-only variants: strip suffix tokens until a
    # variant with a real backdrop is found (fieldgrass -> field).
    for slug, entry in manifest.items():
        if entry["backgroundSrc"]:
            continue
        candidate = slug
        while not entry["backgroundSrc"]:
            for token in SUFFIX_TOKENS:
                if candidate.endswith(token) and len(candidate) > len(token):
                    candidate = candidate[: -len(token)]
                    break
            else:
                break
            parent = manifest.get(candidate)
            if parent and parent["backgroundSrc"]:
                entry["backgroundSrc"] = parent["backgroundSrc"]
                for key in ("playerBaseSrc", "enemyBaseSrc"):
                    if not entry[key]:
                        entry[key] = parent[key]

    (OUTPUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=1))
    complete = sum(1 for entry in manifest.values() if entry["backgroundSrc"])
    print(f"exported {len(manifest)} battlebacks to {OUTPUT_DIR}")
    print(f"  with backdrop: {complete}; missing backdrop: "
          f"{[slug for slug, entry in manifest.items() if not entry['backgroundSrc']]}")


if __name__ == "__main__":
    main()
