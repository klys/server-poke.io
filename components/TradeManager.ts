/**
 * Player-to-player trading.
 *
 * The server is the sole authority for trade state, asset ownership,
 * validation, reservation and execution. Clients send intents; everything they
 * see comes back from here.
 *
 * Shape of the system:
 *
 *   TradeManager        state machine, validation, socket surface (this file)
 *   trade/TradeReservations   locks offered assets against every other system
 *   trade/TradeExecutor       plans + atomically commits the exchange (Lua CAS)
 *   trade/TradeStore          Redis: one-trade-per-player claim, chat, audit
 *   trade/tradeSnapshot       deterministic snapshot + hash both players confirm
 *
 * Validation runs three times, deliberately:
 *   1. when an asset is added to an offer (fast feedback),
 *   2. when the trade enters FINAL_CONFIRMATION (the snapshot must be true),
 *   3. inside the executor, against the exact bytes it compare-and-swaps.
 *
 * See TRADING.md for the state diagram, the event catalogue and the
 * concurrency notes.
 */

import crypto from "crypto";
import type { RedisClientType } from "redis";
import type { Server, Socket } from "socket.io";
import type Auth from "./Auth";
import type { AuthenticatedUser, InventoryItem, PokemonSummary } from "./Auth";
import type BattleManager from "./BattleManager";
import type DesignerSectionStore from "./DesignerSectionStore";
import type { DesignerSectionItem } from "./DesignerSectionStore";
import type EventRuntime from "./EventRuntime";
import type World from "./world";
import TradeExecutor from "./trade/TradeExecutor";
import TradeReservations from "./trade/TradeReservations";
import TradeStore, { type PersistedTradeSession } from "./trade/TradeStore";
import { computeSnapshotHash, toSnapshotOffer } from "./trade/tradeSnapshot";
import {
  ACTIVE_TRADE_STATES,
  TRADE_ERROR_MESSAGES,
  TRADING_GLOBALLY_ENABLED,
  TradeError,
  canTransition,
  createEmptyOffer,
  loadTradeConfig,
  offerIsEmpty,
  parseSafeInteger,
  type TradeActionResult,
  type TradeAuditRecord,
  type TradeAuditSecurityMetadata,
  type TradeChangeSummary,
  type TradeChatMessage,
  type TradeConfig,
  type TradeErrorCode,
  type TradeHistoryEntry,
  type TradeMutationSource,
  type TradeOffer,
  type TradeOfferItem,
  type TradeOfferVenomon,
  type TradeParticipantSnapshot,
  type TradeRarity,
  type TradeSideKey,
  type TradeSnapshot,
  type TradeState,
  type TradeStatePayload,
  type TradeWarning
} from "./trade/tradeTypes";
import type ClientToServerEvents from "../Server/ClientToServerEvents";
import type InterServerEvents from "../Server/InterServerEvents";
import type { SocketData } from "../Server/registerSocketHandlers";
import type ServerToClientEvents from "../Server/ServerToClientEvents";

type TypedSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type ServerSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** The subset of a socket the manager needs — keeps tests and tools simple. */
export type TradeActingSocket = Pick<ServerSocket, "id" | "data"> & {
  handshake?: { address?: string };
};

interface TradeSession {
  id: string;
  playerIds: Record<TradeSideKey, number>;
  participants: Record<TradeSideKey, TradeParticipantSnapshot>;
  state: TradeState;
  version: number;
  offers: Record<TradeSideKey, TradeOffer>;
  snapshot: TradeSnapshot | null;
  snapshotHash: string | null;
  warnings: TradeWarning[];
  lastChange: TradeChangeSummary | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  confirmAvailableAt: number | null;
  disconnected: Record<TradeSideKey, boolean>;
  /** Guards the commit path against re-entry while it is in flight. */
  processing: boolean;
  timers: {
    expiry: NodeJS.Timeout | null;
    disconnect: Record<TradeSideKey, NodeJS.Timeout | null>;
  };
  security: TradeAuditSecurityMetadata;
  startedAt: string;
  failureCode: TradeErrorCode | null;
}

/** Item metadata resolved from the designer catalog. Never client-supplied. */
interface CatalogItem {
  id: string;
  name: string;
  /** The coarse bag bucket the rest of the game uses for filtering/UI. */
  category: InventoryItem["category"];
  /**
   * The catalog's own item type ("general items", "medicine", "quest item", …).
   * Tradeability keys off this and the pocket, NOT off `category`: the bag
   * bucket collapses general items, Poke Balls and key items all into "quest",
   * which would wrongly make most of the catalog untradeable.
   */
  rawType: string;
  description: string;
  iconSrc: string;
  price: number;
  pocket: string;
  pocketName: string;
  flags: string[];
}

interface CatalogVenomon {
  id: string;
  name: string;
  types: string[];
  iconImageSrc: string;
}

const SIDES: TradeSideKey[] = ["A", "B"];

function otherSide(side: TradeSideKey): TradeSideKey {
  return side === "A" ? "B" : "A";
}

function nowIso() {
  return new Date().toISOString();
}

/** Strips control characters and escapes markup so nothing renders as HTML. */
function sanitizeChatText(raw: unknown, maxLength: number): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // Angle brackets and ampersands are escaped here so no renderer anywhere
    // downstream has to be trusted with the text.
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Collapses look-alike characters so near-identical item names are caught. */
function normalizeForConfusion(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[о0]/g, "o")
    .replace(/[і1l|]/g, "i")
    .replace(/[е3]/g, "e")
    .replace(/[а4]/g, "a")
    .replace(/[ѕ5]/g, "s")
    .replace(/[^a-z]/g, "");
}

export default class TradeManager {
  private readonly config: TradeConfig = loadTradeConfig();
  private readonly reservations: TradeReservations;
  private readonly executor: TradeExecutor;
  private readonly store: TradeStore;

  private readonly sessions = new Map<string, TradeSession>();
  /** userId -> tradeId, for sessions past REQUESTED. */
  private readonly sessionIdByUserId = new Map<number, string>();
  /** userId -> their single pending outgoing request. */
  private readonly outgoingRequestByUserId = new Map<number, string>();
  /** targetUserId -> pending incoming request trade ids. */
  private readonly incomingRequestsByUserId = new Map<number, Set<string>>();

  private readonly requestTimestampsByUserId = new Map<number, number[]>();
  private readonly chatTimestampsByUserId = new Map<number, number[]>();

  private itemCatalog = new Map<string, CatalogItem>();
  private venomonCatalog = new Map<string, CatalogVenomon>();
  private catalogLoadedAt = 0;

  constructor(
    private readonly io: TypedSocketServer,
    private readonly world: World,
    private readonly auth: Auth,
    private readonly designerSectionStore: DesignerSectionStore,
    private readonly battleManager: BattleManager,
    private readonly eventRuntime: EventRuntime,
    redis: RedisClientType
  ) {
    this.reservations = new TradeReservations(redis);
    this.executor = new TradeExecutor(redis, this.config);
    this.store = new TradeStore(redis, this.config);
  }

  /** Boot hook: drop reservations and claims left behind by a previous run. */
  public async initialize(): Promise<void> {
    const [orphans, recovery] = await Promise.all([
      this.reservations.recoverOrphans(),
      this.store.recoverAfterRestart()
    ]);
    if (orphans > 0 || recovery.releasedUsers > 0 || recovery.failedSessions > 0) {
      console.log(
        `trade: recovery released ${recovery.releasedUsers} player claim(s), ` +
          `${orphans} reservation set(s), marked ${recovery.failedSessions} session(s) failed`
      );
    }
  }

  public isTrading(userId: number): boolean {
    const tradeId = this.sessionIdByUserId.get(userId);
    if (!tradeId) {
      return false;
    }
    const session = this.sessions.get(tradeId);
    return Boolean(session && ACTIVE_TRADE_STATES.has(session.state));
  }

  /**
   * The guard every other asset-mutating system calls before it writes.
   * Throws TradeError("ASSET_RESERVED") when the asset is locked into a trade.
   */
  public assertMutationAllowed(
    userId: number,
    source: TradeMutationSource,
    target: { itemIds?: string[]; venomonIds?: string[]; currency?: boolean }
  ): void {
    this.reservations.assertMutationAllowed(userId, source, target);
  }

