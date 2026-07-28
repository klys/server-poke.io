# Player-to-Player Trading

Server-authoritative trading for Venova Online: two online players exchange
Venomons, item stacks and in-game money in a single atomic transaction, with a
private per-trade chat and a two-stage lock/confirm flow.

The server is the sole authority for trade state, asset ownership, validation,
reservation and execution. Clients send intents and render what comes back.

---

## 1. Module map

### Server (`server-poke.io`)

| File | Responsibility |
| --- | --- |
| `components/TradeManager.ts` | State machine, validation, warnings, chat, socket surface, moderation API |
| `components/trade/tradeTypes.ts` | States, transitions, error codes, config, offer/snapshot/audit shapes |
| `components/trade/tradeSnapshot.ts` | Canonical JSON + deterministic SHA-256 snapshot hash |
| `components/trade/TradeReservations.ts` | Server-side asset reservations + the guard other systems call |
| `components/trade/TradeExecutor.ts` | Plans the exchange and commits it atomically (Redis Lua CAS) |
| `components/trade/TradeStore.ts` | Redis: one-trade-per-player claim, session mirror, chat, audit, history, moderation indexes |

### Client (`client-poke.io`)

| File | Responsibility |
| --- | --- |
| `src/components/ux/game/trade/TradeContext.tsx` | Owns every `trade:*` listener; exposes actions + authoritative state |
| `src/components/ux/game/trade/TradeWindow.tsx` | Trade window shell, request prompts, outcome banner |
| `src/components/ux/game/trade/TradeOfferPanel.tsx` | "Your Offer" / "Their Offer" panels with status pills |
| `src/components/ux/game/trade/TradeAssetPicker.tsx` | Searchable bag, category filters, party/storage browser, money input |
| `src/components/ux/game/trade/TradeConfirmPanel.tsx` | Final immutable snapshot + countdown + warnings |
| `src/components/ux/game/trade/TradeChatPanel.tsx` | Private trade chat |
| `src/components/ux/game/trade/TradeHistoryWindow.tsx` | Player-facing trade history |
| `src/components/ux/game/trade/tradeTypes.ts` | Client mirror of the wire contract |

---

## 2. State machine

```
                    trade:request
                          │
                          ▼
                     ┌─────────┐  decline / cancel / TTL
                     │REQUESTED├──────────────┐
                     └────┬────┘              │
                  accept  │                   ▼
                          ▼            DECLINED / CANCELLED / EXPIRED
        ┌────────────► ┌──────┐ ◄────────────┐
        │              │ OPEN │              │
        │              └──┬───┘              │
        │        lock(A)  │  lock(B)         │ any offer change
        │        ┌────────┴────────┐         │ or unlock
        │        ▼                 ▼         │
        │ ┌───────────────┐ ┌───────────────┐│
        │ │PLAYER_A_LOCKED│ │PLAYER_B_LOCKED││
        │ └───────┬───────┘ └───────┬───────┘│
        │         └────────┬────────┘        │
        │                  ▼                 │
        │           ┌─────────────┐          │
        │           │ BOTH_LOCKED │          │
        │           └──────┬──────┘          │
        │                  │ snapshot frozen │
        │                  ▼                 │
        │        ┌────────────────────┐      │
        └────────┤ FINAL_CONFIRMATION ├──────┘
                 └─────────┬──────────┘
                 both confirmed
                           ▼
                     ┌──────────┐
                     │PROCESSING│  ← atomic commit, not cancellable
                     └────┬─────┘
                   ┌──────┴──────┐
                   ▼             ▼
             ┌──────────┐   ┌────────┐
             │COMPLETED │   │ FAILED │
             └──────────┘   └────────┘
```

`CANCELLED` / `EXPIRED` are reachable from every non-terminal state except
`PROCESSING`. The legal transition table lives in
`TRADE_TRANSITIONS` (`tradeTypes.ts`) and is the only thing that decides what a
trade may do next — never a client boolean.

