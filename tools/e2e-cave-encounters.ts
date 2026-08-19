/**
 * E2E: cave-style wild encounters against a REAL server + redis.
 *
 * Map 158 "???" is a Cave-table map: no grass tiles at all (terrain tags are
 * all zero), so walking encounters must roll on ANY walked tile from the
 * map's Essentials "Cave" table — Essentials' has_cave_encounters? rule.
 *
 *   CAVE-STEP — walking one tile on map-essentials-158 (Cave density forced
 *               to 100%) starts a wild battle.
 *   SPECIES   — the wild Venomon is drawn from the map's Cave table.
 *   BACKDROP  — battle:state carries battleBack "Cave" (the map's metadata
 *               backdrop, resolved with the cave step context).
 *
 * Mirrors tools/e2e-repel.ts (encounters-blob backup/restore included).
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-cave-encounters.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3995;
const ENCOUNTERS_KEY = "designer:section:encounters";
const PROBE_KEY = `${ENCOUNTERS_KEY}:probe`;

// Two adjacent open cells on "???" (collision grid checked offline).
const TEST_MAP = "map-essentials-158";
const ENCOUNTER_MAP_KEY = "158";
const CELL_A = { x: 14, y: 4 };
const CELL_B = { x: 15, y: 4 };
const CAVE_SPECIES = ["MUK", "WEEZING", "QUILAVA"];

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const fail = (msg: string): never => { throw new Error(`ASSERTION FAILED: ${msg}`); };

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}
async function waitFor<T>(what: string, fn: () => T | Promise<T>, { timeoutMs = 15000, everyMs = 150 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${lastErr}` : ""}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mon(id: string) {
  return {
    id, sourcePokemonId: "pokemon-BULBASAUR", name: id, level: 60, types: ["Grass"],
    hp: 160, maxHp: 160, ivs: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 },
    moves: ["Placaje"], movePp: { Placaje: 35 }, experience: 0, experienceCurve: "medium",
    nextLevelExperience: 300000, statBonuses: {}
  };
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  let socket: Socket | null = null;
  let encountersBackup: string | null = null;
  let probeBackup: string | null = null;
  let testUserId: number | null = null;
  let testCharacterId: number | null = null;

  const cleanup = async () => {
    log("── cleanup ──");
    try { socket?.disconnect(); } catch {}
    if (server && !server.killed) { server.kill("SIGTERM"); await sleep(800); if (!server.killed) server.kill("SIGKILL"); }
    if (redis?.isOpen) {
      if (encountersBackup !== null) { await redis.set(ENCOUNTERS_KEY, encountersBackup); if (probeBackup !== null) await redis.set(PROBE_KEY, probeBackup); else await redis.del(PROBE_KEY); log("restored encounters blob"); }
      if (testUserId !== null) { try { await redis.del(`auth:user:${testUserId}`); } catch {} }
      if (testCharacterId !== null) { try { await redis.del(`auth:character:${testCharacterId}`); } catch {} }
      await redis.quit();
    }
  };

  // ── shared socket state ──
  let lastSession: any = null;
  let battleStates: any[] = [];
  let lastMove: any = null;

  const wireSocket = (s: Socket) => {
    s.on("auth:session", (d: any) => { lastSession = d; });
    s.on("auth:error", (d: any) => { log("  error →", d?.message); });
    s.on("battle:state", (d: any) => { battleStates.push(d); });
    s.onAny((event: string, data: any) => { if (event.startsWith("move")) lastMove = data; });
  };

  try {
    const running = (() => { try { return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]); } catch { return ""; } })();
    if (running !== REDIS_CONTAINER) { try { sh("docker", ["start", REDIS_CONTAINER]); } catch { sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]); } }
    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    redis.on("error", () => {});
    await waitFor("redis PING", async () => { if (!redis!.isOpen) await redis!.connect(); return (await redis!.ping()) === "PONG"; });

    // Force the map's Cave density to 100% (back up the encounters blob first).
    const raw = await redis.get(ENCOUNTERS_KEY);
    if (!raw) fail(`${ENCOUNTERS_KEY} empty`);
    encountersBackup = raw!; probeBackup = await redis.get(PROBE_KEY);
    const payload = JSON.parse(raw!);
    const item = (payload.state.items as any[]).find((i) => i?.encounterProfile?.mapId === ENCOUNTER_MAP_KEY);
    if (!item) fail(`no encounter item for map ${ENCOUNTER_MAP_KEY}`);
    const caveTable = (item.encounterProfile.tables as any[]).find((t) => t?.method === "Cave");
    if (!caveTable?.rows?.length) fail(`map ${ENCOUNTER_MAP_KEY} has no Cave table`);
    caveTable.density = 100;
    await redis.set(ENCOUNTERS_KEY, JSON.stringify(payload));
    await redis.set(PROBE_KEY, `e2e:${Date.now()}`);
    log(`forced Cave density=100 on map ${ENCOUNTER_MAP_KEY} (${caveTable.rows.length} rows)`);

    log(`starting server on :${PORT} …`);
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), REDIS_URL, SMTP_ENABLED: "false", GIT_SHA: "e2e" }, stdio: ["ignore", "pipe", "pipe"] });
    let serverLog = "";
    server.stdout!.on("data", (d) => { serverLog += d; });
    server.stderr!.on("data", (d) => { serverLog += d; process.stderr.write(`  [srv!] ${d}`); });
    await waitFor("server listening", () => serverLog.includes(`Listening on port ${PORT}`), { timeoutMs: 60000 });
    log("server up");

    socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    wireSocket(socket);
    await waitFor("connect", () => socket!.connected);

    const uname = `e2ecave${Date.now().toString().slice(-8)}`;
    socket.emit("auth:register", { name: "Cavernicola", username: uname, email: `${uname}@example.com`, password: "Aa1!aaaa" });
    const session = await waitFor("register session", () => (lastSession?.authenticated && lastSession?.user?.id ? lastSession : null));
    testUserId = Number(session.user.id);
    testCharacterId = Number(session.user.characterId ?? testUserId);
    log(`registered #${testUserId} (character #${testCharacterId})`);

    await redis.hSet(`auth:character:${testCharacterId}`, {
      last_map_id: TEST_MAP, last_x: String(CELL_A.x * 32), last_y: String(CELL_A.y * 32),
      follower_enabled: "0",
      pokemon_party: JSON.stringify([mon("m1")])
    });
    await redis.hSet(`auth:user:${testUserId}`, { pokemon_box: JSON.stringify({ boxes: [] }) });

    socket.emit("addPlayer", { token: session.token });
    await sleep(1200);

    // ── CAVE-STEP: one walked tile on the grass-less map starts a battle ──
    log("── CAVE-STEP ──");
    battleStates = [];
    const drive = setInterval(() => socket!.emit("move", { x: CELL_B.x * 32, y: CELL_B.y * 32 }), 150);
    let battle: any;
    try {
      socket.emit("move", { x: CELL_B.x * 32, y: CELL_B.y * 32 });
      battle = await waitFor("wild battle on cave tile", () => battleStates[0] ?? null, { timeoutMs: 10000 });
    } finally {
      clearInterval(drive);
      socket.emit("stopMove");
    }
    log("  ✓ wild battle started walking a grass-less cave map");

    // ── SPECIES: the wild side comes from the Cave table ──
    const serialized = JSON.stringify(battle);
    const found = CAVE_SPECIES.find((species) => serialized.includes(species));
    if (!found) fail(`wild species not from the Cave table (expected one of ${CAVE_SPECIES.join("/")})`);
    log(`  ✓ wild species from the Cave table: ${found}`);

    // ── BACKDROP: the battle carries the map's Cave battleback ──
    if (battle.battleBack !== "Cave") fail(`battleBack should be "Cave", got ${JSON.stringify(battle.battleBack)}`);
    log("  ✓ battle:state.battleBack = \"Cave\"");

    log("\n✅ ALL CAVE ENCOUNTER ASSERTIONS PASSED");
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n❌", e?.message || e); process.exit(1); });
