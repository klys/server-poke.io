/**
 * Server-side asset reservations.
 *
 * While an asset sits in an open trade offer it must not be spendable through
 * any other system — the bag, the PC, a shop, a held-item swap, a battle, an
 * event script. Everything that mutates player assets calls
 * `assertMutationAllowed` (wired at the socket layer in
 * registerSocketHandlers) and gets a TradeError back if the asset is locked
 * into a live trade.
 *
 * Reservations are:
 *   - server-side only (a client never sees or sets one),
 *   - temporary and tied to a trade session id,
 *   - mirrored into Redis so a crash/restart can find and drop orphans
 *     (`recoverOrphans`, called once at boot).
 *
 * The in-memory map is the hot path; Redis is bookkeeping for recovery.
 */

import type { RedisClientType } from "redis";
import {
  TradeError,
  type TradeAssetKind,
  type TradeMutationSource,
  type TradeOffer,
  type TradeReservation
} from "./tradeTypes";

const RESERVATION_INDEX_KEY = "trade:reservations:index";
const reservationKey = (tradeId: string) => `trade:reservations:${tradeId}`;

function assetKey(kind: TradeAssetKind, assetId: string) {
  return `${kind}:${assetId}`;
}

interface UserReservations {
  /** assetKey -> reservation. One trade may reserve many assets per user. */
  byAsset: Map<string, TradeReservation>;
}

export default class TradeReservations {
  /** userId -> reservations currently held against that account. */
  private readonly byUserId = new Map<number, UserReservations>();
  /** tradeId -> the (userId, assetKey) pairs it owns, for O(1) release. */
  private readonly byTradeId = new Map<string, Set<string>>();

  constructor(private readonly redis: RedisClientType) {}

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Replaces every reservation this trade holds for `userId` with the ones
   * implied by `offer`. Called after each accepted offer mutation, so the
   * reservation set always mirrors the authoritative offer exactly.
   */
  public async syncOffer(tradeId: string, userId: number, offer: TradeOffer): Promise<void> {
    this.releaseForUser(tradeId, userId);

    const reservations: TradeReservation[] = [];

    for (const item of offer.items) {
      reservations.push({
        tradeId,
        userId,
        kind: "item",
        assetId: item.itemDefinitionId,
        amount: item.quantity
      });
    }

    for (const venomon of offer.venomons) {
      reservations.push({
        tradeId,
        userId,
        kind: "venomon",
        assetId: venomon.venomonInstanceId,
        amount: 1
      });
      // A held item travels with its Venomon, so it is reserved implicitly by
      // the Venomon entry — it can no longer be taken off in the bag UI.
    }

    if (offer.currency > 0) {
      reservations.push({ tradeId, userId, kind: "currency", assetId: "money", amount: offer.currency });
    }

    for (const reservation of reservations) {
      this.add(reservation);
    }

    await this.persist(tradeId);
  }

  private add(reservation: TradeReservation) {
    const bucket = this.byUserId.get(reservation.userId) ?? { byAsset: new Map() };
    bucket.byAsset.set(assetKey(reservation.kind, reservation.assetId), reservation);
    this.byUserId.set(reservation.userId, bucket);

    const owned = this.byTradeId.get(reservation.tradeId) ?? new Set<string>();
    owned.add(`${reservation.userId}|${assetKey(reservation.kind, reservation.assetId)}`);
    this.byTradeId.set(reservation.tradeId, owned);
  }