### Invariants

1. **Any change to either offer** increments the version, clears **both** locks
   and **both** confirmations, clears the snapshot, and returns the trade to
   `OPEN`. (`TradeManager.invalidateLocks`)
2. **A locked offer cannot be edited.** The only way back to editing is
   `trade:offer:unlock`, which itself invalidates everything.
3. **The version and snapshot hash never move during `FINAL_CONFIRMATION`.**
   Both players necessarily confirm the same bytes.
4. **`PROCESSING` cannot be cancelled.** The commit is already atomic.
5. **One live trade per player**, enforced by a Redis `SET NX` claim.

---

## 3. Socket events

Every client action carries a **trade id**, the **version the client last saw**,
and an **idempotency key**, and is answered with a `trade:result` envelope:

```ts
interface TradeActionResult {
  success: boolean;
  tradeId: string | null;
  state: TradeState | null;
  version: number | null;
  errorCode: TradeErrorCode | null;   // stable, machine-readable
  message: string | null;             // safe user-facing copy
}
```

No stack traces, SQL/Redis errors, keys or internal identifiers ever cross the
wire. Unexpected exceptions collapse to `INTERNAL_ERROR`.

### Client → server

| Event | Payload | Notes |
| --- | --- | --- |
| `trade:request` | `{ targetPlayerId? , targetUserId? }` | Rate-limited; claims only the requester |
| `trade:request:accept` | `{ tradeId }` | Claims the target, opens the session |
| `trade:request:decline` | `{ tradeId }` | |
| `trade:request:cancel` | `{ tradeId }` | Sender withdrawing their own request |
| `trade:offer:add-item` | `Envelope & { itemId, quantity }` | Adds on top of what is already offered |
| `trade:offer:update-item` | `Envelope & { itemId, quantity }` | Absolute quantity; `0` removes |
| `trade:offer:remove-item` | `Envelope & { itemId }` | |
| `trade:offer:add-venomon` | `Envelope & { venomonId }` | Party or any storage box |
| `trade:offer:remove-venomon` | `Envelope & { venomonId }` | |
| `trade:offer:set-currency` | `Envelope & { amount }` | Non-negative integer |
| `trade:offer:lock` | `Envelope` | Revalidates the offer first |
| `trade:offer:unlock` | `Envelope` | Also the way out of `FINAL_CONFIRMATION` |
| `trade:confirm` | `Envelope & { snapshotHash }` | Must echo the server's hash |
| `trade:cancel` | `{ tradeId, requestId? }` | |
| `trade:chat:send` | `{ tradeId, text, requestId? }` | |
| `trade:sync` | `{ tradeId? }` | Full authoritative resync + chat replay |
| `trade:history` | `{ page?, pageSize? }` | |
| `trade:report` | `{ tradeId, reason, explanation? }` | Participants only |

```ts
interface TradeActionEnvelope {
  tradeId: string;
  expectedVersion: number;   // mismatch → STALE_VERSION
  requestId?: string;        // replays of the same id are dropped
}
```

Moderation (requires `moderator.access`): `moderation:trades:search`,
`moderation:trades:detail`, `moderation:trades:note`,
`moderation:trades:set-restriction`, `moderation:trades:reports`.

### Server → client

