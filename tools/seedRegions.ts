/**
 * Seeds designer:section:regions with the real Venova region: the same
 * mapRegion0.png the in-game Map menu renders plus all town-map points from
 * the generated components/townMapData.ts (44 points, fly landings included).
 * Also publishes the region image to asset-storage under /townmap/ so the
 * designer's Region editor can display it.
 *
 * Usage:
 *   npx ts-node tools/seedRegions.ts [--dry-run]
 *
 * Idempotent: the venova region item is replaced by id, other items kept.
 * Note: the runtime still reads townMapData.ts — regenerate it with
 * tools/generateTownMapData.ts after changing PBS data; this section is the
 * designer-facing view of the same information.
 */
import { promises as fs } from "fs";
import path from "path";
import { createClient } from "redis";
import { TOWN_MAP_GRID_PX, TOWN_MAP_POINTS } from "../components/townMapData";

const REGIONS_SECTION_KEY = "designer:section:regions";
const REGION_ITEM_ID = "region-venova";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const clientImage = path.resolve(
    process.cwd(),
    "../client-poke.io/public/townmap/mapRegion0.png"
  );
  const assetTarget = path.resolve(
    process.cwd(),
    "../asset-storage/assets/townmap/mapRegion0.png"
  );

  try {
    await fs.mkdir(path.dirname(assetTarget), { recursive: true });

    if (!dryRun) {
      await fs.copyFile(clientImage, assetTarget);
    }

    console.log(`Published ${clientImage} -> ${assetTarget}${dryRun ? " (dry run)" : ""}`);
  } catch (error) {
    console.warn(`Could not publish region image (${(error as Error).message}) — continuing.`);
  }

  const points = TOWN_MAP_POINTS.map((point) => ({
    gridX: point.gridX,
    gridY: point.gridY,
    name: point.name,
    ...(point.poi ? { poi: point.poi } : {}),
    ...(point.fly
      ? { fly: { mapId: point.fly.mapId, cellX: point.fly.cellX, cellY: point.fly.cellY } }
      : {}),
  }));

  const regionItem = {
    id: REGION_ITEM_ID,
    name: "Venova",
    category: "Regions",
    details: [
      { label: "Map Image", value: "/townmap/mapRegion0.png" },
      { label: "Grid", value: `${TOWN_MAP_GRID_PX}px` },
      { label: "Points", value: String(points.length) },
      { label: "Fly Landings", value: String(points.filter((point) => "fly" in point).length) },
    ],
    regionProfile: {
      imageSrc: "/townmap/mapRegion0.png",
      gridSize: TOWN_MAP_GRID_PX,
      points,
      source: {
        project: "Venova Adventure",
        sourcePath: "PBS/townmap.txt",
        sectionId: "0",
        originalId: "0",
        originalName: "Venova",
      },
    },
  };

  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });
  await redis.connect();

  try {
    const raw = await redis.get(REGIONS_SECTION_KEY);
    const payload = raw
      ? JSON.parse(raw)
      : {
          sectionKey: "regions",
          state: { categories: ["Regions"], items: [] },
          version: 0,
          updatedAt: null,
          updatedByUserId: null,
          updatedByUsername: null,
        };
    const existingItems: Array<{ id: string }> = Array.isArray(payload?.state?.items)
      ? payload.state.items
      : [];
    const keptItems = existingItems.filter((item) => item?.id !== REGION_ITEM_ID);
    const categories: string[] = Array.isArray(payload?.state?.categories)
      ? payload.state.categories.filter((c: unknown): c is string => typeof c === "string")
      : [];

    payload.sectionKey = "regions";
    payload.state = {
      categories: categories.includes("Regions") ? categories : ["Regions", ...categories],
      items: [regionItem, ...keptItems],
    };
    payload.version = (typeof payload.version === "number" ? payload.version : 0) + 1;
    payload.updatedAt = new Date().toISOString();
    payload.updatedByUsername = "seed-regions";

    console.log(
      `regions: Venova with ${points.length} points seeded, ${keptItems.length} other items kept, ` +
        `new version ${payload.version}${dryRun ? " (dry run — not written)" : ""}`
    );

    if (!dryRun) {
      await redis.set(REGIONS_SECTION_KEY, JSON.stringify(payload));
      console.log(`Wrote ${REGIONS_SECTION_KEY}.`);
    }
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
