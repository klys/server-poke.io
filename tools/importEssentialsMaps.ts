/**
 * Imports a PokeCraft map bundle export (produced by the Desktop_App
 * migration tool via --export-pokecraft) into Redis:
 *
 * - tileset profiles  -> designer:section:tilesets (images embedded as data URIs)
 * - map bundles       -> designer:section:maps (merged by stable id, manual maps preserved)
 * - baked PNG chunks  -> <ASSET_STORAGE_URL|./map-assets>/<runtimeMapId>/
 *
 * Usage:
 *   npx ts-node tools/importEssentialsMaps.ts <bundleDir> [--dry-run]
 *
 * Re-running is safe: items are merged by id, so designer-made maps and
 * manual edits to non-imported records are never touched. A running server
 * picks the new state up on the next map sync; save any map in the designer
 * (or restart the server) to broadcast the new version immediately.
 */
import { promises as fs } from "fs";
import path from "path";
import { createClient } from "redis";
import {
  sanitizePlayableMapsStateSnapshot,
  type PlayableMapEditorData,
  type PlayableMapTileMapProfile,
} from "../components/PlayableMapsState";

const MAPS_REDIS_KEY = "designer:section:maps";
const TILESETS_REDIS_KEY = "designer:section:tilesets";
const IMPORT_CATEGORY = "Pokemon Essentials";

interface BundleTileset {
  id: string;
  name: string;
  essentialsTilesetId: number;
  tileSize: number;
  tilesetGraphicName?: string;
  tilesetImageFile: string;
  tilesetHeightTiles: number;
  autotiles: Array<{ name: string; imageFile: string } | null>;
  passages: number[];
  priorities: number[];
  terrainTags: number[];
}

interface BundleChunk {
  col: number;
  row: number;
  file: string;
  width: number;
  height: number;
}

interface BundleConnection {
  direction: "north" | "south" | "east" | "west";
  targetEssentialsMapId: number;
  offsetXCells: number;
  offsetYCells: number;
}

interface BundleEventCommand {
  code: number;
  indent?: number;
  parameters: unknown[];
}

interface BundleEvent {
  id: number;
  name: string;
  x: number;
  y: number;
  classification?: string;
  trigger?: number;
  graphic?: {
    characterName: string;
    direction: number;
    pattern: number;
    hue: number;
    characterFile?: string;
  } | null;
  messageText?: string | null;
  scriptText?: string | null;
  pages?: Array<{ trigger?: number; commands?: BundleEventCommand[] }>;
}

