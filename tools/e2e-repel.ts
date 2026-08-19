/**
 * E2E: Baygon Azul / Baygon Verde (SUPERREPEL / MAXREPEL) against a REAL
 * server + redis.
 *
 *   USE      — Baygon Azul consumes one unit, arms a 200-step charge and
 *              persists it as `repel_steps` on the character hash.
 *   NO-STACK — a second repellent while one is active is refused and NOT
 *              consumed (Essentials behaviour).
 *   SUPPRESS — walking 100%-encounter grass starts no battle while the
 *              charge lasts; each walked tile spends exactly one step.
 *   PERSIST  — a reconnect keeps the remaining charge (redis-backed).
 *   WEAR-OFF — the last step emits "El repelente se ha agotado" and deletes
 *              the redis field.
 *   VERDE    — Baygon Verde arms 250 steps.
 *   RESUME   — with no charge, the same grass immediately starts a battle.
 *
 * Mirrors tools/e2e-field-skills.ts (maps-blob backup/restore included).
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-repel.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3996;
const MAPS_KEY = "designer:section:maps";
const PROBE_KEY = `${MAPS_KEY}:probe`;

// Two adjacent open cells on map 043 (same pair e2e-field-skills stands on).
const TEST_MAP = "map-essentials-043";
const CELL_A = { x: 1, y: 1 };
const CELL_B = { x: 2, y: 1 };

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
    id, sourcePokemonId: "pokemon-BULBASAUR", name: id, level: 12, types: ["Grass"],
    hp: 40, maxHp: 40, ivs: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 },
    moves: ["Placaje"], movePp: { Placaje: 35 }, experience: 0, experienceCurve: "medium",
    nextLevelExperience: 3000, statBonuses: {}
  };
}
function bagItem(id: string, name: string, quantity: number) {
  return { id, name, category: "quest", quantity, description: `${name} description` };
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  let socket: Socket | null = null;
  let mapsBackup: string | null = null;
  let probeBackup: string | null = null;
  let testUserId: number | null = null;
  let testCharacterId: number | null = null;

  const cleanup = async () => {
    log("── cleanup ──");
    try { socket?.disconnect(); } catch {}
    if (server && !server.killed) { server.kill("SIGTERM"); await sleep(800); if (!server.killed) server.kill("SIGKILL"); }
    if (redis?.isOpen) {
      if (mapsBackup !== null) { await redis.set(MAPS_KEY, mapsBackup); if (probeBackup !== null) await redis.set(PROBE_KEY, probeBackup); else await redis.del(PROBE_KEY); log("restored maps blob"); }
      if (testUserId !== null) { try { await redis.del(`auth:user:${testUserId}`); } catch {} }
      if (testCharacterId !== null) { try { await redis.del(`auth:character:${testCharacterId}`); } catch {} }
      await redis.quit();
    }
  };

  // ── shared socket state ──
  let lastSession: any = null;
  let infos: any[] = [];
  let authErrors: any[] = [];
  let battleStates: any[] = [];
  let lastMove: any = null;

  const wireSocket = (s: Socket) => {
    s.on("auth:session", (d: any) => { lastSession = d; });
    s.on("auth:info", (d: any) => { infos.push(d); log("  info →", d?.message); });
    s.on("auth:error", (d: any) => { authErrors.push(d); log("  error →", d?.message); });
    s.on("battle:state", (d: any) => { battleStates.push(d); if (process.env.E2E_DEBUG) log("  battle:state →", d?.battle?.logs?.[0] ?? d?.logs?.[0] ?? "(state)"); });
    s.on("event:step", (d: any) => { if (process.env.E2E_DEBUG) log("  event:step →", JSON.stringify(d).slice(0, 160)); });
    s.onAny((event: string, data: any) => { if (event.startsWith("move")) { lastMove = data; if (process.env.E2E_DEBUG) log("  move →", JSON.stringify({ x: data?.x, y: data?.y, stopped: data?.stopped, teleported: data?.teleported })); } });
  };

  try {
    const running = (() => { try { return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]); } catch { return ""; } })();
    if (running !== REDIS_CONTAINER) { try { sh("docker", ["start", REDIS_CONTAINER]); } catch { sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]); } }
    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    redis.on("error", () => {});
    await waitFor("redis PING", async () => { if (!redis!.isOpen) await redis!.connect(); return (await redis!.ping()) === "PONG"; });

    // Inject two 100%-encounter grass cells (back up the maps blob first).
    const raw = await redis.get(MAPS_KEY);
    if (!raw) fail(`${MAPS_KEY} empty`);
    mapsBackup = raw!; probeBackup = await redis.get(PROBE_KEY);
    const payload = JSON.parse(raw!);
    const mapEd = payload.state.editorDataByMapId[TEST_MAP];
    if (!mapEd) fail(`${TEST_MAP} has no editorData`);
    mapEd.grass = (mapEd.grass ?? []).filter(
      (g: any) => !((g.x === CELL_A.x && g.y === CELL_A.y) || (g.x === CELL_B.x && g.y === CELL_B.y))
    );
    for (const cell of [CELL_A, CELL_B]) {
      mapEd.grass.push({
        id: `grass-e2e-repel-${cell.x}-${cell.y}`, x: cell.x, y: cell.y,
        encounterRate: 100, minLevel: 2, maxLevel: 3, pokemonIds: ["pokemon-BULBASAUR"]
      });
    }
    await redis.set(MAPS_KEY, JSON.stringify(payload));
    await redis.set(PROBE_KEY, `e2e:${Date.now()}`);
    log(`injected 100% grass at (${CELL_A.x},${CELL_A.y}) + (${CELL_B.x},${CELL_B.y}) on ${TEST_MAP}`);

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

    const uname = `e2erepel${Date.now().toString().slice(-8)}`;
    socket.emit("auth:register", { name: "Repeler", username: uname, email: `${uname}@example.com`, password: "Aa1!aaaa" });
    const session = await waitFor("register session", () => (lastSession?.authenticated && lastSession?.user?.id ? lastSession : null));
    testUserId = Number(session.user.id);
    testCharacterId = Number(session.user.characterId ?? testUserId);
    const charKey = `auth:character:${testCharacterId}`;
    const userKey = `auth:user:${testUserId}`;
    log(`registered #${testUserId} (character #${testCharacterId})`);

    await redis.hSet(charKey, {
      last_map_id: TEST_MAP, last_x: String(CELL_A.x * 32), last_y: String(CELL_A.y * 32),
      follower_enabled: "0", // the trailing follower would block the A<->B walk
      pokemon_party: JSON.stringify([mon("m1")]),
      inventory: JSON.stringify([
        bagItem("item-superrepel", "Baygon Azul", 2),
        bagItem("item-maxrepel", "Baygon Verde", 1)
      ])
    });
    await redis.hSet(userKey, { pokemon_box: JSON.stringify({ boxes: [] }) });

    const join = async () => {
      socket!.emit("addPlayer", { token: session.token });
      await sleep(1200);
    };
    const rejoin = async () => {
      socket!.disconnect();
      await sleep(1200); // let the disconnect handler persist location
      socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
      wireSocket(socket);
      await waitFor("reconnect", () => socket!.connected);
      await join();
    };
    await join();

    const repelSteps = async () => Number.parseInt((await redis!.hGet(charKey, "repel_steps")) ?? "0", 10) || 0;
    const bagQty = async (id: string) => {
      const inv = JSON.parse((await redis!.hGet(charKey, "inventory")) || "[]") as Array<{ id: string; quantity: number }>;
      return inv.find((i) => i.id === id)?.quantity ?? 0;
    };
    /** Walks one tile, re-issuing the move like the client drive loop does
     *  (a step blocked by the trailing follower only frees up after the shove,
     *  so a single emit can stall — see player.ts shovePastObstacle). */
    const walkTo = async (cell: { x: number; y: number }) => {
      lastMove = null;
      const drive = setInterval(() => socket!.emit("move", { x: cell.x * 32, y: cell.y * 32 }), 150);
      try {
        socket!.emit("move", { x: cell.x * 32, y: cell.y * 32 });
        await waitFor(`arrive (${cell.x},${cell.y})`, () => (lastMove && lastMove.x === cell.x * 32 && lastMove.y === cell.y * 32 ? lastMove : null), { timeoutMs: 8000 });
      } finally {
        clearInterval(drive);
      }
      socket!.emit("stopMove");
      await sleep(250);
    };

    // ── USE: Baygon Azul arms 200 steps and consumes one unit ──
    log("── USE Baygon Azul ──");
    infos = [];
    socket.emit("inventory:use-item", { itemId: "item-superrepel" });
    await waitFor("use confirmation", () => infos.find((i) => /200 pasos/.test(i?.message ?? "")) ?? null);
    if ((await repelSteps()) !== 200) fail(`repel_steps should be 200, got ${await repelSteps()}`);
    if ((await bagQty("item-superrepel")) !== 1) fail("Baygon Azul should have been consumed once");
    log("  ✓ armed 200 steps, one unit consumed, persisted to redis");

    // ── NO-STACK: a second repellent is refused and not consumed ──
    log("── NO-STACK ──");
    authErrors = [];
    socket.emit("inventory:use-item", { itemId: "item-superrepel" });
    await waitFor("stack refusal", () => authErrors.find((e) => /repelente activo/i.test(e?.message ?? "")) ?? null);
    if ((await bagQty("item-superrepel")) !== 1) fail("refused repellent must not be consumed");
    if ((await repelSteps()) !== 200) fail("refused repellent must not reset the charge");
    log("  ✓ refused while active, nothing consumed");

    // ── SUPPRESS: 4 walked tiles over 100% grass, no battle, 4 steps spent ──
    log("── SUPPRESS ──");
    battleStates = [];
    for (const cell of [CELL_B, CELL_A, CELL_B, CELL_A]) await walkTo(cell);
    if (battleStates.length > 0) fail("wild battle started while repel was active");
    const afterWalk = await repelSteps();
    if (afterWalk !== 196) fail(`expected 196 steps after 4 tiles, got ${afterWalk}`);
    log("  ✓ 4 tiles walked on 100% grass: no battle, charge 200→196");

    // ── PERSIST: reconnect keeps the charge running ──
    log("── PERSIST ──");
    await rejoin();
    battleStates = [];
    for (const cell of [CELL_B, CELL_A]) await walkTo(cell);
    if (battleStates.length > 0) fail("wild battle started after reconnect with repel active");
    const afterRejoin = await repelSteps();
    if (afterRejoin !== 194) fail(`expected 194 steps after reconnect + 2 tiles, got ${afterRejoin}`);
    log("  ✓ reconnect kept the charge: 196→194, still suppressed");

    // ── WEAR-OFF: force 2 remaining steps, walk them off ──
    log("── WEAR-OFF ──");
    await redis.hSet(charKey, { repel_steps: "2" });
    await rejoin(); // reload the in-memory charge from redis
    infos = []; battleStates = [];
    for (const cell of [CELL_B, CELL_A]) await walkTo(cell);
    await waitFor("wear-off message", () => infos.find((i) => /repelente se ha agotado/i.test(i?.message ?? "")) ?? null);
    if (battleStates.length > 0) fail("battle started during the final repel steps");
    if ((await redis.hGet(charKey, "repel_steps")) !== null) fail("repel_steps field should be deleted when depleted");
    log("  ✓ wear-off message emitted, redis field deleted");

    // ── VERDE: Baygon Verde arms 250 steps ──
    log("── USE Baygon Verde ──");
    infos = [];
    socket.emit("inventory:use-item", { itemId: "item-maxrepel" });
    await waitFor("verde confirmation", () => infos.find((i) => /250 pasos/.test(i?.message ?? "")) ?? null);
    if ((await repelSteps()) !== 250) fail(`repel_steps should be 250, got ${await repelSteps()}`);
    if ((await bagQty("item-maxrepel")) !== 0) fail("Baygon Verde should have been consumed");
    log("  ✓ Baygon Verde armed 250 steps");

    // ── RESUME: clear the charge, the same grass battles immediately ──
    log("── RESUME (no repel → battle) ──");
    await redis.hDel(charKey, "repel_steps");
    await rejoin(); // drop the in-memory charge too
    battleStates = [];
    socket.emit("move", { x: CELL_B.x * 32, y: CELL_B.y * 32 });
    await waitFor("wild battle", () => battleStates[0] ?? null, { timeoutMs: 10000 });
    socket.emit("stopMove");
    log("  ✓ encounter fired on the very same grass without repel");

    log("\n✅ ALL REPEL ASSERTIONS PASSED");
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n❌", e?.message || e); process.exit(1); });
