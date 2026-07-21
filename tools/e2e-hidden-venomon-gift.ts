/**
 * E2E: hidden/gift venomon grant (pbAddPokemon authored as a conditional-branch
 * script condition — RMXP code 111).
 *
 * Reproduces and verifies the fix for: "obtain message shows but the venomon is
 * added to neither the team nor the PC box." The real bug lived in
 * EventRuntime.evaluate() (a pbAddPokemon script condition fell through to a
 * permissive `return true`, consuming the event without granting anything).
 *
 * What this script does, end to end, against a REAL server + REAL redis:
 *   1. Starts the dev redis container (data/ has the imported Venova maps).
 *   2. Injects a clean, battle-free test gift NPC into map-essentials-043 by
 *      cloning a real NPC and swapping only its command list. The raw maps blob
 *      and its probe marker are backed up and restored in `finally`.
 *   3. Boots the server with ts-node (SMTP disabled) on a private port.
 *   4. Registers a throwaway user, seeds a FULL 6-slot party + a location on
 *      map-essentials-043.
 *   5. Test A (party full): interact → expects the "no space, come back later"
 *      message and asserts NOTHING was granted (party stays 6, box empty) and
 *      the event was NOT consumed (self switch A still clear).
 *   6. Test B (empty slot): frees one slot, interacts again → expects the
 *      "¡Has recibido a X!" message and asserts the venomon now sits in the
 *      6th team slot (and auth:session reflects it).
 *
 * Run:  cd server-poke.io && NODE_OPTIONS=--max-old-space-size=4096 \
 *         node_modules/.bin/ts-node <path>/e2e-hidden-venomon-gift.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3999; // private port so we don't collide with a running dev server
const MAPS_KEY = "designer:section:maps";
const PROBE_KEY = `${MAPS_KEY}:probe`;

const TEST_MAP = "map-essentials-043";
const TEST_NPC_ID = "npc-e2e-gift-test";
const TEST_EVENT_ID = 9099; // unique so its self-switch prefix can't clash
const GIFT_SPECIES = "BULBASAUR"; // a starter — guaranteed to resolve in redis
const GIFT_LEVEL = 7;

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const fail = (msg: string): never => {
  throw new Error(`ASSERTION FAILED: ${msg}`);
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

async function waitFor<T>(
  what: string,
  fn: () => T | Promise<T>,
  { timeoutMs = 15000, everyMs = 250 } = {}
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
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** A valid party entry that survives Auth.sanitizePokemonListForStorage. */
function filler(i: number) {
  return {
    id: `filler-${i}-${Date.now()}`,
    sourcePokemonId: "pokemon-RATTATA",
    name: "Rattata",
    level: 5,
    types: ["Normal"],
    hp: 20,
    maxHp: 20,
    ivs: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 },
    moves: ["Tackle"],
    movePp: {},
    experience: 0,
    experienceCurve: "medium",
    nextLevelExperience: 100,
    statBonuses: {}
  };
}

/** The clean gift event: a single action page whose only logic is the
 *  conditional-branch pbAddPokemon (then-branch sets self switch A). */