| Event | Payload | When |
| --- | --- | --- |
| `trade:request:received` | `{ tradeId, from, expiresAt }` | Target gets a request |
| `trade:request:expired` | `{ tradeId }` | TTL elapsed or withdrawn |
| `trade:opened` | `TradeStatePayload` | Request accepted |
| `trade:state` | `TradeStatePayload \| null` | Authoritative state; `null` = not trading |
| `trade:offer:changed` | `TradeStatePayload` | An offer was edited |
| `trade:offer:invalidated` | `TradeStatePayload` | Locks/confirmations cleared |
| `trade:confirmation:started` | `TradeStatePayload` | Snapshot frozen, countdown running |
| `trade:participant:disconnected` | `{ tradeId, userId, graceSeconds }` | |
| `trade:participant:reconnected` | `{ tradeId, userId }` | |
| `trade:chat:message` | `TradeChatMessage` | Player or server-authored system message |
| `trade:completed` | `{ tradeId, state, version, snapshotHash, completedAt, given, received }` | Followed by a fresh `auth:session` |
| `trade:cancelled` | `{ tradeId, state, version, reason, errorCode }` | |
| `trade:failed` | `{ tradeId, state, version, errorCode, message }` | Nothing was exchanged |
| `trade:result` | `TradeActionResult` | Ack for every client action |
| `trade:history` | `{ entries, page, pageSize, total }` | |

`trade:state` is emitted **per recipient** — each side receives its own
`youAre` so the client never has to guess which offer is its own. Chat uses a
scoped Socket.IO room (`trade:<tradeId>`).

`TradeStatePayload` carries only what the trade window needs (the two offers,
participants, warnings, lock/confirm flags, snapshot during final
confirmation). Full inventories are never included.

### Legacy events

`battle:trade-request` / `battle:trade-response` were a no-op handshake before
this feature existed. They now route into `TradeManager`, so clients built
against the old contract open a real trade session.

---

## 4. Data model (Redis)

All mutable player state already lives in one hash per account
(`auth:user:{id}`), so trading writes only the four fields it can touch:
`inventory`, `pokemon_party`, `pokemon_box`, `money`.

| Key | Type | Lifetime | Purpose |
| --- | --- | --- | --- |
| `trade:active:user:{userId}` | string → tradeId | session TTL | **Uniqueness constraint**: one live trade per player (`SET NX`) |
| `trade:active:index` | set | until swept | Members for boot recovery |
| `trade:session:{tradeId}` | JSON | 2× session TTL | Session mirror for reconnect + restart sweep |
| `trade:reservations:{tradeId}` | JSON | 24 h | Mirror of held reservations, for orphan recovery |
| `trade:reservations:index` | set | until swept | |
| `trade:chat:{tradeId}` | list | `TRADE_CHAT_RETENTION_SECONDS` | Bounded (500 msgs) moderation log |
| `trade:audit:{tradeId}` | JSON | **permanent** | Audit record: snapshot, hash, result, security metadata |
| `trade:completed:{tradeId}` | string | 30 d | **Idempotency marker** set inside the commit script |
| `trade:history:{userId}` | list | capped | Player-facing history (`TRADE_HISTORY_LIMIT`) |
| `trade:index:completed` | zset by time | permanent | Moderation paging |
| `trade:index:user:{userId}` | zset by time | permanent | Search by player, volume detection |
| `trade:index:pair:{lo}:{hi}` | zset by time | permanent | Repeated-partner detection |
| `trade:idem:{tradeId}:{key}` | string | 2× session TTL | Replay protection per action |
| `trade:report:{tradeId}:{reporterId}` | JSON | permanent | Player reports |
| `trade:notes:{tradeId}` | list | permanent | Moderator investigation notes |
| `trade:disabled:user:{userId}` | string | until cleared | Moderation trading restriction |

Entity mapping to the suggested model in the brief: `TradeSession` →
`trade:session:*` + in-memory session; `TradeOfferItem` / `TradeOfferVenomon` /
`TradeOfferCurrency` → the `offers` object inside the session and the frozen
snapshot; `TradeChatMessage` → `trade:chat:*`; `TradeAudit` → `trade:audit:*`.
There is no SQL layer in this game, so "database constraints" are Redis
primitives: `SET NX` for uniqueness/idempotency, and an atomic Lua script for
the transaction.

---

## 5. Atomic execution

`TradeExecutor.execute` is the only code that moves assets.

1. Read the four raw stored strings for **both** accounts in one pass. These
   are simultaneously the planning input and the compare-and-swap baseline, so
   there is no second read in between for another system to slip through.
