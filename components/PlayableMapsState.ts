import {
  decodeCollisionGrid,
  TILE_MAP_GRID_ENCODING,
  TILE_MAP_LAYER_ENCODING,
  type MapCollisionGrid
} from "./TileMapGrid";

type DesignerItemDetail = {
  label: string;
  value: string;
};

type DesignerPlayableMapBackgroundImageMode = "repeat" | "centered" | "stretched";

type PlayableMapConnectionDirection = "north" | "south" | "east" | "west";

type PlayableMapConnection = {
  direction: PlayableMapConnectionDirection;
  targetMapId: string;
  /** Neighbor map's top-left cell relative to this map's top-left cell. */
  offsetXCells: number;
  offsetYCells: number;
};

type DesignerPlayableMapConfig = {
  cellSize: number;
  sizePreset: string;
  width: number;
  height: number;
  isInitialMap: boolean;
  initialPositionX: number | null;
  initialPositionY: number | null;
  regionName: string;
  regionX: number;
  regionY: number;
  mapType: string;
  backgroundColor: string;
  backgroundImageSrc: string;
  backgroundImageMode: DesignerPlayableMapBackgroundImageMode;
  essentialsMapId?: string;
  essentialsMapName?: string;
  rxdataPath?: string;
  mapInfoId?: number;
  tilesetId?: number;
  tilesetName?: string;
  tilesetAssetId?: string;
  battleBack?: string;
  environment?: string;
  flags?: string[];
  outdoor?: boolean;
  showArea?: boolean;
  mapPosition?: {
    regionId?: number;
    x: number;
    y: number;
  };
  healingSpot?: {
    mapId: string;
    x: number;
    y: number;
    direction?: number;
  };
  bgm?: string;
  bgs?: string;
  connections?: PlayableMapConnection[];
  source?: {
    project: "Pokemon Essentials v21.1";
    sourcePath: string;
    sectionId?: string;
    lineNumber?: number;
    originalId?: string;
    originalName?: string;
  };
};

type PlayableMapItem = {
  id: string;
  name: string;
  category: string;
  details: DesignerItemDetail[];
  playableMapConfig?: DesignerPlayableMapConfig;
};

type MapEditorObjectPlacement = {
  id: string;
  objectId: string;
  name: string;
  category: string;
  imageSrc: string;
  width: number;
  height: number;
  objectType: string;
  x: number;
  y: number;
};

export type MapEditorPortalPlacement = {
  id: string;
  x: number;
  y: number;
  destinationType: string;
  sameMapX: number;
  sameMapY: number;
  targetMapId: string;
  targetMapX: number;
  targetMapY: number;
  eventScript: string;
  essentialsConnection?: {
    sourceMapId: string;
    sourceX: number;
    sourceY: number;
    targetMapId: string;
    targetX: number;
    targetY: number;
    sourcePath?: string;
  };
};

type MapEditorGrassPlacement = {
  id: string;
  x: number;
  y: number;
  pokemonIds: string[];
  minLevel: number;
  maxLevel: number;
  encounterRate: number;
  encounterMethod?: string;
  encounterRows?: Array<{
    weight: number;
    pokemonId: string;
    minLevel: number;
    maxLevel: number;
  }>;
  sourceEncounterId?: string;
};

type MapEditorNpcPlacement = {
  id: string;
  npcId: string;
  name: string;
  category: string;
  previewImageSrc: string;
  npcType: string;
  aiType: string;
  interactionDistanceSquares: number;
  x: number;
  y: number;
  eventId?: number;
  eventPageIndex?: number;
  eventCommands?: Array<{
    code: number;
    parameters: unknown[];
    indent?: number;
  }>;
};

export type PlayableMapBakedChunk = {
  col: number;
  row: number;
  src: string;
  width: number;
  height: number;
};

export type PlayableMapTileMapProfile = {
  version: 1;
  tilesetItemId: string;
  width: number;
  height: number;
  tileSize: number;
  layerEncoding: typeof TILE_MAP_LAYER_ENCODING;
  layers: string[];
  collisionEncoding: typeof TILE_MAP_GRID_ENCODING;
  collision: string;
  terrainTags?: string;
  baked?: {
    chunkCells: number;
    background: PlayableMapBakedChunk[];
    foreground: PlayableMapBakedChunk[];
    bakedAt?: string;
  };
  essentials?: {
    mapId?: string;
    tilesetId?: number;
    sourcePath?: string;
  };
};

