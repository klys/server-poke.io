/**
 * Player-to-player trading: shared vocabulary.
 *
 * Everything in this file is server-authoritative. The client receives
 * projections of these shapes but never produces them: item names, icons,
 * rarity, venomon details, tradeability and the snapshot hash are all resolved
 * here from the designer catalog + the player's stored account state.
 *
 * See TRADING.md for the state machine diagram and the event catalogue.
 */

import type { InventoryItem, PokemonSummary } from "../Auth";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const TRADE_STATES = [
  "REQUESTED",
  "OPEN",
  "PLAYER_A_LOCKED",
  "PLAYER_B_LOCKED",
  "BOTH_LOCKED",
  "FINAL_CONFIRMATION",
  "PROCESSING",
  "COMPLETED",
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
  "FAILED"
] as const;

export type TradeState = typeof TRADE_STATES[number];

/** States in which the session is still live and holds asset reservations. */
export const ACTIVE_TRADE_STATES: ReadonlySet<TradeState> = new Set<TradeState>([
  "REQUESTED",
  "OPEN",
  "PLAYER_A_LOCKED",
  "PLAYER_B_LOCKED",
  "BOTH_LOCKED",
  "FINAL_CONFIRMATION",
  "PROCESSING"
]);

/** States from which no further transition is possible. */
export const TERMINAL_TRADE_STATES: ReadonlySet<TradeState> = new Set<TradeState>([
  "COMPLETED",
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
  "FAILED"
]);

/**
 * Legal transitions. Anything not listed here is rejected with
 * INVALID_STATE_TRANSITION — the state machine is the only thing that decides
 * what a trade may do next, never a client boolean.
 */
export const TRADE_TRANSITIONS: Record<TradeState, readonly TradeState[]> = {
  REQUESTED: ["OPEN", "DECLINED", "CANCELLED", "EXPIRED"],
  OPEN: ["PLAYER_A_LOCKED", "PLAYER_B_LOCKED", "CANCELLED", "EXPIRED", "FAILED"],
  PLAYER_A_LOCKED: ["OPEN", "BOTH_LOCKED", "CANCELLED", "EXPIRED", "FAILED"],
  PLAYER_B_LOCKED: ["OPEN", "BOTH_LOCKED", "CANCELLED", "EXPIRED", "FAILED"],
  BOTH_LOCKED: ["OPEN", "FINAL_CONFIRMATION", "CANCELLED", "EXPIRED", "FAILED"],
  FINAL_CONFIRMATION: ["OPEN", "PROCESSING", "CANCELLED", "EXPIRED", "FAILED"],
  PROCESSING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  DECLINED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: []
};

