/**
 * Derives wild-encounter grass cells for imported Pokemon Essentials maps.
 *
 * For every map in designer:section:maps that carries an imported tile map
 * (tileMap.terrainTags + tileMap.essentials.mapId), decodes the terrain-tag
 * grid (u8rle-base64, see MAP_TILEMAP_CONTRACT.md) and turns every cell with
 * terrain tag 2 (Essentials grass) into a grass placement. Encounter data is
 * taken from the Land table of the matching designer:section:encounters
 * record (mapId matched in zero-padded and unpadded forms).
 *
 * Only grass cells with ids prefixed "grass-essentials-" are replaced;
 * designer-placed grass is preserved. Maps without a Land encounter table or
 * without tag-2 cells are reported and skipped.
 *
 * Usage:
 *   npx ts-node tools/deriveGrassFromEncounters.ts [--dry-run]
 */
import { createClient } from "redis";
import {
  sanitizePlayableMapsStateSnapshot,
  type PlayableMapEditorData,
} from "../components/PlayableMapsState";

const MAPS_REDIS_KEY = "designer:section:maps";
const ENCOUNTERS_REDIS_KEY = "designer:section:encounters";
const GRASS_ID_PREFIX = "grass-essentials-";
const GRASS_TERRAIN_TAG = 2;

interface EncounterRow {
  weight: number;
  pokemonId: string;
  speciesEssentialsId?: string;
  minLevel: number;
  maxLevel: number;
}

interface EncounterTable {
  method: string;
  rows: EncounterRow[];
  density?: number;
}

interface EncounterItem {
  id: string;
  encounterProfile?: {
    mapId?: string;
    mapName?: string;
    tables?: EncounterTable[];
    densities?: { land?: number; cave?: number; water?: number };
  };
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function decodeU8Rle(encoded: string, expectedLength: number): Uint8Array | null {
  const bytes = Buffer.from(encoded, "base64");
  const out = new Uint8Array(expectedLength);
  let offset = 0;

  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const count = bytes[index];
    const value = bytes[index + 1];

    if (offset + count > expectedLength) {
      return null;
    }

    out.fill(value, offset, offset + count);
    offset += count;
  }

  return offset === expectedLength ? out : null;
}