2. Parse and plan the complete post-trade state for both players in memory:
   debit every outgoing asset first, then credit the recipient, then check
   post-conditions (non-empty party, party ≤ 6, no negative balances, no
   duplicated Venomon instance on one account **or across both**).
3. Commit through a single Redis Lua script, which — atomically:
   - aborts if `trade:completed:{tradeId}` already exists (**idempotency**),
   - compares `redis.sha1hex` of each of the eight fields against the
     fingerprints taken in step 1 (**compare-and-swap**),
   - writes all eight fields,
   - sets the completion marker.

Because Redis runs the script atomically, there is no window in which one
player has been debited and the other not yet credited. If any fingerprint
differs — another system wrote to either account in between — the script
returns before its first write and the trade fails cleanly with both accounts
untouched.

Validation runs **three** times, deliberately:

| Pass | Where | Why |
| --- | --- | --- |
| 1 | `resolveItemOffer` / `resolveVenomonOffer` on add | Fast, specific feedback |
| 2 | `revalidateOffer` on lock + on entering `FINAL_CONFIRMATION` | The frozen snapshot must be true |
| 3 | `revalidateOffer` + `TradeExecutor.plan` at commit | Against the exact bytes being swapped |

---

## 6. Asset reservations

When an asset enters an offer, `TradeReservations.syncOffer` locks it against
every other system. `TradeManager.assertMutationAllowed` is called from
`registerSocketHandlers` before these handlers do anything:

`inventory:use-item`, `inventory:throw-away`, `inventory:hold-item`,
`inventory:take-held-item`, `inventory:teach-move`, `pokemon:box-deposit`,
`pokemon:box-withdraw`, `pokemon:reorder`, `pokemon:learn-move`,
`pokemon:forget-move`, `pokemon:name`, `npc:store-buy`, `npc:store-sell`,
`npc:heal-party`, `npc:battle`, `battle:learn-move`.

Battles are blocked separately through `BattleManager.setTradeGuard`, which
gates wild step encounters, Rock Smash encounters, player challenges and
challenge acceptance — a battle would mutate HP/PP/held items on reserved
Venomons.

A held item is reserved implicitly by its Venomon: it is not in the bag while
equipped, and it travels with the Venomon (see §8).

Reservations are released on **every** terminal path: completion,
cancellation, decline, expiry, failure and disconnect timeout. Orphans are
swept at boot (`TradeManager.initialize`), and the Redis mirror carries a 24 h
TTL as a second line of defence against a hard kill.

---

## 7. Concurrency and anti-duplication

| Threat | Protection |
| --- | --- |
| Repeated / replayed Socket.IO events | Per-action idempotency key (`SET NX` on `trade:idem:*`) |
| Double-clicking Confirm | Idempotency key + `session.processing` re-entry guard + completion marker |
| Retrying a completed transaction | `trade:completed:{tradeId}` checked **inside** the commit script |
| Stale client state | `expectedVersion` on every action → `STALE_VERSION` |
| Confirming a changed offer | Server-issued `snapshotHash` must match → `SNAPSHOT_MISMATCH` |
| Concurrent inventory modification | SHA-1 compare-and-swap on all eight fields |
| Two sessions referencing one asset | One trade per player (`SET NX`) + per-asset reservation registry |
| Client quantity manipulation | Quantities revalidated against stored state three times |
| Integer overflow / NaN / decimals / negatives | `parseSafeInteger` + `Number.isSafeInteger` post-conditions |
| Race with shops / bag / PC / mail / battles | Reservation guard at the socket layer + CAS at commit |
| Disconnect mid-confirmation | Confirmations cleared on disconnect; confirm refused while a participant is away |
| Server restart mid-trade | Sessions are in-memory only; boot sweep releases claims and marks mirrors `FAILED`; the completion marker is never cleared |

---

## 8. Game rules chosen

