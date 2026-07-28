/**
 * Deterministic trade snapshots.
 *
 * Both players must confirm *the same bytes*. That means the hash cannot
 * depend on key insertion order, array ordering the client happened to send,
 * or JSON float formatting — so everything is normalized here first:
 *
 *   - object keys sorted recursively
 *   - offer entries sorted by a stable natural key
 *   - only the fields that describe the exchange are hashed (lock/confirm
 *     flags and presentation-only extras are excluded, so re-locking an
 *     unchanged offer produces an identical hash)
 *
 * The resulting hash is what `trade:confirm` must echo back, and what the
 * atomic executor re-verifies before touching a single account.
 */

import crypto from "crypto";
import type {
  TradeOffer,
  TradeOfferItem,
  TradeOfferVenomon,
  TradeSnapshot
} from "./tradeTypes";

/** Recursively sorts object keys so JSON.stringify is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      // Drop undefined so `{a: undefined}` and `{}` hash identically.
      if (entry !== undefined) {
        sorted[key] = canonicalize(entry);
      }
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sortOfferItems(items: TradeOfferItem[]): TradeOfferItem[] {
  return [...items].sort((left, right) =>
    left.itemInstanceId.localeCompare(right.itemInstanceId) ||
    left.itemDefinitionId.localeCompare(right.itemDefinitionId)
  );
}

export function sortOfferVenomons(venomons: TradeOfferVenomon[]): TradeOfferVenomon[] {
  return [...venomons].sort((left, right) =>
    left.venomonInstanceId.localeCompare(right.venomonInstanceId)
  );
}

/**
 * The hashed projection of one side's offer. Deliberately narrower than
 * TradeOffer: lock/confirm state changes constantly and must not move the
 * hash, while every field that decides *what changes hands* must.
 */
function hashableOffer(offer: TradeOffer) {
  return {
    currency: offer.currency,
    items: sortOfferItems(offer.items).map((item) => ({
      itemDefinitionId: item.itemDefinitionId,
      itemInstanceId: item.itemInstanceId,
      quantity: item.quantity,
      name: item.name,
      category: item.category,
      rarity: item.rarity,
      restricted: item.restricted
    })),
    venomons: sortOfferVenomons(offer.venomons).map((venomon) => ({
      venomonInstanceId: venomon.venomonInstanceId,
      speciesId: venomon.speciesId,
      species: venomon.species,
      nickname: venomon.nickname,
      level: venomon.level,
      moves: [...venomon.moves],
      heldItemId: venomon.heldItemId,
      heldItemName: venomon.heldItemName,
      isEgg: venomon.isEgg,
      hp: venomon.hp,
      maxHp: venomon.maxHp
    }))
  };
}

/** Strips lock/confirm flags — the snapshot records the exchange, not the UI. */
export function toSnapshotOffer(offer: TradeOffer): Omit<TradeOffer, "locked" | "confirmed"> {
  return {
    items: sortOfferItems(offer.items),
    venomons: sortOfferVenomons(offer.venomons),
    currency: offer.currency
  };
}

/**
 * Hashes the parts of a snapshot that define the exchange. Warnings and
 * `createdAt` are excluded: they are advisory/observational, and including
 * them would let a clock tick invalidate a confirmation.
 */
export function computeSnapshotHash(snapshot: TradeSnapshot): string {
  const payload = {
    tradeId: snapshot.tradeId,
    version: snapshot.version,
    heldItemsTransferWithVenomon: snapshot.heldItemsTransferWithVenomon,
    participants: {
      A: { userId: snapshot.participants.A.userId, username: snapshot.participants.A.username },
      B: { userId: snapshot.participants.B.userId, username: snapshot.participants.B.username }
    },
    offers: {
      A: hashableOffer({ ...snapshot.offers.A, locked: false, confirmed: false }),
      B: hashableOffer({ ...snapshot.offers.B, locked: false, confirmed: false })
    }
  };

  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Stable fingerprint of a stored Redis field, used for compare-and-swap. */
export function fingerprint(value: string | null | undefined): string {
  return crypto.createHash("sha256").update(value ?? "").digest("hex");
}