export type PlayableMapEditorData = {
  version: 1;
  objects: MapEditorObjectPlacement[];
  portals: MapEditorPortalPlacement[];
  grass: MapEditorGrassPlacement[];
  npcs: MapEditorNpcPlacement[];
  tileMap?: PlayableMapTileMapProfile;
  essentials?: {
    mapId: string;
    rxdataPath: string;
    width: number;
    height: number;
    tilesetId: number;
    layers?: number;
    table?: {
      xsize: number;
      ysize: number;
      zsize: number;
      data?: number[];
    };
    events?: Array<{
      id: number;
      name: string;
      x: number;
      y: number;
      pages: unknown[];
    }>;
    sourceExportPath?: string;
  };
};

export type PlayableMapsStateSnapshot = {
  categories: string[];
  items: PlayableMapItem[];
  editorDataByMapId: Record<string, PlayableMapEditorData>;
};

export type PlayableMapDefinition = {
  mapId: string;
  width: number;
  height: number;
  obstacles: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  collisionGrid?: MapCollisionGrid;
};

const DEFAULT_CELL_SIZE = 32;
const DEFAULT_MAP_WIDTH = 500;
const DEFAULT_MAP_HEIGHT = 500;
const DEFAULT_NPC_INTERACTION_DISTANCE_SQUARES = 2;

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function clampPositiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : fallback;
}

function clampInteger(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : fallback;
}

