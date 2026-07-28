/**
 * Atomic trade execution.
 *
 * This game keeps all mutable player state in a single Redis hash per account
 * (`auth:user:{id}`), so "one transaction" means: read both accounts, build
 * the complete post-trade state for both in memory, then commit all eight
 * fields through one Lua script. Redis runs a script atomically, so the commit
 * is all-or-nothing by construction — there is no window in which one player
 * has been debited and the other not yet credited.
 *
 * Concurrency is handled with compare-and-swap rather than locks: the script
 * re-checks a fingerprint of every field it is about to overwrite against what
 * the planner read. If any other system (bag, PC, shop, battle, event script)
 * wrote to either account in between, the fingerprints differ, the script
 * aborts before its first write, and the caller reports a clean failure with
 * both accounts untouched.
 *
 * The planner deliberately works from the *raw stored strings* rather than
 * from a hydrated AuthenticatedUser: that guarantees the state it plans against
 * and the state the CAS baseline describes are byte-identical, with no second
 * read in between for another system to slip through.
 *
 * Idempotency: a completion marker keyed by trade id is checked and set inside
 * the same script, so a replayed or double-clicked completion can never apply
 * the exchange twice.
 */

import crypto from "crypto";
import type { RedisClientType } from "redis";
import {
  MAX_POKEMON_PARTY_SIZE,
  POKEMON_BOX_CAPACITY,
  type InventoryItem,
  type PokemonStorageBox,
  type PokemonSummary
} from "../Auth";
import {
  TradeError,
  type TradeConfig,
  type TradeOffer,
  type TradeSideKey,
  type TradeSnapshot
} from "./tradeTypes";

