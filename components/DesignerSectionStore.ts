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
  | "fonts";

export interface DesignerItemDetail {
  label: string;
  value: string;
}

export interface DesignerSectionItem {
  id: string;
  name: string;
  category: string;
  details: DesignerItemDetail[];
  itemProfile?: unknown;
  mapObjectAsset?: unknown;
  skillGfxProfile?: unknown;
  pokemonProfile?: unknown;
  pokemonSkillProfile?: unknown;
  levelingCurveProfile?: unknown;
  npcProfile?: unknown;
  characterSkinProfile?: unknown;
  abilityProfile?: unknown;
  typeProfile?: unknown;
  trainerTypeProfile?: unknown;
  encounterProfile?: unknown;
  berryPlantProfile?: unknown;
  ribbonProfile?: unknown;
  assetProfile?: unknown;
  audioProfile?: unknown;
  fontProfile?: unknown;
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
  "fonts"
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

    return payload;
  }

  async read(sectionKey: DesignerSectionKey): Promise<DesignerSectionSyncPayload | null> {
    const raw = await this.redis.get(getRedisKey(sectionKey));

    if (!raw) {
      return null;
    }

    try {
      return normalizeStoredPayload(sectionKey, JSON.parse(raw));
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