- **Held items travel with their Venomon.** One rule, everywhere: stated in the
  snapshot (`heldItemsTransferWithVenomon`), shown on both offer panels and the
  confirmation screen, and warned about (`HELD_ITEM_TRANSFERS`).
- **A trainer always keeps at least one usable Venomon.** Eggs cannot battle, so
  they never count as the last one. Enforced on add, on lock and at commit
  (`VENOMON_LAST_ONE`).
- **Key items are untradeable.** Determined from the catalog's own signals — the
  `KeyItem` flag, the Key Items pocket (`8`), or the `quest item` type — *not*
  from the bag's coarse `category`, which lumps general items and Poké Balls in
  with key items and would make most of the catalog untradeable.
- **Recipients with a full party** receive Venomons into the first storage box
  with space; a new box is created when every box is full (storage is endless
  in this game, so Venomon capacity never blocks a trade).
- **Emptied item stacks disappear** from the bag, matching item consumption.

---

## 9. Warnings (advisory, never blocking)

`ONE_SIDED`, `UNBALANCED`, `RARE_ASSET`, `NICKNAMED_VENOMON`, `EGG_INCLUDED`,
`HELD_ITEM_TRANSFERS`, `NEW_ACCOUNT`, `SIMILAR_ITEM_NAMES`, `LARGE_CURRENCY`.

They are computed server-side when the snapshot is frozen, shown on the
confirmation screen, and stored on the audit record as `moderationFlags`.
Gifts and intentionally uneven trades remain allowed.

`SIMILAR_ITEM_NAMES` normalizes away diacritics and Cyrillic look-alikes
(о/о, і/i, е/e, а/a, ѕ/s) to catch counterfeit item names.

Status is never communicated by colour alone: every state carries an icon and a
text label.

---

## 10. Configuration