  /** Non-throwing variant for call sites that already return `{ok,message}`. */
  public checkMutationAllowed(
    userId: number,
    source: TradeMutationSource,
    target: { itemIds?: string[]; venomonIds?: string[]; currency?: boolean }
  ): { ok: true } | { ok: false; message: string } {
    try {
      this.reservations.assertMutationAllowed(userId, source, target);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof TradeError ? error.message : TRADE_ERROR_MESSAGES.ASSET_RESERVED
      };
    }
  }

  // ==========================================================================
  // Catalog
  // ==========================================================================

  private async loadCatalogs(): Promise<void> {
    // Designer catalogs change only on editor saves; a short TTL keeps trade
    // validation off the hot path without going stale for long.
    if (Date.now() - this.catalogLoadedAt < 30_000 && this.itemCatalog.size > 0) {
      return;
    }

    const [items, pokemons] = await Promise.all([
      this.designerSectionStore.read("items"),
      this.designerSectionStore.read("pokemons")
    ]);

    const nextItems = new Map<string, CatalogItem>();
    for (const record of ((items?.state.items ?? []) as DesignerSectionItem[])) {
      if (typeof record.id !== "string" || record.id.length === 0) {
        continue;
      }
      const profile = (record.itemProfile ?? {}) as {
        iconSrc?: unknown;
        description?: unknown;
        type?: unknown;
        price?: unknown;
        pocket?: unknown;
        pocketName?: unknown;
        flags?: unknown;
      };
      const rawType = typeof profile.type === "string" ? profile.type : "";
      nextItems.set(record.id, {
        id: record.id,
        name: typeof record.name === "string" ? record.name : record.id,
        category: this.toInventoryCategory(rawType),
        rawType: rawType.toLowerCase(),
        description: typeof profile.description === "string" ? profile.description : "",
        iconSrc: typeof profile.iconSrc === "string" ? profile.iconSrc : "",
        price:
          typeof profile.price === "number" && Number.isFinite(profile.price)
            ? Math.max(0, Math.round(profile.price))
            : 0,
        pocket: typeof profile.pocket === "string" ? profile.pocket.toLowerCase() : String(profile.pocket ?? ""),
        pocketName: typeof profile.pocketName === "string" ? profile.pocketName.toLowerCase() : "",
        flags: Array.isArray(profile.flags)
          ? profile.flags.filter((flag): flag is string => typeof flag === "string")
          : []
      });
    }

    const nextVenomons = new Map<string, CatalogVenomon>();
    for (const record of ((pokemons?.state.items ?? []) as DesignerSectionItem[])) {
      if (typeof record.id !== "string" || record.id.length === 0) {
        continue;
      }
      const profile = (record.pokemonProfile ?? {}) as {
        elements?: unknown;
        iconImageSrc?: unknown;
      };
      nextVenomons.set(record.id, {
        id: record.id,
        name: typeof record.name === "string" ? record.name : record.id,
        types: Array.isArray(profile.elements)
          ? profile.elements.filter((element): element is string => typeof element === "string")
          : [],
        iconImageSrc: typeof profile.iconImageSrc === "string" ? profile.iconImageSrc : ""
      });
    }

    this.itemCatalog = nextItems;
    this.venomonCatalog = nextVenomons;
    this.catalogLoadedAt = Date.now();
  }

  /** Same bucketing the auth session projection uses, kept in step with it. */
  private toInventoryCategory(value: string): InventoryItem["category"] {
    switch (value.toLowerCase()) {
      case "berries":
        return "berries";
      case "skill item":
      case "machines":
        return "moves";
      case "usable":
      case "medicine":
      case "battle item":
      case "battle items":
        return "usable";
      default:
        return "quest";
    }
  }

  /**
   * Resolves item metadata from the designer catalog, falling back to the
   * player's *stored* bag record when the catalog has no entry. Both sources
   * are server-owned; nothing here comes off the wire.
   */
  private resolveCatalogItem(itemId: string, stack: InventoryItem | undefined): CatalogItem | null {
    const fromCatalog = this.itemCatalog.get(itemId);
    if (fromCatalog) {
      return fromCatalog;
    }
    if (!stack) {
      return null;
    }
    return {
      id: stack.id,
      name: stack.name,
      category: stack.category,
      // No catalog entry to key off — fall back to the coarse bucket, which
      // means an unknown item in the "quest" bucket is treated as restricted.
      rawType: stack.category === "quest" ? "quest item" : stack.category,
      description: stack.description,
      iconSrc: typeof stack.iconSrc === "string" ? stack.iconSrc : "",
      price: 0,
      pocket: "",
      pocketName: "",
      flags: []
    };
  }

  private itemRarity(item: CatalogItem): TradeRarity {
    if (item.price >= 5000) return "epic";
    if (item.price >= 1500) return "rare";
    if (item.price >= 400) return "uncommon";
    return "common";
  }

  private venomonRarity(summary: PokemonSummary): TradeRarity {
    if (summary.level >= 70) return "epic";
    if (summary.level >= 50) return "rare";
    if (summary.level >= 30) return "uncommon";
    return "common";
  }

  /**
   * Policy: key/quest items and anything explicitly blocked never trade.
   *
   * The check deliberately uses the catalog's own signals — the KeyItem flag,
   * the Key Items pocket, and the raw item type — rather than the bag's coarse
   * `category`, which buckets general items and Poke Balls together with key
   * items and would make most of the catalog untradeable.
   */
  private itemIsTradeable(item: CatalogItem): boolean {
    if (this.config.blockedItemIds.includes(item.id.toLowerCase())) {
      return false;
    }
    if (this.config.blockedItemCategories.includes(item.rawType)) {
      return false;
    }
    if (item.flags.some((flag) => flag.toLowerCase().replace(/[^a-z]/g, "") === "keyitem")) {
      return false;
    }
    if (item.pocketName.includes("key") || item.pocket === "8") {
      return false;
    }
    return true;
  }

  // ==========================================================================
  // Trade requests
  // ==========================================================================

  /**
   * Validates that `userId` may start or accept a trade at all. Runs for both
   * players at request time and again at accept time, because either of them
   * may have entered a battle, an event or another trade in between.
   */
  private async assertAvailableForTrade(userId: number, role: "requester" | "target"): Promise<void> {
    if (!TRADING_GLOBALLY_ENABLED) {
      throw new TradeError("TRADING_DISABLED_ACCOUNT", "Trading is currently disabled.");
    }

    const player = this.world.getPlayerByUserId(userId);
    if (!player) {
      throw new TradeError(role === "requester" ? "NOT_AUTHENTICATED" : "PLAYER_UNAVAILABLE");
    }

    if (await this.store.isTradingDisabled(userId)) {
      throw new TradeError("TRADING_DISABLED_ACCOUNT");
    }

    if (this.isTrading(userId)) {
      throw new TradeError(role === "requester" ? "ALREADY_TRADING" : "TARGET_ALREADY_TRADING");
    }

    if (player.inBattle || this.battleManager.isPlayerBattling(player.socketId)) {
      throw new TradeError("IN_BATTLE");
    }

    if (this.eventRuntime.isRunning(userId)) {
      throw new TradeError("IN_CUTSCENE");
    }

    if (this.config.blockedMapIds.includes(player.currentMapId.toLowerCase())) {
      throw new TradeError("TRADING_DISABLED_MAP");
    }
  }

  /** Same map plus a configurable radius in squares (-1 disables the check). */
  private assertProximity(requesterUserId: number, targetUserId: number): void {
    if (this.config.proximitySquares < 0) {
      return;
    }
    const requester = this.world.getPlayerByUserId(requesterUserId);
    const target = this.world.getPlayerByUserId(targetUserId);
    if (!requester || !target) {
      throw new TradeError("PLAYER_UNAVAILABLE");
    }
    if (requester.currentMapId !== target.currentMapId) {
      throw new TradeError("DIFFERENT_MAP");
    }
    if (this.config.proximitySquares === 0) {
      return;
    }
    const cellSize = this.world.getMapCellSize(requester.currentMapId) || 32;
    const dx = Math.abs(requester.x - target.x) / cellSize;
    const dy = Math.abs(requester.y - target.y) / cellSize;
    if (Math.max(dx, dy) > this.config.proximitySquares) {
      throw new TradeError("TOO_FAR_AWAY");
    }
  }

  private checkRequestRateLimit(userId: number): void {
    const now = Date.now();
    const stamps = (this.requestTimestampsByUserId.get(userId) ?? []).filter(
      (at) => now - at < this.config.requestRateWindowMs
    );
    if (stamps.length >= this.config.requestRateLimit) {
      this.requestTimestampsByUserId.set(userId, stamps);
      throw new TradeError("RATE_LIMITED");
    }
    stamps.push(now);
    this.requestTimestampsByUserId.set(userId, stamps);
  }

  /**
   * `trade:request` — Player A asks Player B to trade.
   *
   * The requester is claimed immediately (so they cannot fan out requests);
   * the target is only claimed on accept, so an incoming request never blocks
   * someone from trading with a third player.
   */
  public async requestTrade(
    socket: TradeActingSocket,
    payload: { targetPlayerId?: string; targetUserId?: number }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const userId = this.requireUserId(socket);

      const targetUserId = this.resolveTargetUserId(payload);
      if (targetUserId === null) {
        throw new TradeError("PLAYER_UNAVAILABLE");
      }
      if (targetUserId === userId) {
        throw new TradeError("SELF_TRADE");
      }

      this.checkRequestRateLimit(userId);

      if (this.outgoingRequestByUserId.has(userId)) {
        throw new TradeError("DUPLICATE_REQUEST", "You already have a pending trade request.");
      }
      for (const tradeId of this.incomingRequestsByUserId.get(targetUserId) ?? []) {
        const pending = this.sessions.get(tradeId);
        if (pending && pending.playerIds.A === userId) {
          throw new TradeError("DUPLICATE_REQUEST");
        }
      }

      await this.assertAvailableForTrade(userId, "requester");
      await this.assertAvailableForTrade(targetUserId, "target");
      this.assertProximity(userId, targetUserId);

      // Privacy: the Friends window's "accept invitations" toggle doubles as
      // the trade-request switch until a dedicated preference ships. Friends
      // bypass it, which is the friends-only behaviour the spec asks for.
      const prefs = await this.auth.getSocialPrefs(targetUserId);
      if (!prefs.allowChatInvites && !(await this.auth.areFriends(userId, targetUserId))) {
        throw new TradeError("BLOCKED_BY_TARGET");
      }

      const session = await this.createSession(userId, targetUserId, socket);

      // The uniqueness claim is the database-level guard behind
      // one-trade-per-player; losing it means someone else won the race.
      const claimed = await this.store.claimParticipant(session.id, userId);
      if (!claimed) {
        this.sessions.delete(session.id);
        throw new TradeError("ALREADY_TRADING");
      }

      this.outgoingRequestByUserId.set(userId, session.id);
      const incoming = this.incomingRequestsByUserId.get(targetUserId) ?? new Set<string>();
      incoming.add(session.id);
      this.incomingRequestsByUserId.set(targetUserId, incoming);

      session.timers.expiry = setTimeout(() => {
        void this.expireRequest(session.id);
      }, this.config.requestTtlMs);

      this.emitToUser(targetUserId, "trade:request:received", {
        tradeId: session.id,
        from: {
          userId: session.participants.A.userId,
          username: session.participants.A.username,
          displayName: session.participants.A.displayName,
          characterSkinId: session.participants.A.characterSkinId,
          newAccount: session.participants.A.newAccount
        },
        expiresAt: session.expiresAt
      });

      await this.persistSession(session);
      return this.ok(session);
    }, socket);
  }

  private resolveTargetUserId(payload: { targetPlayerId?: string; targetUserId?: number }): number | null {
    if (typeof payload?.targetUserId === "number" && Number.isFinite(payload.targetUserId)) {
      return Math.round(payload.targetUserId);
    }
    if (typeof payload?.targetPlayerId === "string" && payload.targetPlayerId.length > 0) {
      const player = this.world.players.get(payload.targetPlayerId);
      return typeof player?.userId === "number" ? player.userId : null;
    }
    return null;
  }

  /** `trade:request:accept` */
  public async acceptRequest(
    socket: TradeActingSocket,
    payload: { tradeId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const userId = this.requireUserId(socket);
      const session = this.sessions.get(String(payload?.tradeId ?? ""));

      if (!session || session.state !== "REQUESTED" || session.playerIds.B !== userId) {
        throw new TradeError("TRADE_NOT_FOUND");
      }
      this.assertTransition(session, "OPEN");

      await this.assertAvailableForTrade(session.playerIds.A, "requester");
      await this.assertAvailableForTrade(userId, "target");
      this.assertProximity(session.playerIds.A, userId);

      const claimed = await this.store.claimParticipant(session.id, userId);
      if (!claimed) {
        throw new TradeError("ALREADY_TRADING");
      }

      this.clearRequestIndexes(session);
      if (session.timers.expiry) {
        clearTimeout(session.timers.expiry);
        session.timers.expiry = null;
      }

      // The accepting player's snapshot was a stub until now.
      session.participants.B = await this.buildParticipant(userId);
      this.captureSecurityMetadata(session, "B", socket);

      for (const side of SIDES) {
        this.sessionIdByUserId.set(session.playerIds[side], session.id);
      }

      session.state = "OPEN";
      session.version += 1;
      this.touch(session);
      this.joinRoom(session);

      await this.broadcastState(session, "trade:opened");
      await this.systemMessage(session, "Trade opened. Add your offer, then lock it.");
      await this.persistSession(session);

      return this.ok(session);
    }, socket);
  }

  /** `trade:request:decline` */
  public async declineRequest(
    socket: TradeActingSocket,
    payload: { tradeId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const userId = this.requireUserId(socket);
      const session = this.sessions.get(String(payload?.tradeId ?? ""));

      if (!session || session.state !== "REQUESTED" || session.playerIds.B !== userId) {
        throw new TradeError("TRADE_NOT_FOUND");
      }

      await this.terminate(session, "DECLINED", null, "The trade request was declined.");
      return this.ok(session);
    }, socket);
  }

  /** `trade:request:cancel` — the sender withdrawing their own request. */
  public async cancelRequest(
    socket: TradeActingSocket,
    payload: { tradeId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const userId = this.requireUserId(socket);
      const session = this.sessions.get(String(payload?.tradeId ?? ""));

      if (!session || session.state !== "REQUESTED" || session.playerIds.A !== userId) {
        throw new TradeError("TRADE_NOT_FOUND");
      }

      this.emitToUser(session.playerIds.B, "trade:request:expired", { tradeId: session.id });
      await this.terminate(session, "CANCELLED", null, "The trade request was withdrawn.");
      return this.ok(session);
    }, socket);
  }

  private async expireRequest(tradeId: string) {
    const session = this.sessions.get(tradeId);
    if (!session || session.state !== "REQUESTED") {
      return;
    }
    this.emitToUser(session.playerIds.B, "trade:request:expired", { tradeId });
    this.emitToUser(session.playerIds.A, "trade:request:expired", { tradeId });
    await this.terminate(session, "EXPIRED", "REQUEST_EXPIRED", "The trade request expired.");
  }

  private clearRequestIndexes(session: TradeSession) {
    if (this.outgoingRequestByUserId.get(session.playerIds.A) === session.id) {
      this.outgoingRequestByUserId.delete(session.playerIds.A);
    }
    const incoming = this.incomingRequestsByUserId.get(session.playerIds.B);
    if (incoming) {
      incoming.delete(session.id);
      if (incoming.size === 0) {
        this.incomingRequestsByUserId.delete(session.playerIds.B);
      }
    }
  }

  // ==========================================================================
  // Session plumbing
  // ==========================================================================

  private async createSession(
    requesterUserId: number,
    targetUserId: number,
    socket: TradeActingSocket
  ): Promise<TradeSession> {
    const tradeId = crypto.randomUUID();

    const session: TradeSession = {
      id: tradeId,
      playerIds: { A: requesterUserId, B: targetUserId },
      participants: {
        A: await this.buildParticipant(requesterUserId),
        B: await this.buildParticipant(targetUserId)
      },
      state: "REQUESTED",
      version: 1,
      offers: { A: createEmptyOffer(), B: createEmptyOffer() },
      snapshot: null,
      snapshotHash: null,
      warnings: [],
      lastChange: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + this.config.requestTtlMs,
      confirmAvailableAt: null,
      disconnected: { A: false, B: false },
      processing: false,
      timers: { expiry: null, disconnect: { A: null, B: null } },
      security: {
        ipPrefixes: { A: "", B: "" },
        platforms: { A: "", B: "" },
        sessionIds: { A: "", B: "" }
      },
      startedAt: nowIso(),
      failureCode: null
    };

    this.captureSecurityMetadata(session, "A", socket);
    this.sessions.set(tradeId, session);
    return session;
  }

  private async buildParticipant(userId: number): Promise<TradeParticipantSnapshot> {
    const summary = await this.auth.getSocialUserSummary(userId);
    const createdAtMs = await this.auth.getAccountCreatedAtMs(userId);
    return {
      userId,
      username: summary?.username ?? `player-${userId}`,
      displayName: summary?.name ?? summary?.username ?? `player-${userId}`,
      characterSkinId: summary?.characterSkinId ?? "",
      newAccount:
        this.config.newAccountFlagMs > 0 &&
        createdAtMs > 0 &&
        Date.now() - createdAtMs < this.config.newAccountFlagMs
    };
  }

  /**
   * Records only what an investigation needs and nothing more: a truncated IP
   * prefix (never the full address), the client platform, and the ephemeral
   * socket id. No tokens, no emails, no password material.
   */
  private captureSecurityMetadata(
    session: TradeSession,
    side: TradeSideKey,
    socket: TradeActingSocket | null
  ) {
    if (!socket) {
      return;
    }
    const address = String(socket.handshake?.address ?? "");
    const prefix = address.includes(":")
      ? address.split(":").slice(0, 3).join(":") // IPv6, roughly a /48
      : address.split(".").slice(0, 2).join("."); // IPv4, a /16
    session.security.ipPrefixes[side] = prefix;
    session.security.platforms[side] = String(socket.data?.platform ?? "");
    session.security.sessionIds[side] = socket.id;
  }

  private sideOf(session: TradeSession, userId: number): TradeSideKey {
    if (session.playerIds.A === userId) return "A";
    if (session.playerIds.B === userId) return "B";
    throw new TradeError("NOT_A_PARTICIPANT");
  }

  private requireUserId(socket: TradeActingSocket): number {
    if (typeof socket.data?.userId !== "number") {
      throw new TradeError("NOT_AUTHENTICATED");
    }
    return socket.data.userId;
  }

  /**
   * Resolves the session an action refers to and verifies the caller may act
   * on it: existence, participation, expected version and expected state.
   */
  private requireSession(
    socket: TradeActingSocket,
    payload: { tradeId?: string; expectedVersion?: number },
    options: { states?: TradeState[]; checkVersion?: boolean } = {}
  ): { session: TradeSession; userId: number; side: TradeSideKey } {
    const userId = this.requireUserId(socket);
    const session = this.sessions.get(String(payload?.tradeId ?? ""));

    if (!session || !ACTIVE_TRADE_STATES.has(session.state)) {
      throw new TradeError("TRADE_NOT_FOUND");
    }
    const side = this.sideOf(session, userId);

    if (options.states && !options.states.includes(session.state)) {
      throw new TradeError("INVALID_STATE_TRANSITION");
    }
    if (options.checkVersion !== false) {
      const expected = payload?.expectedVersion;
      if (typeof expected !== "number" || !Number.isFinite(expected) || expected !== session.version) {
        throw new TradeError("STALE_VERSION");
      }
    }
    return { session, userId, side };
  }

  private assertTransition(session: TradeSession, next: TradeState) {
    if (!canTransition(session.state, next)) {
      throw new TradeError("INVALID_STATE_TRANSITION");
    }
  }

  private touch(session: TradeSession) {
    session.updatedAt = Date.now();
    session.expiresAt = Date.now() + this.config.sessionTtlMs;
    if (session.timers.expiry) {
      clearTimeout(session.timers.expiry);
    }
    session.timers.expiry = setTimeout(() => {
      void this.expireSession(session.id);
    }, this.config.sessionTtlMs);
  }

  private async expireSession(tradeId: string) {
    const session = this.sessions.get(tradeId);
    if (!session || !ACTIVE_TRADE_STATES.has(session.state) || session.processing) {
      return;
    }
    await this.terminate(session, "EXPIRED", "TRADE_EXPIRED", "The trade expired.");
  }

  private roomName(session: TradeSession) {
    return `trade:${session.id}`;
  }

  private joinRoom(session: TradeSession) {
    for (const socket of this.io.sockets.sockets.values()) {
      if (
        typeof socket.data.userId === "number" &&
        (socket.data.userId === session.playerIds.A || socket.data.userId === session.playerIds.B)
      ) {
        void socket.join(this.roomName(session));
      }
    }
  }

  private leaveRoom(session: TradeSession) {
    this.io.in(this.roomName(session)).socketsLeave(this.roomName(session));
  }

  // ==========================================================================
  // Offer mutation
  // ==========================================================================

  /**
   * Applies a mutation to the acting player's offer, then resets *both*
   * players' locks and confirmations and bumps the version. This is the single
   * anti-scam invariant everything else leans on: no change survives a lock,
   * and no confirmation outlives a change.
   */
  private async applyOfferChange(
    session: TradeSession,
    side: TradeSideKey,
    change: TradeChangeSummary,
    mutate: () => void
  ): Promise<void> {
    if (session.offers[side].locked) {
      throw new TradeError("OFFER_LOCKED");
    }
    if (session.state === "FINAL_CONFIRMATION" || session.state === "PROCESSING") {
      throw new TradeError("OFFER_LOCKED");
    }

    mutate();

    this.invalidateLocks(session, change);
    await this.reservations.syncOffer(session.id, session.playerIds[side], session.offers[side]);
    this.touch(session);
    await this.broadcastState(session, "trade:offer:changed");
    await this.systemMessage(session, change.label);
    await this.persistSession(session);
  }

  /** Clears locks + confirmations and moves the trade back to OPEN. */
  private invalidateLocks(session: TradeSession, change: TradeChangeSummary) {
    for (const side of SIDES) {
      session.offers[side].locked = false;
      session.offers[side].confirmed = false;
    }
    session.snapshot = null;
    session.snapshotHash = null;
    session.confirmAvailableAt = null;
    session.version += 1;
    session.lastChange = change;
    session.warnings = [];
    session.state = "OPEN";
  }

  private mutableStates: TradeState[] = ["OPEN", "PLAYER_A_LOCKED", "PLAYER_B_LOCKED", "BOTH_LOCKED"];

  /** `trade:offer:add-item` — adds `quantity` on top of what is already offered. */
  public async addItem(
    socket: TradeActingSocket,
    payload: { tradeId?: string; expectedVersion?: number; requestId?: string; itemId?: string; quantity?: number }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const { session, side, userId } = this.requireSession(socket, payload, { states: this.mutableStates });
      await this.claimIdempotency(session, payload.requestId);
      await this.loadCatalogs();

      const itemId = String(payload?.itemId ?? "");
      const quantity = parseSafeInteger(payload?.quantity, this.config.maxItemStack);
      if (quantity === null || quantity <= 0) {
        throw new TradeError("CURRENCY_INVALID", "Enter a valid quantity.");
      }

      const user = await this.loadUser(userId);
      const offer = session.offers[side];
      const existing = offer.items.find((entry) => entry.itemDefinitionId === itemId);
      const nextQuantity = (existing?.quantity ?? 0) + quantity;

      if (!existing && offer.items.length >= this.config.maxItemEntries) {
        throw new TradeError("OFFER_TOO_LARGE");
      }

      const resolved = this.resolveItemOffer(user, itemId, nextQuantity, session.id);

      await this.applyOfferChange(
        session,
        side,
        {
          side,
          kind: existing ? "item-quantity" : "item-added",
          label: `${session.participants[side].displayName} offered ${nextQuantity}x ${resolved.name}.`,
          at: nowIso()
        },
        () => {
          if (existing) {
            existing.quantity = nextQuantity;
          } else {
            offer.items.push(resolved);
          }
        }
      );

      return this.ok(session);
    }, socket);
  }

  /** `trade:offer:update-item` — sets an absolute quantity (0 removes it). */
  public async updateItem(
    socket: TradeActingSocket,
    payload: { tradeId?: string; expectedVersion?: number; requestId?: string; itemId?: string; quantity?: number }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const { session, side, userId } = this.requireSession(socket, payload, { states: this.mutableStates });
      await this.claimIdempotency(session, payload.requestId);
      await this.loadCatalogs();

      const itemId = String(payload?.itemId ?? "");
      const quantity = parseSafeInteger(payload?.quantity, this.config.maxItemStack);
      if (quantity === null) {
        throw new TradeError("CURRENCY_INVALID", "Enter a valid quantity.");
      }

      const offer = session.offers[side];
      const index = offer.items.findIndex((entry) => entry.itemDefinitionId === itemId);
      if (index === -1) {
        throw new TradeError("ASSET_UNAVAILABLE");
      }

      if (quantity === 0) {
        const removed = offer.items[index];
        await this.applyOfferChange(
          session,
          side,
          {
            side,
            kind: "item-removed",
            label: `${session.participants[side].displayName} removed ${removed.name}.`,
            at: nowIso()
          },
          () => {
            offer.items.splice(index, 1);
          }
        );
        return this.ok(session);
      }

      const user = await this.loadUser(userId);
      const resolved = this.resolveItemOffer(user, itemId, quantity, session.id);

      await this.applyOfferChange(
        session,
        side,
        {
          side,
          kind: "item-quantity",
          label: `${session.participants[side].displayName} changed ${resolved.name} to ${quantity}.`,
          at: nowIso()
        },
        () => {
          offer.items[index] = { ...resolved };
        }
      );

      return this.ok(session);
    }, socket);
  }

  /** `trade:offer:remove-item` */
  public async removeItem(
    socket: TradeActingSocket,
    payload: { tradeId?: string; expectedVersion?: number; requestId?: string; itemId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const { session, side } = this.requireSession(socket, payload, { states: this.mutableStates });
      await this.claimIdempotency(session, payload.requestId);

      const itemId = String(payload?.itemId ?? "");
      const offer = session.offers[side];
      const index = offer.items.findIndex((entry) => entry.itemDefinitionId === itemId);
      if (index === -1) {
        throw new TradeError("ASSET_UNAVAILABLE");
      }
      const removed = offer.items[index];

      await this.applyOfferChange(
        session,
        side,
        {
          side,
          kind: "item-removed",
          label: `${session.participants[side].displayName} removed ${removed.name}.`,
          at: nowIso()
        },
        () => {
          offer.items.splice(index, 1);
        }
      );

      return this.ok(session);
    }, socket);
  }

  /** `trade:offer:add-venomon` */
  public async addVenomon(
    socket: TradeActingSocket,
    payload: { tradeId?: string; expectedVersion?: number; requestId?: string; venomonId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const { session, side, userId } = this.requireSession(socket, payload, { states: this.mutableStates });
      await this.claimIdempotency(session, payload.requestId);
      await this.loadCatalogs();

      const venomonId = String(payload?.venomonId ?? "");
      const offer = session.offers[side];

      if (offer.venomons.some((entry) => entry.venomonInstanceId === venomonId)) {
        throw new TradeError("VENOMON_DUPLICATE");
      }
      if (offer.venomons.length >= this.config.maxVenomonEntries) {
        throw new TradeError("OFFER_TOO_LARGE");
      }

      const user = await this.loadUser(userId);
      const alreadyOfferedUsable = offer.venomons.filter((entry) => !entry.isEgg).length;
      const resolved = this.resolveVenomonOffer(user, venomonId, session.id, alreadyOfferedUsable);

      await this.applyOfferChange(
        session,
        side,
        {
          side,
          kind: "venomon-added",
          label: `${session.participants[side].displayName} offered ${resolved.nickname ?? resolved.species} (Lv ${resolved.level}).`,
          at: nowIso()
        },
        () => {
          offer.venomons.push(resolved);
        }
      );

      return this.ok(session);
    }, socket);
  }

  /** `trade:offer:remove-venomon` */
  public async removeVenomon(
    socket: TradeActingSocket,
    payload: { tradeId?: string; expectedVersion?: number; requestId?: string; venomonId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const { session, side } = this.requireSession(socket, payload, { states: this.mutableStates });
      await this.claimIdempotency(session, payload.requestId);

      const venomonId = String(payload?.venomonId ?? "");
      const offer = session.offers[side];
      const index = offer.venomons.findIndex((entry) => entry.venomonInstanceId === venomonId);
      if (index === -1) {
        throw new TradeError("ASSET_UNAVAILABLE");
      }
      const removed = offer.venomons[index];

      await this.applyOfferChange(
        session,
        side,
        {
          side,
          kind: "venomon-removed",
          label: `${session.participants[side].displayName} removed ${removed.nickname ?? removed.species}.`,
          at: nowIso()
        },
        () => {
          offer.venomons.splice(index, 1);
        }
      );

      return this.ok(session);
    }, socket);
  }

  /** `trade:offer:set-currency` */
  public async setCurrency(
    socket: TradeActingSocket,
    payload: { tradeId?: string; expectedVersion?: number; requestId?: string; amount?: number }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const { session, side, userId } = this.requireSession(socket, payload, { states: this.mutableStates });
      await this.claimIdempotency(session, payload.requestId);

      const amount = parseSafeInteger(payload?.amount, this.config.maxCurrencyBalance);
      if (amount === null) {
        throw new TradeError("CURRENCY_INVALID");
      }
      if (amount > this.config.maxTradeCurrency) {
        throw new TradeError("CURRENCY_LIMIT");
      }

      const user = await this.loadUser(userId);
      const reservedElsewhere = this.reservations.reservedCurrency(userId, session.id);
      if (amount > user.money - reservedElsewhere) {
        throw new TradeError("CURRENCY_INSUFFICIENT");
      }

      const recipient = await this.loadUser(session.playerIds[otherSide(side)]);
      if (recipient.money + amount > this.config.maxCurrencyBalance) {
        throw new TradeError("CURRENCY_BALANCE_LIMIT");
      }

      await this.applyOfferChange(
        session,
        side,
        {
          side,
          kind: "currency",
          label: `${session.participants[side].displayName} set their money offer to $${amount}.`,
          at: nowIso()
        },
        () => {
          session.offers[side].currency = amount;
        }
      );

      return this.ok(session);
    }, socket);
  }

  // ==========================================================================
  // Locking + final confirmation
  // ==========================================================================

  /** `trade:offer:lock` */
  public async lockOffer(
    socket: TradeActingSocket,
    payload: { tradeId?: string; expectedVersion?: number; requestId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const { session, side, userId } = this.requireSession(socket, payload, {
        states: ["OPEN", "PLAYER_A_LOCKED", "PLAYER_B_LOCKED"]
      });
      await this.claimIdempotency(session, payload.requestId);

      if (session.offers[side].locked) {
        throw new TradeError("INVALID_STATE_TRANSITION", "Your offer is already locked.");
      }
      if (offerIsEmpty(session.offers.A) && offerIsEmpty(session.offers.B)) {
        throw new TradeError("EMPTY_TRADE");
      }
      if (session.disconnected.A || session.disconnected.B) {
        throw new TradeError("PARTICIPANT_DISCONNECTED");
      }

      // Second validation pass: everything this player is committing to must
      // still be theirs, right now.
      await this.revalidateOffer(session, side, userId);

      session.offers[side].locked = true;
      session.version += 1;
      session.lastChange = {
        side,
        kind: "locked",
        label: `${session.participants[side].displayName} locked their offer.`,
        at: nowIso()
      };

      const bothLocked = session.offers.A.locked && session.offers.B.locked;
      const nextState: TradeState = bothLocked
        ? "BOTH_LOCKED"
        : side === "A"
          ? "PLAYER_A_LOCKED"
          : "PLAYER_B_LOCKED";

      this.assertTransition(session, nextState);
      session.state = nextState;
      this.touch(session);

      if (!bothLocked) {
        await this.broadcastState(session, "trade:state");
        await this.systemMessage(session, session.lastChange.label);
        await this.persistSession(session);
        return this.ok(session);
      }

      await this.systemMessage(session, session.lastChange.label);
      // Both locked: revalidate the other side too, including recipient-side
      // capacity, then freeze the snapshot.
      for (const each of SIDES) {
        await this.revalidateOffer(session, each, session.playerIds[each], { fresh: true });
      }
      await this.enterFinalConfirmation(session);

      return this.ok(session);
    }, socket);
  }

  /** `trade:offer:unlock` — also the way back out of FINAL_CONFIRMATION. */
  public async unlockOffer(
    socket: TradeActingSocket,
    payload: { tradeId?: string; expectedVersion?: number; requestId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const { session, side } = this.requireSession(socket, payload, {
        states: ["PLAYER_A_LOCKED", "PLAYER_B_LOCKED", "BOTH_LOCKED", "FINAL_CONFIRMATION"]
      });
      await this.claimIdempotency(session, payload.requestId);

      if (!session.offers[side].locked) {
        throw new TradeError("INVALID_STATE_TRANSITION");
      }

      const change: TradeChangeSummary = {
        side,
        kind: "unlocked",
        label: `${session.participants[side].displayName} unlocked their offer. Both offers must be locked again.`,
        at: nowIso()
      };
      this.invalidateLocks(session, change);
      this.touch(session);

      await this.broadcastState(session, "trade:offer:invalidated");
      await this.systemMessage(session, change.label);
      await this.persistSession(session);

      return this.ok(session);
    }, socket);
  }

  /**
   * Freezes the immutable snapshot both players must confirm and starts the
   * mandatory review delay. From here the version and hash do not move.
   */
  private async enterFinalConfirmation(session: TradeSession): Promise<void> {
    this.assertTransition(session, "FINAL_CONFIRMATION");

    const warnings = this.computeWarnings(session);
    const snapshot: TradeSnapshot = {
      tradeId: session.id,
      version: session.version,
      createdAt: nowIso(),
      participants: { A: session.participants.A, B: session.participants.B },
      offers: {
        A: toSnapshotOffer(session.offers.A),
        B: toSnapshotOffer(session.offers.B)
      },
      warnings,
      heldItemsTransferWithVenomon: this.config.heldItemsTransferWithVenomon
    };

    session.snapshot = snapshot;
    session.snapshotHash = computeSnapshotHash(snapshot);
    session.warnings = warnings;
    session.offers.A.confirmed = false;
    session.offers.B.confirmed = false;
    session.confirmAvailableAt = Date.now() + this.config.confirmationDelayMs;
    session.state = "FINAL_CONFIRMATION";
    this.touch(session);

    await this.broadcastState(session, "trade:confirmation:started");
    await this.systemMessage(
      session,
      "Both offers are locked. Review the final summary — this exchange is permanent."
    );
    await this.persistSession(session);
  }

  /** `trade:confirm` */
  public async confirm(
    socket: TradeActingSocket,
    payload: { tradeId?: string; expectedVersion?: number; snapshotHash?: string; requestId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const { session, side } = this.requireSession(socket, payload, { states: ["FINAL_CONFIRMATION"] });

      // Idempotency first: a replayed confirm must never reach the executor.
      await this.claimIdempotency(session, payload.requestId);

      if (!session.snapshotHash || payload?.snapshotHash !== session.snapshotHash) {
        throw new TradeError("SNAPSHOT_MISMATCH");
      }
      if (session.disconnected.A || session.disconnected.B) {
        throw new TradeError("PARTICIPANT_DISCONNECTED");
      }
      if (session.confirmAvailableAt !== null && Date.now() < session.confirmAvailableAt) {
        throw new TradeError("CONFIRMATION_TOO_SOON");
      }
      if (session.offers[side].confirmed) {
        // Already recorded — the state we hand back already says so.
        return this.ok(session);
      }

      session.offers[side].confirmed = true;
      this.touch(session);
      await this.systemMessage(session, `${session.participants[side].displayName} confirmed the trade.`);

      if (!(session.offers.A.confirmed && session.offers.B.confirmed)) {
        await this.broadcastState(session, "trade:state");
        await this.persistSession(session);
        return this.ok(session);
      }

      await this.executeTrade(session);
      return this.ok(session);
    }, socket);
  }

  // ==========================================================================
  // Execution
  // ==========================================================================

  private async executeTrade(session: TradeSession): Promise<void> {
    if (session.processing) {
      return;
    }
    if (session.state !== "FINAL_CONFIRMATION" || !session.snapshot || !session.snapshotHash) {
      return;
    }

    session.processing = true;
    this.assertTransition(session, "PROCESSING");
    session.state = "PROCESSING";
    await this.broadcastState(session, "trade:state");

    try {
      // Already committed? A retry of the very last step must be a no-op.
      if (await this.executor.isAlreadyCompleted(session.id)) {
        await this.finishCompleted(session);
        return;
      }

      // Third and final validation pass, against freshly re-read accounts.
      for (const side of SIDES) {
        await this.revalidateOffer(session, side, session.playerIds[side], { fresh: true });
      }

      const result = await this.executor.execute(
        session.snapshot,
        { A: session.playerIds.A, B: session.playerIds.B },
        { A: session.offers.A, B: session.offers.B }
      );

      if (!result.ok) {
        const code: TradeErrorCode =
          result.reason === "CONFLICT"
            ? "ASSET_UNAVAILABLE"
            : result.reason === "VALIDATION"
              ? ((result.detail as TradeErrorCode) ?? "TRADE_FAILED")
              : "TRADE_FAILED";
        await this.failTrade(session, code);
        return;
      }

      await this.finishCompleted(session);
    } catch (error) {
      if (error instanceof TradeError) {
        await this.failTrade(session, error.code);
        return;
      }
      console.error("trade: execution failed:", error);
      await this.failTrade(session, "TRADE_FAILED");
    } finally {
      session.processing = false;
    }
  }

  private async finishCompleted(session: TradeSession): Promise<void> {
    session.state = "COMPLETED";
    const completedAt = nowIso();

    await this.writeAudit(session, "COMPLETED", null, completedAt);
    await this.systemMessage(session, "Trade completed.");

    for (const side of SIDES) {
      this.emitToUser(session.playerIds[side], "trade:completed", {
        tradeId: session.id,
        state: session.state,
        version: session.version,
        snapshotHash: session.snapshotHash,
        completedAt,
        given: this.summarizeSide(session, side),
        received: this.summarizeSide(session, otherSide(side))
      });
      // Authoritative post-trade account state; the client never computes it.
      const user = await this.auth.getUserForBattle(session.playerIds[side]);
      if (user) {
        this.emitAuthSession(session.playerIds[side], user);
      }
    }

    await this.disposeSession(session);
  }

  private async failTrade(session: TradeSession, code: TradeErrorCode): Promise<void> {
    session.state = "FAILED";
    session.failureCode = code;

    await this.writeAudit(session, "FAILED", code, nowIso());
    await this.systemMessage(session, "The trade could not be completed. Nothing was exchanged.");

    for (const side of SIDES) {
      this.emitToUser(session.playerIds[side], "trade:failed", {
        tradeId: session.id,
        state: session.state,
        version: session.version,
        errorCode: code,
        message: TRADE_ERROR_MESSAGES[code] ?? TRADE_ERROR_MESSAGES.TRADE_FAILED
      });
    }

    await this.disposeSession(session);
  }

  /** `trade:cancel` */
  public async cancel(
    socket: TradeActingSocket,
    payload: { tradeId?: string; requestId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const userId = this.requireUserId(socket);
      const session = this.sessions.get(String(payload?.tradeId ?? ""));
      if (!session || !ACTIVE_TRADE_STATES.has(session.state)) {
        throw new TradeError("TRADE_NOT_FOUND");
      }
      const side = this.sideOf(session, userId);

      if (session.state === "PROCESSING") {
        // Too late: the exchange is already committing atomically.
        throw new TradeError("INVALID_STATE_TRANSITION", "The trade is already being completed.");
      }

      await this.terminate(
        session,
        "CANCELLED",
        null,
        `${session.participants[side].displayName} cancelled the trade.`
      );
      return this.ok(session);
    }, socket);
  }

  private async terminate(
    session: TradeSession,
    state: Extract<TradeState, "DECLINED" | "CANCELLED" | "EXPIRED">,
    code: TradeErrorCode | null,
    reason: string
  ): Promise<void> {
    if (!canTransition(session.state, state)) {
      return;
    }
    const wasRequest = session.state === "REQUESTED";
    session.state = state;

    if (!wasRequest) {
      await this.systemMessage(session, reason);
    }

    for (const side of SIDES) {
      this.emitToUser(session.playerIds[side], "trade:cancelled", {
        tradeId: session.id,
        state,
        version: session.version,
        reason,
        errorCode: code
      });
    }

    await this.disposeSession(session);
  }

  /** Releases every artifact a finished session held. */
  private async disposeSession(session: TradeSession): Promise<void> {
    if (session.timers.expiry) {
      clearTimeout(session.timers.expiry);
      session.timers.expiry = null;
    }
    for (const side of SIDES) {
      const timer = session.timers.disconnect[side];
      if (timer) {
        clearTimeout(timer);
        session.timers.disconnect[side] = null;
      }
    }

    this.clearRequestIndexes(session);
    for (const side of SIDES) {
      if (this.sessionIdByUserId.get(session.playerIds[side]) === session.id) {
        this.sessionIdByUserId.delete(session.playerIds[side]);
      }
    }

    await this.reservations.release(session.id);
    await this.store.disposeSession(session.id, session.playerIds.A, session.playerIds.B);
    await this.persistSession(session);
    this.leaveRoom(session);

    // Keep the record briefly so a late `trade:sync` gets a real answer
    // instead of "not found", then drop it.
    const timer = setTimeout(() => {
      this.sessions.delete(session.id);
    }, 60_000);
    // Never hold the process open just to forget a finished trade.
    timer.unref?.();
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  private async loadUser(userId: number): Promise<AuthenticatedUser> {
    const user = await this.auth.getUserForBattle(userId);
    if (!user) {
      throw new TradeError("PLAYER_UNAVAILABLE");
    }
    return user;
  }

  /**
   * Resolves an item offer entry entirely from server data. Nothing the client
   * sent about the item beyond its id and quantity is used.
   */
  private resolveItemOffer(
    user: AuthenticatedUser,
    itemId: string,
    quantity: number,
    tradeId: string
  ): TradeOfferItem {
    const stack = user.inventory.find((entry) => entry.id === itemId);
    // Ownership first: "you don't have that" is both the more useful error and
    // the one that leaks least about the catalog to a probing client.
    if (!stack || stack.quantity <= 0) {
      throw new TradeError("ITEM_NOT_OWNED");
    }
    const catalogItem = this.resolveCatalogItem(itemId, stack);
    if (!catalogItem) {
      throw new TradeError("ITEM_NOT_OWNED");
    }
    if (!this.itemIsTradeable(catalogItem)) {
      throw new TradeError("ITEM_RESTRICTED");
    }

    const reservedElsewhere = this.reservations.reservedItemQuantity(user.id, itemId, tradeId);
    if (quantity > stack.quantity - reservedElsewhere) {
      throw new TradeError(reservedElsewhere > 0 ? "ASSET_RESERVED" : "ITEM_QUANTITY_CHANGED");
    }
    if (quantity > this.config.maxItemStack) {
      throw new TradeError("ITEM_STACK_LIMIT");
    }

    return {
      itemDefinitionId: catalogItem.id,
      itemInstanceId: catalogItem.id,
      quantity,
      name: catalogItem.name,
      category: catalogItem.category,
      description: catalogItem.description,
      iconSrc: catalogItem.iconSrc,
      rarity: this.itemRarity(catalogItem),
      // Tradeable but worth flagging in the UI (mail attachments); anything
      // genuinely untradeable was already refused above.
      restricted: catalogItem.pocketName.includes("mail") || catalogItem.pocket === "6"
    };
  }

  private findOwnedVenomon(
    user: AuthenticatedUser,
    venomonId: string
  ): { summary: PokemonSummary; source: "party" | "storage"; boxId?: string } | null {
    const partyEntry = user.pokemonParty.find((entry) => entry.id === venomonId);
    if (partyEntry) {
      return { summary: partyEntry, source: "party" };
    }
    for (const box of user.pokemonStorage) {
      const boxEntry = box.pokemon.find((entry) => entry.id === venomonId);
      if (boxEntry) {
        return { summary: boxEntry, source: "storage", boxId: box.id };
      }
    }
    return null;
  }

  /** Total non-egg Venomon the account holds across party + every box. */
  private countUsableVenomon(user: AuthenticatedUser): number {
    return (
      user.pokemonParty.filter((entry) => !entry.isEgg).length +
      user.pokemonStorage.reduce(
        (sum, box) => sum + box.pokemon.filter((entry) => !entry.isEgg).length,
        0
      )
    );
  }

  private resolveVenomonOffer(
    user: AuthenticatedUser,
    venomonId: string,
    tradeId: string,
    alreadyOfferedUsable: number
  ): TradeOfferVenomon {
    const owned = this.findOwnedVenomon(user, venomonId);
    if (!owned) {
      throw new TradeError("VENOMON_NOT_OWNED");
    }

    if (this.reservations.venomonReservedBy(user.id, venomonId, tradeId)) {
      throw new TradeError("ASSET_RESERVED");
    }

    const player = this.world.getPlayerByUserId(user.id);
    if (player && this.battleManager.isPlayerBattling(player.socketId)) {
      throw new TradeError("IN_BATTLE");
    }

    // A trainer must always keep at least one usable Venomon. Eggs cannot
    // battle, so they never count as the last one.
    const offeredUsable = alreadyOfferedUsable + (owned.summary.isEgg ? 0 : 1);
    if (this.countUsableVenomon(user) - offeredUsable < 1) {
      throw new TradeError("VENOMON_LAST_ONE");
    }

    const speciesId = owned.summary.sourcePokemonId ?? "";
    const catalogEntry = speciesId ? this.venomonCatalog.get(speciesId) : undefined;
    const species = catalogEntry?.name ?? owned.summary.name;
    const nickname = owned.summary.nickname;

    return {
      venomonInstanceId: owned.summary.id,
      source: owned.source,
      boxId: owned.boxId,
      speciesId,
      species,
      nickname,
      nicknameDiffersFromSpecies:
        typeof nickname === "string" &&
        nickname.length > 0 &&
        nickname.toLowerCase() !== species.toLowerCase(),
      level: owned.summary.level,
      types: owned.summary.types ?? catalogEntry?.types ?? [],
      hp: owned.summary.hp,
      maxHp: owned.summary.maxHp,
      moves: [...(owned.summary.moves ?? [])],
      heldItemId: owned.summary.heldItemId,
      heldItemName: owned.summary.heldItemName,
      isEgg: Boolean(owned.summary.isEgg),
      iconImageSrc: catalogEntry?.iconImageSrc,
      rarity: this.venomonRarity(owned.summary)
    };
  }

  /**
   * Re-resolves every entry in one side's offer against the live account.
   * Any drift (item spent, Venomon deposited elsewhere, money gone) throws,
   * which callers turn into an invalidation or a clean failure.
   */
  private async revalidateOffer(
    session: TradeSession,
    side: TradeSideKey,
    userId: number,
    options: { fresh?: boolean } = {}
  ): Promise<void> {
    await this.loadCatalogs();
    const user = await this.loadUser(userId);
    const offer = session.offers[side];

    for (const item of offer.items) {
      const resolved = this.resolveItemOffer(user, item.itemDefinitionId, item.quantity, session.id);
      // Refresh presentation data so the snapshot always mirrors the catalog.
      item.name = resolved.name;
      item.category = resolved.category;
      item.description = resolved.description;
      item.iconSrc = resolved.iconSrc;
      item.rarity = resolved.rarity;
      item.restricted = resolved.restricted;
    }

    const seen = new Set<string>();
    for (const venomon of offer.venomons) {
      if (seen.has(venomon.venomonInstanceId)) {
        throw new TradeError("VENOMON_DUPLICATE");
      }
      seen.add(venomon.venomonInstanceId);
      if (!this.findOwnedVenomon(user, venomon.venomonInstanceId)) {
        throw new TradeError("VENOMON_NOT_OWNED");
      }
    }

    const offeredUsable = offer.venomons.filter((entry) => !entry.isEgg).length;
    if (offeredUsable > 0 && this.countUsableVenomon(user) - offeredUsable < 1) {
      throw new TradeError("VENOMON_LAST_ONE");
    }

    if (offer.currency > 0) {
      if (offer.currency > this.config.maxTradeCurrency) {
        throw new TradeError("CURRENCY_LIMIT");
      }
      if (offer.currency > user.money) {
        throw new TradeError("CURRENCY_INSUFFICIENT");
      }
    }

    // Recipient-side capacity, checked from the giver's perspective.
    if (options.fresh) {
      const recipient = await this.loadUser(session.playerIds[otherSide(side)]);
      for (const item of offer.items) {
        const existing = recipient.inventory.find((entry) => entry.id === item.itemDefinitionId);
        if (existing) {
          if (existing.quantity + item.quantity > this.config.maxItemStack) {
            throw new TradeError("ITEM_STACK_LIMIT");
          }
        } else if (recipient.inventory.length >= this.config.maxInventorySlots) {
          throw new TradeError("INVENTORY_FULL");
        }
      }
      if (offer.currency > 0 && recipient.money + offer.currency > this.config.maxCurrencyBalance) {
        throw new TradeError("CURRENCY_BALANCE_LIMIT");
      }
    }
  }

  // ==========================================================================
  // Warnings
  // ==========================================================================

  private computeWarnings(session: TradeSession): TradeWarning[] {
    const warnings: TradeWarning[] = [];

    const entryCount = (side: TradeSideKey) =>
      session.offers[side].items.reduce((sum, item) => sum + item.quantity, 0) +
      session.offers[side].venomons.length +
      (session.offers[side].currency > 0 ? 1 : 0);

    for (const side of SIDES) {
      if (offerIsEmpty(session.offers[side])) {
        warnings.push({
          code: "ONE_SIDED",
          side,
          detail: `${session.participants[side].displayName} is offering nothing.`
        });
      }
      if (session.participants[side].newAccount) {
        warnings.push({
          code: "NEW_ACCOUNT",
          side,
          detail: `${session.participants[side].displayName}'s account is new.`
        });
      }
      if (
        session.offers[side].currency > 0 &&
        session.offers[side].currency >= Math.floor(this.config.maxTradeCurrency / 2)
      ) {
        warnings.push({ code: "LARGE_CURRENCY", side, detail: `$${session.offers[side].currency}` });
      }
      for (const venomon of session.offers[side].venomons) {
        if (venomon.nicknameDiffersFromSpecies) {
          warnings.push({
            code: "NICKNAMED_VENOMON",
            side,
            detail: `"${venomon.nickname}" is really a ${venomon.species}.`
          });
        }
        if (venomon.isEgg) {
          warnings.push({ code: "EGG_INCLUDED", side, detail: "An unhatched egg is included." });
        }
        if (venomon.rarity === "rare" || venomon.rarity === "epic") {
          warnings.push({
            code: "RARE_ASSET",
            side,
            detail: `${venomon.nickname ?? venomon.species} (Lv ${venomon.level})`
          });
        }
        if (venomon.heldItemName) {
          warnings.push({
            code: "HELD_ITEM_TRANSFERS",
            side,
            detail: `${venomon.nickname ?? venomon.species} is holding ${venomon.heldItemName}.`
          });
        }
      }
      for (const item of session.offers[side].items) {
        if (item.rarity === "rare" || item.rarity === "epic") {
          warnings.push({ code: "RARE_ASSET", side, detail: `${item.quantity}x ${item.name}` });
        }
      }
    }

    const countA = entryCount("A");
    const countB = entryCount("B");
    if (countA > 0 && countB > 0) {
      const ratio = countA > countB ? countA / countB : countB / countA;
      if (ratio >= this.config.unbalancedRatioThreshold) {
        warnings.push({
          code: "UNBALANCED",
          side: countA > countB ? "B" : "A",
          detail: "One side is offering far more than the other."
        });
      }
    }

    // Look-alike item names across both offers (e.g. a counterfeit "Rare Candy").
    const normalized = new Map<string, Set<string>>();
    for (const side of SIDES) {
      for (const item of session.offers[side].items) {
        const key = normalizeForConfusion(item.name);
        const ids = normalized.get(key) ?? new Set<string>();
        ids.add(item.itemDefinitionId);
        normalized.set(key, ids);
      }
    }
    for (const ids of normalized.values()) {
      if (ids.size > 1) {
        warnings.push({
          code: "SIMILAR_ITEM_NAMES",
          side: "BOTH",
          detail: "Two different items in this trade have nearly identical names."
        });
        break;
      }
    }

    return warnings;
  }

  // ==========================================================================
  // Trade chat
  // ==========================================================================

  /** `trade:chat:send` */
  public async sendChat(
    socket: TradeActingSocket,
    payload: { tradeId?: string; text?: string; requestId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const userId = this.requireUserId(socket);
      const session = this.sessions.get(String(payload?.tradeId ?? ""));

      // Only the two participants of a live, opened trade may read or write.
      if (!session || !ACTIVE_TRADE_STATES.has(session.state) || session.state === "REQUESTED") {
        throw new TradeError("CHAT_CLOSED");
      }
      const side = this.sideOf(session, userId);

      if (typeof payload?.text === "string" && payload.text.length > this.config.chatMaxLength) {
        throw new TradeError("CHAT_TOO_LONG");
      }
      const text = sanitizeChatText(payload?.text, this.config.chatMaxLength);
      if (text.length === 0) {
        throw new TradeError("CHAT_EMPTY");
      }
      if (!this.checkChatRateLimit(userId)) {
        throw new TradeError("CHAT_RATE_LIMITED");
      }

      const message: TradeChatMessage = {
        id: crypto.randomUUID(),
        tradeId: session.id,
        // Clients can only ever produce "player" messages — the type is set
        // here and never read from the payload.
        messageType: "player",
        senderUserId: userId,
        senderUsername: session.participants[side].displayName,
        text,
        createdAt: nowIso()
      };

      await this.store.appendChatMessage(message);
      this.io.in(this.roomName(session)).emit("trade:chat:message", message);

      return this.ok(session);
    }, socket);
  }

  private checkChatRateLimit(userId: number): boolean {
    const now = Date.now();
    const stamps = (this.chatTimestampsByUserId.get(userId) ?? []).filter(
      (at) => now - at < this.config.chatRateWindowMs
    );
    if (stamps.length >= this.config.chatRateLimit) {
      this.chatTimestampsByUserId.set(userId, stamps);
      return false;
    }
    stamps.push(now);
    this.chatTimestampsByUserId.set(userId, stamps);
    return true;
  }

  /** Server-authored chat entries: the only source of `messageType: system`. */
  private async systemMessage(session: TradeSession, text: string): Promise<void> {
    const message: TradeChatMessage = {
      id: crypto.randomUUID(),
      tradeId: session.id,
      messageType: "system",
      text: sanitizeChatText(text, this.config.chatMaxLength),
      createdAt: nowIso()
    };
    try {
      await this.store.appendChatMessage(message);
    } catch (error) {
      console.error("trade: unable to store system message:", error);
    }
    this.io.in(this.roomName(session)).emit("trade:chat:message", message);
  }

  // ==========================================================================
  // Sync + presence
  // ==========================================================================

  /** `trade:sync` — the client's only way to (re)build its view. */
  public async sync(
    socket: TradeActingSocket,
    payload?: { tradeId?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const userId = this.requireUserId(socket);
      const tradeId = String(payload?.tradeId ?? this.sessionIdByUserId.get(userId) ?? "");
      const session = this.sessions.get(tradeId);

      if (!session) {
        // Answer definitively so the client can close a stale window.
        this.emitToSocket(socket.id, "trade:state", null);
        return { success: true, tradeId: null, state: null, version: null, errorCode: null, message: null };
      }
      const side = this.sideOf(session, userId);

      void this.io.sockets.sockets.get(socket.id)?.join(this.roomName(session));

      this.emitToSocket(socket.id, "trade:state", this.buildStatePayload(session, side));
      for (const message of await this.store.readChat(session.id)) {
        this.emitToSocket(socket.id, "trade:chat:message", message);
      }

      return this.ok(session);
    }, socket);
  }

  /**
   * The player's last socket went away. Policy: pause the trade for a grace
   * period (offers stay reserved, confirmations blocked), then cancel.
   */
  public handleUserDisconnected(userId: number): void {
    for (const tradeId of this.collectTradeIdsForUser(userId)) {
      const session = this.sessions.get(tradeId);
      if (!session || !ACTIVE_TRADE_STATES.has(session.state)) {
        continue;
      }

      if (session.state === "REQUESTED") {
        void this.terminate(session, "CANCELLED", null, "The other trainer went offline.");
        continue;
      }
      if (session.state === "PROCESSING") {
        // The commit is atomic and already in flight; a disconnect cannot
        // split it. Let it finish.
        continue;
      }

      const side = this.sideOf(session, userId);
      session.disconnected[side] = true;
      // A disconnect invalidates confirmations: nobody confirms on behalf of
      // an absent player.
      session.offers.A.confirmed = false;
      session.offers.B.confirmed = false;

      this.emitToUser(session.playerIds[otherSide(side)], "trade:participant:disconnected", {
        tradeId: session.id,
        userId,
        graceSeconds: Math.ceil(this.config.disconnectGraceMs / 1000)
      });
      void this.broadcastState(session, "trade:state");

      const existing = session.timers.disconnect[side];
      if (existing) {
        clearTimeout(existing);
      }
      session.timers.disconnect[side] = setTimeout(() => {
        const current = this.sessions.get(tradeId);
        if (current && current.disconnected[side] && ACTIVE_TRADE_STATES.has(current.state)) {
          void this.terminate(
            current,
            "CANCELLED",
            "PARTICIPANT_DISCONNECTED",
            "The other trainer did not come back."
          );
        }
      }, this.config.disconnectGraceMs);
    }
  }

  /** The player is back: re-join the room and push authoritative state. */
  public handleUserReconnected(userId: number): void {
    const tradeId = this.sessionIdByUserId.get(userId);
    if (!tradeId) {
      return;
    }
    const session = this.sessions.get(tradeId);
    if (!session || !ACTIVE_TRADE_STATES.has(session.state)) {
      return;
    }

    const side = this.sideOf(session, userId);
    const timer = session.timers.disconnect[side];
    if (timer) {
      clearTimeout(timer);
      session.timers.disconnect[side] = null;
    }
    if (!session.disconnected[side]) {
      return;
    }
    session.disconnected[side] = false;
    this.joinRoom(session);

    this.emitToUser(session.playerIds[otherSide(side)], "trade:participant:reconnected", {
      tradeId: session.id,
      userId
    });
    void this.broadcastState(session, "trade:state");
  }

  private collectTradeIdsForUser(userId: number): string[] {
    const ids = new Set<string>();
    const active = this.sessionIdByUserId.get(userId);
    if (active) {
      ids.add(active);
    }
    const outgoing = this.outgoingRequestByUserId.get(userId);
    if (outgoing) {
      ids.add(outgoing);
    }
    for (const tradeId of this.incomingRequestsByUserId.get(userId) ?? []) {
      ids.add(tradeId);
    }
    return Array.from(ids);
  }

  // ==========================================================================
  // History, audit, moderation
  // ==========================================================================

  private summarizeSide(session: TradeSession, side: TradeSideKey) {
    const offer = session.offers[side];
    return {
      items: offer.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        iconSrc: item.iconSrc
      })),
      venomons: offer.venomons.map((venomon) => ({
        species: venomon.species,
        nickname: venomon.nickname,
        level: venomon.level,
        iconImageSrc: venomon.iconImageSrc
      })),
      currency: offer.currency
    };
  }

  private async writeAudit(
    session: TradeSession,
    result: "COMPLETED" | "FAILED",
    failureCode: TradeErrorCode | null,
    completedAt: string
  ): Promise<void> {
    if (!session.snapshot || !session.snapshotHash) {
      return;
    }
    const record: TradeAuditRecord = {
      tradeId: session.id,
      playerAId: session.playerIds.A,
      playerBId: session.playerIds.B,
      playerAUsername: session.participants.A.username,
      playerBUsername: session.participants.B.username,
      playerACharacterName: session.participants.A.displayName,
      playerBCharacterName: session.participants.B.displayName,
      startedAt: session.startedAt,
      completedAt,
      version: session.version,
      snapshotHash: session.snapshotHash,
      finalSnapshot: session.snapshot,
      result,
      failureCode,
      moderationFlags: Array.from(new Set(session.warnings.map((warning) => warning.code))),
      securityMetadata: session.security
    };
    try {
      await this.store.writeAudit(record);
    } catch (error) {
      console.error("trade: unable to write audit record:", error);
    }
  }

  /** `trade:history` — safe player-facing view. No security metadata. */
  public async listHistory(
    socket: TradeActingSocket,
    payload?: { page?: number; pageSize?: number }
  ): Promise<{ entries: TradeHistoryEntry[]; page: number; pageSize: number; total: number }> {
    const userId = this.requireUserId(socket);
    const pageSize = Math.min(Math.max(Number(payload?.pageSize) || 10, 1), 50);
    const page = Math.max(Number(payload?.page) || 1, 1);
    const offset = (page - 1) * pageSize;

    const [ids, total] = await Promise.all([
      this.store.readHistoryIds(userId, offset, pageSize),
      this.store.countHistory(userId)
    ]);

    const entries: TradeHistoryEntry[] = [];
    for (const tradeId of ids) {
      const record = await this.store.readAudit(tradeId);
      if (!record) {
        continue;
      }
      const mySide: TradeSideKey = record.playerAId === userId ? "A" : "B";
      const partner = record.finalSnapshot.participants[otherSide(mySide)];

      entries.push({
        tradeId: record.tradeId,
        completedAt: record.completedAt,
        result: record.result,
        partnerUsername: partner.username,
        partnerDisplayName: partner.displayName,
        given: this.historySideOf(record, mySide),
        received: this.historySideOf(record, otherSide(mySide))
      });
    }

    return { entries, page, pageSize, total };
  }

  private historySideOf(record: TradeAuditRecord, side: TradeSideKey) {
    const offer = record.finalSnapshot.offers[side];
    return {
      items: offer.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        iconSrc: item.iconSrc
      })),
      venomons: offer.venomons.map((venomon) => ({
        species: venomon.species,
        nickname: venomon.nickname,
        level: venomon.level,
        iconImageSrc: venomon.iconImageSrc
      })),
      currency: offer.currency
    };
  }

  /** `trade:report` — a participant flags a finished trade for moderation. */
  public async reportTrade(
    socket: TradeActingSocket,
    payload: { tradeId?: string; reason?: string; explanation?: string }
  ): Promise<TradeActionResult> {
    return this.guard(async () => {
      const userId = this.requireUserId(socket);
      const tradeId = String(payload?.tradeId ?? "");
      const record = await this.store.readAudit(tradeId);

      if (!record || (record.playerAId !== userId && record.playerBId !== userId)) {
        throw new TradeError("TRADE_NOT_FOUND");
      }

      await this.store.saveReport({
        tradeId,
        reporterUserId: userId,
        reportedUserId: record.playerAId === userId ? record.playerBId : record.playerAId,
        reason: sanitizeChatText(payload?.reason, 60) || "unspecified",
        explanation: sanitizeChatText(payload?.explanation, 1000),
        createdAt: nowIso()
      });

      return {
        success: true,
        tradeId,
        state: null,
        version: null,
        errorCode: null,
        message: "Report submitted."
      };
    }, socket);
  }

  // ---- moderation surface (called behind a moderator.access check) ----------

  public async moderationSearch(options: {
    userId?: number;
    tradeId?: string;
    page: number;
    pageSize: number;
  }) {
    if (options.tradeId) {
      const record = await this.store.readAudit(options.tradeId);
      return { rows: record ? [record] : [], total: record ? 1 : 0 };
    }
    return this.store.searchTrades({
      userId: options.userId,
      page: options.page,
      pageSize: options.pageSize
    });
  }

  public async moderationDetail(tradeId: string) {
    const [record, chat, notes] = await Promise.all([
      this.store.readAudit(tradeId),
      this.store.readChat(tradeId, 500),
      this.store.readModerationNotes(tradeId)
    ]);
    if (!record) {
      return null;
    }
    const sinceMs = Date.now() - 30 * 24 * 3600 * 1000;
    const [pairCount, volumeA, volumeB] = await Promise.all([
      this.store.countPairTrades(record.playerAId, record.playerBId, sinceMs),
      this.store.countUserTrades(record.playerAId, sinceMs),
      this.store.countUserTrades(record.playerBId, sinceMs)
    ]);
    return {
      record,
      chat,
      notes,
      signals: {
        repeatedPartnerTrades30d: pairCount,
        playerATrades30d: volumeA,
        playerBTrades30d: volumeB,
        currencyMoved: {
          A: record.finalSnapshot.offers.A.currency,
          B: record.finalSnapshot.offers.B.currency
        }
      }
    };
  }

  public async moderationAddNote(tradeId: string, moderatorUserId: number, text: string) {
    await this.store.addModerationNote(tradeId, {
      moderatorUserId,
      text: sanitizeChatText(text, 1000),
      createdAt: nowIso()
    });
  }

  public async moderationSetTradingDisabled(userId: number, disabled: boolean, reason?: string) {
    await this.store.setTradingDisabled(userId, disabled, reason);
    if (!disabled) {
      return;
    }
    const tradeId = this.sessionIdByUserId.get(userId);
    const session = tradeId ? this.sessions.get(tradeId) : undefined;
    if (session && ACTIVE_TRADE_STATES.has(session.state) && session.state !== "PROCESSING") {
      await this.terminate(session, "CANCELLED", null, "Trading was restricted for this account.");
    }
  }

  public async moderationListReports(page: number, pageSize: number) {
    return this.store.listReports(page, pageSize);
  }

  // ==========================================================================
  // Emitting
  // ==========================================================================

  private buildStatePayload(session: TradeSession, side: TradeSideKey): TradeStatePayload {
    return {
      tradeId: session.id,
      state: session.state,
      version: session.version,
      snapshotHash: session.snapshotHash,
      youAre: side,
      participants: session.participants,
      offers: session.offers,
      warnings: session.warnings,
      snapshot: session.state === "FINAL_CONFIRMATION" ? session.snapshot : null,
      confirmAvailableAt: session.confirmAvailableAt,
      expiresAt: session.expiresAt,
      disconnected: session.disconnected,
      heldItemsTransferWithVenomon: this.config.heldItemsTransferWithVenomon,
      lastChange: session.lastChange
    };
  }

  private async broadcastState(
    session: TradeSession,
    eventName:
      | "trade:state"
      | "trade:opened"
      | "trade:offer:changed"
      | "trade:offer:invalidated"
      | "trade:confirmation:started"
  ): Promise<void> {
    for (const side of SIDES) {
      this.emitToUser(session.playerIds[side], eventName, this.buildStatePayload(session, side));
    }
  }

  private emitToUser<EventName extends keyof ServerToClientEvents>(
    userId: number,
    eventName: EventName,
    payload: Parameters<ServerToClientEvents[EventName]>[0]
  ) {
    for (const candidate of this.io.sockets.sockets.values()) {
      if (candidate.data.userId === userId) {
        (candidate as any).emit(eventName, payload);
      }
    }
  }

  private emitToSocket<EventName extends keyof ServerToClientEvents>(
    socketId: string,
    eventName: EventName,
    payload: Parameters<ServerToClientEvents[EventName]>[0]
  ) {
    (this.io.in(socketId) as any).emit(eventName, payload);
  }

  /** Pushes refreshed authoritative account state after a completed trade. */
  private emitAuthSession(userId: number, user: AuthenticatedUser) {
    for (const candidate of this.io.sockets.sockets.values()) {
      if (candidate.data.userId === userId) {
        (candidate as any).emit("auth:session", { authenticated: true, user });
      }
    }
  }

  // ==========================================================================
  // Result envelope + error funnel
  // ==========================================================================

  private ok(session: TradeSession): TradeActionResult {
    return {
      success: true,
      tradeId: session.id,
      state: session.state,
      version: session.version,
      errorCode: null,
      message: null
    };
  }

  private async claimIdempotency(session: TradeSession, requestId: unknown): Promise<void> {
    if (typeof requestId !== "string" || requestId.length === 0) {
      // Idempotency keys are optional on the wire but strongly recommended;
      // without one an action is simply not replay-protected.
      return;
    }
    const claimed = await this.store.claimIdempotencyKey(session.id, requestId.slice(0, 80));
    if (!claimed) {
      throw new TradeError("INVALID_STATE_TRANSITION", "That action was already applied.");
    }
  }

  /**
   * Single exit point for every handler: converts thrown TradeErrors into the
   * uniform result envelope, emits it back to the acting socket, and makes
   * sure unexpected failures never leak internals to a client.
   */
  private async guard(
    run: () => Promise<TradeActionResult>,
    socket: TradeActingSocket
  ): Promise<TradeActionResult> {
    let result: TradeActionResult;
    try {
      result = await run();
    } catch (error) {
      const tradeError = error instanceof TradeError ? error : new TradeError("INTERNAL_ERROR");
      if (!(error instanceof TradeError)) {
        console.error("trade: unhandled error:", error);
      }
      result = {
        success: false,
        tradeId: null,
        state: null,
        version: null,
        errorCode: tradeError.code,
        message: tradeError.message
      };
    }
    this.emitToSocket(socket.id, "trade:result", result);
    return result;
  }

  private async persistSession(session: TradeSession): Promise<void> {
    const persisted: PersistedTradeSession = {
      tradeId: session.id,
      playerAId: session.playerIds.A,
      playerBId: session.playerIds.B,
      state: session.state,
      version: session.version,
      snapshotHash: session.snapshotHash,
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString()
    };
    try {
      await this.store.saveSession(persisted);
    } catch (error) {
      console.error("trade: unable to persist session mirror:", error);
    }
  }
}
