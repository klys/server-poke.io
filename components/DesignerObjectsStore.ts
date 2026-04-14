import type { RedisClientType } from "redis";

export type DesignerMapObjectType = "obstacle" | "mob area" | "floor" | "water";

export interface DesignerMapObjectAsset {
  imageSrc: string;
  width: number;
  height: number;
  objectType: DesignerMapObjectType;
}

export interface DesignerItemDetail {
  label: string;
  value: string;
}

export interface DesignerObjectItem {
  id: string;
  name: string;
  category: string;
  details: DesignerItemDetail[];
  mapObjectAsset?: DesignerMapObjectAsset;
}

export interface DesignerObjectsSectionState {
  categories: string[];
  items: DesignerObjectItem[];
}

export interface DesignerObjectsSyncPayload {
  state: DesignerObjectsSectionState;
  updatedAt: string | null;
  updatedByUserId: number | null;
  updatedByUsername: string | null;
}

export interface DesignerObjectsJoinPayload {
  seedState?: DesignerObjectsSectionState;
}

export interface DesignerObjectsUpdatePayload {
  state: DesignerObjectsSectionState;
}

const REDIS_KEY = "designer:section:objects";
const UNCATEGORIZED = "Uncategorized";
const VALID_OBJECT_TYPES: DesignerMapObjectType[] = [
  "obstacle",
  "mob area",
  "floor",
  "water"
];

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeCategoryName(value: string) {
  return normalizeText(value);
}

function isValidObjectType(value: unknown): value is DesignerMapObjectType {
  return typeof value === "string" && VALID_OBJECT_TYPES.includes(value as DesignerMapObjectType);
}

function sanitizeMapObjectAsset(value: unknown): DesignerMapObjectAsset | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<DesignerMapObjectAsset>;
  const width =
    typeof candidate.width === "number" && Number.isFinite(candidate.width)
      ? Math.max(1, Math.round(candidate.width))
      : null;
  const height =
    typeof candidate.height === "number" && Number.isFinite(candidate.height)
      ? Math.max(1, Math.round(candidate.height))
      : null;

  if (
    typeof candidate.imageSrc !== "string" ||
    candidate.imageSrc.length === 0 ||
    width === null ||
    height === null ||
    !isValidObjectType(candidate.objectType)
  ) {
    return undefined;
  }

  return {
    imageSrc: candidate.imageSrc,
    width,
    height,
    objectType: candidate.objectType
  };
}

function sanitizeItemDetails(value: unknown, asset?: DesignerMapObjectAsset): DesignerItemDetail[] {
  if (!Array.isArray(value)) {
    return asset
      ? [
          { label: "Type", value: asset.objectType },
          { label: "Width", value: `${asset.width} px` },
          { label: "Height", value: `${asset.height} px` }
        ]
      : [];
  }

  return value
    .filter((detail): detail is DesignerItemDetail => {
      return (
        typeof detail?.label === "string" &&
        typeof detail?.value === "string" &&
        normalizeText(detail.label).length > 0 &&
        normalizeText(detail.value).length > 0
      );
    })
    .map((detail) => ({
      label: normalizeText(detail.label),
      value: normalizeText(detail.value)
    }));
}

function buildDefaultState(): DesignerObjectsSectionState {
  return {
    categories: [UNCATEGORIZED, "Nature", "Buildings", "Interactables"],
    items: [
      {
        id: "object-ancient-oak",
        name: "Ancient Oak",
        category: "Nature",
        details: [
          { label: "Type", value: "obstacle" },
          { label: "Width", value: "96 px" },
          { label: "Height", value: "144 px" }
        ]
      },
      {
        id: "object-market-stall",
        name: "Market Stall",
        category: "Buildings",
        details: [
          { label: "Type", value: "floor" },
          { label: "Width", value: "144 px" },
          { label: "Height", value: "96 px" }
        ]
      },
      {
        id: "object-crystal-switch",
        name: "Crystal Switch",
        category: "Interactables",
        details: [
          { label: "Type", value: "mob area" },
          { label: "Width", value: "48 px" },
          { label: "Height", value: "48 px" }
        ]
      }
    ]
  };
}

export function sanitizeDesignerObjectsState(value: unknown): DesignerObjectsSectionState {
  const fallback = buildDefaultState();

  if (!value || typeof value !== "object") {
    return fallback;
  }

  const candidate = value as Partial<DesignerObjectsSectionState>;

  if (!Array.isArray(candidate.categories) || !Array.isArray(candidate.items)) {
    return fallback;
  }

  const categories = Array.from(
    new Set(
      [UNCATEGORIZED, ...candidate.categories]
        .filter((category): category is string => typeof category === "string")
        .map((category) => normalizeCategoryName(category))
        .filter(Boolean)
    )
  );

  const items = candidate.items
    .filter((item): item is DesignerObjectItem => {
      return (
        typeof item?.id === "string" &&
        typeof item?.name === "string" &&
        typeof item?.category === "string"
      );
    })
    .map((item) => {
      const mapObjectAsset = sanitizeMapObjectAsset(item.mapObjectAsset);

      return {
        id: item.id,
        name: normalizeText(item.name),
        category: normalizeCategoryName(item.category) || UNCATEGORIZED,
        details: sanitizeItemDetails(item.details, mapObjectAsset),
        mapObjectAsset
      };
    })
    .filter((item) => item.id.length > 0 && item.name.length > 0);

  items.forEach((item) => {
    categories.push(item.category);
  });

  return {
    categories: Array.from(new Set(categories)),
    items
  };
}

function normalizeStoredPayload(value: unknown): DesignerObjectsSyncPayload {
  if (!value || typeof value !== "object") {
    return {
      state: buildDefaultState(),
      updatedAt: null,
      updatedByUserId: null,
      updatedByUsername: null
    };
  }

  const candidate = value as Partial<DesignerObjectsSyncPayload & DesignerObjectsSectionState>;
  const state = Array.isArray(candidate.categories) && Array.isArray(candidate.items)
    ? sanitizeDesignerObjectsState(candidate)
    : sanitizeDesignerObjectsState(candidate.state);

  return {
    state,
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

export default class DesignerObjectsStore {
  private readonly redis: RedisClientType;

  constructor(redis: RedisClientType) {
    this.redis = redis;
  }

  async getOrCreate(seedState?: DesignerObjectsSectionState): Promise<DesignerObjectsSyncPayload> {
    const existing = await this.read();

    if (existing) {
      return existing;
    }

    return this.save(seedState ?? buildDefaultState(), null, null);
  }

  async save(
    state: DesignerObjectsSectionState,
    updatedByUserId: number | null,
    updatedByUsername: string | null
  ): Promise<DesignerObjectsSyncPayload> {
    const payload: DesignerObjectsSyncPayload = {
      state: sanitizeDesignerObjectsState(state),
      updatedAt: new Date().toISOString(),
      updatedByUserId,
      updatedByUsername
    };

    await this.redis.set(REDIS_KEY, JSON.stringify(payload));

    return payload;
  }

  private async read(): Promise<DesignerObjectsSyncPayload | null> {
    const raw = await this.redis.get(REDIS_KEY);

    if (!raw) {
      return null;
    }

    try {
      return normalizeStoredPayload(JSON.parse(raw));
    } catch (error) {
      console.error("Unable to parse stored designer objects state:", error);
      return null;
    }
  }
}