export function canTransition(from: TradeState, to: TradeState): boolean {
  return TRADE_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Stable machine-readable codes. The client maps these to localized copy; the
 * `message` that travels with them is already safe for display (no stack
 * traces, no Redis keys, no internal ids).
 */
export const TRADE_ERROR_CODES = [
  "NOT_AUTHENTICATED",
  "PLAYER_UNAVAILABLE",
  "SELF_TRADE",
  "ALREADY_TRADING",
  "TARGET_ALREADY_TRADING",
  "IN_BATTLE",
  "BUSY_INTERFACE",
  "IN_CUTSCENE",
  "TOO_FAR_AWAY",
  "DIFFERENT_MAP",
  "TRADING_DISABLED_ACCOUNT",
  "TRADING_DISABLED_MAP",
  "BLOCKED_BY_TARGET",
  "FRIENDS_ONLY",
  "DUPLICATE_REQUEST",
  "RATE_LIMITED",
  "REQUEST_EXPIRED",
  "TRADE_NOT_FOUND",
  "NOT_A_PARTICIPANT",
  "INVALID_STATE_TRANSITION",
  "STALE_VERSION",
  "SNAPSHOT_MISMATCH",
  "OFFER_LOCKED",
  "ASSET_UNAVAILABLE",
  "ASSET_RESERVED",
  "ITEM_NOT_OWNED",
  "ITEM_QUANTITY_CHANGED",
  "ITEM_RESTRICTED",
  "ITEM_STACK_LIMIT",
  "INVENTORY_FULL",
  "VENOMON_NOT_OWNED",
  "VENOMON_RESTRICTED",
  "VENOMON_DUPLICATE",
  "VENOMON_LAST_ONE",
  "VENOMON_STORAGE_FULL",
  "CURRENCY_INVALID",
  "CURRENCY_INSUFFICIENT",
  "CURRENCY_LIMIT",
  "CURRENCY_BALANCE_LIMIT",
  "OFFER_TOO_LARGE",
  "EMPTY_TRADE",
  "CONFIRMATION_INVALIDATED",
  "CONFIRMATION_TOO_SOON",
  "PARTICIPANT_DISCONNECTED",
  "TRADE_EXPIRED",
  "TRADE_FAILED",
  "CHAT_EMPTY",
  "CHAT_TOO_LONG",
  "CHAT_RATE_LIMITED",
  "CHAT_CLOSED",
  "INTERNAL_ERROR"
] as const;

export type TradeErrorCode = typeof TRADE_ERROR_CODES[number];

/** Default user-facing copy per code (English; the client localizes by code). */
export const TRADE_ERROR_MESSAGES: Record<TradeErrorCode, string> = {
  NOT_AUTHENTICATED: "Log in to trade.",
  PLAYER_UNAVAILABLE: "That trainer is unavailable right now.",
  SELF_TRADE: "You cannot trade with yourself.",
  ALREADY_TRADING: "You are already in a trade.",
  TARGET_ALREADY_TRADING: "That trainer is already in a trade.",
  IN_BATTLE: "Trading is not possible during a battle.",
  BUSY_INTERFACE: "Close your shop, storage or bag first.",
  IN_CUTSCENE: "Trading is not possible during an event.",
  TOO_FAR_AWAY: "Get closer to that trainer to trade.",
  DIFFERENT_MAP: "That trainer is on another map.",
  TRADING_DISABLED_ACCOUNT: "Trading is disabled for this account.",
  TRADING_DISABLED_MAP: "Trading is disabled on this map.",
  BLOCKED_BY_TARGET: "That trainer is not accepting trade requests.",
  FRIENDS_ONLY: "That trainer only trades with friends.",
  DUPLICATE_REQUEST: "You already have a pending request with that trainer.",
  RATE_LIMITED: "Slow down — too many trade requests.",
  REQUEST_EXPIRED: "That trade request expired.",
  TRADE_NOT_FOUND: "That trade is no longer available.",
  NOT_A_PARTICIPANT: "You are not part of that trade.",
  INVALID_STATE_TRANSITION: "That action is not available at this stage of the trade.",
  STALE_VERSION: "The offer changed — review it again.",
  SNAPSHOT_MISMATCH: "The offer changed — review it again.",
  OFFER_LOCKED: "Unlock your offer before changing it.",
  ASSET_UNAVAILABLE: "That asset is no longer available.",
  ASSET_RESERVED: "That asset is reserved by another trade.",
  ITEM_NOT_OWNED: "You do not have that item.",
  ITEM_QUANTITY_CHANGED: "You no longer have that many of that item.",
  ITEM_RESTRICTED: "That item cannot be traded.",
  ITEM_STACK_LIMIT: "The other trainer cannot hold that many of that item.",
  INVENTORY_FULL: "The other trainer's bag is full.",
  VENOMON_NOT_OWNED: "That Venomon is not yours.",
  VENOMON_RESTRICTED: "That Venomon cannot be traded.",
  VENOMON_DUPLICATE: "That Venomon is already in the offer.",
  VENOMON_LAST_ONE: "You must keep at least one Venomon.",
  VENOMON_STORAGE_FULL: "The other trainer has no room for that Venomon.",
  CURRENCY_INVALID: "Enter a valid amount.",
  CURRENCY_INSUFFICIENT: "You do not have that much money.",
  CURRENCY_LIMIT: "That is above the per-trade money limit.",
  CURRENCY_BALANCE_LIMIT: "The other trainer cannot hold that much money.",
  OFFER_TOO_LARGE: "That offer has too many entries.",
  EMPTY_TRADE: "Both offers are empty.",
  CONFIRMATION_INVALIDATED: "The trade changed — confirm again.",
  CONFIRMATION_TOO_SOON: "Take a moment to review the trade first.",
  PARTICIPANT_DISCONNECTED: "The other trainer disconnected.",
  TRADE_EXPIRED: "The trade expired.",
  TRADE_FAILED: "The trade could not be completed. Nothing was exchanged.",
  CHAT_EMPTY: "Type a message first.",
  CHAT_TOO_LONG: "That message is too long.",
  CHAT_RATE_LIMITED: "You are sending messages too fast.",
  CHAT_CLOSED: "This trade chat is closed.",
  INTERNAL_ERROR: "Something went wrong. Nothing was exchanged."
};

export class TradeError extends Error {
  public readonly code: TradeErrorCode;

  constructor(code: TradeErrorCode, message?: string) {
    super(message ?? TRADE_ERROR_MESSAGES[code]);
    this.name = "TradeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function envBool(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function envList(name: string): string[] {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export interface TradeConfig {
  /** Trade request lifetime before it auto-expires. */
  requestTtlMs: number;
  /** Idle session lifetime (refreshed on every action). */
  sessionTtlMs: number;
  /** Grace period a disconnected participant has to come back. */
  disconnectGraceMs: number;
  /** Mandatory review delay before FINAL_CONFIRMATION accepts a confirm. */
  confirmationDelayMs: number;
  /** Max squares between the two players (0 = same map only, -1 = anywhere). */
  proximitySquares: number;
  /** Trade requests allowed per rolling window, per requester. */
  requestRateLimit: number;
  requestRateWindowMs: number;
  /** Trade chat rate limit. */
  chatRateLimit: number;
  chatRateWindowMs: number;
  chatMaxLength: number;
  /** How long trade chat is retained for moderation, in seconds. */
  chatRetentionSeconds: number;
  /** Per-side offer caps. */
  maxItemEntries: number;
  maxVenomonEntries: number;
  /** Currency caps (integer game money). */
  maxTradeCurrency: number;
  maxCurrencyBalance: number;
  /** Recipient-side inventory caps. */
  maxInventorySlots: number;
  maxItemStack: number;
  /** Player-facing history depth. */
  historyLimit: number;
  /** Held items travel with the Venomon (single game-wide rule). */
  heldItemsTransferWithVenomon: true;
  /**
   * Catalog item *types* that may never be traded (matched against
   * `itemProfile.type`, lower-cased) — not the coarse bag category.
   */
  blockedItemCategories: string[];
  blockedItemIds: string[];
  /** Maps on which trading is disabled. */
  blockedMapIds: string[];
  /** Accounts younger than this (ms) are flagged (not blocked) as "new". */
  newAccountFlagMs: number;
  /** A side offering this many entries more than the other is flagged. */
  unbalancedRatioThreshold: number;
}

export function loadTradeConfig(): TradeConfig {
  return {
    requestTtlMs: envInt("TRADE_REQUEST_TTL_SECONDS", 60, 5, 600) * 1000,
    sessionTtlMs: envInt("TRADE_SESSION_TTL_SECONDS", 15 * 60, 60, 3600) * 1000,
    disconnectGraceMs: envInt("TRADE_DISCONNECT_GRACE_SECONDS", 45, 0, 600) * 1000,
    confirmationDelayMs: envInt("TRADE_CONFIRMATION_DELAY_SECONDS", 3, 0, 60) * 1000,
    proximitySquares: envInt("TRADE_PROXIMITY_SQUARES", 12, -1, 1000),
    requestRateLimit: envInt("TRADE_REQUEST_RATE_LIMIT", 5, 1, 100),
    requestRateWindowMs: envInt("TRADE_REQUEST_RATE_WINDOW_SECONDS", 60, 1, 3600) * 1000,
    chatRateLimit: envInt("TRADE_CHAT_RATE_LIMIT", 8, 1, 100),
    chatRateWindowMs: envInt("TRADE_CHAT_RATE_WINDOW_SECONDS", 5, 1, 600) * 1000,
    chatMaxLength: envInt("TRADE_CHAT_MAX_LENGTH", 300, 20, 2000),
    chatRetentionSeconds: envInt("TRADE_CHAT_RETENTION_SECONDS", 30 * 24 * 3600, 3600),
    maxItemEntries: envInt("TRADE_MAX_ITEM_ENTRIES", 20, 1, 200),
    maxVenomonEntries: envInt("TRADE_MAX_VENOMON_ENTRIES", 6, 1, 30),
    maxTradeCurrency: envInt("TRADE_MAX_CURRENCY", 1_000_000, 0, Number.MAX_SAFE_INTEGER),
    maxCurrencyBalance: envInt("TRADE_MAX_CURRENCY_BALANCE", 9_999_999, 1, Number.MAX_SAFE_INTEGER),
    maxInventorySlots: envInt("TRADE_MAX_INVENTORY_SLOTS", 500, 1, 10_000),
    maxItemStack: envInt("TRADE_MAX_ITEM_STACK", 999, 1, 1_000_000),
    historyLimit: envInt("TRADE_HISTORY_LIMIT", 50, 1, 500),
    heldItemsTransferWithVenomon: true,
    blockedItemCategories: envList("TRADE_BLOCKED_ITEM_CATEGORIES").length > 0
      ? envList("TRADE_BLOCKED_ITEM_CATEGORIES")
      : ["quest item", "key item", "key items"],
    blockedItemIds: envList("TRADE_BLOCKED_ITEM_IDS"),
    blockedMapIds: envList("TRADE_BLOCKED_MAP_IDS"),
    newAccountFlagMs: envInt("TRADE_NEW_ACCOUNT_FLAG_DAYS", 3, 0, 365) * 24 * 3600 * 1000,
    unbalancedRatioThreshold: envInt("TRADE_UNBALANCED_THRESHOLD", 4, 2, 100)
  };
}

export const TRADING_GLOBALLY_ENABLED = envBool("TRADE_ENABLED", true);

// ---------------------------------------------------------------------------
// Offers & snapshots
// ---------------------------------------------------------------------------

export type TradeRarity = "common" | "uncommon" | "rare" | "epic";

/**
 * One stack of items in an offer.
 *
 * This game stores the bag as `{ id, quantity }` stacks, so an item's
 * "instance id" is its definition id — the field is kept distinct so a future
 * per-instance item model drops in without a wire change.
 */
export interface TradeOfferItem {
  itemDefinitionId: string;
  itemInstanceId: string;
  quantity: number;
  /** Server-resolved presentation data. Never accepted from the client. */
  name: string;
  category: InventoryItem["category"];
  description: string;
  iconSrc: string;
  rarity: TradeRarity;
  /** True when the item is only tradeable because policy explicitly allows it. */
  restricted: boolean;
}

export interface TradeOfferVenomon {
  venomonInstanceId: string;
  /** Where it lives right now on the owner's account. */
  source: "party" | "storage";
  boxId?: string;
  speciesId: string;
  species: string;
  nickname?: string;
  /** Highlighted in the UI: a nickname that hides the real species. */
  nicknameDiffersFromSpecies: boolean;
  level: number;
  types: string[];
  hp: number;
  maxHp: number;
  moves: string[];
  heldItemId?: string;
  heldItemName?: string;
  /** Battle-use and appearance equipment slots (transfer with the venomon). */
  battleItemId?: string;
  battleItemName?: string;
  appearanceItemId?: string;
  appearanceItemName?: string;
  isEgg: boolean;
  iconImageSrc?: string;
  rarity: TradeRarity;
  /** Optional attributes, present only when the game models them. */
  gender?: string;
  shiny?: boolean;
  form?: string;
  nature?: string;
  ability?: string;
  originalTrainer?: string;
}

export interface TradeOffer {
  items: TradeOfferItem[];
  venomons: TradeOfferVenomon[];
  currency: number;
  locked: boolean;
  confirmed: boolean;
}

export function createEmptyOffer(): TradeOffer {
  return { items: [], venomons: [], currency: 0, locked: false, confirmed: false };
}

export function offerIsEmpty(offer: TradeOffer): boolean {
  return offer.items.length === 0 && offer.venomons.length === 0 && offer.currency === 0;
}

/** Warnings surfaced on the final-confirmation screen. Advisory, never blocking. */
export type TradeWarningCode =
  | "ONE_SIDED"
  | "UNBALANCED"
  | "RARE_ASSET"
  | "NICKNAMED_VENOMON"
  | "EGG_INCLUDED"
  | "HELD_ITEM_TRANSFERS"
  | "NEW_ACCOUNT"
  | "SIMILAR_ITEM_NAMES"
  | "LARGE_CURRENCY";

export interface TradeWarning {
  code: TradeWarningCode;
  /** Which side the warning is about ("A"/"B"), or "BOTH". */
  side: TradeSideKey | "BOTH";
  detail?: string;
}

export type TradeSideKey = "A" | "B";

export interface TradeParticipantSnapshot {
  userId: number;
  username: string;
  displayName: string;
  characterSkinId: string;
  /** Account age flag only — no timestamps, no emails, no ids beyond userId. */
  newAccount: boolean;
  /** Account identity (userId/username restated for the shared contract). */
  accountId: number;
  accountName: string;
  /** The character actually doing the trading. */
  characterId: number;
  characterName: string;
}

/**
 * The immutable thing both players confirm. `hash` is computed over a
 * canonical serialization of everything below it (see tradeSnapshot.ts).
 */
export interface TradeSnapshot {
  tradeId: string;
  version: number;
  createdAt: string;
  participants: Record<TradeSideKey, TradeParticipantSnapshot>;
  offers: Record<TradeSideKey, Omit<TradeOffer, "locked" | "confirmed">>;
  warnings: TradeWarning[];
  /** Game-wide rule, restated in the snapshot so audits are self-describing. */
  heldItemsTransferWithVenomon: boolean;
}

// ---------------------------------------------------------------------------
// Wire payloads
// ---------------------------------------------------------------------------

/** Everything a client needs to render the trade window. */
export interface TradeStatePayload {
  tradeId: string;
  state: TradeState;
  version: number;
  snapshotHash: string | null;
  /** The receiving client's own side, so the UI never guesses. */
  youAre: TradeSideKey;
  participants: Record<TradeSideKey, TradeParticipantSnapshot>;
  offers: Record<TradeSideKey, TradeOffer>;
  warnings: TradeWarning[];
  /** Populated only in FINAL_CONFIRMATION. */
  snapshot: TradeSnapshot | null;
  /** Epoch ms after which `trade:confirm` is accepted (review delay). */
  confirmAvailableAt: number | null;
  expiresAt: number;
  disconnected: Record<TradeSideKey, boolean>;
  heldItemsTransferWithVenomon: boolean;
  /** What changed since the previous version, for change highlighting. */
  lastChange: TradeChangeSummary | null;
}

export interface TradeChangeSummary {
  side: TradeSideKey;
  kind:
    | "item-added"
    | "item-removed"
    | "item-quantity"
    | "venomon-added"
    | "venomon-removed"
    | "currency"
    | "locked"
    | "unlocked"
    | "invalidated"
    | "asset-revoked";
  label: string;
  at: string;
}

export type TradeChatMessageType = "player" | "system";

export interface TradeChatMessage {
  id: string;
  tradeId: string;
  messageType: TradeChatMessageType;
  /** Absent on system messages — those are generated here, never by clients. */
  senderUserId?: number;
  senderUsername?: string;
  text: string;
  createdAt: string;
}

/** Uniform envelope every trade acknowledgement uses. */
export interface TradeActionResult {
  success: boolean;
  tradeId: string | null;
  state: TradeState | null;
  version: number | null;
  errorCode: TradeErrorCode | null;
  message: string | null;
}

export interface TradeHistoryEntry {
  tradeId: string;
  completedAt: string;
  result: "COMPLETED" | "FAILED" | "CANCELLED";
  partnerUsername: string;
  partnerDisplayName: string;
  given: TradeHistorySide;
  received: TradeHistorySide;
}

export interface TradeHistorySide {
  items: Array<{ name: string; quantity: number; iconSrc: string }>;
  venomons: Array<{ species: string; nickname?: string; level: number; iconImageSrc?: string }>;
  currency: number;
}

/** What one side handed over, as reported on completion. */
export type TradeExchangeSummary = TradeHistorySide;

// ---------------------------------------------------------------------------
// Reservation vocabulary (see TradeReservations.ts)
// ---------------------------------------------------------------------------

export type TradeAssetKind = "item" | "venomon" | "currency";

export interface TradeReservation {
  tradeId: string;
  userId: number;
  kind: TradeAssetKind;
  /** Item definition id, venomon instance id, or "money" for currency. */
  assetId: string;
  /** Items/currency reserve an amount; venomons reserve the whole instance. */
  amount: number;
}

/** Systems that must respect trade reservations before mutating an asset. */
export type TradeMutationSource =
  | "inventory:use-item"
  | "inventory:throw-away"
  | "inventory:hold-item"
  | "inventory:take-held-item"
  | "inventory:teach-move"
  | "pokemon:box-deposit"
  | "pokemon:box-withdraw"
  | "pokemon:box-move"
  | "pokemon:box-release"
  | "pokemon:reorder"
  | "pokemon:learn-move"
  | "pokemon:forget-move"
  | "pokemon:name"
  | "npc:store-buy"
  | "npc:store-sell"
  | "battle:start"
  | "event:script"
  | "house:buy"
  | "house:furniture-place"
  | "house:furniture-pick";

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface TradeAuditSecurityMetadata {
  /** Truncated for privacy: only the network prefix is retained. */
  ipPrefixes: Record<TradeSideKey, string>;
  platforms: Record<TradeSideKey, string>;
  sessionIds: Record<TradeSideKey, string>;
}

export interface TradeAuditRecord {
  tradeId: string;
  playerAId: number;
  playerBId: number;
  playerAUsername: string;
  playerBUsername: string;
  playerACharacterName: string;
  playerBCharacterName: string;
  startedAt: string;
  completedAt: string;
  version: number;
  snapshotHash: string;
  finalSnapshot: TradeSnapshot;
  result: "COMPLETED" | "FAILED";
  failureCode: TradeErrorCode | null;
  moderationFlags: TradeWarningCode[];
  securityMetadata: TradeAuditSecurityMetadata;
}

// ---------------------------------------------------------------------------
// Helpers shared by validation + execution
// ---------------------------------------------------------------------------

/** Rejects NaN/Infinity/decimals/negatives/overflow in one place. */
export function parseSafeInteger(value: unknown, max: number): number | null {
  if (typeof value === "boolean") {
    return null;
  }
  const numeric = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    return null;
  }
  if (!Number.isInteger(numeric)) {
    return null;
  }
  if (numeric < 0 || numeric > max || numeric > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return numeric;
}

export function displayNameOfVenomon(summary: Pick<PokemonSummary, "name" | "nickname">) {
  return summary.nickname && summary.nickname.length > 0 ? summary.nickname : summary.name;
}