function sanitizePlayableMapConfig(value: unknown): DesignerPlayableMapConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<DesignerPlayableMapConfig>;

  return {
    cellSize:
      typeof candidate.cellSize === "number" &&
      [8, 16, 32, 64, 128].includes(candidate.cellSize)
        ? candidate.cellSize
        : DEFAULT_CELL_SIZE,
    sizePreset: typeof candidate.sizePreset === "string" ? candidate.sizePreset : "medium",
    width: clampPositiveInteger(candidate.width, DEFAULT_MAP_WIDTH),
    height: clampPositiveInteger(candidate.height, DEFAULT_MAP_HEIGHT),
    isInitialMap: candidate.isInitialMap === true,
    initialPositionX:
      typeof candidate.initialPositionX === "number" && Number.isFinite(candidate.initialPositionX)
        ? Math.round(candidate.initialPositionX)
        : null,
    initialPositionY:
      typeof candidate.initialPositionY === "number" && Number.isFinite(candidate.initialPositionY)
        ? Math.round(candidate.initialPositionY)
        : null,
    regionName:
      typeof candidate.regionName === "string" && candidate.regionName.trim()
        ? normalizeText(candidate.regionName)
        : "Ash Coast",
    regionX: clampInteger(candidate.regionX),
    regionY: clampInteger(candidate.regionY),
    mapType: typeof candidate.mapType === "string" ? candidate.mapType : "grassland",
    backgroundColor:
      typeof candidate.backgroundColor === "string" ? candidate.backgroundColor : "#8bc17f",
    backgroundImageSrc:
      typeof candidate.backgroundImageSrc === "string" ? candidate.backgroundImageSrc : "",
    backgroundImageMode:
      candidate.backgroundImageMode === "centered" ||
      candidate.backgroundImageMode === "stretched" ||
      candidate.backgroundImageMode === "repeat"
        ? candidate.backgroundImageMode
        : "repeat",
    essentialsMapId:
      typeof candidate.essentialsMapId === "string" ? candidate.essentialsMapId : undefined,
    essentialsMapName:
      typeof candidate.essentialsMapName === "string" ? candidate.essentialsMapName : undefined,
    rxdataPath: typeof candidate.rxdataPath === "string" ? candidate.rxdataPath : undefined,
    mapInfoId:
      typeof candidate.mapInfoId === "number" && Number.isFinite(candidate.mapInfoId)
        ? Math.round(candidate.mapInfoId)
        : undefined,
    tilesetId:
      typeof candidate.tilesetId === "number" && Number.isFinite(candidate.tilesetId)
        ? Math.round(candidate.tilesetId)
        : undefined,
    tilesetName: typeof candidate.tilesetName === "string" ? candidate.tilesetName : undefined,
    tilesetAssetId:
      typeof candidate.tilesetAssetId === "string" ? candidate.tilesetAssetId : undefined,
    battleBack: typeof candidate.battleBack === "string" ? candidate.battleBack : undefined,
    environment: typeof candidate.environment === "string" ? candidate.environment : undefined,
    flags: Array.isArray(candidate.flags)
      ? candidate.flags.filter((flag): flag is string => typeof flag === "string")
      : undefined,
    outdoor: typeof candidate.outdoor === "boolean" ? candidate.outdoor : undefined,
    showArea: typeof candidate.showArea === "boolean" ? candidate.showArea : undefined,
    mapPosition:
      candidate.mapPosition && typeof candidate.mapPosition === "object" &&
      typeof candidate.mapPosition.x === "number" &&
      typeof candidate.mapPosition.y === "number"
        ? {
            regionId:
              typeof candidate.mapPosition.regionId === "number" &&
              Number.isFinite(candidate.mapPosition.regionId)
                ? Math.round(candidate.mapPosition.regionId)
                : undefined,
            x: clampInteger(candidate.mapPosition.x),
            y: clampInteger(candidate.mapPosition.y),
          }
        : undefined,
    healingSpot:
      candidate.healingSpot && typeof candidate.healingSpot === "object" &&
      typeof candidate.healingSpot.mapId === "string" &&
      typeof candidate.healingSpot.x === "number" &&
      typeof candidate.healingSpot.y === "number"
        ? {
            mapId: candidate.healingSpot.mapId,
            x: clampInteger(candidate.healingSpot.x),
            y: clampInteger(candidate.healingSpot.y),
            direction:
              typeof candidate.healingSpot.direction === "number" &&
              Number.isFinite(candidate.healingSpot.direction)
                ? Math.round(candidate.healingSpot.direction)
                : undefined,
          }
        : undefined,
    bgm: typeof candidate.bgm === "string" ? candidate.bgm : undefined,
    bgs: typeof candidate.bgs === "string" ? candidate.bgs : undefined,
    connections: Array.isArray(candidate.connections)
      ? candidate.connections
          .filter(
            (connection): connection is PlayableMapConnection =>
              !!connection &&
              typeof connection === "object" &&
              ["north", "south", "east", "west"].includes(connection.direction) &&
              typeof connection.targetMapId === "string" &&
              connection.targetMapId.length > 0 &&
              typeof connection.offsetXCells === "number" &&
              Number.isFinite(connection.offsetXCells) &&
              typeof connection.offsetYCells === "number" &&
              Number.isFinite(connection.offsetYCells)
          )
          .map((connection) => ({
            direction: connection.direction,
            targetMapId: connection.targetMapId,
            offsetXCells: Math.round(connection.offsetXCells),
            offsetYCells: Math.round(connection.offsetYCells),
          }))
      : undefined,
    source:
      candidate.source && typeof candidate.source === "object" &&
      candidate.source.project === "Pokemon Essentials v21.1" &&
      typeof candidate.source.sourcePath === "string"
        ? candidate.source
        : undefined,
  };
}

function sanitizePlayableMapItems(value: unknown): PlayableMapItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is PlayableMapItem =>
        typeof item?.id === "string" &&
        typeof item?.name === "string" &&
        typeof item?.category === "string" &&
        Array.isArray(item?.details)
    )
    .map((item) => ({
      id: item.id,
      name: normalizeText(item.name),
      category: normalizeText(item.category),
      details: item.details
        .filter(
          (detail): detail is DesignerItemDetail =>
            typeof detail?.label === "string" && typeof detail?.value === "string"
        )
        .map((detail) => ({
          label: normalizeText(detail.label),
          value: normalizeText(detail.value),
        })),
      playableMapConfig: sanitizePlayableMapConfig(item.playableMapConfig),
    }))
    .filter((item) => item.id.length > 0 && item.name.length > 0 && item.category.length > 0);
}

