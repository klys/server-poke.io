/**
 * Read-only diagnostic: report the terrain-tag distribution of imported maps
 * and cross-reference each tag with the water/grass autotile names that carry
 * it, so the meaning of every numeric tag can be established (which value is
 * surfable water, deep/dive water, waterfall, grass, ...).
 *
 * Nothing is written back. Used to derive the constants in
 * `components/terrainTags.ts`.
 *
 * Usage:
 *   npx ts-node tools/inspectTerrainTags.ts [--map <essentialsMapId>]...
 */
import { createClient } from "redis";
import { decodeU8RleGrid } from "../components/terrainTags";

const MAPS_REDIS_KEY = "designer:section:maps";
const TILESETS_REDIS_KEY = "designer:section:tilesets";

interface TilesetProfile {
  terrainTags?: number[];
  autotiles?: Array<{ name?: string } | null>;
  tilesetGraphicName?: string;
}

function autotileTag(profile: TilesetProfile, slot: number): number {
  return profile.terrainTags?.[(slot + 1) * 48] ?? 0;
}

async function main() {
  const wanted = new Set<string>();
  process.argv.forEach((arg, index) => {
    if (arg === "--map" && process.argv[index + 1]) {
      wanted.add(process.argv[index + 1].trim());
    }
  });

  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });
  await redis.connect();

  try {
    const rawMaps = await redis.get(MAPS_REDIS_KEY);
    const rawTilesets = await redis.get(TILESETS_REDIS_KEY);
    if (!rawMaps || !rawTilesets) {
      console.error(`Missing ${MAPS_REDIS_KEY} or ${TILESETS_REDIS_KEY} in Redis.`);
      process.exit(1);
    }

    const editorDataByMapId = JSON.parse(rawMaps)?.state?.editorDataByMapId ?? {};
    const tilesetItems: Array<{ id: string; tilesetProfile?: TilesetProfile; profile?: TilesetProfile }> =
      JSON.parse(rawTilesets)?.state?.items ?? [];
    const tilesetById = new Map(tilesetItems.map((item) => [item.id, item.tilesetProfile ?? item.profile]));

    const globalHistogram: Record<number, number> = {};
    const tagAutotileNames: Record<number, Set<string>> = {};

    // Which autotile names carry each tag (the semantic key).
    for (const profile of tilesetById.values()) {
      if (!profile) continue;
      (profile.autotiles ?? []).forEach((autotile, slot) => {
        if (!autotile?.name) return;
        const tag = autotileTag(profile, slot);
        (tagAutotileNames[tag] ??= new Set()).add(autotile.name);
      });
    }

    for (const [mapId, editorData] of Object.entries<any>(editorDataByMapId)) {
      const tileMap = editorData?.tileMap;
      const essentialsMapId = tileMap?.essentials?.mapId;
      if (!tileMap?.terrainTags) continue;
      if (wanted.size > 0 && !wanted.has(String(essentialsMapId))) continue;

      const cells = tileMap.width * tileMap.height;
      const tags = decodeU8RleGrid(tileMap.terrainTags, cells);
      if (!tags) continue;

      const histogram: Record<number, number> = {};
      for (const tag of tags) {
        histogram[tag] = (histogram[tag] ?? 0) + 1;
        globalHistogram[tag] = (globalHistogram[tag] ?? 0) + 1;
      }

      if (wanted.size > 0) {
        console.log(`${mapId} (essentials ${essentialsMapId}): ${JSON.stringify(histogram)}`);
      }
    }

    console.log("\nGlobal terrain-tag histogram (cells):", JSON.stringify(globalHistogram));
    console.log("\nTag → autotile names:");
    for (const tag of Object.keys(tagAutotileNames).map(Number).sort((a, b) => a - b)) {
      console.log(`  ${tag}: ${[...tagAutotileNames[tag]].slice(0, 12).join(" | ")}`);
    }
  } finally {
    await redis.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
