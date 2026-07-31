/**
 * Derives `tileMap.passageTerrainTags` for every map: per cell, the terrain
 * tag OF THE COLLISION-DECIDING TILE — the top-down (z 2→0) first tile that
 * is non-empty and not star/through (0x10), i.e. exactly the tile the
 * contract's collision derivation lets decide passability.
 *
 * Why: plain `terrainTags` takes the first NON-ZERO tag top-down, so a rock
 * (tag 0, impassable) drawn over sea water leaves the cell tagged "water".
 * Surf's pass-through-water rule then walks straight through rocks. With this
 * grid, surf traversal requires the DECIDING tile itself to be water — RMXP's
 * real passability semantics.
 *
 * Reads designer:section:tilesets (passages/terrainTags tables) and rewrites
 * designer:section:maps (version bump + probe marker). Idempotent.
 * Run on BOTH dev and prod redis:
 *   cd server-poke.io && node_modules/.bin/ts-node tools/derivePassageTerrainTags.ts
 */
import { createClient } from "redis";
import { decodeRleBytes, decodeTileLayer, encodeRleBytes } from "../components/TileMapGrid";
import { SURF_TERRAIN_TAGS } from "../components/terrainTags";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const MAPS_KEY = "designer:section:maps";
const TILESETS_KEY = "designer:section:tilesets";
const PROBE_KEY = `${MAPS_KEY}:probe`;

const PASSAGE_STAR = 0x10;
const AUTOTILE_ID_UNIT = 48;
const FIRST_TILESET_TILE_ID = 384;

/** Autotiles resolve properties at the slot base id (variant 0). */
function propertyIndexForTileId(tileId: number) {
  if (tileId < FIRST_TILESET_TILE_ID) {
    return Math.floor(tileId / AUTOTILE_ID_UNIT) * AUTOTILE_ID_UNIT;
  }
  return tileId;
}

interface TilesetTables {
  passages: number[];
  priorities: number[];
  terrainTags: number[];
}

async function main() {
  const redis = createClient({ url: REDIS_URL });
  redis.on("error", (error) => console.error("redis error:", error));
  await redis.connect();

  const tilesetsRaw = await redis.get(TILESETS_KEY);
  if (!tilesetsRaw) {
    throw new Error(`${TILESETS_KEY} is empty`);
  }
  const tilesetTables = new Map<string, TilesetTables>();
  for (const item of JSON.parse(tilesetsRaw).state?.items ?? []) {
    const profile = item?.tilesetProfile;
    if (
      item?.id &&
      Array.isArray(profile?.passages) &&
      Array.isArray(profile?.priorities) &&
      Array.isArray(profile?.terrainTags)
    ) {
      tilesetTables.set(item.id, {
        passages: profile.passages,
        priorities: profile.priorities,
        terrainTags: profile.terrainTags
      });
    }
  }
  console.log(`tilesets with tables: ${tilesetTables.size}`);

  const mapsRaw = await redis.get(MAPS_KEY);
  if (!mapsRaw) {
    throw new Error(`${MAPS_KEY} is empty`);
  }
  const payload = JSON.parse(mapsRaw);
  const editorDataByMapId = payload.state?.editorDataByMapId ?? {};

  let derived = 0;
  let skipped = 0;
  let totalBlockers = 0;

  for (const [mapId, editorData] of Object.entries<any>(editorDataByMapId)) {
    const tileMap = editorData?.tileMap;
    if (!tileMap?.layers?.length || typeof tileMap.width !== "number") {
      skipped += 1;
      continue;
    }
    const tables = tilesetTables.get(tileMap.tilesetItemId);
    if (!tables) {
      console.warn(`map ${mapId}: tileset ${tileMap.tilesetItemId} has no tables — skipped`);
      skipped += 1;
      continue;
    }
    const cellCount = tileMap.width * tileMap.height;
    const layers: Uint16Array[] = [];
    let decodeFailed = false;
    for (const encoded of tileMap.layers) {
      const layer = decodeTileLayer(encoded, cellCount);
      if (!layer) {
        decodeFailed = true;
        break;
      }
      layers.push(layer);
    }
    if (decodeFailed || layers.length === 0) {
      console.warn(`map ${mapId}: undecodable layers — skipped`);
      skipped += 1;
      continue;
    }

    const cells = new Uint8Array(cellCount);
    let blockers = 0;
    for (let index = 0; index < cellCount; index += 1) {
      // Mirror the contract's collision walk exactly: z 2→0, skip empty and
      // star/through tiles; a tile with blocking bits decides; a fully
      // passable tile decides only at priority 0, otherwise the walk
      // continues to the layer below (passable overlays above water must not
      // hide the water underneath).
      for (let z = layers.length - 1; z >= 0; z -= 1) {
        const tileId = layers[z][index];
        if (tileId === 0) {
          continue;
        }
        const propertyIndex = propertyIndexForTileId(tileId);
        const passage = tables.passages[propertyIndex] ?? 0;
        if (passage & PASSAGE_STAR) {
          continue;
        }
        if (passage & 0x0f) {
          cells[index] = (tables.terrainTags[propertyIndex] ?? 0) & 0xff;
          break;
        }
        if ((tables.priorities[propertyIndex] ?? 0) === 0) {
          cells[index] = (tables.terrainTags[propertyIndex] ?? 0) & 0xff;
          break;
        }
      }
    }

    // Count the cells this grid changes for surf: terrain tag says water but
    // the deciding tile is not water (rocks/obstacles drawn over the sea).
    if (typeof tileMap.terrainTags === "string") {
      const plainTags = decodeRleBytes(tileMap.terrainTags);
      if (plainTags && plainTags.length === cellCount) {
        for (let index = 0; index < cellCount; index += 1) {
          if (SURF_TERRAIN_TAGS.has(plainTags[index]) && !SURF_TERRAIN_TAGS.has(cells[index])) {
            blockers += 1;
          }
        }
      }
    }

    tileMap.passageTerrainTags = encodeRleBytes(cells);
    derived += 1;
    totalBlockers += blockers;
    if (blockers > 0) {
      console.log(`map ${mapId}: ${blockers} water-obstacle cells (surf-blocked)`);
    }
  }

  payload.version = (typeof payload.version === "number" ? payload.version : 0) + 1;
  await redis.set(MAPS_KEY, JSON.stringify(payload));
  await redis.set(PROBE_KEY, `passage-tags:${payload.version}`);
  console.log(
    `done: derived ${derived} maps, skipped ${skipped}, ${totalBlockers} obstacle-over-water cells total; maps version ${payload.version}`
  );
  await redis.quit();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
