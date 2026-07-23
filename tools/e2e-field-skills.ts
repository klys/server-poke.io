/**
 * E2E: MO field skills (Cut + Surf + Dive gate) against a REAL server + redis.
 *
 *   CUT   — an "Arbol" Cut event only erases (pbEraseThisEvent -> ERASED
 *           self-switch) when a party Venomon knows Corte; otherwise it hints
 *           and stays put.
 *   SURF  — facing water without a Surf Venomon errors; with one, the player
 *           mounts the water (player:surf-state surfing=true, position moves).
 *   DIVE  — while surfing over non-deep water, player:dive reports it needs
 *           deep water (proves the dive pairing + party-knows + deep-water gate).
 *
 * Mirrors tools/e2e-hidden-venomon-gift.ts (maps-blob backup/restore included).
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-field-skills.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3997;
const MAPS_KEY = "designer:section:maps";
const PROBE_KEY = `${MAPS_KEY}:probe`;

const CUT_MAP = "map-essentials-043";
const CUT_NPC_ID = "npc-e2e-cut-test";
const CUT_EVENT_ID = 9098;
const CUT_ESS_MAP = 43;
const ERASED_KEY = `${CUT_ESS_MAP}:${CUT_EVENT_ID}:ERASED`;

// A walkable land cell on the ocean route map-294, facing water to its left.
const SURF_MAP = "map-essentials-294";
const SURF_LAND = { x: 52, y: 14 };
const SURF_WATER = { x: 51, y: 14 };

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const fail = (msg: string): never => { throw new Error(`ASSERTION FAILED: ${msg}`); };

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}
async function waitFor<T>(what: string, fn: () => T | Promise<T>, { timeoutMs = 15000, everyMs = 200 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${lastErr}` : ""}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function surfMon(id: string, moves: string[]) {
  const movePp: Record<string, number> = {};
  moves.forEach((m) => (movePp[m] = 15));
  return {
    id, sourcePokemonId: "pokemon-MAGIKARP", name: id, level: 20, types: ["Water"],
    hp: 40, maxHp: 40, ivs: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 },
    moves, movePp, experience: 0, experienceCurve: "medium", nextLevelExperience: 1000, statBonuses: {}
  };
}

/** The Cut obstacle: action page gated by pbCut whose body erases the event. */
function cutEvent() {
  return {
    eventId: CUT_EVENT_ID,
    essentialsMapId: CUT_ESS_MAP,
    pages: [{
      conditions: {},
      graphic: { characterName: "Object tree 1", direction: 2, pattern: 0 },
      trigger: 0,
      commands: [
        { code: 111, indent: 0, parameters: [12, "Kernel.pbCut"] },
        { code: 355, indent: 1, parameters: ["pbEraseThisEvent"] },
        { code: 0, indent: 1, parameters: [] },
        { code: 412, indent: 0, parameters: [] },
        { code: 0, indent: 0, parameters: [] }
      ]
    }]
  };
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  let socket: Socket | null = null;
  let mapsBackup: string | null = null;
  let probeBackup: string | null = null;
  let testUserId: number | null = null;

  const cleanup = async () => {
    log("── cleanup ──");
    try { socket?.disconnect(); } catch {}
    if (server && !server.killed) { server.kill("SIGTERM"); await new Promise((r) => setTimeout(r, 800)); if (!server.killed) server.kill("SIGKILL"); }
    if (redis?.isOpen) {
      if (mapsBackup !== null) { await redis.set(MAPS_KEY, mapsBackup); if (probeBackup !== null) await redis.set(PROBE_KEY, probeBackup); else await redis.del(PROBE_KEY); log("restored maps blob"); }
      if (testUserId !== null) { try { await redis.del(`auth:user:${testUserId}`); } catch {} }
      await redis.quit();
    }
  };

  try {
    const running = (() => { try { return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]); } catch { return ""; } })();
    if (running !== REDIS_CONTAINER) { try { sh("docker", ["start", REDIS_CONTAINER]); } catch { sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]); } }
    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    redis.on("error", () => {});
    await waitFor("redis PING", async () => { if (!redis!.isOpen) await redis!.connect(); return (await redis!.ping()) === "PONG"; });

    // Inject the Cut NPC (back up the maps blob first).
    const raw = await redis.get(MAPS_KEY);
    if (!raw) fail(`${MAPS_KEY} empty`);
    mapsBackup = raw!; probeBackup = await redis.get(PROBE_KEY);
    const payload = JSON.parse(raw!);
    const mapEd = payload.state.editorDataByMapId[CUT_MAP];
    if (!mapEd?.npcs?.length) fail(`${CUT_MAP} has no npcs to clone`);
    const template = mapEd.npcs.find((n: any) => n.essentialsEvent) ?? mapEd.npcs[0];
    const testNpc = JSON.parse(JSON.stringify(template));
    Object.assign(testNpc, { id: CUT_NPC_ID, npcId: "essentials-event-e2e-cut", name: "E2E Cut Tree", eventId: CUT_EVENT_ID, eventPageIndex: 0, interactable: true, essentialsEvent: cutEvent() });
    mapEd.npcs = mapEd.npcs.filter((n: any) => n.id !== CUT_NPC_ID);
    mapEd.npcs.push(testNpc);
    await redis.set(MAPS_KEY, JSON.stringify(payload));
    await redis.set(PROBE_KEY, `e2e:${Date.now()}`);
    log(`injected ${CUT_NPC_ID} into ${CUT_MAP}`);

    log(`starting server on :${PORT} …`);
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), REDIS_URL, SMTP_ENABLED: "false", GIT_SHA: "e2e" }, stdio: ["ignore", "pipe", "pipe"] });
    let serverLog = "";
    server.stdout!.on("data", (d) => { serverLog += d; });
    server.stderr!.on("data", (d) => { serverLog += d; process.stderr.write(`  [srv!] ${d}`); });
    await waitFor("server listening", () => serverLog.includes(`Listening on port ${PORT}`), { timeoutMs: 60000 });
    log("server up");

    socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    const steps: any[] = [];
    let lastSession: any = null;
    let fieldError: any = null;
    let surfState: any = null;
    socket.on("event:step", (s: any) => steps.push(s));
    socket.on("auth:session", (s: any) => { lastSession = s; });
    socket.on("player:field-skill-error", (e: any) => { fieldError = e; log("  field-skill-error →", JSON.stringify(e)); });
    socket.on("player:surf-state", (s: any) => { surfState = s; log("  surf-state →", JSON.stringify(s)); });
    await waitFor("connect", () => socket!.connected);

    const uname = `e2efield${Date.now().toString().slice(-8)}`;
    socket.emit("auth:register", { name: "Fielder", username: uname, email: `${uname}@example.com`, password: "Aa1!aaaa" });
    const session = await waitFor("register session", () => (lastSession?.authenticated && lastSession?.user?.id ? lastSession : null));
    testUserId = Number(session.user.id);
    const userKey = `auth:user:${testUserId}`;
    log(`registered #${testUserId}`);

    // Party WITHOUT Corte for the first Cut test.
    await redis.hSet(userKey, {
      last_map_id: CUT_MAP, last_x: "50", last_y: "41",
      pokemon_party: JSON.stringify([surfMon("m1", ["Salpicadura"])]),
      pokemon_box: JSON.stringify({ boxes: [] })
    });
    socket.emit("addPlayer", { token: session.token });
    await new Promise((r) => setTimeout(r, 1200));

    const readSelfSwitches = async () => (await redis!.hGet(userKey, "event_self_switches")) || "";

    // ── CUT A: no Corte → hint, not erased ──
    log("── CUT A: no Corte ──");
    steps.length = 0;
    socket.emit("event:interact", { npcPlacementId: CUT_NPC_ID });
    await waitFor("cut hint", () => steps.find((s) => s.type === "info" && /Corte/i.test(s.text || "")) ?? null);
    socket.emit("event:advance", {});
    await new Promise((r) => setTimeout(r, 600));
    if ((await readSelfSwitches()).includes(ERASED_KEY)) fail("tree erased without Corte");
    log("  ✓ hinted, not erased");

    // ── CUT B: with Corte → erased ──
    log("── CUT B: with Corte ──");
    await redis.hSet(userKey, { pokemon_party: JSON.stringify([surfMon("m1", ["Corte"])]) });
    steps.length = 0;
    socket.emit("event:interact", { npcPlacementId: CUT_NPC_ID });
    await waitFor("erased self-switch", async () => (await readSelfSwitches()).includes(ERASED_KEY));
    log("  ✓ tree erased (ERASED self-switch set)");

    // ── SURF: teleport to the ocean route, face water ──
    log("── SURF ──");
    await redis.hSet(userKey, { pokemon_party: JSON.stringify([surfMon("m1", ["Salpicadura"])]) });
    socket.emit("player:teleport", { mapId: SURF_MAP, x: SURF_LAND.x * 32, y: SURF_LAND.y * 32 });
    await new Promise((r) => setTimeout(r, 1000));
    // Face the water (bump-left sets the facing without moving onto water).
    socket.emit("move", { x: 0, y: SURF_LAND.y * 32 });
    await new Promise((r) => setTimeout(r, 500));
    socket.emit("stopMove");
    await new Promise((r) => setTimeout(r, 200));

    // No Surf move known → error.
    fieldError = null;
    socket.emit("player:surf");
    await waitFor("surf error (no move)", () => (fieldError && fieldError.skill === "surf" ? fieldError : null));
    if (!/Surf/i.test(fieldError.message || "")) fail(`unexpected surf error: ${fieldError.message}`);
    log("  ✓ surf refused without a Surf Venomon");

    // Teach a Surf move → surf succeeds.
    await redis.hSet(userKey, { pokemon_party: JSON.stringify([surfMon("m1", ["Surf"])]) });
    surfState = null; fieldError = null;
    socket.emit("player:surf");
    const surfed = await waitFor("surf-state on", () => (surfState && surfState.surfing ? surfState : (fieldError ? { err: fieldError } : null)));
    if ((surfed as any).err) fail(`surf failed: ${JSON.stringify((surfed as any).err)}`);
    log("  ✓ surfing started (player:surf-state surfing=true)");

    // ── DIVE gate: surfing over non-deep water needs deep water ──
    log("── DIVE gate ──");
    await redis.hSet(userKey, { pokemon_party: JSON.stringify([surfMon("m1", ["Surf", "Buceo"])]) });
    fieldError = null;
    socket.emit("player:dive");
    await waitFor("dive gate error", () => (fieldError && fieldError.skill === "dive" ? fieldError : null));
    if (!/profund/i.test(fieldError.message || "")) fail(`expected deep-water gate, got: ${fieldError.message}`);
    log("  ✓ dive requires deep water (pairing + party-knows-Buceo verified)");

    log("\n✅ ALL FIELD-SKILL ASSERTIONS PASSED");
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n❌", e?.message || e); process.exit(1); });
