import type { RedisClientType } from "redis";
import {
  buildPlayableMapDefinitions,
  sanitizePlayableMapsStateSnapshot,
  type PlayableMapsStateSnapshot
} from "./PlayableMapsState";
import type World from "./world";

export interface PlayableMapsSyncPayload {
  state: PlayableMapsStateSnapshot;
  version: number;
  updatedAt: string | null;
  updatedByUserId: number | null;
  updatedByUsername: string | null;
}

export interface PlayableMapsVersionPayload {
  hasState: boolean;
  version: number | null;
  updatedAt: string | null;
}

const REDIS_KEY = "designer:section:maps";

function parseVersion(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 1;
}

function normalizeStoredPayload(value: unknown): PlayableMapsSyncPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<PlayableMapsSyncPayload & PlayableMapsStateSnapshot>;
  const stateCandidate =
    "state" in candidate
      ? candidate.state
      : {
          categories: candidate.categories,
          items: candidate.items,
          editorDataByMapId: candidate.editorDataByMapId
        };
  const state = sanitizePlayableMapsStateSnapshot(stateCandidate);

  if (!state) {
    return null;
  }

  return {
    state,
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

export function applyPlayableMapsStateToWorld(
  world: World,
  payload: PlayableMapsSyncPayload | null
) {
  if (!payload) {
    return;
  }

  world.setPlayableMapsState(payload.state);
  world.registerMapDefinitions(buildPlayableMapDefinitions(payload.state));
}

export default class PlayableMapsStore {
  private readonly redis: RedisClientType;

  constructor(redis: RedisClientType) {
    this.redis = redis;
  }

  async getOrCreate(seedState?: PlayableMapsStateSnapshot): Promise<PlayableMapsSyncPayload | null> {
    const existing = await this.read();

    if (existing) {
      return existing;
    }

    const sanitizedSeed = sanitizePlayableMapsStateSnapshot(seedState);

    if (!sanitizedSeed) {
      return null;
    }

    return this.save(sanitizedSeed, null, null);
  }

  async save(
    state: PlayableMapsStateSnapshot,
    updatedByUserId: number | null,
    updatedByUsername: string | null
  ): Promise<PlayableMapsSyncPayload> {
    const existing = await this.read();
    const sanitizedState = sanitizePlayableMapsStateSnapshot(state);

    if (!sanitizedState) {
      throw new Error("Playable maps state must include at least one valid map.");
    }

    const payload: PlayableMapsSyncPayload = {
      state: sanitizedState,
      version: (existing?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserId,
      updatedByUsername
    };

    await this.redis.set(REDIS_KEY, JSON.stringify(payload));

    return payload;
  }

  async read(): Promise<PlayableMapsSyncPayload | null> {
    const raw = await this.redis.get(REDIS_KEY);

    if (!raw) {
      return null;
    }

    try {
      return normalizeStoredPayload(JSON.parse(raw));
    } catch (error) {
      console.error("Unable to parse stored playable maps state:", error);
      return null;
    }
  }

  async readVersion(): Promise<PlayableMapsVersionPayload> {
    const payload = await this.read();

    return {
      hasState: Boolean(payload),
      version: payload?.version ?? null,
      updatedAt: payload?.updatedAt ?? null
    };
  }
}
