---
name: essentials-data
description: The imported Pokemon Essentials data pipeline — map/tileset importers into Redis, migration reports, event repair, and the bundled-data export for native clients.
---

# Pokemon Essentials data pipeline

The game runs content imported from RPG Maker XP / Pokemon Essentials projects
(Venova Adventure today). The imported data lives in Redis
(`designer:section:maps` etc. — see the root `redis-data` skill); these tools
populate, audit, and repair it.

## Ground rules

- `data_pokemonEssentials.zip` (22 MB) is the original Essentials project
  export; `data.tar.gz` (5 MB) is archived data; `migration-data/rxdata_json`
  holds converted RMXP data. Don't extract or read these wholesale — pull the
  specific file you need.
- Importers are **merge-by-id and re-run safe**: designer-made content and
  manual edits to non-imported records are preserved. A running server picks
  up changes on the next map sync; restart the server (or save any map in the
  designer) to broadcast immediately.
- Some tools hardcode absolute workspace paths (e.g.
  `/home/klys/Dev/pokecraft/...`) — the workspace has moved between machines
  before, so check the constants at the top of a tool against the actual
  checkout location before running.
- Docs: `ESSENTIALS_PROGRESSION.md` (how progression/events work — read this
  before touching event logic), `migration-report.md` (last audit results).

## Main tools (`tools/`, run with `npx ts-node` unless noted)

Import into Redis:

- `importEssentialsMaps.ts <bundleDir> [--dry-run]` — map bundles + tilesets →
  `designer:section:maps`/`tilesets`, baked PNG chunks → `ASSET_STORAGE_URL`.
  The bundle comes from the Desktop_App migration tool (`--export-pokecraft`).
- `importDiveMaps.ts`, `importTmCompatibility.ts`, `seedRegions.ts`,
  `seedPassiveStates.ts` — narrower importers/seeders.
- `deriveGrassFromEncounters.ts`, `derivePassageTerrainTags.ts`,
  `generateTownMapData.ts` — derive runtime data from imported content.

Audit and repair:

- `essentialsMigrationReport.ts` (npm alias `report:migration`) — writes
  `migration-report.{json,md}`: what imported, what's unhandled.
- `repairEssentialsEvents.ts` — fix broken imported events in place. It
  REWRITES every event page from the rxdata dump, so anything `convertPage`
  fails to carry over is destroyed for the whole game. This already happened
  once: it hardcoded `route: null`, and a repair run silently froze all 562
  walking NPCs (NPC movement is driven entirely by `move.route`; see
  `components/NpcActors.ts`). Recovery is re-running the fixed repair against
  `migration-data/rxdata_json` — the rxdata is the source of truth, Redis is
  not. Check the summary line's **"Move routes preserved: N"** (expect ~1199
  pages / 562 walking NPCs for Venova); a sudden 0 means routes were stripped
  again. Verify with `tools/e2e-npc-movement.ts`, which fails fast when no NPC
  actors exist.
- `inspectTerrainTags.ts`, `resetConsumedItemBalls.ts` — inspection/reset
  utilities. Prebuilt bundles of the report/repair tools sit in `dist-tools/`.

Publish assets to asset-storage (`exportTilesetsToAssetStorage.ts`,
`exportAssetManifestToAssetStorage.ts`, `publishCharacterSheets.ts`,
`publishFonts.ts`, plus `*.py` publishers) — need `ASSET_STORAGE_URL`
pointing at the asset-storage checkout's folders.

Native client bundles:

- `tools/export-bundled-data.sh [out-dir]` — snapshots `/playable-maps.json`
  and the public designer sections from a RUNNING server
  (`SERVER_URL`, default `http://localhost:3001`) into `bundled-data/` for the
  mobile/desktop wrapper builds.

## After changing progression semantics

Anything touching `eventPageSelection.ts`, `essentialsScriptAdapters.ts`, or
`EventRuntime.ts` must pass `npm run test:progression`, and new script
calls/conditions should be added to the adapter tables rather than special-cased
inline — `ESSENTIALS_PROGRESSION.md` explains the extension points.
