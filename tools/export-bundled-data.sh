#!/usr/bin/env bash
#
# Snapshots the shared game data a running server-poke.io exposes over HTTP
# into a "bundled-data" directory that the native app builds (client-mobile /
# client-desktop) package inside the app. Native clients seed their caches
# from these files at startup, so the server never has to stream the payloads
# to them over the websocket.
#
# Usage:
#   ./tools/export-bundled-data.sh [output-dir]
#
# Environment:
#   SERVER_URL   Base URL of a running server-poke.io. Default: http://localhost:3001
#
set -euo pipefail

SERVER_URL="${SERVER_URL:-http://localhost:3001}"
OUT_DIR="${1:-bundled-data}"

PUBLIC_SECTIONS=(pokemons npcs players skillsGfx audio types battleInterface)

mkdir -p "$OUT_DIR/sections"

echo "==> Exporting bundled data from $SERVER_URL into $OUT_DIR"

curl -fsS "$SERVER_URL/playable-maps.json" -o "$OUT_DIR/playable-maps.json"
echo "    playable-maps.json ($(du -h "$OUT_DIR/playable-maps.json" | cut -f1))"

for section in "${PUBLIC_SECTIONS[@]}"; do
  curl -fsS "$SERVER_URL/designer-sections/$section.json" -o "$OUT_DIR/sections/$section.json"
  echo "    sections/$section.json ($(du -h "$OUT_DIR/sections/$section.json" | cut -f1))"
done

echo "==> Done. Total: $(du -sh "$OUT_DIR" | cut -f1)"
