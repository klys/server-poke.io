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
// Tiny sidecar marker bumped on every save(); together with STRLEN of the
// blob it forms a cheap staleness probe so cache refreshes don't have to
// re-download and re-parse the multi-MB payload when nothing changed.
const PROBE_KEY = `${REDIS_KEY}:probe`;

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

let lastAppliedWorldState: PlayableMapsStateSnapshot | null = null;

export function applyPlayableMapsStateToWorld(
  world: World,
  payload: PlayableMapsSyncPayload | null
) {
  if (!payload) {
    return;
  }
  // Re-applying the same (cached) snapshot is wasted work — rebuilding the
  // map definitions for 250+ maps on every addPlayer starves the event loop.
  if (payload.state === lastAppliedWorldState) {
    return;
  }
  lastAppliedWorldState = payload.state;

  world.setPlayableMapsState(payload.state);
  world.registerMapDefinitions(buildPlayableMapDefinitions(payload.state));
}

export default class PlayableMapsStore {
  private readonly redis: RedisClientType;

  // The maps payload is tens of MB; parsing it from Redis on every read used
  // to burn a CPU core whenever clients churned (each addPlayer / maps sync
  // re-parsed it). Reads are served from this cache; on TTL expiry a cheap
  // probe (blob byte length + save marker) decides whether the blob actually
  // changed — only then is it re-downloaded and re-parsed. Serving the SAME
  // payload object also keeps its identity stable, which is what lets
  // applyPlayableMapsStateToWorld skip rebuilding the world's map definitions.
  private cache: {
    payload: PlayableMapsSyncPayload | null;
    fetchedAt: number;
    probe: string;
  } | null = null;
  private static CACHE_TTL_MS = 5000;

  constructor(redis: RedisClientType) {
    this.redis = redis;
  }

  /**
   * Cheap change detector: byte length of the stored blob plus the marker
   * written by save(). External importers that write the blob directly won't
   * bump the marker, but any realistic content change alters the byte length.
   */
  private async fetchProbe() {
    const [byteLength, marker] = await Promise.all([
      this.redis.strLen(REDIS_KEY),
      this.redis.get(PROBE_KEY)
    ]);

    return `${byteLength}:${marker ?? ""}`;
  }

  /** Probe of the currently cached payload; used to build cheap HTTP ETags. */
  currentProbe() {
    return this.cache?.probe ?? "";
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
      throw new Error("Playable maps state is invalid.");
    }

    const payload: PlayableMapsSyncPayload = {
      state: sanitizedState,
      version: (existing?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserId,
      updatedByUsername
    };

    const serialized = JSON.stringify(payload);
    const marker = `${payload.version}:${payload.updatedAt}`;
    await this.redis.set(REDIS_KEY, serialized);
    await this.redis.set(PROBE_KEY, marker);
    this.cache = {
      payload,
      fetchedAt: Date.now(),
      probe: `${Buffer.byteLength(serialized)}:${marker}`
    };

    return payload;
  }

  async read(): Promise<PlayableMapsSyncPayload | null> {
    if (this.cache && Date.now() - this.cache.fetchedAt < PlayableMapsStore.CACHE_TTL_MS) {
      return this.cache.payload;
    }

    // Probe before the full download: if the blob is byte-identical, keep
    // serving the already-parsed payload (same object identity) and just
    // extend the TTL window.
    const probe = await this.fetchProbe();
    if (this.cache && this.cache.probe === probe) {
      this.cache.fetchedAt = Date.now();
      return this.cache.payload;
    }

    const raw = await this.redis.get(REDIS_KEY);

    if (!raw) {
      this.cache = { payload: null, fetchedAt: Date.now(), probe };
      return null;
    }

    try {
      const payload = normalizeStoredPayload(JSON.parse(raw));
      this.cache = { payload, fetchedAt: Date.now(), probe };
      return payload;
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