function normalizedMapIdForms(mapId: string): string[] {
  const trimmed = mapId.trim();
  const unpadded = trimmed.replace(/^0+(?=\d)/, "");
  const padded = /^\d+$/.test(unpadded) ? unpadded.padStart(3, "0") : trimmed;
  return Array.from(new Set([trimmed, unpadded, padded]));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });

  await redis.connect();

  try {
    const rawMaps = await redis.get(MAPS_REDIS_KEY);
    const rawEncounters = await redis.get(ENCOUNTERS_REDIS_KEY);

    if (!rawMaps) {
      fail(`No ${MAPS_REDIS_KEY} payload in Redis.`);
    }

    if (!rawEncounters) {
      fail(`No ${ENCOUNTERS_REDIS_KEY} payload in Redis.`);
    }

    const mapsPayload = JSON.parse(rawMaps);
    const encountersPayload = JSON.parse(rawEncounters);
    const encounterItems: EncounterItem[] = encountersPayload?.state?.items ?? [];
    const encountersByMapId = new Map<string, EncounterItem>();

    for (const item of encounterItems) {
      const sourceMapId = item.encounterProfile?.mapId;

      if (typeof sourceMapId !== "string" || sourceMapId.length === 0) {
        continue;
      }

      for (const form of normalizedMapIdForms(sourceMapId)) {
        encountersByMapId.set(form, item);
      }
    }

    const editorDataByMapId: Record<string, PlayableMapEditorData> =
      mapsPayload?.state?.editorDataByMapId ?? {};
    let changedMaps = 0;

    for (const [mapId, editorData] of Object.entries(editorDataByMapId)) {
      const tileMap = editorData?.tileMap;
      const essentialsMapId = tileMap?.essentials?.mapId;

      if (!tileMap || typeof essentialsMapId !== "string" || !tileMap.terrainTags) {
        continue;
      }

      const { width, height } = tileMap;
      const tags = decodeU8Rle(tileMap.terrainTags, width * height);

      if (!tags) {
        console.warn(`${mapId}: terrainTags did not decode to ${width * height} cells, skipped.`);
        continue;
      }

      const grassCells: Array<{ x: number; y: number }> = [];

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (tags[y * width + x] === GRASS_TERRAIN_TAG) {
            grassCells.push({ x, y });
          }
        }
      }

      if (grassCells.length === 0) {
        console.log(`${mapId} (essentials ${essentialsMapId}): no tag-${GRASS_TERRAIN_TAG} cells, skipped.`);
        continue;
      }

      const encounterItem = encountersByMapId.get(essentialsMapId.trim())
        ?? normalizedMapIdForms(essentialsMapId)
          .map((form) => encountersByMapId.get(form))
          .find((item) => item !== undefined);

      const landTable = encounterItem?.encounterProfile?.tables?.find(
        (table) => table.method === "Land" && Array.isArray(table.rows) && table.rows.length > 0
      );

      if (!encounterItem || !landTable) {
        console.log(
          `${mapId} (essentials ${essentialsMapId}): ${grassCells.length} grass cells but no Land encounter table, skipped.`
        );
        continue;
      }

      const rows = landTable.rows.filter(
        (row) =>
          typeof row.pokemonId === "string" &&
          typeof row.weight === "number" &&
          typeof row.minLevel === "number" &&
          typeof row.maxLevel === "number"
      );

      if (rows.length === 0) {
        console.log(`${mapId} (essentials ${essentialsMapId}): Land table has no usable rows, skipped.`);
        continue;
      }

      const pokemonIds = Array.from(new Set(rows.map((row) => row.pokemonId)));
      const minLevel = Math.min(...rows.map((row) => row.minLevel));
      const maxLevel = Math.max(...rows.map((row) => row.maxLevel));
      const encounterRate = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            landTable.density ?? encounterItem.encounterProfile?.densities?.land ?? 25
          )
        )
      );
      const encounterRows = rows.map((row) => ({
        weight: row.weight,
        pokemonId: row.pokemonId,
        minLevel: row.minLevel,
        maxLevel: row.maxLevel,
      }));

      const preservedGrass = (editorData.grass ?? []).filter(
        (cell) => typeof cell?.id === "string" && !cell.id.startsWith(GRASS_ID_PREFIX)
      );
      // The weighted table is identical for every cell of the map: store it
      // once on the first derived cell (the battle engine falls back to it).
      // Copying it onto thousands of cells bloated the payload by ~16MB.
      const derivedGrass = grassCells.map((cell, index) => ({
        id: `${GRASS_ID_PREFIX}${mapId}-${cell.x}-${cell.y}`,
        x: cell.x,
        y: cell.y,
        pokemonIds,
        minLevel,
        maxLevel,
        encounterRate,
        encounterMethod: "Land",
        ...(index === 0 ? { encounterRows } : {}),
        sourceEncounterId: encounterItem.id,
      }));

      editorData.grass = [...preservedGrass, ...derivedGrass];
      changedMaps += 1;
      console.log(
        `${mapId} (essentials ${essentialsMapId}): ${derivedGrass.length} grass cells ` +
          `(${preservedGrass.length} manual kept), rate ${encounterRate}, ` +
          `levels ${minLevel}-${maxLevel}, species ${pokemonIds.join(", ")}.`
      );
    }

    if (changedMaps === 0) {
      console.log("No maps updated; nothing to write.");
      return;
    }

    const sanitizedState = sanitizePlayableMapsStateSnapshot(mapsPayload.state);

    if (!sanitizedState) {
      fail("Updated maps snapshot failed sanitization.");
    }

    const nextPayload = {
      ...mapsPayload,
      state: sanitizedState,
      version: (mapsPayload.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserId: null,
      updatedByUsername: "essentials-grass-derivation",
    };

    if (dryRun) {
      console.log(`Dry run: would update ${changedMaps} maps at version ${nextPayload.version}.`);
      return;
    }

    await redis.set(MAPS_REDIS_KEY, JSON.stringify(nextPayload));
    console.log(`Wrote ${changedMaps} maps with derived grass at version ${nextPayload.version}.`);
  } finally {
    await redis.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