  /** Drops this trade's reservations for one participant (in memory only). */
  private releaseForUser(tradeId: string, userId: number) {
    const owned = this.byTradeId.get(tradeId);
    if (!owned) {
      return;
    }
    const prefix = `${userId}|`;
    for (const entry of Array.from(owned)) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const key = entry.slice(prefix.length);
      const bucket = this.byUserId.get(userId);
      if (bucket?.byAsset.get(key)?.tradeId === tradeId) {
        bucket.byAsset.delete(key);
        if (bucket.byAsset.size === 0) {
          this.byUserId.delete(userId);
        }
      }
      owned.delete(entry);
    }
  }

  /**
   * Releases everything a trade holds. Called on COMPLETED, CANCELLED,
   * DECLINED, EXPIRED, FAILED and on disconnect timeout — every terminal path.
   */
  public async release(tradeId: string): Promise<void> {
    const owned = this.byTradeId.get(tradeId);
    if (owned) {
      for (const entry of owned) {
        const separator = entry.indexOf("|");
        const userId = Number(entry.slice(0, separator));
        const key = entry.slice(separator + 1);
        const bucket = this.byUserId.get(userId);
        if (bucket?.byAsset.get(key)?.tradeId === tradeId) {
          bucket.byAsset.delete(key);
          if (bucket.byAsset.size === 0) {
            this.byUserId.delete(userId);
          }
        }
      }
      this.byTradeId.delete(tradeId);
    }

    try {
      await this.redis.del(reservationKey(tradeId));
      await this.redis.sRem(RESERVATION_INDEX_KEY, tradeId);
    } catch (error) {
      console.error("trade: unable to clear reservation mirror:", error);
    }
  }

  private async persist(tradeId: string) {
    const owned = this.byTradeId.get(tradeId);
    try {
      if (!owned || owned.size === 0) {
        await this.redis.del(reservationKey(tradeId));
        await this.redis.sRem(RESERVATION_INDEX_KEY, tradeId);
        return;
      }
      await this.redis.set(reservationKey(tradeId), JSON.stringify(Array.from(owned)), {
        // Self-healing: even if release() never runs (hard kill), the mirror
        // evaporates instead of blocking assets forever.
        EX: 24 * 3600
      });
      await this.redis.sAdd(RESERVATION_INDEX_KEY, tradeId);
    } catch (error) {
      console.error("trade: unable to persist reservation mirror:", error);
    }
  }

  /**
   * Boot-time cleanup. In-memory sessions do not survive a restart, so every
   * mirrored reservation found here is by definition orphaned.
   */
  public async recoverOrphans(): Promise<number> {
    try {
      const tradeIds = await this.redis.sMembers(RESERVATION_INDEX_KEY);
      for (const tradeId of tradeIds) {
        await this.redis.del(reservationKey(tradeId));
      }
      if (tradeIds.length > 0) {
        await this.redis.del(RESERVATION_INDEX_KEY);
      }
      return tradeIds.length;
    } catch (error) {
      console.error("trade: unable to recover orphaned reservations:", error);
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Quantity of `itemId` locked into trades other than `exceptTradeId`. */
  public reservedItemQuantity(userId: number, itemId: string, exceptTradeId?: string): number {
    const reservation = this.byUserId.get(userId)?.byAsset.get(assetKey("item", itemId));
    if (!reservation || reservation.tradeId === exceptTradeId) {
      return 0;
    }
    return reservation.amount;
  }

  /** The trade holding this Venomon, ignoring `exceptTradeId`. */
  public venomonReservedBy(userId: number, venomonId: string, exceptTradeId?: string): string | null {
    const reservation = this.byUserId.get(userId)?.byAsset.get(assetKey("venomon", venomonId));
    if (!reservation || reservation.tradeId === exceptTradeId) {
      return null;
    }
    return reservation.tradeId;
  }

  public reservedCurrency(userId: number, exceptTradeId?: string): number {
    const reservation = this.byUserId.get(userId)?.byAsset.get(assetKey("currency", "money"));
    if (!reservation || reservation.tradeId === exceptTradeId) {
      return 0;
    }
    return reservation.amount;
  }

  public hasAnyReservation(userId: number): boolean {
    return (this.byUserId.get(userId)?.byAsset.size ?? 0) > 0;
  }

  /** Every Venomon instance id this user currently has locked into a trade. */
  public reservedVenomonIds(userId: number): string[] {
    const bucket = this.byUserId.get(userId);
    if (!bucket) {
      return [];
    }
    return Array.from(bucket.byAsset.values())
      .filter((reservation) => reservation.kind === "venomon")
      .map((reservation) => reservation.assetId);
  }

  // -------------------------------------------------------------------------
  // The guard other systems call
  // -------------------------------------------------------------------------

  /**
   * Throws a TradeError when the requested mutation would touch an asset that
   * a live trade has reserved. `source` only shapes the message.
   */
  public assertMutationAllowed(
    userId: number,
    source: TradeMutationSource,
    target: {
      itemIds?: string[];
      venomonIds?: string[];
      currency?: boolean;
      /** For whole-party operations (healing, battling) with no single id. */
      anyVenomon?: boolean;
    }
  ): void {
    const bucket = this.byUserId.get(userId);
    if (!bucket || bucket.byAsset.size === 0) {
      return;
    }

    for (const itemId of target.itemIds ?? []) {
      if (bucket.byAsset.has(assetKey("item", itemId))) {
        throw new TradeError(
          "ASSET_RESERVED",
          "That item is part of your active trade. Remove it from the offer first."
        );
      }
    }

    for (const venomonId of target.venomonIds ?? []) {
      if (bucket.byAsset.has(assetKey("venomon", venomonId))) {
        throw new TradeError(
          "ASSET_RESERVED",
          "That Venomon is part of your active trade. Remove it from the offer first."
        );
      }
    }

    if (target.currency && bucket.byAsset.has(assetKey("currency", "money"))) {
      throw new TradeError(
        "ASSET_RESERVED",
        "Money you offered in a trade is on hold. Change your offer first."
      );
    }

    // Whole-party operations (battling, healing) touch HP, PP, faint state and
    // held items, so any reserved Venomon at all blocks them.
    if (
      (target.anyVenomon || source === "battle:start") &&
      this.reservedVenomonIds(userId).length > 0
    ) {
      throw new TradeError(
        "ASSET_RESERVED",
        source === "battle:start"
          ? "Finish or cancel your trade before battling."
          : "Venomon in your active trade cannot be changed. Remove them from the offer first."
      );
    }
  }
}