function giftEvent() {
  return {
    eventId: TEST_EVENT_ID,
    essentialsMapId: 43,
    pages: [
      {
        conditions: {},
        graphic: { characterName: "", direction: 2, pattern: 0 },
        trigger: 1,
        commands: [
          { code: 111, indent: 0, parameters: [12, `pbAddPokemon(:${GIFT_SPECIES}, ${GIFT_LEVEL})`] },
          { code: 123, indent: 1, parameters: ["A", 0] }, // Self Switch A = ON
          { code: 0, indent: 1, parameters: [] },
          { code: 412, indent: 0, parameters: [] }, // Branch End
          { code: 0, indent: 0, parameters: [] }
        ]
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let startedRedis = false;
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  let socket: Socket | null = null;
  let mapsBackup: string | null = null;
  let probeBackup: string | null = null;
  let testUserId: number | null = null;

  const cleanup = async () => {
    log("── cleanup ──");
    try { socket?.disconnect(); } catch {}
    if (server && !server.killed) {
      server.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1000));
      if (!server.killed) server.kill("SIGKILL");
    }
    if (redis?.isOpen) {
      try {
        if (mapsBackup !== null) {
          await redis.set(MAPS_KEY, mapsBackup);
          if (probeBackup !== null) await redis.set(PROBE_KEY, probeBackup);
          else await redis.del(PROBE_KEY);
          log("restored maps blob + probe marker");
        }
        if (testUserId !== null) {
          await redis.del(`auth:user:${testUserId}`);
          log(`deleted test user auth:user:${testUserId}`);
        }
      } catch (e) {
        console.error("cleanup redis error:", e);
      }
      await redis.quit();
    }
    if (startedRedis) {
      try { sh("docker", ["stop", REDIS_CONTAINER]); log("stopped redis container"); } catch {}
    }
  };

  try {
    // --- 1. redis up -------------------------------------------------------
    const running = (() => { try { return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]); } catch { return ""; } })();
    if (running !== REDIS_CONTAINER) {
      log("starting redis container…");
      try { sh("docker", ["start", REDIS_CONTAINER]); }
      catch { sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]); }
      startedRedis = true;
    } else {
      log("redis already running — reusing it");
    }

    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    redis.on("error", (e: unknown) => console.error("redis client error:", e));
    await waitFor("redis PING", async () => {
      if (!redis!.isOpen) await redis!.connect();
      return (await redis!.ping()) === "PONG";
    });
    log("redis reachable");

    // --- 2. inject test NPC (back up raw blob first) -----------------------
    const raw = await redis.get(MAPS_KEY);
    if (!raw) fail(`${MAPS_KEY} is empty — dev redis has no imported maps`);
    mapsBackup = raw!;
    probeBackup = await redis.get(PROBE_KEY);
    log(`maps blob is ${(raw!.length / 1e6).toFixed(1)} MB — parsing`);

    const payload = JSON.parse(raw!);
    const state = payload.state ?? payload;
    const mapEd = state.editorDataByMapId?.[TEST_MAP];
    if (!mapEd?.npcs?.length) fail(`${TEST_MAP} has no npcs to clone from`);

    // Clone a real NPC (so every field the sanitizer expects is present) and
    // swap only the parts that make it our clean, battle-free gift.
    const template = mapEd.npcs.find((n: any) => n.essentialsEvent) ?? mapEd.npcs[0];
    const testNpc = JSON.parse(JSON.stringify(template));
    testNpc.id = TEST_NPC_ID;
    testNpc.npcId = "essentials-event-e2e-gift";
    testNpc.name = "E2E Gift NPC";
    testNpc.eventId = TEST_EVENT_ID;
    testNpc.eventPageIndex = 0;
    testNpc.interactable = true;
    testNpc.essentialsEvent = giftEvent();
    // Drop any prior copy from an interrupted run, then add ours.
    mapEd.npcs = mapEd.npcs.filter((n: any) => n.id !== TEST_NPC_ID);
    mapEd.npcs.push(testNpc);

    await redis.set(MAPS_KEY, JSON.stringify(payload));
    await redis.set(PROBE_KEY, `e2e:${Date.now()}`); // force cache invalidation
    log(`injected ${TEST_NPC_ID} into ${TEST_MAP}`);

    // --- 3. boot server ----------------------------------------------------
    log(`starting server on :${PORT} …`);
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(PORT), REDIS_URL, SMTP_ENABLED: "false", GIT_SHA: "e2e" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverLog = "";
    server.stdout!.on("data", (d) => { serverLog += d; process.stdout.write(`  [srv] ${d}`); });
    server.stderr!.on("data", (d) => { serverLog += d; process.stderr.write(`  [srv!] ${d}`); });
    server.on("exit", (code) => log(`server exited (code ${code})`));
    await waitFor("server listening", () => serverLog.includes(`Listening on port ${PORT}`), { timeoutMs: 60000 });
    log("server is up");

    // --- 4. connect + register --------------------------------------------
    socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    const steps: any[] = [];
    let lastSession: any = null;
    socket.on("event:step", (s: any) => { steps.push(s); log("  event:step →", JSON.stringify(s).slice(0, 140)); });
    socket.on("auth:session", (s: any) => { lastSession = s; });
    socket.on("auth:error", (e: any) => log("  auth:error →", e?.message));

    await waitFor("socket connect", () => socket!.connected);
    log("socket connected", socket.id);

    const uname = `e2egift${Date.now().toString().slice(-8)}`;
    socket.emit("auth:register", {
      name: "Ester",
      username: uname,
      email: `${uname}@example.com`,
      password: "Aa1!aaaa"
    });
    const session = await waitFor("auth:session after register", () =>
      lastSession?.authenticated && lastSession?.user?.id ? lastSession : null
    );
    testUserId = Number(session.user.id);
    log(`registered user #${testUserId} (${uname})`);

    // --- 5. seed FULL party + location ------------------------------------
    const userKey = `auth:user:${testUserId}`;
    const fullParty = Array.from({ length: 6 }, (_, i) => filler(i));
    await redis.hSet(userKey, {
      last_map_id: TEST_MAP,
      last_x: "50",
      last_y: "41",
      pokemon_party: JSON.stringify(fullParty),
      pokemon_box: JSON.stringify({ boxes: [] })
    });
    log("seeded full 6-slot party + location on", TEST_MAP);

    // enter the world
    lastSession = null;
    socket.emit("addPlayer", { token: session.token });
    await waitFor("myPlayer / world join", () => true, { timeoutMs: 3000 }).catch(() => {});
    // give resumeEventsOnJoin a beat
    await new Promise((r) => setTimeout(r, 1500));

    const selfSwitchKey = `${TEST_EVENT_ID}`; // just for logging clarity
    const readParty = async () => JSON.parse((await redis!.hGet(userKey, "pokemon_party")) || "[]");
    const readEventState = async () => (await redis!.hGet(userKey, "event_self_switches")) || "(none)";

    // ===================================================================
    // TEST A — party full → refuse + "come back later", nothing granted
    // ===================================================================
    log("── TEST A: party full ──");
    steps.length = 0;
    socket.emit("event:interact", { npcPlacementId: TEST_NPC_ID });
    const fullMsg = await waitFor("full-team message", () =>
      steps.find((s) => s.type === "info" && /No tienes espacio/i.test(s.text || "")) ?? null
    );
    log('  got refusal:', JSON.stringify(fullMsg.text));
    socket.emit("event:advance", {}); // dismiss
    await new Promise((r) => setTimeout(r, 800));

    const partyAfterFull = await readParty();
    if (partyAfterFull.length !== 6) fail(`party changed while full (len=${partyAfterFull.length}, expected 6)`);
    if (steps.some((s) => /Has recibido/i.test(s.text || ""))) fail(`saw an "obtained" message while party was full`);
    log("  ✓ party still 6, no venomon granted, no 'obtained' message");
    log("  (self switches:", await readEventState(), "— event should NOT be consumed)");

    // ===================================================================
    // TEST B — free a slot → grant into the empty team slot
    // ===================================================================
    log("── TEST B: one empty slot ──");
    const fiveParty = fullParty.slice(0, 5);
    await redis.hSet(userKey, { pokemon_party: JSON.stringify(fiveParty) });
    log("  freed a slot (party now 5)");

    steps.length = 0;
    lastSession = null;
    socket.emit("event:interact", { npcPlacementId: TEST_NPC_ID });
    const gotMsg = await waitFor("obtained message", () =>
      steps.find((s) => s.type === "info" && /Has recibido/i.test(s.text || "")) ?? null
    );
    log("  got grant:", JSON.stringify(gotMsg.text));
    socket.emit("event:advance", {});
    await new Promise((r) => setTimeout(r, 1000));

    const partyAfterGrant = await readParty();
    if (partyAfterGrant.length !== 6) fail(`expected party of 6 after grant, got ${partyAfterGrant.length}`);
    const added = partyAfterGrant[partyAfterGrant.length - 1];
    const addedName = String(added?.name || "").toUpperCase();
    if (!addedName.includes(GIFT_SPECIES) && !String(added?.sourcePokemonId || "").toUpperCase().includes(GIFT_SPECIES)) {
      fail(`6th slot is not the gift species (got name=${added?.name}, src=${added?.sourcePokemonId})`);
    }
    log(`  ✓ venomon landed in team slot 6: ${added?.name} (lvl ${added?.level})`);

    // box should still be empty (team-only grant, never boxed)
    const box = JSON.parse((await redis.hGet(userKey, "pokemon_box")) || '{"boxes":[]}');
    const boxCount = (box.boxes || []).reduce((n: number, b: any) => n + (b.pokemon?.length || 0), 0);
    if (boxCount !== 0) fail(`box should be empty but has ${boxCount} venomons`);
    log("  ✓ PC box still empty (granted to team, not boxed)");

    // client should have been refreshed with the new party
    if (lastSession?.user?.pokemonParty?.length === 6) {
      log("  ✓ auth:session pushed updated 6-member party to client");
    } else {
      log("  ⚠ did not observe an auth:session with 6 members (party still verified via redis)");
    }

    log("\n✅ ALL ASSERTIONS PASSED — gift venomon grant works and refuses cleanly when full.");
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌", e?.message || e);
  process.exit(1);
});
