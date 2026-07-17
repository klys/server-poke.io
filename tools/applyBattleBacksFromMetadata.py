#!/usr/bin/env python3
"""
Writes per-map Essentials battlebacks into the designer maps section.

Source of truth is the legacy PBS metadata.txt ([NNN] sections with
BattleBack=Name / Outdoor=true). For every imported map item
(id "map-essentials-NNN") in designer:section:maps this sets
playableMapConfig.battleBack:

  * explicit BattleBack entry           -> that name
  * Outdoor=true (no explicit back)     -> "Field"
  * everything else (interiors)         -> "IndoorA"

The server resolves this at battle start (BattleManager.resolveBattleBackForPlayer)
and streams it to the client as BattlePublicState.battleBack; wild battles in
grass upgrade "Field" to "FieldGrass" there. Hand-made (non-essentials) maps are
left untouched — battles on them keep the designer-configured default backdrop.

Idempotent: re-running just rewrites the same values (version still bumps).
The section probe key is updated so server/client caches pick the change up.

Usage:
  python3 tools/applyBattleBacksFromMetadata.py ["/path/to/PBS/metadata.txt"]
"""

import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

METADATA_DEFAULT = "/home/klys/Downloads/Venova Adventure/PBS/metadata.txt"
REDIS_KEY = "designer:section:maps"


def parse_metadata(path):
    entries = {}
    current = None
    with open(path, encoding="utf-8-sig") as handle:
        for raw in handle:
            line = raw.strip()
            match = re.match(r"^\[(\d+)\]$", line)
            if match:
                current = int(match.group(1))
                entries[current] = {}
                continue
            if current is None or "=" not in line or line.startswith("#"):
                continue
            key, value = line.split("=", 1)
            entries[current][key.strip()] = value.strip()
    return entries


def battleback_for(entry):
    if entry is None:
        return "IndoorA"
    explicit = entry.get("BattleBack")
    if explicit:
        return explicit
    if entry.get("Outdoor", "").lower() == "true":
        return "Field"
    return "IndoorA"


def main():
    metadata_path = sys.argv[1] if len(sys.argv) > 1 else METADATA_DEFAULT
    entries = parse_metadata(metadata_path)
    print(f"metadata entries: {len(entries)} ({metadata_path})")

    raw = subprocess.run(
        ["redis-cli", "GET", REDIS_KEY], capture_output=True, check=True
    ).stdout.decode("utf-8")
    payload = json.loads(raw)

    changed = 0
    skipped = 0
    counts = {}
    for item in payload["state"]["items"]:
        item_id = item.get("id", "")
        match = re.match(r"^map-essentials-(\d+)$", item_id)
        if not match:
            skipped += 1
            continue
        essentials_id = int(match.group(1))
        back = battleback_for(entries.get(essentials_id))
        config = item.setdefault("playableMapConfig", {})
        if config.get("battleBack") != back:
            changed += 1
        config["battleBack"] = back
        counts[back] = counts.get(back, 0) + 1

    payload["version"] = int(payload.get("version", 0)) + 1
    payload["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(payload, handle, separators=(",", ":"))
        temp_path = handle.name

    with open(temp_path, "rb") as handle:
        subprocess.run(["redis-cli", "-x", "SET", REDIS_KEY], stdin=handle, check=True)
    marker = f"{payload['version']}:{payload['updatedAt']}"
    subprocess.run(["redis-cli", "SET", f"{REDIS_KEY}:probe", marker], check=True)

    print(f"updated {changed} maps (skipped {skipped} hand-made), version -> {payload['version']}")
    for name in sorted(counts, key=counts.get, reverse=True):
        print(f"  {name}: {counts[name]}")


if __name__ == "__main__":
    main()