function sanitizeBakedChunks(value: unknown): PlayableMapBakedChunk[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (chunk): chunk is PlayableMapBakedChunk =>
        typeof chunk?.col === "number" &&
        typeof chunk?.row === "number" &&
        typeof chunk?.src === "string" &&
        chunk.src.length > 0 &&
        typeof chunk?.width === "number" &&
        typeof chunk?.height === "number"
    )
    .map((chunk) => ({
      col: Math.max(0, clampInteger(chunk.col)),
      row: Math.max(0, clampInteger(chunk.row)),
      src: chunk.src,
      width: clampPositiveInteger(chunk.width, 1),
      height: clampPositiveInteger(chunk.height, 1)
    }));
}

function sanitizeTileMapProfile(value: unknown): PlayableMapTileMapProfile | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<PlayableMapTileMapProfile>;

  if (
    candidate.version !== 1 ||
    typeof candidate.tilesetItemId !== "string" ||
    candidate.layerEncoding !== TILE_MAP_LAYER_ENCODING ||
    candidate.collisionEncoding !== TILE_MAP_GRID_ENCODING ||
    !Array.isArray(candidate.layers) ||
    typeof candidate.collision !== "string" ||
    typeof candidate.width !== "number" ||
    typeof candidate.height !== "number"
  ) {
    return undefined;
  }

  const layers = candidate.layers.filter(
    (layer): layer is string => typeof layer === "string"
  );

  if (layers.length === 0 || layers.length > 3) {
    return undefined;
  }

  return {
    version: 1,
    tilesetItemId: candidate.tilesetItemId,
    width: clampPositiveInteger(candidate.width, 1),
    height: clampPositiveInteger(candidate.height, 1),
    tileSize: clampPositiveInteger(candidate.tileSize, 32),
    layerEncoding: TILE_MAP_LAYER_ENCODING,
    layers,
    collisionEncoding: TILE_MAP_GRID_ENCODING,
    collision: candidate.collision,
    terrainTags:
      typeof candidate.terrainTags === "string" ? candidate.terrainTags : undefined,
    baked:
      candidate.baked && typeof candidate.baked === "object"
        ? {
            chunkCells: clampPositiveInteger(candidate.baked.chunkCells, 64),
            background: sanitizeBakedChunks(candidate.baked.background),
            foreground: sanitizeBakedChunks(candidate.baked.foreground),
            bakedAt:
              typeof candidate.baked.bakedAt === "string"
                ? candidate.baked.bakedAt
                : undefined
          }
        : undefined,
    essentials:
      candidate.essentials && typeof candidate.essentials === "object"
        ? {
            mapId:
              typeof candidate.essentials.mapId === "string"
                ? candidate.essentials.mapId
                : undefined,
            tilesetId:
              typeof candidate.essentials.tilesetId === "number" &&
              Number.isFinite(candidate.essentials.tilesetId)
                ? Math.round(candidate.essentials.tilesetId)
                : undefined,
            sourcePath:
              typeof candidate.essentials.sourcePath === "string"
                ? candidate.essentials.sourcePath
                : undefined
          }
        : undefined
  };
}