All optional; defaults in parentheses.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRADE_ENABLED` | `true` | Global kill switch |
| `TRADE_REQUEST_TTL_SECONDS` | `60` | Request lifetime |
| `TRADE_SESSION_TTL_SECONDS` | `900` | Idle session lifetime (refreshed per action) |
| `TRADE_DISCONNECT_GRACE_SECONDS` | `45` | Reconnect window before auto-cancel |
| `TRADE_CONFIRMATION_DELAY_SECONDS` | `3` | Mandatory review countdown |
| `TRADE_PROXIMITY_SQUARES` | `12` | `0` = same map only, `-1` = anywhere |
| `TRADE_REQUEST_RATE_LIMIT` / `_WINDOW_SECONDS` | `5` / `60` | Request spam limit |
| `TRADE_CHAT_RATE_LIMIT` / `_WINDOW_SECONDS` | `8` / `5` | Chat spam limit |
| `TRADE_CHAT_MAX_LENGTH` | `300` | |
| `TRADE_CHAT_RETENTION_SECONDS` | `2592000` (30 d) | Moderation retention |
| `TRADE_MAX_ITEM_ENTRIES` | `20` | Item stacks per side |
| `TRADE_MAX_VENOMON_ENTRIES` | `6` | Venomons per side |
| `TRADE_MAX_CURRENCY` | `1000000` | Per-trade money cap |
| `TRADE_MAX_CURRENCY_BALANCE` | `9999999` | Post-receipt balance cap |
| `TRADE_MAX_INVENTORY_SLOTS` | `500` | Recipient bag slots |
| `TRADE_MAX_ITEM_STACK` | `999` | Recipient stack limit |
| `TRADE_HISTORY_LIMIT` | `50` | Player history depth |
| `TRADE_BLOCKED_ITEM_CATEGORIES` | `quest item,key item,key items` | Catalog item *types* |
| `TRADE_BLOCKED_ITEM_IDS` | — | Explicit id blocklist |
| `TRADE_BLOCKED_MAP_IDS` | — | Maps where trading is off |
| `TRADE_NEW_ACCOUNT_FLAG_DAYS` | `3` | Flags (never blocks) new accounts |
| `TRADE_UNBALANCED_THRESHOLD` | `4` | Entry-count ratio for `UNBALANCED` |

---

## 11. Audit, history and moderation

Every completed **and** failed trade writes a permanent
`trade:audit:{tradeId}` record: both player ids, usernames and character names
at the time of trade, start/completion timestamps, version, snapshot hash, the
full final snapshot, result, failure code, moderation flags, and security
metadata (**truncated IP prefix only** — IPv4 /16, IPv6 /48 — plus platform and
the ephemeral socket id; never tokens, emails or full addresses).

Players see a safe projection: date, partner display name, assets given and
received, completion status. The e2e suite asserts that no security metadata
leaks into it.

Moderators can search by player or trade id (paginated over sorted sets),
review the final snapshot and the retained chat, see the warnings raised,
count repeated-partner trades and 30-day volume per player, add investigation
notes, and disable trading for an account. **No automatic asset reversal is
implemented** — by design; reversal requires a controlled process and a full
audit trail.

---

## 12. Tests

`tools/e2e-trade.ts` drives a real server and real Redis with three live socket
clients (40 assertions). Every assertion reads authoritative Redis state, not
socket payloads, so "nothing was exchanged" is verified against the accounts.

```bash
cd server-poke.io && node_modules/.bin/ts-node tools/e2e-trade.ts
```

Covered: single-item trade; multi-stack + multi-Venomon + money in one trade;
one-sided gift; cancel during selection; cancel after locking; decline; request
expiry; reconnect via `trade:sync`; late offer change clearing both locks;
stale version; outdated snapshot hash; confirmation delay; unowned item;
over-quantity; duplicate Venomon; last-usable-Venomon protection; restricted
item; negative/decimal/NaN/Infinity/overflow currency; over-balance currency;
duplicate completion requests; replayed idempotency key; reserved-asset
mutation attempts (bag, PC, shop); non-participant actions; chat
authorization/empty/oversized/HTML-injection/rate-limit/after-close/forged
system message; duplicate + rate-limited requests; disconnect during final
confirmation and reconnect; audit record contents; history privacy; and a real
server restart mid-trade.

---

## 13. Known limitations / follow-up

1. **Attributes the game does not model.** Venomon have no shiny, nature,
   ability, gender or form field in `PokemonSummary` (gender is derived at
   battle time from species data). The wire format and UI already carry
   optional slots for all of them, so they render as soon as the game stores
   them. Original-trainer/origin metadata is likewise not modelled.
2. **No value metadata**, so `UNBALANCED` uses entry counts, and item rarity is
   inferred from catalog price. A real value table would improve both.
3. **Systems that do not exist yet** (auction house, mail attachments, daycare,
   breeding, expeditions, crafting) have no reservation hooks, because they
   have no code. `TradeMutationSource` already names them; wire them up when
   they land.
4. **Reservations are per-process.** The game runs as a single server process;
   a multi-process deployment would need the reservation registry moved into
   Redis (the mirror already exists) or a sticky-session router. The Lua CAS
   commit is already multi-process safe.
5. **Trade-request privacy** currently reuses the Friends window's "accept
   invitations" preference (friends bypass it). A dedicated
   "who can send me trade requests" setting is a small follow-up in
   `SocialPrefs`.
6. **Not covered by the e2e suite**: forcing a mid-transfer database failure and
   forcing a recipient inventory-capacity failure. Both are exercised by the
   same code paths the CAS-conflict and `INVENTORY_FULL` branches use, but a
   fault-injection harness would make them explicit.
7. **Pre-existing, unrelated**: `npx tsc --noEmit` in `server-poke.io` reports
   `Cannot find name 'XMLHttpRequest'` from `engine.io-client`, pulled in by the
   `tools/e2e-*.ts` scripts that import `socket.io-client`. It predates this
   work; adding `"skipLibCheck": true` (or `"DOM"` to `lib`) to `tsconfig.json`
   would clear it.
