type DesignerItemDetail = {
  label: string;
  value: string;
};

type DesignerPlayableMapBackgroundImageMode = "repeat" | "centered" | "stretched";

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

type MapEditorPortalPlacement = {
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
};

type MapEditorGrassPlacement = {
  id: string;
  x: number;
  y: number;
  pokemonIds: string[];
  minLevel: number;
  maxLevel: number;
  encounterRate: number;
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
};

export type PlayableMapEditorData = {
  version: 1;
  objects: MapEditorObjectPlacement[];
  portals: MapEditorPortalPlacement[];
  grass: MapEditorGrassPlacement[];
  npcs: MapEditorNpcPlacement[];
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

function sanitizePlayableMapEditorData(value: unknown): PlayableMapEditorData {
  if (!value || typeof value !== "object") {
    return {
      version: 1,
      objects: [],
      portals: [],
      grass: [],
      npcs: [],
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

export function buildPlayableMapDefinitions(snapshot: PlayableMapsStateSnapshot): PlayableMapDefinition[] {
  return snapshot.items
    .map((item) => {
      const config = sanitizePlayableMapConfig(item.playableMapConfig);

      if (!config) {
        return null;
      }

      const editorData = snapshot.editorDataByMapId[item.id] ?? sanitizePlayableMapEditorData(null);

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
      };
    })
    .filter((definition): definition is PlayableMapDefinition => definition !== null);
}