function sanitizePlayableMapEditorData(value: unknown): PlayableMapEditorData {
  if (!value || typeof value !== "object") {
    return {
      version: 1,
      objects: [],
      portals: [],
      grass: [],
      npcs: [],
      essentials: undefined,
    };
  }

  const candidate = value as Partial<PlayableMapEditorData>;

  return {
    version: 1,
    objects: Array.isArray(candidate.objects)
      ? candidate.objects
          .filter(
            (item): item is MapEditorObjectPlacement =>
              typeof item?.id === "string" &&
              typeof item?.objectId === "string" &&
              typeof item?.name === "string" &&
              typeof item?.category === "string" &&
              typeof item?.imageSrc === "string" &&
              typeof item?.width === "number" &&
              typeof item?.height === "number" &&
              typeof item?.objectType === "string" &&
              typeof item?.x === "number" &&
              typeof item?.y === "number"
          )
          .map((item) => ({
            ...item,
            width: clampPositiveInteger(item.width, 16),
            height: clampPositiveInteger(item.height, 16),
            x: Math.max(0, clampInteger(item.x)),
            y: Math.max(0, clampInteger(item.y)),
          }))
      : [],
    portals: Array.isArray(candidate.portals)
      ? candidate.portals
          .filter(
            (item): item is MapEditorPortalPlacement =>
              typeof item?.id === "string" &&
              typeof item?.x === "number" &&
              typeof item?.y === "number" &&
              typeof item?.destinationType === "string" &&
              typeof item?.sameMapX === "number" &&
              typeof item?.sameMapY === "number" &&
              typeof item?.targetMapId === "string" &&
              typeof item?.targetMapX === "number" &&
              typeof item?.targetMapY === "number" &&
              typeof item?.eventScript === "string"
          )
          .map((item) => ({
            ...item,
            x: Math.max(0, clampInteger(item.x)),
            y: Math.max(0, clampInteger(item.y)),
            sameMapX: clampInteger(item.sameMapX),
            sameMapY: clampInteger(item.sameMapY),
            targetMapX: clampInteger(item.targetMapX),
            targetMapY: clampInteger(item.targetMapY),
          }))
      : [],
    grass: Array.isArray(candidate.grass)
      ? candidate.grass
          .filter(
            (item): item is MapEditorGrassPlacement =>
              typeof item?.id === "string" &&
              typeof item?.x === "number" &&
              typeof item?.y === "number" &&
              Array.isArray(item?.pokemonIds) &&
              typeof item?.minLevel === "number" &&
              typeof item?.maxLevel === "number" &&
              typeof item?.encounterRate === "number"
          )
          .map((item) => ({
            ...item,
            x: Math.max(0, clampInteger(item.x)),
            y: Math.max(0, clampInteger(item.y)),
            pokemonIds: item.pokemonIds.filter(
              (pokemonId): pokemonId is string => typeof pokemonId === "string"
            ),
            minLevel: Math.max(1, clampInteger(item.minLevel, 1)),
            maxLevel: Math.max(
              Math.max(1, clampInteger(item.minLevel, 1)),
              Math.max(1, clampInteger(item.maxLevel, 1))
            ),
            encounterRate: Math.max(0, Math.min(100, clampInteger(item.encounterRate))),
          }))
      : [],
    npcs: Array.isArray(candidate.npcs)
      ? candidate.npcs
          .filter(
            (item): item is MapEditorNpcPlacement =>
              typeof item?.id === "string" &&
              typeof item?.npcId === "string" &&
              typeof item?.name === "string" &&
              typeof item?.category === "string" &&
              typeof item?.previewImageSrc === "string" &&
              typeof item?.npcType === "string" &&
              typeof item?.aiType === "string" &&
              typeof item?.x === "number" &&
              typeof item?.y === "number"
          )
          .map((item) => ({
            ...item,
            interactionDistanceSquares:
              typeof item.interactionDistanceSquares === "number" &&
              Number.isFinite(item.interactionDistanceSquares) &&
              item.interactionDistanceSquares >= 0
                ? Math.round(item.interactionDistanceSquares)
                : DEFAULT_NPC_INTERACTION_DISTANCE_SQUARES,
            x: Math.max(0, clampInteger(item.x)),
            y: Math.max(0, clampInteger(item.y)),
          }))
      : [],
    tileMap: sanitizeTileMapProfile(candidate.tileMap),
    essentials:
      candidate.essentials && typeof candidate.essentials === "object" &&
      typeof candidate.essentials.mapId === "string" &&
      typeof candidate.essentials.rxdataPath === "string" &&
      typeof candidate.essentials.width === "number" &&
      typeof candidate.essentials.height === "number" &&
      typeof candidate.essentials.tilesetId === "number"
        ? candidate.essentials
        : undefined,
  };
}

