/**
 * Terrain-tag semantics for imported Pokemon Essentials maps.
 *
 * Terrain tags are the raw RMXP/Essentials numeric tags, baked per cell into
 * `tileMap.terrainTags` (u8rle-base64, see MAP_TILEMAP_CONTRACT.md) from each
 * tileset's `terrainTags[tileId]` table. The values below were established by
 * cross-referencing the water/grass autotile names against the per-cell tags
 * of the real Venova maps (see `tools/inspectTerrainTags.ts`). They match the
 * classic Essentials `PBTerrain` enumeration:
 *
 *   2 Grass · 3 Sand · 5 DeepWater · 6 StillWater · 7 Sea/Beach ·
 *   8 Waterfall · 9 WaterfallCrest · 1 Ledge · 4 Rock · 12 Neutral
 *
 * Confirmed by autotile names: tag 5 = "Sea deep"/"PU-RiverDive",
 * tag 6 = "calm transparent water", tag 7 = "Sea"/"Beach",
 * tags 8/9 = "Waterfall"/"Waterfall crest".
 */

/** Tall-grass wild-encounter cells (already used by deriveGrassFromEncounters). */
export const GRASS_TERRAIN_TAG = 2;

/** Deep water — the only tiles you can Dive from (surface) / resurface onto. */
export const DEEP_WATER_TERRAIN_TAG = 5;

/** Every water surface a surfing player may traverse (still + sea + deep). */
export const SURF_TERRAIN_TAGS: ReadonlySet<number> = new Set([5, 6, 7]);

/** Waterfall body + crest — climbable with Waterfall (rare in current maps). */
export const WATERFALL_TERRAIN_TAGS: ReadonlySet<number> = new Set([8, 9]);

/** True when a terrain tag denotes a surfable water surface. */
export function isSurfableWaterTag(tag: number): boolean {
  return SURF_TERRAIN_TAGS.has(tag);
}

/** True when a terrain tag denotes deep (dive-able) water. */
export function isDeepWaterTag(tag: number): boolean {
  return tag === DEEP_WATER_TERRAIN_TAG;
}

/** True when a terrain tag denotes a waterfall cell. */
export function isWaterfallTag(tag: number): boolean {
  return WATERFALL_TERRAIN_TAGS.has(tag);
}

/** Decode a `u8rle-base64` terrain/collision grid (mirrors the map contract). */
export function decodeU8RleGrid(encoded: string, expectedLength: number): Uint8Array | null {
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
