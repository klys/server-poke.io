/**
 * E2E: account/character split against a REAL server + REAL redis.
 *
 * Live socket clients register, migrate, create/select/delete characters,
 * move currency through the shared account box, and exercise the account-
 * level friends/block system. Every assertion reads the authoritative Redis
 * state (auth:user:{id} account hashes + auth:character:{id} hashes), not
 * socket payloads, unless the payload itself is the thing under test.
 *
 * MIGRATION
 *   M1  legacy single-hash account splits into account + default character on first read
 *   M2  legacy pc_money becomes a shared deposit owned by the default character
 *   M3  legacy box venomons get stamped with the default character as owner
 *
 * CHARACTERS
 *   K1  register creates account + first character; session exposes both identities
 *   K2  character:create adds a character (and rejects bad names)
 *   K3  character:select switches the session; gameplay state is fresh + independent
 *   K4  each character has an independent currency balance
 *   K5  character:delete soft-deletes (not active, not last); restore works
 *   K6  a deleted character cannot be selected
 *
 * SHARED CURRENCY (account box)
 *   C1  deposit subtracts from the depositing character and records it as owner
 *   C2  a character always withdraws its OWN deposit regardless of medals
 *   C3  withdrawing a sibling's deposit is denied below the medal requirement
 *   C4  with enough medals the withdrawal succeeds and transfers only that amount
 *   C5  partial withdrawal leaves the remainder owned by the original character
 *   C6  zero/negative amounts and over-balance withdrawals are rejected
 *
 * SHARED BOX ASSETS
 *   B1  a deposited venomon is stamped with the owning character
 *   B2  a sibling character without medals cannot withdraw it
 *   B3  with medals the withdrawal succeeds and strips the ownership stamp
 *
 * FRIENDS & BLOCKS (account-level)
 *   F1  friendship is created between accounts and survives a character switch
 *   F2  creating a new character does not duplicate the friendship
 *   F3  an account cannot friend itself; duplicate requests are rejected
 *   F4  blocking severs the friendship and hides the account from requests
 *   F5  a blocked account cannot whisper or open a trade with any character
 *   F6  unblocking restores normal interaction
 *   F7  public identity payloads carry account AND character names (no email)
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-account-character.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3996;
const TEST_MAP = "map-essentials-043";

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
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

function mon(id: string, level = 12) {
  return {
    id,
    sourcePokemonId: id,
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
    statBonuses: {}
  };
}

interface Client {
  label: string;
  socket: Socket;
  userId: number;
  token: string;
  userKey: string;
  characterId: number;
  myPlayerId: string | null;
  session: any;
  authErrors: string[];
  authInfos: string[];
  characterErrors: string[];
  characterChanges: any[];
  friendsState: any;
  friendsErrors: string[];
  chatMessages: any[];
  chatErrors: string[];
  tradeResults: any[];
  addPlayerPayloads: any[];
}

const charKeyOf = (characterId: number) => `auth:character:${characterId}`;

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  let restorePinnedSettings: (() => Promise<void>) | null = null;
  const clients: Client[] = [];
  const keysToClean = new Set<string>();

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
      try {
        await restorePinnedSettings?.();
      } catch {
        /* best effort */
      }
      for (const key of keysToClean) {
        try {
          await redis.del(key);
        } catch {
          /* best effort */
        }
      }
      await redis.quit();
    }
  };

  const newClient = async (label: string): Promise<Client> => {
    const socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    const c: Client = {
      label,
      socket,
      userId: 0,
      token: "",
      userKey: "",
      characterId: 0,
      myPlayerId: null,
      session: null,
      authErrors: [],
      authInfos: [],
      characterErrors: [],
      characterChanges: [],
      friendsState: null,
      friendsErrors: [],
      chatMessages: [],
      chatErrors: [],
      tradeResults: [],
      addPlayerPayloads: []
    };
    socket.on("auth:session", (s: any) => {
      c.session = s;
      if (s?.user?.characterId) c.characterId = Number(s.user.characterId);
    });
    socket.on("myPlayer", (m: any) => {
      c.myPlayerId = m?.playerId ?? null;
    });
    socket.on("auth:error", (e: any) => c.authErrors.push(String(e?.message ?? "")));
    socket.on("auth:info", (e: any) => c.authInfos.push(String(e?.message ?? "")));
    socket.on("character:error", (e: any) => c.characterErrors.push(String(e?.message ?? "")));
    socket.on("character:changed", (e: any) => c.characterChanges.push(e));
    socket.on("friends:state", (s: any) => {
      c.friendsState = s;
    });
    socket.on("friends:error", (e: any) => c.friendsErrors.push(String(e?.message ?? "")));
    socket.on("chat:message", (m: any) => c.chatMessages.push(m));
    socket.on("chat:error", (e: any) => c.chatErrors.push(String(e?.message ?? "")));
    socket.on("trade:result", (r: any) => c.tradeResults.push(r));
    socket.on("addPlayer", (p: any) => c.addPlayerPayloads.push(p));

    await waitFor(`${label} connect`, () => socket.connected);

    const lettersStamp = Date.now()
      .toString()
      .slice(-8)
      .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
    const uname = `ac${label.toLowerCase()}${lettersStamp}`.slice(0, 14);
    socket.emit("auth:register", {
      name: `Char${label}`,
      username: uname,
      email: `${uname}@example.com`,
      password: "Aa1!aaaa"
    });
    const session = await waitFor(
      `${label} register`,
      () => (c.session?.authenticated && c.session?.user?.id ? c.session : null),
      { timeoutMs: 8000 }
    );
    c.userId = Number(session.user.id);
    c.token = session.token;
    c.userKey = `auth:user:${c.userId}`;
    c.characterId = Number(session.user.characterId);
    keysToClean.add(c.userKey);
    keysToClean.add(charKeyOf(c.characterId));
    keysToClean.add(`auth:index:username:${uname}`);
    keysToClean.add(`auth:index:email:${uname}@example.com`);
    clients.push(c);
    log(`  [${label}] registered account #${c.userId}, character #${c.characterId} (@${uname})`);
    return c;
  };

  const join = async (c: Client) => {
    c.myPlayerId = null;
    await redis!.hSet(charKeyOf(c.characterId), {
      last_map_id: TEST_MAP,
      last_x: String(50 * 32),
      last_y: String(41 * 32)
    });
    c.socket.emit("addPlayer", { token: c.token });
    await waitFor(`${c.label} myPlayer`, () => c.myPlayerId);
  };

  const waitSessionCharacter = (c: Client, characterId: number) =>
    waitFor(
      `${c.label} session on character ${characterId}`,
      () => (Number(c.session?.user?.characterId) === characterId ? c.session : null)
    );

  const readDeposits = async (accountId: number) => {
    const raw = await redis!.hGet(`auth:user:${accountId}`, "pc_money_deposits");
    return (raw ? JSON.parse(raw) : []) as Array<{
      ownerCharacterId: number;
      amount: number;
      depositedByCharacterId: number;
    }>;
  };
  const readMoney = async (characterId: number) =>
    Number.parseInt((await redis!.hGet(charKeyOf(characterId), "money")) ?? "0", 10);

  try {
    // ---- infrastructure ---------------------------------------------------
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

    // The medal gate is admin-tunable (settings:global) — pin it to 1 for
    // this run and restore whatever the operator had configured afterwards.
    const previousGlobalSettings = await redis.get("settings:global");
    const pinnedSettings = { ...(previousGlobalSettings ? JSON.parse(previousGlobalSettings) : {}) };
    pinnedSettings.crossCharacterStorageMinMedals = 1;
    await redis.set("settings:global", JSON.stringify(pinnedSettings));
    restorePinnedSettings = async () => {
      if (previousGlobalSettings === null) {
        await redis!.del("settings:global");
      } else {
        await redis!.set("settings:global", previousGlobalSettings);
      }
    };

    log(`starting server on :${PORT} …`);
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(PORT),
        REDIS_URL,
        SMTP_ENABLED: "false",
        GIT_SHA: "e2e",
        CROSS_CHARACTER_STORAGE_MIN_MEDALS: "1",
        TRADE_PROXIMITY_SQUARES: "12"
      },
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

    // =======================================================================
    log("── MIGRATION ──");
    // Build a pre-split account by hand: gameplay fields directly on the
    // account hash, no `characters` field — exactly what production data
    // looked like before the schema bump.
    const A = await newClient("A");
    const firstCharId = A.characterId;
    const legacyId = Number(await redis.incr("auth:user:id:sequence"));
    const legacyKey = `auth:user:${legacyId}`;
    const legacyUsername = `legacy${legacyId}`;
    keysToClean.add(legacyKey);
    keysToClean.add(charKeyOf(legacyId));
    keysToClean.add(`auth:index:username:${legacyUsername}`);
    await redis.hSet(legacyKey, {
      id: String(legacyId),
      name: "Legacy",
      username: legacyUsername,
      email: `${legacyUsername}@example.com`,
      password_hash: "00",
      password_salt: "00",
      email_verified: "0",
      role: "user",
      created_at: new Date().toISOString(),
      money: "4321",
      pc_money: "999",
      inventory: "[]",
      pokemon_party: JSON.stringify([mon("legacy-party-mon")]),
      pokemon_box: JSON.stringify({ boxes: [{ name: "Box 1", pokemon: [mon("legacy-box-mon")] }] }),
      badges: "[0,1]",
      last_map_id: TEST_MAP,
      last_x: "100",
      last_y: "100",
      friends: JSON.stringify([legacyId, 424242, 424242])
    });
    await redis.set(`auth:index:username:${legacyUsername}`, String(legacyId));
    // Lazy migration fires on the first server-side read of the account. A
    // friend request by username is such a read (findSocialUserByUsername →
    // getSocialUserSummary → getActiveCharacterId → ensureAccountMigrated).
    await join(A);
    A.socket.emit("friends:request", { username: legacyUsername });
    await waitFor(
      "legacy account migrated",
      async () => Boolean(await redis!.hGet(legacyKey, "characters"))
    );

    const legacyAccount = await redis.hGetAll(legacyKey);
    const legacyChar = await redis.hGetAll(charKeyOf(legacyId));
    if (!legacyAccount.characters) fail("legacy account did not gain a characters list");
    if (JSON.parse(legacyAccount.characters)[0] !== legacyId) fail("default character should reuse the account id");
    if (legacyChar.money !== "4321") fail(`character money not moved (got ${legacyChar.money})`);
    if (legacyChar.badges !== "[0,1]") fail("badges not moved to the character");
    if (typeof legacyAccount.money === "string") fail("account hash still holds money");
    if (typeof legacyAccount.pokemon_party === "string") fail("account hash still holds pokemon_party");
    pass("M1 legacy account split into account + default character (same id)");

    const legacyDeposits = await readDeposits(legacyId);
    if (legacyDeposits.length !== 1 || legacyDeposits[0].amount !== 999) {
      fail(`pc_money not converted to a deposit: ${JSON.stringify(legacyDeposits)}`);
    }
    if (legacyDeposits[0].ownerCharacterId !== legacyId) fail("deposit owner should be the default character");
    if (typeof legacyAccount.pc_money === "string") fail("legacy pc_money field should be gone");
    pass("M2 legacy pc_money became a shared deposit owned by the default character");

    const legacyBox = JSON.parse(legacyAccount.pokemon_box ?? "{}");
    const boxMon = legacyBox?.boxes?.[0]?.pokemon?.[0];
    if (boxMon?.ownerCharacterId !== legacyId || boxMon?.storedByCharacterId !== legacyId) {
      fail(`box venomon not stamped: ${JSON.stringify(boxMon)}`);
    }
    const migratedFriends = JSON.parse(legacyAccount.friends ?? "[]");
    if (migratedFriends.includes(legacyId)) fail("self-friendship survived migration");
    if (migratedFriends.filter((x: number) => x === 424242).length !== 1) fail("friends not deduped");
    pass("M3 box assets stamped with owner; friends deduped and self-filtered");

    // =======================================================================
    log("── CHARACTERS ──");
    if (!A.session.user.accountName || !A.session.user.characterName) {
      fail("session must expose accountName and characterName");
    }
    if (A.session.user.characters?.length !== 1) fail("new account should have exactly one character");
    if (A.session.user.characterId === A.session.user.accountId) {
      fail("a fresh registration's character id should come from the shared sequence (distinct from the account id)");
    }
    pass("K1 register creates account + first character with dual identity");

    A.socket.emit("character:create", { name: "x" });
    await waitFor("bad name rejected", () => A.characterErrors.length > 0);
    A.socket.emit("character:create", { name: "Segundo" });
    await waitFor(
      "character created",
      () => A.characterChanges.some((e) => e.action === "created")
    );
    const createdId = A.characterChanges.find((e) => e.action === "created")!.characterId as number;
    keysToClean.add(charKeyOf(createdId));
    await waitFor(
      "session lists two characters",
      () => A.session?.user?.characters?.length === 2
    );
    pass("K2 character:create adds a character and rejects invalid names");

    // Give the FIRST character distinctive money before switching away.
    await redis.hSet(charKeyOf(firstCharId), { money: "5000" });

    A.socket.emit("character:select", { characterId: createdId });
    await waitFor(
      "selected",
      () => A.characterChanges.some((e) => e.action === "selected" && e.characterId === createdId)
    );
    await waitSessionCharacter(A, createdId);
    // The client would reload here; the driver re-joins explicitly.
    await join(A);
    if (Number(A.session.user.money) !== 1000) {
      fail(`fresh character should start with default money, got ${A.session.user.money}`);
    }
    if ((A.session.user.pokemonParty ?? []).length !== 0) fail("fresh character should have no party");
    pass("K3 character:select switches the session to a fresh character");

    if ((await readMoney(firstCharId)) !== 5000) fail("first character's money changed on switch");
    if ((await readMoney(createdId)) !== 1000) fail("second character's money wrong");
    pass("K4 each character has an independent currency balance");

    // Soft-delete rules: cannot delete the active character…
    A.characterErrors = [];
    A.socket.emit("character:delete", { characterId: createdId });
    await waitFor("active-delete rejected", () => A.characterErrors.length > 0);
    // …but the first (inactive) one can be deleted, then restored.
    A.socket.emit("character:delete", { characterId: firstCharId });
    await waitFor(
      "deleted",
      () => A.characterChanges.some((e) => e.action === "deleted" && e.characterId === firstCharId)
    );
    if (!(await redis.hGet(charKeyOf(firstCharId), "deleted_at"))) fail("deleted_at not set");
    pass("K5 soft delete works and refuses the active character");

    A.characterErrors = [];
    A.socket.emit("character:select", { characterId: firstCharId });
    await waitFor("select-deleted rejected", () => A.characterErrors.length > 0);
    A.socket.emit("character:restore", { characterId: firstCharId });
    await waitFor(
      "restored",
      () => A.characterChanges.some((e) => e.action === "restored" && e.characterId === firstCharId)
    );
    if (await redis.hGet(charKeyOf(firstCharId), "deleted_at")) fail("deleted_at not cleared");
    pass("K6 deleted characters cannot be selected; restore clears the deletion");

    // =======================================================================
    log("── SHARED CURRENCY ──");
    // Active character: createdId (money 1000, 0 badges).
    A.socket.emit("pc:money-deposit", { amount: 400 });
    await waitFor("deposit applied", async () => (await readMoney(createdId)) === 600);
    let deposits = await readDeposits(A.userId);
    const own = deposits.find((d) => d.ownerCharacterId === createdId);
    if (!own || own.amount !== 400) fail(`own deposit wrong: ${JSON.stringify(deposits)}`);
    pass("C1 deposit subtracts from the character and records it as owner");

    A.socket.emit("pc:money-withdraw", { amount: 150 });
    await waitFor("own withdraw applied", async () => (await readMoney(createdId)) === 750);
    deposits = await readDeposits(A.userId);
    if (deposits.find((d) => d.ownerCharacterId === createdId)?.amount !== 250) {
      fail("own deposit should be 250 after partial withdrawal");
    }
    pass("C2 a character withdraws its own deposit without any medals");

    // Seed a deposit owned by the (restored) first character.
    await redis.hSet(
      A.userKey,
      "pc_money_deposits",
      JSON.stringify([
        { ownerCharacterId: createdId, amount: 250, depositedByCharacterId: createdId, depositedAt: "x", updatedAt: "x" },
        { ownerCharacterId: firstCharId, amount: 1000, depositedByCharacterId: firstCharId, depositedAt: "x", updatedAt: "x" }
      ])
    );
    A.authErrors = [];
    A.socket.emit("pc:money-withdraw", { amount: 300, ownerCharacterId: firstCharId });
    await waitFor("gated withdraw rejected", () => A.authErrors.some((m) => m.includes("medal")));
    if ((await readMoney(createdId)) !== 750) fail("gated withdrawal must not change the wallet");
    deposits = await readDeposits(A.userId);
    if (deposits.find((d) => d.ownerCharacterId === firstCharId)?.amount !== 1000) {
      fail("gated withdrawal must not change the sibling deposit");
    }
    pass("C3 sibling deposit withdrawal denied below the medal requirement");

    // One gym medal (threshold = 1 in this run) unlocks cross-character access.
    await redis.hSet(charKeyOf(createdId), { badges: "[0]" });
    A.socket.emit("pc:money-withdraw", { amount: 300, ownerCharacterId: firstCharId });
    await waitFor("cross withdraw applied", async () => (await readMoney(createdId)) === 1050);
    deposits = await readDeposits(A.userId);
    if (deposits.find((d) => d.ownerCharacterId === firstCharId)?.amount !== 700) {
      fail("sibling deposit should keep the remaining 700");
    }
    pass("C4/C5 medal-gated partial withdrawal transfers only the withdrawn amount");

    A.authErrors = [];
    A.socket.emit("pc:money-withdraw", { amount: 0 });
    await waitFor("zero rejected", () => A.authErrors.length >= 1);
    A.socket.emit("pc:money-withdraw", { amount: -50 });
    await waitFor("negative rejected", () => A.authErrors.length >= 2);
    A.socket.emit("pc:money-withdraw", { amount: 99999999, ownerCharacterId: firstCharId });
    await waitFor("over-balance rejected", () => A.authErrors.length >= 3);
    deposits = await readDeposits(A.userId);
    if (deposits.find((d) => d.ownerCharacterId === firstCharId)?.amount !== 700) {
      fail("failed withdrawals must not move money");
    }
    pass("C6 zero/negative/over-balance operations are rejected");

    // =======================================================================
    log("── SHARED BOX ASSETS ──");
    // Give the ACTIVE character (createdId) a party and deposit one venomon.
    await redis.hSet(charKeyOf(createdId), {
      pokemon_party: JSON.stringify([mon("keeper"), mon("shared-mon")])
    });
    A.socket.emit("pokemon:box-deposit", { pokemonIds: ["shared-mon"] });
    await waitFor("mon deposited", async () => {
      const box = JSON.parse((await redis!.hGet(A.userKey, "pokemon_box")) ?? "{}");
      return box?.boxes?.some((b: any) => b.pokemon?.some((p: any) => p.id === "shared-mon"));
    });
    const boxRaw = JSON.parse((await redis.hGet(A.userKey, "pokemon_box")) ?? "{}");
    const stored = boxRaw.boxes.flatMap((b: any) => b.pokemon).find((p: any) => p.id === "shared-mon");
    if (stored.ownerCharacterId !== createdId) fail("deposited mon not stamped with owner");
    pass("B1 deposited venomon carries its owning character");

    // Switch to the first character (0 medals — badges were seeded pre-split
    // era as [0,1]? no: firstCharId badges are whatever registration left: []).
    A.socket.emit("character:select", { characterId: firstCharId });
    await waitFor(
      "back on first",
      () => A.characterChanges.filter((e) => e.action === "selected").length >= 2
    );
    await waitSessionCharacter(A, firstCharId);
    await join(A);
    await redis.hSet(charKeyOf(firstCharId), { badges: "[]" });
    A.authErrors = [];
    A.socket.emit("pokemon:box-withdraw", { pokemonIds: ["shared-mon"], boxId: "box-1" });
    await waitFor("gated box withdraw rejected", () => A.authErrors.some((m) => m.includes("medal")));
    pass("B2 sibling's boxed venomon is medal-gated");

    await redis.hSet(charKeyOf(firstCharId), { badges: "[3]" });
    A.socket.emit("pokemon:box-withdraw", { pokemonIds: ["shared-mon"], boxId: "box-1" });
    await waitFor("box withdraw applied", async () => {
      const party = JSON.parse((await redis!.hGet(charKeyOf(firstCharId), "pokemon_party")) ?? "[]");
      return party.some((p: any) => p.id === "shared-mon");
    });
    const partyNow = JSON.parse((await redis.hGet(charKeyOf(firstCharId), "pokemon_party")) ?? "[]");
    const withdrawn = partyNow.find((p: any) => p.id === "shared-mon");
    if (withdrawn.ownerCharacterId !== undefined) fail("ownership stamp should be stripped on withdrawal");
    pass("B3 medal-holder withdraws the venomon; ownership transfers (stamp stripped)");

    // =======================================================================
    log("── FRIENDS & BLOCKS ──");
    const X = await newClient("X");
    const Y = await newClient("Y");
    await join(X);
    await join(Y);

    X.socket.emit("friends:request", { username: Y.session.user.accountName });
    await sleep(300);
    Y.socket.emit("friends:list");
    await waitFor("Y sees request", () => Y.friendsState?.incoming?.length === 1);
    if (Y.friendsState.incoming[0].accountId !== X.userId) fail("request must carry the requester account id");
    Y.socket.emit("friends:respond", { userId: X.userId, accepted: true });
    await waitFor(
      "friends both ways",
      async () =>
        JSON.parse((await redis!.hGet(X.userKey, "friends")) ?? "[]").includes(Y.userId) &&
        JSON.parse((await redis!.hGet(Y.userKey, "friends")) ?? "[]").includes(X.userId)
    );
    pass("F1 friendship is stored account-to-account");

    // Y creates + switches to a second character; the friendship must be
    // unchanged and not duplicated.
    Y.socket.emit("character:create", { name: "Alterno" });
    await waitFor("Y alt created", () => Y.characterChanges.some((e) => e.action === "created"));
    const yAltId = Y.characterChanges.find((e) => e.action === "created")!.characterId as number;
    keysToClean.add(charKeyOf(yAltId));
    Y.socket.emit("character:select", { characterId: yAltId });
    await waitSessionCharacter(Y, yAltId);
    await join(Y);
    const xFriends = JSON.parse((await redis.hGet(X.userKey, "friends")) ?? "[]");
    if (xFriends.filter((id: number) => id === Y.userId).length !== 1) {
      fail("character switch duplicated or dropped the friendship");
    }
    X.socket.emit("friends:list");
    await waitFor(
      "X sees Y's new character in presence",
      () =>
        X.friendsState?.friends?.some(
          (f: any) => f.accountId === Y.userId && f.activeCharacterName === "Alterno"
        )
    );
    pass("F2 friendship survives a character switch; presence shows the active character");

    X.friendsErrors = [];
    X.socket.emit("friends:request", { username: X.session.user.accountName });
    await waitFor("self-request rejected", () => X.friendsErrors.length > 0);
    X.friendsErrors = [];
    X.socket.emit("friends:request", { username: Y.session.user.accountName });
    await waitFor("duplicate-friend rejected", () => X.friendsErrors.length > 0);
    pass("F3 self-friending and duplicate friendships are rejected");

    X.socket.emit("friends:block", { accountId: Y.userId });
    await waitFor(
      "friendship severed",
      async () => !JSON.parse((await redis!.hGet(X.userKey, "friends")) ?? "[]").includes(Y.userId)
    );
    const xBlocked = JSON.parse((await redis.hGet(X.userKey, "blocked_accounts")) ?? "[]");
    if (!xBlocked.includes(Y.userId)) fail("block list not updated");
    Y.friendsErrors = [];
    Y.socket.emit("friends:request", { username: X.session.user.accountName });
    await waitFor("blocked request denied", () => Y.friendsErrors.length > 0);
    const xIncoming = JSON.parse((await redis.hGet(X.userKey, "friend_requests_in")) ?? "[]");
    if (xIncoming.some((r: any) => r.userId === Y.userId)) fail("blocked request must not be stored");
    pass("F4 blocking severs the friendship and rejects new requests from any character");

    Y.chatErrors = [];
    Y.socket.emit("chat:map-message", { text: `/w ${X.session.user.accountName} hola` });
    await waitFor("whisper blocked", () => Y.chatErrors.length > 0);
    Y.tradeResults = [];
    Y.socket.emit("trade:request", { targetUserId: X.userId, requestId: "e2e-b1" });
    await waitFor(
      "trade blocked",
      () => Y.tradeResults.some((r) => r?.success === false)
    );
    pass("F5 whispers and trade requests are denied for blocked accounts");

    X.socket.emit("friends:unblock", { accountId: Y.userId });
    await waitFor(
      "unblocked",
      async () => !JSON.parse((await redis!.hGet(X.userKey, "blocked_accounts")) ?? "[]").includes(Y.userId)
    );
    Y.friendsErrors = [];
    Y.socket.emit("friends:request", { username: X.session.user.accountName });
    await waitFor(
      "request flows again",
      async () =>
        JSON.parse((await redis!.hGet(X.userKey, "friend_requests_in")) ?? "[]").some(
          (r: any) => r.userId === Y.userId
        )
    );
    pass("F6 unblocking restores normal interaction");

    // Public identity payloads: X observes Y's join payload.
    const yPayload = X.addPlayerPayloads
      .filter((p) => p?.accountId === Y.userId)
      .pop();
    if (!yPayload) fail("X never saw Y's addPlayer payload");
    if (yPayload.accountName !== Y.session.user.accountName) fail("addPlayer missing accountName");
    if (yPayload.characterName !== "Alterno") fail(`addPlayer characterName wrong: ${yPayload.characterName}`);
    if ("email" in yPayload) fail("addPlayer payload must not leak email");
    pass("F7 public payloads carry account + character identity and no private data");

    log("");
    log(`ALL PASS — ${passed} assertions`);
  } catch (error) {
    log("");
    log(`FAILED after ${passed} passing assertions:`);
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

void main();
