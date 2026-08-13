/**
 * E2E: 3-slot venomon equipment (bonus / battle / appearance) against a REAL
 * server + redis.
 *
 *   T1  equipping a bonus item (Life Orb) fills heldItem* and debits the bag
 *   T2  equipping a berry with no slot hint auto-classifies into battleItem*
 *   T3  equipping the Shiny Charm fills appearanceItem* and re-skins the
 *       session sprites to the front-shiny set
 *   T4  a species-gated appearance item (Griseous Orb on a Pikachu) is refused
 *   T5  equipping over an occupied slot returns the previous item to the bag
 *   T6  inventory:take-held-item with slot "battle" unequips only that slot
 *   T7  an explicit slot that contradicts the item's class is refused
 *   T8  a legacy berry stored in the old single heldItem slot migrates to the
 *       battle slot on the next session load
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-equipment.ts
 */
import { spawn, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";
import {
  applyAppearanceToSpritePath,
  resolveAppearanceEffect
} from "../components/battle/heldItems";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const PORT = 3995;
const TEST_MAP = "map-essentials-043";
const CELL = 32;
const BASE_X = 50;
const BASE_Y = 41;

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

function item(id: string, name: string, quantity: number, category = "usable") {
  return { id, name, category, quantity, description: `${name} description` };
}

function leaderSummary() {
  return {
    id: `e2e-equip-${Date.now()}`,
    sourcePokemonId: "pokemon-PIKACHU",
    name: "Lapitta",
    level: 12,
    types: ["ELECTRIC"],
    hp: 30,
    maxHp: 30,
    moves: ["Impactrueno"],
    experience: 0,
    experienceCurve: "medium",
    nextLevelExperience: 100,
    statBonuses: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 }
  };
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  let socket: Socket | null = null;
  const keysToClean = new Set<string>();

  const cleanup = async () => {
    log("── cleanup ──");
    try {
      socket?.disconnect();
    } catch {
      /* gone */
    }
    if (server && !server.killed) {
      server.kill("SIGTERM");
      await sleep(800);
      if (!server.killed) server.kill("SIGKILL");
    }
    if (redis?.isOpen) {
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

  try {
    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    redis.on("error", () => {});
    await waitFor("redis PING", async () => {
      if (!redis!.isOpen) await redis!.connect();
      return (await redis!.ping()) === "PONG";
    });
    log("redis reachable");

    log(`starting server on :${PORT} …`);
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(PORT), REDIS_URL, SMTP_ENABLED: "false", GIT_SHA: "e2e" },
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

    // ---- register + seed --------------------------------------------------
    let session: any = null;
    let myPlayerId: string | null = null;
    const authErrors: string[] = [];
    const attachListeners = (s: Socket) => {
      s.on("auth:session", (payload: any) => {
        session = payload;
      });
      s.on("auth:error", (e: any) => authErrors.push(String(e?.message ?? "")));
      s.on("myPlayer", (m: any) => {
        myPlayerId = m?.playerId ?? null;
      });
    };
    socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    attachListeners(socket);
    await waitFor("connect", () => socket!.connected);

    const lettersStamp = Date.now()
      .toString()
      .slice(-8)
      .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
    const uname = `eq${lettersStamp}`.slice(0, 14);
    socket.emit("auth:register", {
      name: "EquipTester",
      username: uname,
      email: `${uname}@example.com`,
      password: "Aa1!aaaa"
    });
    const registered = await waitFor(
      "register",
      () => (session?.authenticated && session?.user?.id ? session : null),
      { timeoutMs: 8000 }
    );
    const userId = Number(registered.user.id);
    const token: string = registered.token;
    const characterId = Number(registered.user.characterId);
    const charKey = `auth:character:${characterId}`;
    keysToClean.add(`auth:user:${userId}`);
    keysToClean.add(charKey);
    keysToClean.add(`auth:index:username:${uname}`);
    keysToClean.add(`auth:index:email:${uname}@example.com`);
    log(`registered account #${userId}, character #${characterId}`);

    const leader = leaderSummary();
    await redis.hSet(charKey, {
      event_self_switches: JSON.stringify({ "129:2:A": true }),
      last_map_id: TEST_MAP,
      last_x: String(BASE_X * CELL),
      last_y: String(BASE_Y * CELL),
      pokemon_party: JSON.stringify([leader]),
      inventory: JSON.stringify([
        item("item-lifeorb", "Vidasfera", 1),
        item("item-oranberry", "Baya Aranja", 2, "berries"),
        item("item-shinycharm", "Amuleto Iris", 1),
        item("item-griseousorb", "Hueso Maldito", 1),
        item("item-leftovers", "Restos", 1)
      ]),
      money: "0"
    });
    socket.emit("addPlayer", { token });
    await waitFor("myPlayer", () => myPlayerId);

    const partyLeader = () => session?.user?.pokemonParty?.[0] ?? null;
    const bagQty = (itemId: string) =>
      Number(
        (session?.user?.inventory ?? []).find((entry: any) => entry.id === itemId)?.quantity ?? 0
      );

    await waitFor("seeded session", () => partyLeader()?.id === leader.id);

    // ---- T1 bonus slot ----------------------------------------------------
    log("── T1 equip bonus item ──");
    socket.emit("inventory:hold-item", {
      pokemonId: leader.id,
      itemId: "item-lifeorb",
      slot: "bonus"
    });
    await waitFor("Life Orb equipped", () => partyLeader()?.heldItemId === "item-lifeorb");
    if (bagQty("item-lifeorb") !== 0) fail(`Life Orb still in bag x${bagQty("item-lifeorb")}`);
    pass("Life Orb fills the bonus slot and leaves the bag");

    // ---- T2 battle slot auto-classification -------------------------------
    log("── T2 berry auto-classifies into the battle slot ──");
    socket.emit("inventory:hold-item", { pokemonId: leader.id, itemId: "item-oranberry" });
    await waitFor("Oran Berry equipped", () => partyLeader()?.battleItemId === "item-oranberry");
    if (partyLeader()?.heldItemId !== "item-lifeorb") fail("bonus slot was disturbed by the berry");
    if (bagQty("item-oranberry") !== 1) fail(`Oran Berry bag qty ${bagQty("item-oranberry")}`);
    pass("berry landed in battleItem* without touching the bonus slot");

    // ---- T3 appearance slot + shiny sprites -------------------------------
    log("── T3 Shiny Charm re-skins the sprites ──");
    socket.emit("inventory:hold-item", {
      pokemonId: leader.id,
      itemId: "item-shinycharm",
      slot: "appearance"
    });
    await waitFor("Shiny Charm equipped", () => partyLeader()?.appearanceItemId === "item-shinycharm");
    const storedParty = JSON.parse((await redis.hGet(charKey, "pokemon_party")) ?? "[]");
    if (storedParty[0]?.appearanceItemId !== "item-shinycharm") {
      fail(`appearance slot not persisted: ${JSON.stringify(storedParty[0] ?? null)}`);
    }
    // Menu sprites are re-skinned client-side and battle sprites by
    // BattleManager.resolveBattleSprites — both through these two functions;
    // assert the production transform against the real catalog sprite path.
    const catalogRaw = (await redis.get("designer:section:pokemons")) ?? "{}";
    const pikachuProfile = (JSON.parse(catalogRaw)?.state?.items ?? []).find(
      (entry: any) => entry?.id === "pokemon-PIKACHU"
    )?.pokemonProfile;
    const shinyEffect = resolveAppearanceEffect("SHINYCHARM", "PIKACHU");
    if (!shinyEffect) fail("SHINYCHARM missing from the appearance registry");
    const shinyFront = applyAppearanceToSpritePath(
      String(pikachuProfile?.frontImageSrc ?? ""),
      shinyEffect!,
      "front"
    );
    if (!shinyFront.includes("/front-shiny/")) fail(`transform produced ${shinyFront}`);
    pass("appearance slot persisted and sprite transform yields the front-shiny path");

    const relogin = async (expectLeaderId: string) => {
      socket!.disconnect();
      socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
      attachListeners(socket);
      await waitFor("reconnect", () => socket!.connected);
      session = null;
      myPlayerId = null;
      socket.emit("auth:session", { token });
      await waitFor(
        "relogin session",
        () => session?.user?.pokemonParty?.[0]?.id === expectLeaderId
      );
      socket.emit("addPlayer", { token });
      await waitFor("relogin myPlayer", () => myPlayerId);
    };

    // ---- T4 species-gated appearance item refused -------------------------
    log("── T4 Griseous Orb refused on a Pikachu ──");
    const errorsBefore = authErrors.length;
    socket.emit("inventory:hold-item", { pokemonId: leader.id, itemId: "item-griseousorb" });
    await waitFor("refusal error", () => authErrors.length > errorsBefore);
    if (partyLeader()?.appearanceItemId !== "item-shinycharm") fail("appearance slot changed");
    if (bagQty("item-griseousorb") !== 1) fail("Griseous Orb left the bag");
    pass(`equip refused: "${authErrors[authErrors.length - 1]}"`);

    // ---- T5 replacing returns the previous item ---------------------------
    log("── T5 replacing the bonus item returns it to the bag ──");
    socket.emit("inventory:hold-item", {
      pokemonId: leader.id,
      itemId: "item-leftovers",
      slot: "bonus"
    });
    await waitFor("Leftovers equipped", () => partyLeader()?.heldItemId === "item-leftovers");
    if (bagQty("item-lifeorb") !== 1) fail(`Life Orb not returned (x${bagQty("item-lifeorb")})`);
    pass("Leftovers replaced Life Orb; Life Orb returned to the bag");

    // ---- T6 slot-scoped unequip -------------------------------------------
    log("── T6 take-held-item on the battle slot ──");
    socket.emit("inventory:take-held-item", { pokemonId: leader.id, slot: "battle" });
    await waitFor("battle slot empty", () => !partyLeader()?.battleItemId);
    if (partyLeader()?.heldItemId !== "item-leftovers") fail("bonus slot was cleared too");
    if (bagQty("item-oranberry") !== 2) fail(`Oran Berry qty ${bagQty("item-oranberry")}`);
    pass("battle slot emptied alone; berry back in the bag");

    // ---- T7 slot mismatch refused -----------------------------------------
    log("── T7 explicit wrong slot refused ──");
    const errorsBefore7 = authErrors.length;
    socket.emit("inventory:hold-item", {
      pokemonId: leader.id,
      itemId: "item-lifeorb",
      slot: "battle"
    });
    await waitFor("mismatch error", () => authErrors.length > errorsBefore7);
    if (partyLeader()?.battleItemId) fail("Life Orb slipped into the battle slot");
    pass(`slot mismatch refused: "${authErrors[authErrors.length - 1]}"`);

    // ---- T8 legacy single-slot migration ----------------------------------
    log("── T8 legacy heldItemId berry migrates to the battle slot ──");
    const legacy = { ...leaderSummary(), id: `${leader.id}-legacy` };
    (legacy as any).heldItemId = "item-oranberry";
    (legacy as any).heldItemName = "Baya Aranja";
    await redis.hSet(charKey, { pokemon_party: JSON.stringify([legacy]) });
    await relogin(legacy.id);
    const migrated = session.user.pokemonParty[0];
    if (migrated.battleItemId !== "item-oranberry") {
      fail(`legacy berry not migrated (battleItemId=${migrated.battleItemId})`);
    }
    if (migrated.heldItemId) fail(`legacy heldItemId lingers (${migrated.heldItemId})`);
    pass("legacy berry moved from heldItem* to battleItem* on load");

    log(`\nALL PASS — ${passed} assertions`);
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
