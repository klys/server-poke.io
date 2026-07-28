/**
 * E2E: player-to-player trading against a REAL server + REAL redis.
 *
 * Two live socket clients (A and B) drive the whole state machine and then
 * attack it. Every assertion reads the authoritative Redis state, not the
 * socket payloads, so "nothing was exchanged" really means nothing changed on
 * either account.
 *
 * FUNCTIONAL
 *   F1  trade a single item stack
 *   F2  trade multiple item stacks + multiple Venomons + money in one trade
 *   F3  one-sided gift trade (A gives, B gives nothing)
 *   F4  cancel during offer selection
 *   F5  cancel after locking
 *   F6  decline a trade request
 *   F7  expire a trade request
 *   F8  reconnect to an active trade (trade:sync rebuilds the state)
 *
 * SECURITY / INTEGRITY
 *   S1  modifying an offer after the other player locks clears both locks
 *   S2  a stale trade version is rejected
 *   S3  confirming an outdated snapshot hash is rejected
 *   S4  offering an item the player does not own
 *   S5  offering more of an item than the player owns
 *   S6  offering the same Venomon twice
 *   S7  negative / decimal / NaN / overflow currency
 *   S8  currency above the player's balance
 *   S9  duplicate completion requests cannot duplicate assets
 *   S10 replaying an old socket action (same idempotency key) is dropped
 *   S11 mutating an asset reserved by a trade is refused
 *   S12 a non-participant cannot act on the trade
 *   S13 trading away the last usable Venomon is refused
 *   S14 restricted (quest/key) items cannot be traded
 *
 * CHAT
 *   C1  an unauthorized player cannot read or send trade chat
 *   C2  empty message rejected
 *   C3  oversized message rejected
 *   C4  HTML/script payload is escaped, never stored raw
 *   C5  rate limit kicks in
 *   C6  messages after the trade closes are rejected
 *   C7  a client cannot forge a system message
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-trade.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3997;
const TEST_MAP = "map-essentials-043";

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
// Explicitly typed so TypeScript treats it as never-returning and narrows
// after `if (!x) fail(...)`.
const fail: (msg: string) => never = (msg) => {
  throw new Error(`ASSERTION FAILED: ${msg}`);
};
const pass = (msg: string) => {
  passed += 1;
  log(`  ✓ ${msg}`);
};

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

async function waitFor<T>(
  what: string,
  fn: () => T | Promise<T>,
  { timeoutMs = 15000, everyMs = 100 } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${lastErr}` : ""}`);
    }
    await sleep(everyMs);
  }
}

function mon(id: string, sourcePokemonId: string, level = 20, extra: Record<string, unknown> = {}) {
  return {
    id,
    sourcePokemonId,
    name: id,
    level,
    types: ["Normal"],
    hp: 40,
    maxHp: 40,
    moves: ["Placaje"],
    movePp: { Placaje: 35 },
    experience: 0,
    experienceCurve: "medium",
    nextLevelExperience: 1000,
    statBonuses: {},
    ...extra
  };
}

function item(id: string, name: string, quantity: number, category = "usable") {
  return { id, name, category, quantity, description: `${name} description` };
}

interface Client {
  label: string;
  socket: Socket;
  userId: number;
  token: string;
  userKey: string;
  myPlayerId: string | null;
  state: any | null;
  results: any[];
  chat: any[];
  requests: any[];
  completed: any[];
  cancelled: any[];
  failed: any[];
  authErrors: string[];
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  const clients: Client[] = [];
  const testUserIds: number[] = [];

  const cleanup = async () => {
    log("── cleanup ──");
    for (const c of clients) {
      try {
        c.socket.disconnect();
      } catch {
        /* already gone */
      }
    }
    if (server && !server.killed) {
      server.kill("SIGTERM");
      await sleep(800);
      if (!server.killed) server.kill("SIGKILL");
    }
    if (redis?.isOpen) {
      for (const id of testUserIds) {
        try {
          await redis.del(`auth:user:${id}`);
        } catch {
          /* best effort */
        }
      }
      // Drop the trade artifacts this run created.
      for (const pattern of ["trade:*"]) {
        try {
          const keys = await redis.keys(pattern);
          if (keys.length > 0) await redis.del(keys);
        } catch {
          /* best effort */
        }
      }
      await redis.quit();
    }
  };

  const attach = (c: Client) => {
    c.socket.on("trade:state", (s: any) => {
      c.state = s;
    });
    for (const event of [
      "trade:opened",
      "trade:offer:changed",
      "trade:offer:invalidated",
      "trade:confirmation:started"
    ]) {
      c.socket.on(event, (s: any) => {
        c.state = s;
      });
    }
    c.socket.on("trade:result", (r: any) => {
      c.results.push(r);
    });
    c.socket.on("trade:chat:message", (m: any) => {
      c.chat.push(m);
    });
    c.socket.on("trade:request:received", (r: any) => {
      c.requests.push(r);
    });
    c.socket.on("trade:request:expired", (r: any) => {
      c.requests = c.requests.filter((entry) => entry.tradeId !== r?.tradeId);
    });
    c.socket.on("trade:completed", (d: any) => {
      c.completed.push(d);
      c.state = null;
    });
    c.socket.on("trade:cancelled", (d: any) => {
      c.cancelled.push(d);
      c.state = null;
    });
    c.socket.on("trade:failed", (d: any) => {
      c.failed.push(d);
      c.state = null;
    });
    c.socket.on("auth:error", (e: any) => {
      c.authErrors.push(String(e?.message ?? ""));
    });
  };

  const newClient = async (label: string): Promise<Client> => {
    const socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    const c: Client = {
      label,
      socket,
      userId: 0,
      token: "",
      userKey: "",
      myPlayerId: null,
      state: null,
      results: [],
      chat: [],
      requests: [],
      completed: [],
      cancelled: [],
      failed: [],
      authErrors: []
    };
    let lastSession: any = null;
    socket.on("auth:session", (s: any) => {
      lastSession = s;
    });
    socket.on("myPlayer", (m: any) => {
      c.myPlayerId = m?.playerId ?? null;
    });
    attach(c);

    await waitFor(`${label} connect`, () => socket.connected);

    // Usernames must be letters-only and unique across runs.
    const lettersStamp = Date.now()
      .toString()
      .slice(-8)
      .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
    const uname = `tr${label.toLowerCase()}${lettersStamp}`.slice(0, 14);
    const payload = {
      name: `Trader${label}`,
      username: uname,
      email: `${uname}@example.com`,
      password: "Aa1!aaaa"
    };

    let session: any = null;
    for (let attempt = 0; attempt < 3 && !session; attempt += 1) {
      socket.emit("auth:register", payload);
      try {
        session = await waitFor(
          `${label} register`,
          () => (lastSession?.authenticated && lastSession?.user?.id ? lastSession : null),
          { timeoutMs: 8000 }
        );
      } catch {
        log(`  [${label}] register attempt ${attempt + 1} failed, retrying…`);
      }
    }
    if (!session) fail(`${label} could not register`);

    c.userId = Number(session.user.id);
    c.token = session.token;
    c.userKey = `auth:user:${c.userId}`;
    testUserIds.push(c.userId);
    clients.push(c);
    log(`  [${label}] registered #${c.userId}`);
    return c;
  };

  const seedAndJoin = async (
    c: Client,
    opts: { party: unknown[]; boxes?: unknown[]; inventory: unknown[]; money: number }
  ) => {
    await redis!.hSet(c.userKey, {
      last_map_id: TEST_MAP,
      last_x: String(50 * 32),
      last_y: String(41 * 32),
      pokemon_party: JSON.stringify(opts.party),
      pokemon_box: JSON.stringify({ boxes: opts.boxes ?? [] }),
      inventory: JSON.stringify(opts.inventory),
      money: String(opts.money)
    });
    c.socket.emit("addPlayer", { token: c.token });
    await waitFor(`${c.label} myPlayer`, () => c.myPlayerId);
  };

  /**
   * The auth-session sanitizer prunes bag entries that are not in the designer
   * item catalog, so fixtures must use REAL catalog ids. This picks two
   * tradeable items and one restricted (key/quest) item from the live catalog.
   */
  const pickCatalogItems = async () => {
    const raw = await redis!.get("designer:section:items");
    const items: Array<{ id: string; name: string; itemProfile?: { type?: string; pocket?: string; flags?: string[] } }> =
      raw ? JSON.parse(raw)?.state?.items ?? [] : [];

    const bucket = (profile?: { type?: string }) => {
      switch (String(profile?.type ?? "").toLowerCase()) {
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
    };

    const isKeyItem = (entry: (typeof items)[number]) => {
      const profile = entry.itemProfile ?? {};
      const flags = (profile.flags ?? []).map((f) => f.toLowerCase().replace(/[^a-z]/g, ""));
      return (
        String(profile.type ?? "").toLowerCase() === "quest item" ||
        String(profile.pocket ?? "") === "8" ||
        flags.includes("keyitem")
      );
    };

    const tradeable = items.filter((entry) => !isKeyItem(entry) && bucket(entry.itemProfile) !== "quest");
    const restricted = items.find(isKeyItem);
    // A tradeable item that is NOT one of the three seeded fixtures, so
    // "player does not own it" is the only reason it can be rejected.
    const unowned = tradeable[3];

    if (tradeable.length < 4 || !restricted || !unowned) {
      fail("the designer item catalog does not have enough entries to run this suite");
    }
    return {
      itemP: tradeable[0],
      itemS: tradeable[1],
      itemAnti: tradeable[2],
      restricted,
      unowned
    };
  };

  // --- helpers ------------------------------------------------------------
  const readAccount = async (c: Client) => {
    const [inventory, party, box, money] = await redis!.hmGet(c.userKey, [
      "inventory",
      "pokemon_party",
      "pokemon_box",
      "money"
    ]);
    return {
      inventory: JSON.parse(inventory || "[]") as Array<{ id: string; quantity: number }>,
      party: JSON.parse(party || "[]") as Array<{ id: string }>,
      box: JSON.parse(box || '{"boxes":[]}') as { boxes: Array<{ pokemon: Array<{ id: string }> }> },
      money: Number.parseInt(money || "0", 10)
    };
  };
  const qtyOf = (inv: Array<{ id: string; quantity: number }>, id: string) =>
    inv.find((entry) => entry.id === id)?.quantity ?? 0;
  const ownsMon = (acct: Awaited<ReturnType<typeof readAccount>>, id: string) =>
    acct.party.some((p) => p.id === id) ||
    acct.box.boxes.some((b) => b.pokemon.some((p) => p.id === id));

  let requestSeq = 0;
  const rid = () => `e2e-${(requestSeq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

  /** Emits an action and waits for its `trade:result`. */
  const act = async (c: Client, event: string, payload: Record<string, unknown>) => {
    const before = c.results.length;
    c.socket.emit(event, payload);
    await waitFor(`${c.label} result for ${event}`, () => c.results.length > before, { timeoutMs: 8000 });
    return c.results[c.results.length - 1];
  };

  /** The side key of the OTHER participant, from this client's viewpoint. */
  const otherSideOf = (c: Client) => (c.state?.youAre === "A" ? "B" : "A");

  /** Stamps an action with the client's last-seen version + a fresh key. */
  const envelope = (c: Client, extra: Record<string, unknown> = {}) => ({
    tradeId: c.state?.tradeId ?? "",
    expectedVersion: c.state?.version ?? 0,
    requestId: rid(),
    ...extra
  });

  /** Runs the request/accept handshake and leaves both clients in OPEN. */
  const openTrade = async (a: Client, b: Client) => {
    a.requests = [];
    b.requests = [];
    const result = await act(a, "trade:request", { targetUserId: b.userId });
    if (!result.success) fail(`trade:request rejected: ${result.errorCode} ${result.message}`);
    const request = await waitFor(`${b.label} request received`, () => b.requests[0]);
    await act(b, "trade:request:accept", { tradeId: request.tradeId });
    await waitFor("both OPEN", () => a.state?.state === "OPEN" && b.state?.state === "OPEN");
    return request.tradeId as string;
  };

  /** Locks both sides and waits for FINAL_CONFIRMATION. */
  const lockBoth = async (a: Client, b: Client) => {
    await act(a, "trade:offer:lock", envelope(a));
    await waitFor("A locked", () => a.state?.offers?.[a.state.youAre]?.locked === true);
    await act(b, "trade:offer:lock", envelope(b));
    await waitFor(
      "final confirmation",
      () => a.state?.state === "FINAL_CONFIRMATION" && b.state?.state === "FINAL_CONFIRMATION"
    );
  };

  /** Confirms from both sides and waits for the completion event. */
  const confirmBoth = async (a: Client, b: Client) => {
    // The review countdown must elapse before a confirm is accepted.
    const availableAt = a.state?.confirmAvailableAt ?? 0;
    const waitMs = Math.max(0, availableAt - Date.now()) + 250;
    await sleep(waitMs);
    await act(a, "trade:confirm", envelope(a, { snapshotHash: a.state.snapshotHash }));
    await act(b, "trade:confirm", envelope(b, { snapshotHash: b.state.snapshotHash }));
  };

  try {
    // ---- infrastructure --------------------------------------------------
    const running = (() => {
      try {
        return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]);
      } catch {
        return "";
      }
    })();
    if (running !== REDIS_CONTAINER) {
      try {
        sh("docker", ["start", REDIS_CONTAINER]);
      } catch {
        sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]);
      }
    }
    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    redis.on("error", () => {});
    await waitFor("redis PING", async () => {
      if (!redis!.isOpen) await redis!.connect();
      return (await redis!.ping()) === "PONG";
    });
    log("redis reachable");

    // One env for both the initial boot and the restart-safety respawn, so the
    // restart really is the only variable that changes.
    const serverEnv = {
      ...process.env,
      PORT: String(PORT),
      REDIS_URL,
      SMTP_ENABLED: "false",
      GIT_SHA: "e2e",
      // Deterministic, fast timings for the test run.
      TRADE_CONFIRMATION_DELAY_SECONDS: "1",
      TRADE_REQUEST_TTL_SECONDS: "5",
      // High enough for the whole suite; the burst test below proves the
      // limiter still fires.
      TRADE_REQUEST_RATE_LIMIT: "30",
      TRADE_REQUEST_RATE_WINDOW_SECONDS: "600",
      TRADE_CHAT_RATE_LIMIT: "4",
      TRADE_CHAT_RATE_WINDOW_SECONDS: "5",
      TRADE_CHAT_MAX_LENGTH: "60",
      TRADE_PROXIMITY_SQUARES: "12",
      TRADE_DISCONNECT_GRACE_SECONDS: "30"
    };

    log(`starting server on :${PORT} …`);
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: serverEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverLog = "";
    server.stdout!.on("data", (d) => {
      serverLog += d;
    });
    server.stderr!.on("data", (d) => {
      serverLog += d;
      process.stderr.write(`  [srv!] ${d}`);
    });
    await waitFor("server listening", () => serverLog.includes(`Listening on port ${PORT}`), {
      timeoutMs: 60000
    });
    log("server is up");

    const A = await newClient("A");
    const B = await newClient("B");
    const C = await newClient("C"); // bystander, for authorization tests

    const catalog = await pickCatalogItems();
    const ITEM_P = catalog.itemP.id;
    const ITEM_S = catalog.itemS.id;
    const ITEM_ANTI = catalog.itemAnti.id;
    const ITEM_RESTRICTED = catalog.restricted.id;
    const ITEM_UNOWNED = catalog.unowned.id;
    log(
      `catalog fixtures → tradeable: ${ITEM_P}, ${ITEM_S}, ${ITEM_ANTI}; ` +
        `restricted: ${ITEM_RESTRICTED}; unowned: ${ITEM_UNOWNED}`
    );

    const seedA = () =>
      seedAndJoin(A, {
        party: [mon("a_keep", "pokemon-BULBASAUR"), mon("a_give1", "pokemon-CHARMANDER", 35)],
        boxes: [{ name: "Box 1", pokemon: [mon("a_boxed", "pokemon-SQUIRTLE", 12)] }],
        inventory: [
          item(ITEM_P, catalog.itemP.name, 10),
          item(ITEM_S, catalog.itemS.name, 4),
          item(ITEM_RESTRICTED, catalog.restricted.name, 1, "quest")
        ],
        money: 5000
      });
    const seedB = () =>
      seedAndJoin(B, {
        party: [mon("b_keep", "pokemon-PIDGEY")],
        boxes: [],
        inventory: [item(ITEM_ANTI, catalog.itemAnti.name, 6)],
        money: 800
      });

    await seedA();
    await seedB();
    await seedAndJoin(C, {
      party: [mon("c_keep", "pokemon-RATTATA")],
      boxes: [],
      inventory: [],
      money: 100
    });
    await sleep(600);
    log("seeded A, B and bystander C");

    // =====================================================================
    // F1 — trade one item
    // =====================================================================
    log("── F1: trade a single item stack ──");
    await openTrade(A, B);
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 3 }));
    await lockBoth(A, B);
    await confirmBoth(A, B);
    await waitFor("F1 completed", () => A.completed.length > 0 && B.completed.length > 0);

    let acctA = await readAccount(A);
    let acctB = await readAccount(B);
    if (qtyOf(acctA.inventory, ITEM_P) !== 7)
      fail(`A should have 7 Potions, has ${qtyOf(acctA.inventory, ITEM_P)}`);
    if (qtyOf(acctB.inventory, ITEM_P) !== 3)
      fail(`B should have 3 Potions, has ${qtyOf(acctB.inventory, ITEM_P)}`);
    pass("one item stack moved, quantities exact on both sides");

    // =====================================================================
    // F2 — multiple stacks + multiple Venomons + money in one trade
    // =====================================================================
    log("── F2: multi-asset trade (items + Venomons + money) ──");
    A.completed = [];
    B.completed = [];
    await openTrade(A, B);
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 2 }));
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_S, quantity: 1 }));
    await act(A, "trade:offer:add-venomon", envelope(A, { venomonId: "a_give1" }));
    await act(A, "trade:offer:add-venomon", envelope(A, { venomonId: "a_boxed" }));
    await act(A, "trade:offer:set-currency", envelope(A, { amount: 1500 }));
    await act(B, "trade:offer:add-item", envelope(B, { itemId: ITEM_ANTI, quantity: 2 }));
    await act(B, "trade:offer:set-currency", envelope(B, { amount: 200 }));

    const stateBeforeLock = A.state;
    if (stateBeforeLock.offers.A.venomons.length !== 2) fail("A's offer should list 2 Venomons");
    if (stateBeforeLock.offers.A.items.length !== 2) fail("A's offer should list 2 item stacks");

    await lockBoth(A, B);
    await confirmBoth(A, B);
    await waitFor("F2 completed", () => A.completed.length > 0 && B.completed.length > 0);

    acctA = await readAccount(A);
    acctB = await readAccount(B);
    if (ownsMon(acctA, "a_give1") || ownsMon(acctA, "a_boxed"))
      fail("A still owns a traded Venomon");
    if (!ownsMon(acctB, "a_give1") || !ownsMon(acctB, "a_boxed"))
      fail("B did not receive both Venomons");
    if (!ownsMon(acctA, "a_keep")) fail("A lost a Venomon that was not offered");
    if (qtyOf(acctA.inventory, ITEM_P) !== 5) fail("A's Potion count is wrong");
    if (qtyOf(acctB.inventory, ITEM_P) !== 5) fail("B's Potion count is wrong");
    if (qtyOf(acctB.inventory, ITEM_S) !== 1) fail("B did not receive the Super Potion");
    if (qtyOf(acctA.inventory, ITEM_ANTI) !== 2) fail("A did not receive the Antidotes");
    if (qtyOf(acctB.inventory, ITEM_ANTI) !== 4) fail("B's Antidote count is wrong");
    if (acctA.money !== 5000 - 1500 + 200) fail(`A's money is ${acctA.money}, expected 3700`);
    if (acctB.money !== 800 + 1500 - 200) fail(`B's money is ${acctB.money}, expected 2100`);
    pass("items, Venomons and money all moved atomically and exactly once");

    // No Venomon instance may exist on both accounts.
    const idsA = new Set([
      ...acctA.party.map((p) => p.id),
      ...acctA.box.boxes.flatMap((b) => b.pokemon.map((p) => p.id))
    ]);
    const idsB = [
      ...acctB.party.map((p) => p.id),
      ...acctB.box.boxes.flatMap((b) => b.pokemon.map((p) => p.id))
    ];
    if (idsB.some((id) => idsA.has(id))) fail("a Venomon instance exists on BOTH accounts");
    pass("no Venomon instance is duplicated across accounts");

    // Reset the fixtures for the remaining scenarios.
    await seedA();
    await seedB();
    await sleep(400);

    // =====================================================================
    // F3 — one-sided gift trade
    // =====================================================================
    log("── F3: one-sided gift ──");
    A.completed = [];
    B.completed = [];
    await openTrade(A, B);
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 1 }));
    await lockBoth(A, B);
    const giftWarnings: any[] = A.state.warnings ?? [];
    if (!giftWarnings.some((w) => w.code === "ONE_SIDED"))
      fail("a gift trade should raise the ONE_SIDED warning");
    await confirmBoth(A, B);
    await waitFor("F3 completed", () => A.completed.length > 0);
    pass("gift trade completes and is flagged ONE_SIDED (warned, not blocked)");

    await seedA();
    await seedB();
    await sleep(400);

    // =====================================================================
    // F4 / F5 — cancelling
    // =====================================================================
    log("── F4: cancel during offer selection ──");
    A.cancelled = [];
    B.cancelled = [];
    await openTrade(A, B);
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 2 }));
    await act(A, "trade:cancel", { tradeId: A.state.tradeId, requestId: rid() });
    await waitFor("F4 cancelled", () => A.cancelled.length > 0 && B.cancelled.length > 0);
    acctA = await readAccount(A);
    if (qtyOf(acctA.inventory, ITEM_P) !== 10) fail("cancelling changed A's inventory");
    pass("cancel during selection leaves both accounts untouched");

    log("── F5: cancel after locking ──");
    A.cancelled = [];
    B.cancelled = [];
    await openTrade(A, B);
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 2 }));
    await act(A, "trade:offer:lock", envelope(A));
    await waitFor("A locked", () => A.state?.offers?.A?.locked === true);
    await act(B, "trade:cancel", { tradeId: B.state.tradeId, requestId: rid() });
    await waitFor("F5 cancelled", () => A.cancelled.length > 0 && B.cancelled.length > 0);
    acctA = await readAccount(A);
    if (qtyOf(acctA.inventory, ITEM_P) !== 10) fail("cancel-after-lock changed A's inventory");
    pass("cancel after locking leaves both accounts untouched");

    // =====================================================================
    // F6 — decline / F7 — expire
    // =====================================================================
    log("── F6: decline a trade request ──");
    B.requests = [];
    await act(A, "trade:request", { targetUserId: B.userId });
    const declineTarget = await waitFor("request received", () => B.requests[0]);
    await act(B, "trade:request:decline", { tradeId: declineTarget.tradeId });
    await sleep(300);
    if (A.state !== null && A.state?.state === "OPEN") fail("declined request opened a trade anyway");
    pass("declined request never opens a session");

    log("── F7: expire a trade request (TTL 5s) ──");
    B.requests = [];
    await act(A, "trade:request", { targetUserId: B.userId });
    await waitFor("request received", () => B.requests.length > 0);
    await waitFor("request expired", () => B.requests.length === 0, { timeoutMs: 12000 });
    pass("pending request expires on its own and frees both players");

    // =====================================================================
    // S12 — a non-participant cannot act
    // =====================================================================
    log("── S12: bystander cannot act on someone else's trade ──");
    const tradeId = await openTrade(A, B);
    let result = await act(C, "trade:offer:add-item", {
      tradeId,
      expectedVersion: A.state.version,
      requestId: rid(),
      itemId: ITEM_P,
      quantity: 1
    });
    if (result.success || result.errorCode !== "NOT_A_PARTICIPANT")
      fail(`bystander action should be NOT_A_PARTICIPANT, got ${result.errorCode}`);
    pass("a third player is rejected with NOT_A_PARTICIPANT");

    // C1 — bystander chat
    log("── C1: bystander cannot use the trade chat ──");
    const bystanderChatBefore = C.chat.length;
    result = await act(C, "trade:chat:send", { tradeId, text: "let me in", requestId: rid() });
    if (result.success) fail("bystander was allowed to post in trade chat");
    await sleep(300);
    if (C.chat.length !== bystanderChatBefore) fail("bystander received trade chat traffic");
    pass("trade chat is closed to non-participants (no read, no write)");

    // =====================================================================
    // S4 / S5 / S14 — item ownership + restrictions
    // =====================================================================
    log("── S4: offering an item the player does not own ──");
    result = await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_UNOWNED, quantity: 1 }));
    if (result.success || result.errorCode !== "ITEM_NOT_OWNED")
      fail(`expected ITEM_NOT_OWNED, got ${result.errorCode}`);
    pass("unowned item rejected (ITEM_NOT_OWNED)");

    log("── S5: offering more than the player owns ──");
    result = await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 999 }));
    if (result.success || result.errorCode !== "ITEM_QUANTITY_CHANGED")
      fail(`expected ITEM_QUANTITY_CHANGED, got ${result.errorCode}`);
    pass("over-quantity rejected (ITEM_QUANTITY_CHANGED)");

    log("── S14: restricted (quest/key) item cannot be traded ──");
    result = await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_RESTRICTED, quantity: 1 }));
    if (result.success || result.errorCode !== "ITEM_RESTRICTED")
      fail(`expected ITEM_RESTRICTED, got ${result.errorCode}`);
    pass("quest/key item rejected (ITEM_RESTRICTED)");

    // =====================================================================
    // S6 — the same Venomon twice / S13 — last usable Venomon
    // =====================================================================
    log("── S6: offering the same Venomon twice ──");
    await act(A, "trade:offer:add-venomon", envelope(A, { venomonId: "a_give1" }));
    result = await act(A, "trade:offer:add-venomon", envelope(A, { venomonId: "a_give1" }));
    if (result.success || result.errorCode !== "VENOMON_DUPLICATE")
      fail(`expected VENOMON_DUPLICATE, got ${result.errorCode}`);
    pass("duplicate Venomon rejected (VENOMON_DUPLICATE)");

    log("── S13: cannot trade away the last usable Venomon ──");
    result = await act(B, "trade:offer:add-venomon", envelope(B, { venomonId: "b_keep" }));
    if (result.success || result.errorCode !== "VENOMON_LAST_ONE")
      fail(`expected VENOMON_LAST_ONE, got ${result.errorCode}`);
    pass("last usable Venomon protected (VENOMON_LAST_ONE)");

    // =====================================================================
    // S7 / S8 — currency validation
    // =====================================================================
    log("── S7: malformed currency values ──");
    for (const [label, amount] of [
      ["negative", -100],
      ["decimal", 10.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["overflow", Number.MAX_SAFE_INTEGER + 10]
    ] as Array<[string, number]>) {
      result = await act(A, "trade:offer:set-currency", envelope(A, { amount }));
      if (result.success) fail(`${label} currency (${amount}) was accepted`);
      log(`    ${label} → ${result.errorCode}`);
    }
    pass("negative / decimal / NaN / Infinity / overflow currency all rejected");

    log("── S8: currency above the player's balance ──");
    result = await act(B, "trade:offer:set-currency", envelope(B, { amount: 999_999 }));
    if (result.success || !["CURRENCY_INSUFFICIENT", "CURRENCY_LIMIT"].includes(result.errorCode))
      fail(`expected CURRENCY_INSUFFICIENT, got ${result.errorCode}`);
    pass("over-balance currency rejected");

    // =====================================================================
    // S11 — reserved assets cannot be mutated by other systems
    // =====================================================================
    log("── S11: an asset reserved by the trade cannot be mutated elsewhere ──");
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 2 }));
    A.authErrors = [];
    A.socket.emit("inventory:throw-away", { itemId: ITEM_P, quantity: 1 });
    await waitFor("throw-away refused", () => A.authErrors.length > 0, { timeoutMs: 6000 });
    acctA = await readAccount(A);
    if (qtyOf(acctA.inventory, ITEM_P) !== 10)
      fail("a reserved item stack was mutated by inventory:throw-away");
    pass("inventory:throw-away refused for a reserved stack, inventory unchanged");

    A.authErrors = [];
    A.socket.emit("pokemon:box-deposit", { pokemonId: "a_give1" });
    await waitFor("deposit refused", () => A.authErrors.length > 0, { timeoutMs: 6000 });
    acctA = await readAccount(A);
    if (!acctA.party.some((p) => p.id === "a_give1"))
      fail("a reserved Venomon was moved by pokemon:box-deposit");
    pass("pokemon:box-deposit refused for a reserved Venomon, party unchanged");

    A.authErrors = [];
    A.socket.emit("npc:store-buy", { npcPlacementId: "nope", itemId: ITEM_P, quantity: 1 });
    await waitFor("store-buy refused", () => A.authErrors.length > 0, { timeoutMs: 6000 });
    pass("npc:store-buy refused while money is reserved by the trade");

    // =====================================================================
    // S1 — a late change clears both locks
    // =====================================================================
    log("── S1: modifying an offer after the other player locks ──");
    await act(B, "trade:offer:add-item", envelope(B, { itemId: ITEM_ANTI, quantity: 1 }));
    await act(B, "trade:offer:lock", envelope(B));
    await waitFor("B locked", () => A.state?.offers?.B?.locked === true);
    const versionBeforeChange = A.state.version;

    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_S, quantity: 1 }));
    await waitFor("locks cleared", () => A.state?.offers?.B?.locked === false);
    if (A.state.offers.A.locked) fail("A's own lock survived their change");
    if (A.state.version <= versionBeforeChange) fail("the trade version did not increment");
    if (A.state.state !== "OPEN") fail(`state should return to OPEN, is ${A.state.state}`);
    pass("any offer change clears both locks, bumps the version and reopens the trade");

    // =====================================================================
    // S2 — stale version rejected
    // =====================================================================
    log("── S2: stale trade version ──");
    result = await act(A, "trade:offer:add-item", {
      tradeId: A.state.tradeId,
      expectedVersion: versionBeforeChange, // deliberately old
      requestId: rid(),
      itemId: ITEM_P,
      quantity: 1
    });
    if (result.success || result.errorCode !== "STALE_VERSION")
      fail(`expected STALE_VERSION, got ${result.errorCode}`);
    pass("stale version rejected (STALE_VERSION)");

    // =====================================================================
    // S10 — replayed idempotency key dropped
    // =====================================================================
    log("── S10: replaying a socket action with the same idempotency key ──");
    const replayId = rid();
    const first = await act(A, "trade:offer:set-currency", {
      tradeId: A.state.tradeId,
      expectedVersion: A.state.version,
      requestId: replayId,
      amount: 100
    });
    if (!first.success) fail(`first set-currency failed: ${first.errorCode}`);
    const replayed = await act(A, "trade:offer:set-currency", {
      tradeId: A.state.tradeId,
      expectedVersion: A.state.version,
      requestId: replayId, // same key
      amount: 400
    });
    if (replayed.success) fail("a replayed action with a reused request id was applied");
    if (A.state.offers.A.currency !== 100)
      fail(`the replay changed the offer (currency=${A.state.offers.A.currency})`);
    pass("replayed action dropped, offer unchanged");

    // =====================================================================
    // S3 — outdated snapshot hash rejected
    // =====================================================================
    log("── S3: confirming an outdated snapshot ──");
    await lockBoth(A, B);
    const staleHash = A.state.snapshotHash;
    const staleVersion = A.state.version;

    // Unlock + relock produces a *different* snapshot; the old hash must die.
    await act(A, "trade:offer:unlock", envelope(A));
    await waitFor("reopened", () => A.state?.state === "OPEN");
    await lockBoth(A, B);
    if (A.state.snapshotHash === staleHash && A.state.version === staleVersion)
      fail("the snapshot did not change after unlock/relock");

    await sleep(Math.max(0, (A.state.confirmAvailableAt ?? 0) - Date.now()) + 250);
    result = await act(A, "trade:confirm", {
      tradeId: A.state.tradeId,
      expectedVersion: A.state.version,
      requestId: rid(),
      snapshotHash: staleHash // the pre-unlock hash
    });
    if (result.success || result.errorCode !== "SNAPSHOT_MISMATCH")
      fail(`expected SNAPSHOT_MISMATCH, got ${result.errorCode}`);
    pass("confirming an outdated snapshot is rejected (SNAPSHOT_MISMATCH)");

    // =====================================================================
    // Confirmation delay is enforced
    // =====================================================================
    log("── confirmation delay ──");
    await act(A, "trade:offer:unlock", envelope(A));
    await waitFor("reopened", () => A.state?.state === "OPEN");
    await lockBoth(A, B);
    result = await act(A, "trade:confirm", envelope(A, { snapshotHash: A.state.snapshotHash }));
    if (result.success || result.errorCode !== "CONFIRMATION_TOO_SOON")
      fail(`expected CONFIRMATION_TOO_SOON, got ${result.errorCode}`);
    pass("confirming before the review countdown is rejected (CONFIRMATION_TOO_SOON)");

    // =====================================================================
    // CHAT
    // =====================================================================
    log("── C2/C3/C4: empty, oversized and HTML chat payloads ──");
    result = await act(A, "trade:chat:send", { tradeId: A.state.tradeId, text: "   ", requestId: rid() });
    if (result.success || result.errorCode !== "CHAT_EMPTY")
      fail(`expected CHAT_EMPTY, got ${result.errorCode}`);
    pass("empty message rejected (CHAT_EMPTY)");

    result = await act(A, "trade:chat:send", {
      tradeId: A.state.tradeId,
      text: "x".repeat(5000),
      requestId: rid()
    });
    if (result.success || result.errorCode !== "CHAT_TOO_LONG")
      fail(`expected CHAT_TOO_LONG, got ${result.errorCode}`);
    pass("oversized message rejected (CHAT_TOO_LONG)");

    B.chat = [];
    await act(A, "trade:chat:send", {
      tradeId: A.state.tradeId,
      text: `<script>alert(1)</script>`,
      requestId: rid()
    });
    const injected = await waitFor(
      "injected message delivered",
      () => B.chat.find((m) => m.messageType === "player" && m.text.includes("script"))
    );
    if (injected.text.includes("<") || injected.text.includes(">"))
      fail(`chat text was not escaped: ${injected.text}`);
    pass("HTML/script payload escaped before delivery");

    log("── C7: a client cannot forge a system message ──");
    B.chat = [];
    await act(A, "trade:chat:send", {
      tradeId: A.state.tradeId,
      text: "Trade completed.",
      requestId: rid(),
      // A hostile client trying to pass itself off as the server.
      messageType: "system",
      senderUserId: undefined
    } as Record<string, unknown>);
    const forged = await waitFor("forged message delivered", () =>
      B.chat.find((m) => m.text.includes("Trade completed"))
    );
    if (forged.messageType !== "player") fail("a client-supplied messageType was honoured");
    if (forged.senderUserId !== A.userId) fail("the message was not attributed to its real sender");
    pass("client-supplied messageType ignored; message attributed to the real sender");

    log("── C5: chat rate limit ──");
    let rateLimited = false;
    for (let i = 0; i < 8; i += 1) {
      const r = await act(A, "trade:chat:send", {
        tradeId: A.state.tradeId,
        text: `spam ${i}`,
        requestId: rid()
      });
      if (!r.success && r.errorCode === "CHAT_RATE_LIMITED") {
        rateLimited = true;
        break;
      }
    }
    if (!rateLimited) fail("the chat rate limit never triggered");
    pass("chat rate limit enforced (CHAT_RATE_LIMITED)");

    // =====================================================================
    // S9 — duplicate completion requests
    // =====================================================================
    log("── S9: duplicate completion requests cannot duplicate assets ──");
    await act(A, "trade:offer:unlock", envelope(A));
    await waitFor("reopened", () => A.state?.state === "OPEN");

    // Build a known-value trade: A gives 2 Potions, B gives 300 money.
    for (const entry of A.state.offers.A.items) {
      await act(A, "trade:offer:remove-item", envelope(A, { itemId: entry.itemDefinitionId }));
    }
    for (const entry of A.state.offers.A.venomons) {
      await act(A, "trade:offer:remove-venomon", envelope(A, { venomonId: entry.venomonInstanceId }));
    }
    await act(A, "trade:offer:set-currency", envelope(A, { amount: 0 }));
    for (const entry of B.state.offers.B.items) {
      await act(B, "trade:offer:remove-item", envelope(B, { itemId: entry.itemDefinitionId }));
    }
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 2 }));
    await act(B, "trade:offer:set-currency", envelope(B, { amount: 300 }));

    const moneyABefore = (await readAccount(A)).money;
    const moneyBBefore = (await readAccount(B)).money;
    const potionsABefore = qtyOf((await readAccount(A)).inventory, ITEM_P);
    const potionsBBefore = qtyOf((await readAccount(B)).inventory, ITEM_P);

    A.completed = [];
    B.completed = [];
    await lockBoth(A, B);
    const finalHash = A.state.snapshotHash;
    const finalVersion = A.state.version;
    const finalTradeId = A.state.tradeId;
    await sleep(Math.max(0, (A.state.confirmAvailableAt ?? 0) - Date.now()) + 250);

    await act(A, "trade:confirm", {
      tradeId: finalTradeId,
      expectedVersion: finalVersion,
      requestId: rid(),
      snapshotHash: finalHash
    });
    await act(B, "trade:confirm", {
      tradeId: finalTradeId,
      expectedVersion: finalVersion,
      requestId: rid(),
      snapshotHash: finalHash
    });
    await waitFor("S9 completed", () => A.completed.length > 0 && B.completed.length > 0);

    // Fire the completion again from both sides, several times.
    for (let i = 0; i < 4; i += 1) {
      A.socket.emit("trade:confirm", {
        tradeId: finalTradeId,
        expectedVersion: finalVersion,
        requestId: rid(),
        snapshotHash: finalHash
      });
      B.socket.emit("trade:confirm", {
        tradeId: finalTradeId,
        expectedVersion: finalVersion,
        requestId: rid(),
        snapshotHash: finalHash
      });
    }
    await sleep(1500);

    acctA = await readAccount(A);
    acctB = await readAccount(B);
    if (qtyOf(acctA.inventory, ITEM_P) !== potionsABefore - 2)
      fail(`A's Potions moved more than once (${qtyOf(acctA.inventory, ITEM_P)})`);
    if (qtyOf(acctB.inventory, ITEM_P) !== potionsBBefore + 2)
      fail(`B's Potions moved more than once (${qtyOf(acctB.inventory, ITEM_P)})`);
    if (acctA.money !== moneyABefore + 300) fail(`A's money moved twice (${acctA.money})`);
    if (acctB.money !== moneyBBefore - 300) fail(`B's money moved twice (${acctB.money})`);
    pass("repeated completion requests applied the exchange exactly once");

    // C6 — chat after the trade closed
    log("── C6: chat after the trade closes ──");
    result = await act(A, "trade:chat:send", {
      tradeId: finalTradeId,
      text: "still there?",
      requestId: rid()
    });
    if (result.success || result.errorCode !== "CHAT_CLOSED")
      fail(`expected CHAT_CLOSED, got ${result.errorCode}`);
    pass("messages after the trade closes are rejected (CHAT_CLOSED)");

    // =====================================================================
    // Audit + history
    // =====================================================================
    log("── audit record + player-facing history ──");
    const auditRaw = await redis!.get(`trade:audit:${finalTradeId}`);
    if (!auditRaw) fail("no audit record was written for the completed trade");
    const audit = JSON.parse(auditRaw);
    if (audit.result !== "COMPLETED") fail(`audit result is ${audit.result}`);
    if (audit.snapshotHash !== finalHash) fail("audit snapshot hash does not match the confirmed one");
    if (!audit.finalSnapshot?.offers?.A) fail("audit record has no final snapshot");
    if (!audit.securityMetadata) fail("audit record has no security metadata");
    pass("permanent audit record written with the confirmed snapshot + hash");

    const historyPage: any = await new Promise((resolve) => {
      A.socket.once("trade:history", resolve);
      A.socket.emit("trade:history", { page: 1, pageSize: 10 });
    });
    if (!Array.isArray(historyPage.entries) || historyPage.entries.length === 0)
      fail("player trade history is empty after a completed trade");
    const historyEntry = historyPage.entries[0];
    if (!historyEntry.partnerUsername) fail("history entry has no partner name");
    if (JSON.stringify(historyEntry).includes("securityMetadata"))
      fail("player-facing history leaked security metadata");
    if (JSON.stringify(historyEntry).includes("ipPrefixes"))
      fail("player-facing history leaked IP data");
    pass("player history lists the trade and exposes no security metadata");

    // =====================================================================
    // F8 — reconnect to an active trade
    // =====================================================================
    log("── F8: reconnect to an active trade ──");
    await openTrade(A, B);
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 1 }));
    const liveTradeId = A.state.tradeId;
    const liveVersion = A.state.version;

    // A second socket for the same account resyncs from the server alone.
    const A2 = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    let a2State: any = null;
    const a2Chat: any[] = [];
    let a2My: string | null = null;
    A2.on("trade:state", (s: any) => {
      a2State = s;
    });
    A2.on("trade:chat:message", (m: any) => a2Chat.push(m));
    A2.on("myPlayer", (m: any) => {
      a2My = m?.playerId ?? null;
    });
    await waitFor("A2 connect", () => A2.connected);
    A2.emit("addPlayer", { token: A.token });
    await waitFor("A2 myPlayer", () => a2My);
    A2.emit("trade:sync", {});
    await waitFor("A2 synced", () => a2State?.tradeId === liveTradeId, { timeoutMs: 8000 });
    if (a2State.version !== liveVersion) fail("the resynced state carried a different version");
    if (a2State.offers[a2State.youAre].items.length !== 1)
      fail("the resynced state lost the offer contents");
    await waitFor("A2 chat replayed", () => a2Chat.length > 0, { timeoutMs: 5000 });
    A2.disconnect();
    pass("trade:sync rebuilds the complete authoritative state and replays chat");

    await act(A, "trade:cancel", { tradeId: liveTradeId, requestId: rid() });
    await sleep(300);

    // =====================================================================
    // Request spam: duplicate + rate limit
    // =====================================================================
    log("── request spam: duplicate outgoing request, then the rate limit ──");
    const firstSpam = await act(C, "trade:request", { targetUserId: A.userId });
    if (!firstSpam.success) fail(`C's first request failed: ${firstSpam.errorCode}`);
    const dupe = await act(C, "trade:request", { targetUserId: A.userId });
    if (dupe.success || dupe.errorCode !== "DUPLICATE_REQUEST")
      fail(`expected DUPLICATE_REQUEST, got ${dupe.errorCode}`);
    pass("a second pending request from the same player is refused (DUPLICATE_REQUEST)");

    let sawRateLimit = false;
    for (let i = 0; i < 40 && !sawRateLimit; i += 1) {
      const r = await act(C, "trade:request", { targetUserId: A.userId });
      if (!r.success && r.errorCode === "RATE_LIMITED") sawRateLimit = true;
    }
    if (!sawRateLimit) fail("the trade-request rate limit never triggered");
    pass("trade-request rate limit enforced (RATE_LIMITED)");

    // Clear C's pending request so it cannot interfere with the restart test.
    A.requests = [];
    await sleep(200);

    // =====================================================================
    // Disconnect during FINAL_CONFIRMATION, then reconnect
    // =====================================================================
    log("── disconnect during final confirmation ──");
    await openTrade(A, B);
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 1 }));
    await lockBoth(A, B);
    const dcTradeId = A.state.tradeId;
    const dcAccountA = await readAccount(A);
    const dcAccountB = await readAccount(B);

    B.socket.disconnect();
    await waitFor("A sees the disconnect", () => A.state?.disconnected?.[otherSideOf(A)] === true, {
      timeoutMs: 10000
    });

    await sleep(Math.max(0, (A.state.confirmAvailableAt ?? 0) - Date.now()) + 250);
    result = await act(A, "trade:confirm", envelope(A, { snapshotHash: A.state.snapshotHash }));
    if (result.success || result.errorCode !== "PARTICIPANT_DISCONNECTED")
      fail(`expected PARTICIPANT_DISCONNECTED, got ${result.errorCode}`);
    if (JSON.stringify(await readAccount(A)) !== JSON.stringify(dcAccountA))
      fail("A's account changed while the partner was away");
    if (JSON.stringify(await readAccount(B)) !== JSON.stringify(dcAccountB))
      fail("B's account changed while B was away");
    pass("confirming while the partner is disconnected is refused, nothing exchanged");

    // Reconnect B on a fresh socket and resync from the server alone.
    B.socket.removeAllListeners();
    B.socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    B.myPlayerId = null;
    B.state = null;
    B.socket.on("myPlayer", (m: any) => {
      B.myPlayerId = m?.playerId ?? null;
    });
    attach(B);
    await waitFor("B reconnect", () => B.socket.connected);
    B.socket.emit("addPlayer", { token: B.token });
    await waitFor("B rejoined", () => B.myPlayerId);
    await act(B, "trade:sync", { tradeId: dcTradeId });
    await waitFor("B resynced", () => B.state?.tradeId === dcTradeId, { timeoutMs: 8000 });
    await waitFor("A sees the reconnect", () => A.state?.disconnected?.[otherSideOf(A)] === false, {
      timeoutMs: 10000
    });
    pass("reconnecting restores the same trade session for both players");

    await act(A, "trade:cancel", { tradeId: dcTradeId, requestId: rid() });
    await sleep(300);

    // =====================================================================
    // Server restart must not complete an unfinished trade
    // =====================================================================
    log("── restart safety: an in-flight trade cannot complete across a restart ──");
    await openTrade(A, B);
    await act(A, "trade:offer:add-item", envelope(A, { itemId: ITEM_P, quantity: 1 }));
    await lockBoth(A, B);
    const orphanTradeId = A.state.tradeId;

    const beforeRestart = await readAccount(A);
    const activeClaim = await redis!.get(`trade:active:user:${A.userId}`);
    if (activeClaim !== orphanTradeId) fail("the one-trade-per-player claim was not held in Redis");

    server.kill("SIGKILL");
    await sleep(1200);

    serverLog = "";
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: serverEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout!.on("data", (d) => {
      serverLog += d;
    });
    server.stderr!.on("data", (d) => {
      serverLog += d;
    });
    await waitFor("server restarted", () => serverLog.includes(`Listening on port ${PORT}`), {
      timeoutMs: 60000
    });

    const afterRestart = await readAccount(A);
    if (JSON.stringify(beforeRestart) !== JSON.stringify(afterRestart))
      fail("a restart changed a trading account's state");
    if (await redis!.get(`trade:completed:${orphanTradeId}`))
      fail("the restart marked an unfinished trade as completed");
    if (await redis!.get(`trade:active:user:${A.userId}`))
      fail("the restart left an orphaned one-trade-per-player claim");
    const mirrored = await redis!.get(`trade:session:${orphanTradeId}`);
    if (mirrored && JSON.parse(mirrored).state !== "FAILED")
      fail(`the orphaned session should be FAILED, is ${JSON.parse(mirrored).state}`);
    pass("restart recovery released claims, failed the orphan and exchanged nothing");

    log(`\n✅ ALL TRADE ASSERTIONS PASSED (${passed} checks)`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error?.message ?? error}`);
  process.exitCode = 1;
});