export function sanitizePlayableMapsStateSnapshot(value: unknown): PlayableMapsStateSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<PlayableMapsStateSnapshot>;
  const items = sanitizePlayableMapItems(candidate.items);

  if (!Array.isArray(candidate.items)) {
    return null;
  }

  return {
    categories: Array.isArray(candidate.categories)
      ? candidate.categories.filter((category): category is string => typeof category === "string")
      : [],
    items,
    editorDataByMapId: Object.entries(
      (candidate.editorDataByMapId ?? {}) as Record<string, unknown>
    ).reduce<Record<string, PlayableMapEditorData>>((accumulator, [mapId, editorData]) => {
      if (typeof mapId !== "string" || mapId.length === 0) {
        return accumulator;
      }

      accumulator[mapId] = sanitizePlayableMapEditorData(editorData);
      return accumulator;
    }, {}),
  };
}

function resolveInitialPosition(config: DesignerPlayableMapConfig) {
  if (
    typeof config.initialPositionX === "number" &&
    typeof config.initialPositionY === "number"
  ) {
    return {
      x: config.initialPositionX,
      y: config.initialPositionY,
    };
  }

  return {
    x: Math.round((config.width * config.cellSize) / 2),
    y: Math.round((config.height * config.cellSize) / 2),
  };
}

export function resolveInitialSpawnFromPlayableMapsState(snapshot: PlayableMapsStateSnapshot) {
  const initialMap =
    snapshot.items.find((item) => item.playableMapConfig?.isInitialMap === true) ??
    snapshot.items[0] ??
    null;

  if (!initialMap) {
    return null;
  }

  const config = sanitizePlayableMapConfig(initialMap.playableMapConfig);

  if (!config) {
    return null;
  }

  const position = resolveInitialPosition(config);

  return {
    mapId: initialMap.id,
    x: position.x,
    y: position.y,
  };
}

/**
 * Server-side mirror of the client's resolvePortalDestination: designer
 * portals teleport within the source map ("same-map") or to a cell on a
 * target map ("other-map"), scaled by the DESTINATION map's cellSize.
 */
export function resolvePlayableMapPortalDestination(
  snapshot: PlayableMapsStateSnapshot,
  sourceMapId: string,
  portal: MapEditorPortalPlacement
): { mapId: string; x: number; y: number } | null {
  const cellSizeOf = (mapId: string) =>
    snapshot.items.find((item) => item.id === mapId)?.playableMapConfig?.cellSize ??
    DEFAULT_CELL_SIZE;

  if (portal.destinationType === "same-map") {
    const cellSize = cellSizeOf(sourceMapId);
    return {
      mapId: sourceMapId,
      x: Math.max(0, Math.round(portal.sameMapX)) * cellSize,
      y: Math.max(0, Math.round(portal.sameMapY)) * cellSize
    };
  }

  if (portal.destinationType !== "other-map") {
    return null;
  }

  const targetMap = snapshot.items.find((item) => item.id === portal.targetMapId);

  if (!targetMap) {
    return null;
  }

  const cellSize = targetMap.playableMapConfig?.cellSize ?? DEFAULT_CELL_SIZE;

  return {
    mapId: targetMap.id,
    x: Math.max(0, Math.round(portal.targetMapX)) * cellSize,
    y: Math.max(0, Math.round(portal.targetMapY)) * cellSize
  };
}

export function buildPlayableMapDefinitions(snapshot: PlayableMapsStateSnapshot): PlayableMapDefinition[] {
  return snapshot.items
    .map((item): PlayableMapDefinition | null => {
      const config = sanitizePlayableMapConfig(item.playableMapConfig);

      if (!config) {
        return null;
      }

      const editorData = snapshot.editorDataByMapId[item.id] ?? sanitizePlayableMapEditorData(null);
      const tileMap = editorData.tileMap;
      const collisionGrid = tileMap
        ? decodeCollisionGrid(
            tileMap.collision,
            tileMap.width,
            tileMap.height,
            tileMap.tileSize
          ) ?? undefined
        : undefined;

      return {
        mapId: item.id,
        width: config.width * config.cellSize,
        height: config.height * config.cellSize,
        obstacles: editorData.objects
          .filter((object) => object.objectType === "obstacle")
          .map((object) => ({
            x: object.x * config.cellSize,
            y: object.y * config.cellSize,
            width: object.width,
            height: object.height,
          })),
        collisionGrid,
      };
    })
    .filter((definition): definition is PlayableMapDefinition => definition !== null);
}
