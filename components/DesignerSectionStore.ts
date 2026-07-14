import type { RedisClientType } from "redis";

export type DesignerSectionKey =
  | "skillsGfx"
  | "pokemons"
  | "objects"
  | "items"
  | "skills"
  | "passiveStates"
  | "players"
  | "regions"
  | "npcs"
  | "levelingCurve"
  | "abilities"
  | "types"
  | "trainers"
  | "trainerTypes"
  | "encounters"
  | "berries"
  | "ribbons"
  | "assets"
  | "battleBackgrounds"
  | "audio"
  | "fonts"
  | "tilesets"
  | "battleInterface";

export interface DesignerItemDetail {
  label: string;
  value: string;
}

export interface DesignerEssentialsSourceProfile {
  project: "Pokemon Essentials v21.1";
  sourcePath: string;
  sectionId?: string;
  lineNumber?: number;
  originalId?: string;
  originalName?: string;
}

export interface DesignerPokemonSkillAssignment {
  skillId: string;
  skillName: string;
  level: number;
  sourceMoveId?: string;
}

export interface DesignerPokemonEvYield {
  stat: string;
  value: number;
}

export interface DesignerPokemonEvolution {
  targetId: string;
  method: string;
  parameter?: string | number | boolean | null;
}

export interface DesignerPokemonFormProfile {
  formId: string;
  formName?: string;
  properties: Record<string, unknown>;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerPokemonMetricsProfile {
  backSprite?: [number, number];
  frontSprite?: [number, number];
  frontSpriteAltitude?: number;
  shadowX?: number;
  shadowSize?: number;
  raw?: Record<string, unknown>;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerPokemonProfile {
  essentialsId?: string;
  hp: number;
  attack: number;
  defense: number;
  specialAttack: number;
  specialDefense: number;
  speed: number;
  isInitialPokemon: boolean;
  elements: string[];
  skills: DesignerPokemonSkillAssignment[];
  frontImageSrc: string;
  backImageSrc: string;
  iconImageSrc: string;
  genderRatio?: string;
  growthRate?: string;
  baseExp?: number;
  evs?: DesignerPokemonEvYield[];
  catchRate?: number;
  happiness?: number;
  abilities?: string[];
  hiddenAbilities?: string[];
  tutorMoves?: string[];
  eggMoves?: string[];
  eggGroups?: string[];
  hatchSteps?: number;
  height?: number;
  weight?: number;
  color?: string;
  shape?: string;
  habitat?: string;
  category?: string;
  pokedex?: string;
  generation?: number;
  evolutions?: DesignerPokemonEvolution[];
  forms?: DesignerPokemonFormProfile[];
  metrics?: DesignerPokemonMetricsProfile;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerPokemonSkillProfile {
  essentialsId?: string;
  elements: string[];
  power: number;
  powerPoint: number;
  accuracy: number;
  category?: string;
  target?: string;
  functionCode?: string;
  flags?: string[];
  priority?: number;
  description: string;
  effectText?: string;
  skillGfxId: string;
  skillGfxName: string;
  animationId?: string;
  animationName?: string;
  weatherEffect: string;
  inflictStateId: string;
  inflictStateName: string;
  cooldown: number;
  stateConditionId: string;
  stateConditionName: string;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerSkillGfxProfile {
  mediaSrc: string;
  applyTo: string;
  appear: number;
  essentialsAnimationId?: number;
  essentialsAnimationIndex?: number;
  essentialsAnimationName?: string;
  animationKind?: "sheet" | "record" | "battle-animation" | "other";
  graphic?: string;
  sourcePath?: string;
  outputPath?: string;
  sheetSourcePath?: string;
  sheetOutputPath?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  cellSize?: number;
  columns?: number;
  rows?: number;
  frameCount?: number;
  fps?: number;
  durationMs?: number;
  hue?: number;
  position?: number;
  speed?: number;
  warnings?: string[];
  linkedMoveIds?: string[];
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerItemStatModifiers {
  hp: number;
  attack: number;
  defense: number;
  specialAttack: number;
  specialDefense: number;
  speed: number;
}

export interface DesignerGameItemProfile {
  essentialsId?: string;
  iconSrc: string;
  description: string;
  namePlural?: string;
  pocket?: string;
  price?: number;
  fieldUse?: string;
  flags?: string[];
  pokemonDbCategory: string;
  effectText: string;
  effectKind: string;
  useCondition: string;
  type: string;
  statModifiers: DesignerItemStatModifiers;
  skillId: string;
  skillName: string;
  pokeballBonusElements: string[];
  pokeballBonusRatio: number;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerNpcTrainerPokemon {
  pokemonId: string;
  pokemonName: string;
  level: number;
  moves?: string[];
  ability?: string;
  itemId?: string;
}

export interface DesignerNpcStoreItem {
  itemId: string;
  itemName: string;
  quantity: number;
  price: number;
}

export interface DesignerNpcChestItem {
  itemId: string;
  itemName: string;
  quantity: number;
}

export interface DesignerMapEventCommandProfile {
  code: number;
  parameters: unknown[];
  indent?: number;
}

export interface DesignerNpcGraphicsProfile {
  standingUpSrc: string;
  standingDownSrc: string;
  standingLeftSrc: string;
  standingRightSrc: string;
  walkingUpSrc: string;
  walkingDownSrc: string;
  walkingLeftSrc: string;
  walkingRightSrc: string;
  chestImageSrc: string;
  trainerFrontImageSrc: string;
}

export interface DesignerNpcProfile {
  essentialsId?: string;
  aiType: string;
  npcType: "healer" | "trainer" | "store" | "chest";
  trainerTypeId?: string;
  trainerTypeName?: string;
  loseText?: string;
  eventCommands?: DesignerMapEventCommandProfile[];
  graphicsSource: string;
  characterSkinId: string;
  characterSkinName: string;
  movementIntervalMinSeconds: number;
  movementIntervalMaxSeconds: number;
  movementStepMin: number;
  movementStepMax: number;
  scriptSource: string;
  healPrice: number;
  trainerPokemons: DesignerNpcTrainerPokemon[];
  storeMoney: number;
  storeItems: DesignerNpcStoreItem[];
  chestSlotCapacity: number;
  chestItems: DesignerNpcChestItem[];
  graphics: DesignerNpcGraphicsProfile;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerCharacterSkinProfile {
  standingUpSrc: string;
  standingDownSrc: string;
  standingLeftSrc: string;
  standingRightSrc: string;
  walkingUpSrc: string;
  walkingDownSrc: string;
  walkingLeftSrc: string;
  walkingRightSrc: string;
  frontImageSrc: string;
  backImageSrc: string;
}

export interface DesignerAbilityProfile {
  essentialsId: string;
  name: string;
  description: string;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerTypeProfile {
  essentialsId: string;
  name: string;
  iconPosition?: number;
  weaknesses: string[];
  resistances?: string[];
  immunities: string[];
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerTrainerPokemonProfile {
  pokemonId: string;
  level: number;
  name?: string;
  form?: number;
  gender?: string;
  ability?: string;
  itemId?: string;
  moves?: string[];
  nature?: string;
  ivs?: Record<string, number>;
  evs?: Record<string, number>;
}

export interface DesignerTrainerProfile {
  essentialsId: string;
  trainerTypeId: string;
  trainerTypeName?: string;
  version?: number;
  name: string;
  party: DesignerTrainerPokemonProfile[];
  items?: string[];
  loseText?: string;
  battleBgm?: string;
  victoryMe?: string;
  sourceEventIds?: string[];
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerTrainerTypeProfile {
  essentialsId: string;
  name: string;
  baseMoney?: number;
  battleBgm?: string;
  victoryMe?: string;
  gender?: string;
  skillLevel?: number;
  flags?: string[];
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerEncounterRowProfile {
  weight: number;
  pokemonId: string;
  minLevel: number;
  maxLevel: number;
}

export interface DesignerEncounterTableProfile {
  method: string;
  density?: number;
  rows: DesignerEncounterRowProfile[];
}

export interface DesignerEncounterProfile {
  mapId: string;
  mapVersion?: number;
  mapName?: string;
  tables: DesignerEncounterTableProfile[];
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerBerryPlantProfile {
  essentialsId: string;
  hoursPerStage?: number;
  dryRatePerHour?: number;
  minimumYield?: number;
  maximumYield?: number;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerRibbonProfile {
  essentialsId: string;
  name: string;
  description: string;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerAssetFrameProfile {
  index: number;
  x?: number;
  y?: number;
  width: number;
  height: number;
  durationMs?: number;
  outputPath?: string;
}

export interface DesignerAssetProfile {
  assetId: string;
  sourcePath: string;
  dataUri?: string;
  imageSrc?: string;
  kind: "image" | "gif" | "sprite-sheet" | "tileset" | "battleback" | "animation" | "ui" | "audio" | "font" | "other";
  width?: number;
  height?: number;
  mimeType?: string;
  frameCount?: number;
  loop?: boolean;
  frames?: DesignerAssetFrameProfile[];
  relatedRecordIds?: string[];
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerBattleBackgroundProfile extends DesignerAssetProfile {
  kind: "battleback";
  environment?: string;
  mapIds?: string[];
  componentAssetIds?: string[];
  componentAssets?: Array<DesignerAssetProfile & {
    role?: string;
    filename?: string;
    byteSize?: number;
  }>;
}

export interface DesignerAudioProfile {
  assetId: string;
  sourcePath: string;
  kind: "BGM" | "ME" | "SE";
  loop?: boolean;
  volume?: number;
  pitch?: number;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerFontProfile {
  assetId: string;
  sourcePath: string;
  familyName?: string;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerTilesetAutotileSlot {
  name: string;
  imageSrc: string;
}

/**
 * RPG Maker XP tileset profile. `passages`, `priorities`, and `terrainTags`
 * are indexed by tile id (autotiles occupy ids 0..383, tileset tiles start at
 * 384). See MAP_TILEMAP_CONTRACT.md at the workspace root.
 */
export interface DesignerTilesetProfile {
  tileSize: number;
  tilesetImageSrc: string;
  tilesetHeightTiles: number;
  autotiles: Array<DesignerTilesetAutotileSlot | null>;
  passages: number[];
  priorities: number[];
  terrainTags: number[];
  essentialsTilesetId?: number;
  tilesetGraphicName?: string;
  source?: DesignerEssentialsSourceProfile;
}

export interface DesignerSectionItem {
  id: string;
  name: string;
  category: string;
  details: DesignerItemDetail[];
  itemProfile?: DesignerGameItemProfile;
  mapObjectAsset?: unknown;
  skillGfxProfile?: DesignerSkillGfxProfile;
  pokemonProfile?: DesignerPokemonProfile;
  pokemonSkillProfile?: DesignerPokemonSkillProfile;
  levelingCurveProfile?: unknown;
  npcProfile?: DesignerNpcProfile;
  characterSkinProfile?: DesignerCharacterSkinProfile;
  abilityProfile?: DesignerAbilityProfile;
  typeProfile?: DesignerTypeProfile;
  trainerProfile?: DesignerTrainerProfile;
  trainerTypeProfile?: DesignerTrainerTypeProfile;
  encounterProfile?: DesignerEncounterProfile;
  berryPlantProfile?: DesignerBerryPlantProfile;
  ribbonProfile?: DesignerRibbonProfile;
  assetProfile?: DesignerAssetProfile;
  battleBackgroundProfile?: DesignerBattleBackgroundProfile;
  audioProfile?: DesignerAudioProfile;
  fontProfile?: DesignerFontProfile;
  tilesetProfile?: DesignerTilesetProfile;
  battleInterfaceProfile?: unknown;
}

export interface DesignerSectionState {
  categories: string[];
  items: DesignerSectionItem[];
}

export interface DesignerSectionSyncPayload {
  sectionKey: DesignerSectionKey;
  state: DesignerSectionState;
  version: number;
  updatedAt: string | null;
  updatedByUserId: number | null;
  updatedByUsername: string | null;
}

export interface DesignerSectionVersionPayload {
  sectionKey: DesignerSectionKey;
  hasState: boolean;
  version: number | null;
  updatedAt: string | null;
}

export interface DesignerSectionJoinPayload {
  sectionKey: DesignerSectionKey;
  version?: number | null;
  seedState?: DesignerSectionState;
}

export interface DesignerSectionUpdatePayload {
  sectionKey: DesignerSectionKey;
  state: DesignerSectionState;
}

const UNCATEGORIZED = "Uncategorized";
const VALID_SECTION_KEYS: DesignerSectionKey[] = [
  "skillsGfx",
  "pokemons",
  "objects",
  "items",
  "skills",
  "passiveStates",
  "players",
  "regions",
  "npcs",
  "levelingCurve",
  "abilities",
  "types",
  "trainers",
  "trainerTypes",
  "encounters",
  "berries",
  "ribbons",
  "assets",
  "battleBackgrounds",
  "audio",
  "fonts",
  "tilesets",
  "battleInterface"
];

export function isDesignerSectionKey(value: unknown): value is DesignerSectionKey {
  return typeof value === "string" && VALID_SECTION_KEYS.includes(value as DesignerSectionKey);
}

function getRedisKey(sectionKey: DesignerSectionKey) {
  return `designer:section:${sectionKey === "objects" ? "objects" : sectionKey}`;
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function parseVersion(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 1;
}

function buildEmptyState(): DesignerSectionState {
  return {
    categories: [UNCATEGORIZED],
    items: []
  };
}

export function sanitizeDesignerSectionState(value: unknown): DesignerSectionState {
  if (!value || typeof value !== "object") {
    return buildEmptyState();
  }

  const candidate = value as Partial<DesignerSectionState>;

  if (!Array.isArray(candidate.categories) || !Array.isArray(candidate.items)) {
    return buildEmptyState();
  }

  const categories = Array.from(
    new Set(
      [UNCATEGORIZED, ...candidate.categories]
        .filter((category): category is string => typeof category === "string")
        .map((category) => normalizeText(category))
        .filter(Boolean)
    )
  );

  const items = candidate.items
    .filter((item): item is DesignerSectionItem => {
      return (
        typeof item?.id === "string" &&
        typeof item?.name === "string" &&
        typeof item?.category === "string" &&
        Array.isArray(item?.details)
      );
    })
    .map((item) => ({
      ...item,
      id: item.id,
      name: normalizeText(item.name),
      category: normalizeText(item.category) || UNCATEGORIZED,
      details: item.details
        .filter(
          (detail): detail is DesignerItemDetail =>
            typeof detail?.label === "string" && typeof detail?.value === "string"
        )
        .map((detail) => ({
          label: normalizeText(detail.label),
          value: normalizeText(detail.value)
        }))
    }))
    .filter((item) => item.id.length > 0 && item.name.length > 0);

  items.forEach((item) => {
    categories.push(item.category);
  });

  return {
    categories: Array.from(new Set(categories)),
    items
  };
}

function normalizeStoredPayload(
  sectionKey: DesignerSectionKey,
  value: unknown
): DesignerSectionSyncPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<DesignerSectionSyncPayload & DesignerSectionState>;
  const stateCandidate = Array.isArray(candidate.categories) && Array.isArray(candidate.items)
    ? candidate
    : candidate.state;

  return {
    sectionKey,
    state: sanitizeDesignerSectionState(stateCandidate),
    version: parseVersion(candidate.version),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : null,
    updatedByUserId:
      typeof candidate.updatedByUserId === "number" && Number.isFinite(candidate.updatedByUserId)
        ? candidate.updatedByUserId
        : null,
    updatedByUsername:
      typeof candidate.updatedByUsername === "string" && candidate.updatedByUsername.length > 0
        ? candidate.updatedByUsername
        : null
  };
}

export default class DesignerSectionStore {
  private readonly redis: RedisClientType;
  // Sections can be tens of MB (maps, assets, pokemons); parsing them from
  // Redis on every read starves the event loop under client churn. Reads are
  // cached per section with a short TTL so external importers still land.
  private readonly cache = new Map<string, { payload: DesignerSectionSyncPayload | null; fetchedAt: number }>();
  private static CACHE_TTL_MS = 5000;

  constructor(redis: RedisClientType) {
    this.redis = redis;
  }

  async getOrCreate(
    sectionKey: DesignerSectionKey,
    seedState?: DesignerSectionState
  ): Promise<DesignerSectionSyncPayload> {
    const existing = await this.read(sectionKey);

    if (existing) {
      return existing;
    }

    return this.save(sectionKey, seedState ?? buildEmptyState(), null, null);
  }

  async save(
    sectionKey: DesignerSectionKey,
    state: DesignerSectionState,
    updatedByUserId: number | null,
    updatedByUsername: string | null
  ): Promise<DesignerSectionSyncPayload> {
    const existing = await this.read(sectionKey);
    const payload: DesignerSectionSyncPayload = {
      sectionKey,
      state: sanitizeDesignerSectionState(state),
      version: (existing?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserId,
      updatedByUsername
    };

    await this.redis.set(getRedisKey(sectionKey), JSON.stringify(payload));
    this.cache.set(sectionKey, { payload, fetchedAt: Date.now() });

    return payload;
  }

  async read(sectionKey: DesignerSectionKey): Promise<DesignerSectionSyncPayload | null> {
    const cached = this.cache.get(sectionKey);
    if (cached && Date.now() - cached.fetchedAt < DesignerSectionStore.CACHE_TTL_MS) {
      return cached.payload;
    }

    const raw = await this.redis.get(getRedisKey(sectionKey));

    if (!raw) {
      this.cache.set(sectionKey, { payload: null, fetchedAt: Date.now() });
      return null;
    }

    try {
      const payload = normalizeStoredPayload(sectionKey, JSON.parse(raw));
      this.cache.set(sectionKey, { payload, fetchedAt: Date.now() });
      return payload;
    } catch (error) {
      console.error(`Unable to parse stored designer ${sectionKey} state:`, error);
      return null;
    }
  }

  async readVersion(sectionKey: DesignerSectionKey): Promise<DesignerSectionVersionPayload> {
    const payload = await this.read(sectionKey);

    return {
      sectionKey,
      hasState: Boolean(payload),
      version: payload?.version ?? null,
      updatedAt: payload?.updatedAt ?? null
    };
  }
}