/** sha1 of the exact stored string; matches `redis.sha1hex` inside the script. */
function sha1(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

const COMMIT_SCRIPT = `
local marker = redis.call('GET', KEYS[3])
if marker then
  return cjson.encode({ status = 'ALREADY_COMPLETED', at = marker })
end

local fields = {'inventory', 'pokemon_party', 'pokemon_box', 'money'}

for i = 1, 4 do
  local current = redis.call('HGET', KEYS[1], fields[i])
  if current == false then current = '' end
  if redis.sha1hex(current) ~= ARGV[3 + i] then
    return cjson.encode({ status = 'CONFLICT', side = 'A', field = fields[i] })
  end
end

for i = 1, 4 do
  local current = redis.call('HGET', KEYS[2], fields[i])
  if current == false then current = '' end
  if redis.sha1hex(current) ~= ARGV[7 + i] then
    return cjson.encode({ status = 'CONFLICT', side = 'B', field = fields[i] })
  end
end

for i = 1, 4 do
  redis.call('HSET', KEYS[1], fields[i], ARGV[11 + i])
end
for i = 1, 4 do
  redis.call('HSET', KEYS[2], fields[i], ARGV[15 + i])
end

redis.call('SET', KEYS[3], ARGV[2], 'EX', tonumber(ARGV[3]))
return cjson.encode({ status = 'OK' })
`;

/** Raw stored values for the four fields a trade may touch. */
interface AccountFields {
  inventory: string;
  pokemon_party: string;
  pokemon_box: string;
  money: string;
}

/** The parsed, mutable working copy of one account. */
interface AccountState {
  inventory: InventoryItem[];
  party: PokemonSummary[];
  boxes: PokemonStorageBox[];
  money: number;
}

export interface TradeExecutionResult {
  ok: boolean;
  /** Set when ok === false. */
  reason?: "CONFLICT" | "VALIDATION" | "REDIS";
  /** True when the trade had already been committed by an earlier request. */
  alreadyCompleted?: boolean;
  detail?: string;
}

export default class TradeExecutor {
  constructor(
    private readonly redis: RedisClientType,
    private readonly config: TradeConfig
  ) {}

  private userKey(userId: number) {
    return `auth:user:${userId}`;
  }

  private completionKey(tradeId: string) {
    return `trade:completed:${tradeId}`;
  }

  /** Reads the four trade-relevant fields exactly as stored. */
  private async readFields(userId: number): Promise<AccountFields> {
    const values = await this.redis.hmGet(this.userKey(userId), [
      "inventory",
      "pokemon_party",
      "pokemon_box",
      "money"
    ]);
    return {
      inventory: values[0] ?? "",
      pokemon_party: values[1] ?? "",
      pokemon_box: values[2] ?? "",
      money: values[3] ?? ""
    };
  }

  /**
   * True when this trade has already been committed. Checked before doing any
   * work so a duplicate `trade:confirm` short-circuits instead of re-planning.
   */
  public async isAlreadyCompleted(tradeId: string): Promise<boolean> {
    return Boolean(await this.redis.get(this.completionKey(tradeId)));
  }

  /**
   * Plans and commits the exchange. `userIds` maps each trade side to its
   * account; everything else is re-read from Redis here and revalidated.
   */
  public async execute(
    snapshot: TradeSnapshot,
    userIds: Record<TradeSideKey, number>,
    offers: Record<TradeSideKey, TradeOffer>
  ): Promise<TradeExecutionResult> {
    let raw: Record<TradeSideKey, AccountFields>;
    let after: Record<TradeSideKey, AccountFields>;

    try {
      const [rawA, rawB] = await Promise.all([
        this.readFields(userIds.A),
        this.readFields(userIds.B)
      ]);
      raw = { A: rawA, B: rawB };
      after = this.plan(raw, offers);
    } catch (error) {
      if (error instanceof TradeError) {
        return { ok: false, reason: "VALIDATION", detail: error.code };
      }
      console.error("trade: unable to plan exchange:", error);
      return { ok: false, reason: "VALIDATION", detail: "INTERNAL_ERROR" };
    }

    const expected = (fields: AccountFields) => [
      sha1(fields.inventory),
      sha1(fields.pokemon_party),
      sha1(fields.pokemon_box),
      sha1(fields.money)
    ];

    try {
      const reply = await this.redis.eval(COMMIT_SCRIPT, {
        keys: [
          this.userKey(userIds.A),
          this.userKey(userIds.B),
          this.completionKey(snapshot.tradeId)
        ],
        arguments: [
          snapshot.tradeId,
          new Date().toISOString(),
          String(30 * 24 * 3600),
          ...expected(raw.A),
          ...expected(raw.B),
          after.A.inventory,
          after.A.pokemon_party,
          after.A.pokemon_box,
          after.A.money,
          after.B.inventory,
          after.B.pokemon_party,
          after.B.pokemon_box,
          after.B.money
        ]
      });

      const parsed = JSON.parse(String(reply)) as { status: string; side?: string; field?: string };

      if (parsed.status === "OK") {
        return { ok: true };
      }
      if (parsed.status === "ALREADY_COMPLETED") {
        return { ok: true, alreadyCompleted: true };
      }
      return {
        ok: false,
        reason: "CONFLICT",
        detail: `${parsed.side ?? "?"}:${parsed.field ?? "?"}`
      };
    } catch (error) {
      console.error("trade: commit script failed:", error);
      return { ok: false, reason: "REDIS" };
    }
  }

  // -------------------------------------------------------------------------
  // Parsing (mirrors Auth's storage shapes)
  // -------------------------------------------------------------------------

  private parseAccount(fields: AccountFields): AccountState {
    return {
      inventory: this.parseInventory(fields.inventory),
      party: this.parsePokemonList(fields.pokemon_party),
      boxes: this.parseBoxes(fields.pokemon_box),
      money: this.parseMoney(fields.money)
    };
  }

  private parseInventory(value: string): InventoryItem[] {
    if (!value) {
      return [];
    }
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(
        (entry): entry is InventoryItem =>
          Boolean(entry) &&
          typeof entry.id === "string" &&
          typeof entry.quantity === "number" &&
          Number.isFinite(entry.quantity)
      );
    } catch {
      return [];
    }
  }

  private parsePokemonList(value: string): PokemonSummary[] {
    if (!value) {
      return [];
    }
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(
        (entry): entry is PokemonSummary => Boolean(entry) && typeof entry.id === "string"
      );
    } catch {
      return [];
    }
  }

  private parseBoxes(value: string): PokemonStorageBox[] {
    let rawBoxes: Array<{ name?: unknown; pokemon?: unknown }> = [];

    if (value) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          // Legacy flat overflow list — chunk it the way Auth does on read.
          const flat = parsed.filter(
            (entry): entry is PokemonSummary => Boolean(entry) && typeof entry.id === "string"
          );
          for (let start = 0; start < flat.length; start += POKEMON_BOX_CAPACITY) {
            rawBoxes.push({ pokemon: flat.slice(start, start + POKEMON_BOX_CAPACITY) });
          }
        } else if (parsed && Array.isArray(parsed.boxes)) {
          rawBoxes = parsed.boxes.filter(
            (box: unknown): box is { name?: unknown; pokemon?: unknown } =>
              Boolean(box) && typeof box === "object"
          );
        }
      } catch {
        rawBoxes = [];
      }
    }

    return rawBoxes.map((box, index) => ({
      id: `box-${index + 1}`,
      name:
        typeof box.name === "string" && box.name.trim().length > 0
          ? box.name.trim().slice(0, 20)
          : `Box ${index + 1}`,
      capacity: POKEMON_BOX_CAPACITY,
      pokemon: Array.isArray(box.pokemon)
        ? box.pokemon.filter(
            (entry: unknown): entry is PokemonSummary =>
              Boolean(entry) && typeof (entry as PokemonSummary).id === "string"
          )
        : []
    }));
  }

  private parseMoney(value: string): number {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  private serializeStorage(boxes: PokemonStorageBox[]): string {
    return JSON.stringify({
      boxes: boxes.map((box) => ({ name: box.name, pokemon: box.pokemon }))
    });
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  /**
   * Builds the complete post-trade state for both accounts. Throws TradeError
   * the moment anything does not line up — this is the last of the three
   * validation passes (add-time, lock-time, here), and the only one that runs
   * against the exact bytes the commit will compare-and-swap against.
   */
  private plan(
    raw: Record<TradeSideKey, AccountFields>,
    offers: Record<TradeSideKey, TradeOffer>
  ): Record<TradeSideKey, AccountFields> {
    const working: Record<TradeSideKey, AccountState> = {
      A: this.parseAccount(raw.A),
      B: this.parseAccount(raw.B)
    };

    const sidePairs: Array<[TradeSideKey, TradeSideKey]> = [["A", "B"], ["B", "A"]];

    // --- 1. Remove every outgoing asset from its owner ----------------------
    const outgoing: Record<TradeSideKey, PokemonSummary[]> = { A: [], B: [] };

    for (const [from] of sidePairs) {
      const offer = offers[from];
      const state = working[from];

      const requested = new Map<string, number>();
      for (const item of offer.items) {
        requested.set(
          item.itemDefinitionId,
          (requested.get(item.itemDefinitionId) ?? 0) + item.quantity
        );
      }
      for (const [itemId, quantity] of requested) {
        const stack = state.inventory.find((entry) => entry.id === itemId);
        if (!stack) {
          throw new TradeError("ITEM_NOT_OWNED");
        }
        if (stack.quantity < quantity) {
          throw new TradeError("ITEM_QUANTITY_CHANGED");
        }
        stack.quantity -= quantity;
      }
      // Emptied stacks disappear from the bag, matching item consumption.
      state.inventory = state.inventory.filter((entry) => entry.quantity > 0);

      const seen = new Set<string>();
      for (const venomon of offer.venomons) {
        if (seen.has(venomon.venomonInstanceId)) {
          throw new TradeError("VENOMON_DUPLICATE");
        }
        seen.add(venomon.venomonInstanceId);

        const partyIndex = state.party.findIndex((entry) => entry.id === venomon.venomonInstanceId);
        if (partyIndex !== -1) {
          outgoing[from].push(state.party.splice(partyIndex, 1)[0]);
          continue;
        }

        let found = false;
        for (const box of state.boxes) {
          const boxIndex = box.pokemon.findIndex((entry) => entry.id === venomon.venomonInstanceId);
          if (boxIndex !== -1) {
            outgoing[from].push(box.pokemon.splice(boxIndex, 1)[0]);
            found = true;
            break;
          }
        }
        if (!found) {
          throw new TradeError("VENOMON_NOT_OWNED");
        }
      }

      if (offer.currency > 0) {
        if (offer.currency > this.config.maxTradeCurrency) {
          throw new TradeError("CURRENCY_LIMIT");
        }
        if (state.money < offer.currency) {
          throw new TradeError("CURRENCY_INSUFFICIENT");
        }
        state.money -= offer.currency;
      }
    }

    // --- 2. Credit the recipient ------------------------------------------
    for (const [from, to] of sidePairs) {
      const offer = offers[from];
      const recipient = working[to];

      for (const item of offer.items) {
        const existing = recipient.inventory.find((entry) => entry.id === item.itemDefinitionId);
        if (existing) {
          const merged = existing.quantity + item.quantity;
          if (merged > this.config.maxItemStack) {
            throw new TradeError("ITEM_STACK_LIMIT");
          }
          existing.quantity = merged;
          continue;
        }
        if (recipient.inventory.length >= this.config.maxInventorySlots) {
          throw new TradeError("INVENTORY_FULL");
        }
        if (item.quantity > this.config.maxItemStack) {
          throw new TradeError("ITEM_STACK_LIMIT");
        }
        recipient.inventory.push({
          id: item.itemDefinitionId,
          name: item.name,
          category: item.category,
          quantity: item.quantity,
          description: item.description
        });
      }

      // Held items travel with the Venomon — one game-wide rule, restated in
      // the snapshot and shown on the confirmation screen.
      for (const summary of outgoing[from]) {
        this.placeVenomon(recipient, summary);
      }

      if (offer.currency > 0) {
        const credited = recipient.money + offer.currency;
        if (credited > this.config.maxCurrencyBalance) {
          throw new TradeError("CURRENCY_BALANCE_LIMIT");
        }
        recipient.money = credited;
      }
    }

    // --- 3. Post-conditions ------------------------------------------------
    for (const side of ["A", "B"] as TradeSideKey[]) {
      const state = working[side];

      // The game requires a non-empty party; pull one back out of storage
      // rather than failing a trade that leaves the trainer with Venomons.
      if (state.party.length === 0) {
        const donorBox = state.boxes.find((box) => box.pokemon.length > 0);
        if (!donorBox) {
          throw new TradeError("VENOMON_LAST_ONE");
        }
        state.party.push(donorBox.pokemon.shift()!);
      }

      if (state.party.length > MAX_POKEMON_PARTY_SIZE) {
        throw new TradeError("VENOMON_STORAGE_FULL");
      }
      if (state.money < 0 || !Number.isSafeInteger(state.money)) {
        throw new TradeError("CURRENCY_INVALID");
      }
      for (const item of state.inventory) {
        if (item.quantity < 0 || !Number.isSafeInteger(item.quantity)) {
          throw new TradeError("ITEM_QUANTITY_CHANGED");
        }
      }

      // No Venomon instance may exist twice on one account.
      const ids = new Set<string>();
      for (const entry of [...state.party, ...state.boxes.flatMap((box) => box.pokemon)]) {
        if (ids.has(entry.id)) {
          throw new TradeError("VENOMON_DUPLICATE");
        }
        ids.add(entry.id);
      }
    }

    // ...nor on both accounts at once.
    const idsA = new Set(
      [...working.A.party, ...working.A.boxes.flatMap((box) => box.pokemon)].map((entry) => entry.id)
    );
    for (const entry of [...working.B.party, ...working.B.boxes.flatMap((box) => box.pokemon)]) {
      if (idsA.has(entry.id)) {
        throw new TradeError("VENOMON_DUPLICATE");
      }
    }

    const serialize = (side: TradeSideKey): AccountFields => ({
      inventory: JSON.stringify(working[side].inventory),
      pokemon_party: JSON.stringify(working[side].party),
      pokemon_box: this.serializeStorage(working[side].boxes),
      money: String(working[side].money)
    });

    return { A: serialize("A"), B: serialize("B") };
  }

  /** Party first (up to 6), then the first box with room, then a new box. */
  private placeVenomon(recipient: AccountState, summary: PokemonSummary) {
    if (recipient.party.length < MAX_POKEMON_PARTY_SIZE) {
      recipient.party.push(summary);
      return;
    }
    const target = recipient.boxes.find((box) => box.pokemon.length < box.capacity);
    if (target) {
      target.pokemon.push(summary);
      return;
    }
    recipient.boxes.push({
      id: `box-${recipient.boxes.length + 1}`,
      name: `Box ${recipient.boxes.length + 1}`,
      capacity: POKEMON_BOX_CAPACITY,
      pokemon: [summary]
    });
  }
}