interface BundleMap {
  formatVersion: number;
  essentialsMapId: number;
  runtimeMapId: string;
  name: string;
  width: number;
  height: number;
  tilesetId: number;
  tilesetItemId: string;
  tileMap: Omit<PlayableMapTileMapProfile, "baked"> & {
    baked?: {
      chunkCells: number;
      background: BundleChunk[];
      foreground: BundleChunk[];
    };
  };
  bgm?: string;
  bgs?: string;
  connections?: BundleConnection[];
  portals?: Array<{
    x: number;
    y: number;
    targetEssentialsMapId: number;
    targetX: number;
    targetY: number;
    sourceEventId?: number;
  }>;
  events?: BundleEvent[];
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readImageAsDataUri(filePath: string) {
  const bytes = await fs.readFile(filePath);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function runtimeIdForEssentialsMap(essentialsMapId: number) {
  return `map-essentials-${String(essentialsMapId).padStart(3, "0")}`;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const bundleDir = args.find((argument) => !argument.startsWith("--"));

  if (!bundleDir) {
    fail("Usage: npx ts-node tools/importEssentialsMaps.ts <bundleDir> [--dry-run]");
  }

  const resolvedBundleDir = path.resolve(bundleDir);
  const mapAssetsDir =
    process.env.ASSET_STORAGE_URL || path.resolve(process.cwd(), "map-assets");
  const warnings: string[] = [];

  const manifest = await readJson<{ formatVersion: number; maps: string[] }>(
    path.join(resolvedBundleDir, "manifest.json")
  ).catch(() => fail(`No readable manifest.json in ${resolvedBundleDir}`));

  if (manifest.formatVersion !== 1) {
    fail(`Unsupported bundle formatVersion ${manifest.formatVersion}`);
  }

  // ------------------------------------------------------------------
  // Tilesets
  // ------------------------------------------------------------------

  const bundleTilesets = await readJson<BundleTileset[]>(
    path.join(resolvedBundleDir, "tilesets", "tilesets.json")
  );

  const tilesetItems = [] as Array<Record<string, unknown>>;

  for (const tileset of bundleTilesets) {
    const imagesDir = path.join(resolvedBundleDir, "tilesets");
    const tilesetImageSrc = await readImageAsDataUri(
      path.join(imagesDir, tileset.tilesetImageFile)
    ).catch(() => {
      warnings.push(`Tileset ${tileset.id}: missing image ${tileset.tilesetImageFile}`);
      return "";
    });

    const autotiles = [] as Array<{ name: string; imageSrc: string } | null>;

    for (const autotile of tileset.autotiles.slice(0, 7)) {
      if (!autotile || !autotile.imageFile) {
        autotiles.push(null);
        continue;
      }

      const imageSrc = await readImageAsDataUri(path.join(imagesDir, autotile.imageFile)).catch(
        () => {
          warnings.push(`Tileset ${tileset.id}: missing autotile ${autotile.imageFile}`);
          return "";
        }
      );

      autotiles.push(imageSrc ? { name: autotile.name, imageSrc } : null);
    }

    while (autotiles.length < 7) {
      autotiles.push(null);
    }

    tilesetItems.push({
      id: tileset.id,
      name: tileset.name || tileset.tilesetGraphicName || tileset.id,
      category: IMPORT_CATEGORY,
      details: [
        { label: "Tileset", value: tileset.tilesetGraphicName ?? "" },
        { label: "Essentials ID", value: String(tileset.essentialsTilesetId) },
        { label: "Tiles", value: String(tileset.tilesetHeightTiles * 8) },
      ],
      tilesetProfile: {
        tileSize: tileset.tileSize || 32,
        tilesetImageSrc,
        tilesetHeightTiles: tileset.tilesetHeightTiles,
        autotiles,
        passages: tileset.passages ?? [],
        priorities: tileset.priorities ?? [],
        terrainTags: tileset.terrainTags ?? [],
        essentialsTilesetId: tileset.essentialsTilesetId,
        tilesetGraphicName: tileset.tilesetGraphicName,
        source: {
          project: "Pokemon Essentials v21.1",
          sourcePath: `Graphics/Tilesets/${tileset.tilesetGraphicName ?? ""}`,
        },
      },
    });
  }

  // ------------------------------------------------------------------
  // Maps
  // ------------------------------------------------------------------

  const mapsDir = path.join(resolvedBundleDir, "maps");
  const bundleFiles = (await fs.readdir(mapsDir)).filter((file) => file.endsWith(".json"));
  const bundles: BundleMap[] = [];

  for (const file of bundleFiles) {
    bundles.push(await readJson<BundleMap>(path.join(mapsDir, file)));
  }

  const knownRuntimeIds = new Set(bundles.map((bundle) => bundle.runtimeMapId));
  const mapItems = [] as Array<Record<string, unknown>>;
  const editorDataByMapId = {} as Record<string, PlayableMapEditorData>;
  const characterCropCache = new Map<string, string>();
  let copiedChunks = 0;
  let projectedNpcs = 0;
  let preservedEvents = 0;

  const readCharacterCrop = async (characterFile: string) => {
    const cached = characterCropCache.get(characterFile);

    if (cached !== undefined) {
      return cached;
    }

    const dataUri = await readImageAsDataUri(path.join(mapsDir, characterFile)).catch(() => "");

    if (!dataUri) {
      warnings.push(`Missing event character crop ${characterFile}`);
    }

    characterCropCache.set(characterFile, dataUri);
    return dataUri;
  };

  for (const bundle of bundles) {
    const chunkSource = path.join(mapsDir, bundle.runtimeMapId);
    const chunkTarget = path.join(mapAssetsDir, bundle.runtimeMapId);
    const allChunks = [
      ...(bundle.tileMap.baked?.background ?? []),
      ...(bundle.tileMap.baked?.foreground ?? []),
    ];

    if (!dryRun && allChunks.length > 0) {
      await fs.rm(chunkTarget, { recursive: true, force: true });
      await fs.mkdir(chunkTarget, { recursive: true });

      for (const chunk of allChunks) {
        await fs.copyFile(
          path.join(chunkSource, chunk.file),
          path.join(chunkTarget, chunk.file)
        );
        copiedChunks += 1;
      }
    }

    const toChunkRefs = (chunks: BundleChunk[]) =>
      chunks.map((chunk) => ({
        col: chunk.col,
        row: chunk.row,
        width: chunk.width,
        height: chunk.height,
        src: `/map-assets/${bundle.runtimeMapId}/${chunk.file}`,
      }));

    const tileMap: PlayableMapTileMapProfile = {
      version: 1,
      tilesetItemId: bundle.tilesetItemId,
      width: bundle.width,
      height: bundle.height,
      tileSize: bundle.tileMap.tileSize || 32,
      layerEncoding: "u16le-base64",
      layers: bundle.tileMap.layers,
      collisionEncoding: "u8rle-base64",
      collision: bundle.tileMap.collision,
      terrainTags: bundle.tileMap.terrainTags,
      baked: bundle.tileMap.baked
        ? {
            chunkCells: bundle.tileMap.baked.chunkCells,
            background: toChunkRefs(bundle.tileMap.baked.background),
            foreground: toChunkRefs(bundle.tileMap.baked.foreground),
            bakedAt: new Date().toISOString(),
          }
        : undefined,
      essentials: bundle.tileMap.essentials,
    };

    const portals = (bundle.portals ?? [])
      .filter((portal) => {
        const targetId = runtimeIdForEssentialsMap(portal.targetEssentialsMapId);

        if (!knownRuntimeIds.has(targetId)) {
          warnings.push(
            `${bundle.runtimeMapId}: portal at ${portal.x},${portal.y} targets missing map ${targetId}`
          );
          return false;
        }

        return true;
      })
      .map((portal, index) => ({
        id: `portal-${bundle.runtimeMapId}-${portal.sourceEventId ?? index}`,
        x: portal.x,
        y: portal.y,
        destinationType: "other-map",
        sameMapX: 0,
        sameMapY: 0,
        targetMapId: runtimeIdForEssentialsMap(portal.targetEssentialsMapId),
        targetMapX: portal.targetX,
        targetMapY: portal.targetY,
        eventScript: "",
        essentialsConnection: {
          sourceMapId: String(bundle.essentialsMapId),
          sourceX: portal.x,
          sourceY: portal.y,
          targetMapId: String(portal.targetEssentialsMapId),
          targetX: portal.targetX,
          targetY: portal.targetY,
          sourcePath: `Data/Map${String(bundle.essentialsMapId).padStart(3, "0")}.rxdata`,
        },
      }));

    // Project dialogue-capable events (signs and talking NPCs) into
    // interactable placements. Everything else stays preserved raw below.
    const npcPlacements = [] as PlayableMapEditorData["npcs"];

    for (const event of bundle.events ?? []) {
      const classification = event.classification ?? "preserved-only";

      if (classification !== "sign" && classification !== "npc") {
        continue;
      }

      const previewImageSrc = event.graphic?.characterFile
        ? await readCharacterCrop(event.graphic.characterFile)
        : "";
      const messageCommands = (event.pages?.[0]?.commands ?? []).filter(
        (command) =>
          (command.code === 101 || command.code === 401) &&
          typeof command.parameters?.[0] === "string"
      );

      npcPlacements.push({
        id: `npc-${bundle.runtimeMapId}-ev${event.id}`,
        npcId: `essentials-event-${bundle.essentialsMapId}-${event.id}`,
        name: event.name || (classification === "sign" ? "Sign" : "NPC"),
        category: IMPORT_CATEGORY,
        previewImageSrc,
        npcType: "sign",
        aiType: "standing",
        interactionDistanceSquares: 2,
        x: event.x,
        y: event.y,
        eventId: event.id,
        eventPageIndex: 0,
        eventCommands: messageCommands.map((command) => ({
          code: command.code,
          parameters: command.parameters,
          indent: command.indent,
        })),
      });
      projectedNpcs += 1;
    }

    const connections = (bundle.connections ?? [])
      .filter((connection) => {
        const targetId = runtimeIdForEssentialsMap(connection.targetEssentialsMapId);

        if (!knownRuntimeIds.has(targetId)) {
          warnings.push(
            `${bundle.runtimeMapId}: connection ${connection.direction} targets missing map ${targetId}`
          );
          return false;
        }

        return true;
      })
      .map((connection) => ({
        direction: connection.direction,
        targetMapId: runtimeIdForEssentialsMap(connection.targetEssentialsMapId),
        offsetXCells: connection.offsetXCells,
        offsetYCells: connection.offsetYCells,
      }));

    preservedEvents += (bundle.events ?? []).length;

    mapItems.push({
      id: bundle.runtimeMapId,
      name: bundle.name || bundle.runtimeMapId,
      category: IMPORT_CATEGORY,
      details: [
        { label: "Cell Size", value: "32 px" },
        { label: "Map Size", value: `${bundle.width} x ${bundle.height}` },
        { label: "Essentials Map", value: String(bundle.essentialsMapId) },
      ],
      playableMapConfig: {
        cellSize: 32,
        sizePreset: "custom",
        width: bundle.width,
        height: bundle.height,
        isInitialMap: false,
        initialPositionX: null,
        initialPositionY: null,
        regionName: IMPORT_CATEGORY,
        regionX: 0,
        regionY: 0,
        mapType: "grassland",
        backgroundColor: "#000000",
        backgroundImageSrc: "",
        backgroundImageMode: "repeat",
        essentialsMapId: String(bundle.essentialsMapId),
        essentialsMapName: bundle.name,
        rxdataPath: `Data/Map${String(bundle.essentialsMapId).padStart(3, "0")}.rxdata`,
        tilesetId: bundle.tilesetId,
        bgm: bundle.bgm,
        bgs: bundle.bgs,
        connections: connections.length > 0 ? connections : undefined,
      },
    });

    editorDataByMapId[bundle.runtimeMapId] = {
      version: 1,
      objects: [],
      portals,
      grass: [],
      npcs: npcPlacements,
      tileMap,
      essentials: {
        mapId: String(bundle.essentialsMapId),
        rxdataPath: `Data/Map${String(bundle.essentialsMapId).padStart(3, "0")}.rxdata`,
        width: bundle.width,
        height: bundle.height,
        tilesetId: bundle.tilesetId,
        events: (bundle.events ?? []).map((event) => ({
          id: event.id,
          name: event.name,
          x: event.x,
          y: event.y,
          pages: (event.pages ?? []) as unknown[],
        })),
      },
    } as PlayableMapEditorData;
  }

  console.log(
    `Bundle: ${bundles.length} maps, ${tilesetItems.length} tilesets, ` +
      `${projectedNpcs} dialogue events projected, ${preservedEvents} events preserved, ` +
      `${warnings.length} warnings.`
  );
  warnings.forEach((warning) => console.warn(`  WARN ${warning}`));

  if (dryRun) {
    console.log("Dry run: nothing was written.");
    return;
  }

  // ------------------------------------------------------------------
  // Redis merge
  // ------------------------------------------------------------------

  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });

