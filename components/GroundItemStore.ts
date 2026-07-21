import type { RedisClientType } from "redis";

export interface GroundItem {
  id: string;
  itemId: string;
  itemName: string;
  category: string;
  description: string;
  iconSrc: string;
  quantity: number;
  mapId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  droppedAt: string;
  /**
   * Hidden items are invisible on the ground (never emitted to clients) and
   * can't be walked into until the Dowsing Machine/Itemfinder reveals them.
   */
  hidden?: boolean;
}

const REDIS_KEY = "world:ground-items";

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}

function sanitizeGroundItem(value: unknown): GroundItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<GroundItem>;
  const id = normalizeText(candidate.id);
  const itemId = normalizeText(candidate.itemId);
  const itemName = normalizeText(candidate.itemName);
  const quantity = normalizeNumber(candidate.quantity);
  const mapId = normalizeText(candidate.mapId);

  if (!id || !itemId || !itemName || !mapId || quantity <= 0) {
    return null;
  }

  return {
    id,
    itemId,
    itemName,
    category: normalizeText(candidate.category),
    description: normalizeText(candidate.description),
    iconSrc: typeof candidate.iconSrc === "string" ? candidate.iconSrc : "",
    quantity,
    mapId,
    x: Math.max(0, normalizeNumber(candidate.x)),
    y: Math.max(0, normalizeNumber(candidate.y)),
    width: Math.max(16, normalizeNumber(candidate.width, 32)),
    height: Math.max(16, normalizeNumber(candidate.height, 32)),
    droppedAt: normalizeText(candidate.droppedAt) || new Date().toISOString(),
    ...(candidate.hidden ? { hidden: true } : {})
  };
}

export default class GroundItemStore {
  private readonly redis: RedisClientType;

  constructor(redis: RedisClientType) {
    this.redis = redis;
  }

  async readAll() {
    const raw = await this.redis.get(REDIS_KEY);

    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map(sanitizeGroundItem).filter((item): item is GroundItem => Boolean(item))
        : [];
    } catch (error) {
      console.error("Unable to parse ground item state:", error);
      return [];
    }
  }

  async saveAll(items: GroundItem[]) {
    await this.redis.set(REDIS_KEY, JSON.stringify(items.map(sanitizeGroundItem).filter(Boolean)));
  }
}