  await redis.connect();

  try {
    // Tilesets section: merge by item id.
    const rawTilesets = await redis.get(TILESETS_REDIS_KEY);
    const tilesetsPayload = rawTilesets
      ? JSON.parse(rawTilesets)
      : { state: { categories: [IMPORT_CATEGORY], items: [] }, version: 0 };
    const importedTilesetIds = new Set(tilesetItems.map((item) => item.id));
    const keptTilesets = (tilesetsPayload.state.items ?? []).filter(
      (item: { id: string }) => !importedTilesetIds.has(item.id)
    );

    tilesetsPayload.state.items = [...keptTilesets, ...tilesetItems];
    tilesetsPayload.state.categories = Array.from(
      new Set([...(tilesetsPayload.state.categories ?? []), "Uncategorized", IMPORT_CATEGORY])
    );
    tilesetsPayload.sectionKey = "tilesets";
    tilesetsPayload.version = (tilesetsPayload.version ?? 0) + 1;
    tilesetsPayload.updatedAt = new Date().toISOString();
    tilesetsPayload.updatedByUserId = null;
    tilesetsPayload.updatedByUsername = "essentials-import";

    await redis.set(TILESETS_REDIS_KEY, JSON.stringify(tilesetsPayload));
    console.log(
      `Wrote ${tilesetItems.length} tilesets (${keptTilesets.length} existing kept) at version ${tilesetsPayload.version}.`
    );

    // Maps snapshot: merge by item id, preserve manual maps and editor data.
    const rawMaps = await redis.get(MAPS_REDIS_KEY);
    const mapsPayload = rawMaps
      ? JSON.parse(rawMaps)
      : {
          state: { categories: ["Uncategorized"], items: [], editorDataByMapId: {} },
          version: 0,
        };
    const importedMapIds = new Set(mapItems.map((item) => item.id));
    const keptMaps = (mapsPayload.state.items ?? []).filter(
      (item: { id: string }) => !importedMapIds.has(item.id)
    );
    const mergedEditorData = { ...(mapsPayload.state.editorDataByMapId ?? {}) };

    importedMapIds.forEach((mapId) => {
      delete mergedEditorData[mapId as string];
    });
    Object.assign(mergedEditorData, editorDataByMapId);

    const mergedState = sanitizePlayableMapsStateSnapshot({
      categories: Array.from(
        new Set([...(mapsPayload.state.categories ?? []), IMPORT_CATEGORY])
      ),
      items: [...keptMaps, ...mapItems],
      editorDataByMapId: mergedEditorData,
    });

    if (!mergedState) {
      fail("Merged maps snapshot failed sanitization.");
    }

    const droppedTileMaps = Object.keys(editorDataByMapId).filter(
      (mapId) => !mergedState.editorDataByMapId[mapId]?.tileMap
    );

    if (droppedTileMaps.length > 0) {
      fail(`Sanitizer dropped tile maps for: ${droppedTileMaps.join(", ")}`);
    }

    const nextMapsPayload = {
      state: mergedState,
      version: (mapsPayload.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserId: null,
      updatedByUsername: "essentials-import",
    };

    await redis.set(MAPS_REDIS_KEY, JSON.stringify(nextMapsPayload));
    console.log(
      `Wrote ${mapItems.length} maps (${keptMaps.length} existing kept) at version ${nextMapsPayload.version}; copied ${copiedChunks} baked chunks to ${mapAssetsDir}.`
    );
  } finally {
    await redis.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
