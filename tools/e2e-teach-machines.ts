/**
 * E2E: MO/MT (HM/TM) move-teaching items against a REAL server + REAL redis.
 *
 * Verifies the teach rail rewrite:
 *   A. MO (HM) teach — compatible species learns the move (display name + PP),
 *      and the reusable MO item is NOT consumed.
 *   B. MO reusability — teaching the same MO to a second mon still leaves qty 1.
 *   C. Compatibility gate — an incompatible species is rejected ("can't learn").
 *   D. 4-move replace flow — teaching to a full moveset asks for a replacement
 *      (inventory:teach-replace-needed), then replaces + sets PP.
 *   E. MT (TM) single-use — a compatible species learns it, the MT item is
 *      consumed (qty 1 -> 0), and a second teach fails ("no longer available").
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-teach-machines.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3998;
const TEST_MAP = "map-essentials-043";

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const fail = (msg: string): never => {
  throw new Error(`ASSERTION FAILED: ${msg}`);
};

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

async function waitFor<T>(what: string, fn: () => T | Promise<T>, { timeoutMs = 15000, everyMs = 200 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${lastErr}` : ""}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function mon(id: string, sourcePokemonId: string, moves: string[]) {
  const movePp: Record<string, number> = {};
  moves.forEach((m) => (movePp[m] = 20));
  return {
    id,
    sourcePokemonId,
    name: id,
    level: 30,
    types: ["Normal"],
    hp: 60,
    maxHp: 60,
    ivs: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 },
    moves,
    movePp,
    experience: 0,
    experienceCurve: "medium",
    nextLevelExperience: 1000,
    statBonuses: {}
  };
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  let socket: Socket | null = null;
  let testUserId: number | null = null;

  const cleanup = async () => {
    log("── cleanup ──");
    try { socket?.disconnect(); } catch {}
    if (server && !server.killed) {
      server.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 800));
      if (!server.killed) server.kill("SIGKILL");
    }
    if (redis?.isOpen) {
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
    log("redis reachable");

    log(`starting server on :${PORT} …`);
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(PORT), REDIS_URL, SMTP_ENABLED: "false", GIT_SHA: "e2e" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverLog = "";
    server.stdout!.on("data", (d) => { serverLog += d; });
    server.stderr!.on("data", (d) => { serverLog += d; process.stderr.write(`  [srv!] ${d}`); });
    await waitFor("server listening", () => serverLog.includes(`Listening on port ${PORT}`), { timeoutMs: 60000 });
    log("server is up");

    socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    let lastSession: any = null;
    let lastError: string | null = null;
    let replaceNeeded: any = null;
    socket.on("auth:session", (s: any) => { lastSession = s; });
    socket.on("auth:error", (e: any) => { lastError = e?.message ?? ""; log("  auth:error →", e?.message); });
    socket.on("auth:info", (e: any) => log("  auth:info →", e?.message));
    socket.on("inventory:teach-replace-needed", (d: any) => { replaceNeeded = d; log("  teach-replace-needed →", JSON.stringify(d)); });
    await waitFor("socket connect", () => socket!.connected);

    const uname = `e2eteach${Date.now().toString().slice(-8)}`;
    socket.emit("auth:register", { name: "Tester", username: uname, email: `${uname}@example.com`, password: "Aa1!aaaa" });
    const session = await waitFor("auth:session after register", () => (lastSession?.authenticated && lastSession?.user?.id ? lastSession : null));
    testUserId = Number(session.user.id);
    log(`registered user #${testUserId}`);

    const userKey = `auth:user:${testUserId}`;
    const party = [
      mon("p_cut", "pokemon-BULBASAUR", ["Placaje", "Gruñido"]),
      mon("p_cut2", "pokemon-BULBASAUR", ["Placaje"]),
      mon("p_bad", "pokemon-MAGIKARP", ["Salpicadura"]),
      mon("p_four", "pokemon-BULBASAUR", ["Placaje", "Gruñido", "Látigo Cepa", "Drenadoras"]),
      mon("p_mt", "pokemon-CHARMANDER", ["Arañazo"])
    ];
    const inventory = [
      { id: "item-hm01", name: "MO01", category: "moves", quantity: 1, description: "MO Corte" },
      { id: "item-tm01", name: "MT01", category: "moves", quantity: 1, description: "MT HoneClaws" }
    ];
    await redis.hSet(userKey, {
      last_map_id: TEST_MAP, last_x: "50", last_y: "41",
      pokemon_party: JSON.stringify(party),
      inventory: JSON.stringify(inventory),
      pokemon_box: JSON.stringify({ boxes: [] })
    });
    log("seeded party + inventory");

    const readParty = async () => JSON.parse((await redis!.hGet(userKey, "pokemon_party")) || "[]");
    const readInv = async () => JSON.parse((await redis!.hGet(userKey, "inventory")) || "[]");
    const qtyOf = (inv: any[], id: string) => inv.find((i) => i.id === id)?.quantity ?? 0;
    const movesOf = (pty: any[], id: string) => (pty.find((p) => p.id === id)?.moves ?? []) as string[];
    const ci = (arr: string[], sub: string) => arr.some((m) => m.toLowerCase() === sub.toLowerCase());

    // A — MO teach to compatible species, not consumed
    log("── A: MO teach (Corte → BULBASAUR) ──");
    lastError = null; lastSession = null;
    socket.emit("inventory:teach-move", { itemId: "item-hm01", targetPokemonId: "p_cut" });
    await waitFor("A auth:session", () => (lastSession ? lastSession : null));
    let pty = await readParty(); let inv = await readInv();
    if (!ci(movesOf(pty, "p_cut"), "Corte")) fail(`p_cut did not learn Corte (moves=${movesOf(pty, "p_cut")})`);
    if (!(pty.find((p: any) => p.id === "p_cut")?.movePp?.["Corte"] > 0)) fail("Corte has no PP");
    if (qtyOf(inv, "item-hm01") !== 1) fail(`MO consumed (qty=${qtyOf(inv, "item-hm01")}, expected 1)`);
    log("  ✓ learned Corte (+PP), MO not consumed");

    // B — MO reusable to a second mon
    log("── B: MO reusable (teach again) ──");
    lastSession = null;
    socket.emit("inventory:teach-move", { itemId: "item-hm01", targetPokemonId: "p_cut2" });
    await waitFor("B auth:session", () => (lastSession ? lastSession : null));
    pty = await readParty(); inv = await readInv();
    if (!ci(movesOf(pty, "p_cut2"), "Corte")) fail("p_cut2 did not learn Corte");
    if (qtyOf(inv, "item-hm01") !== 1) fail(`MO consumed on 2nd teach (qty=${qtyOf(inv, "item-hm01")})`);
    log("  ✓ second mon learned Corte, MO still qty 1");

    // C — incompatible species rejected
    log("── C: compatibility gate (MAGIKARP can't learn Corte) ──");
    lastError = null; lastSession = null;
    socket.emit("inventory:teach-move", { itemId: "item-hm01", targetPokemonId: "p_bad" });
    await waitFor("C auth:error", () => (lastError ? lastError : null));
    if (!/can't learn/i.test(lastError || "")) fail(`expected "can't learn", got "${lastError}"`);
    pty = await readParty();
    if (ci(movesOf(pty, "p_bad"), "Corte")) fail("MAGIKARP wrongly learned Corte");
    log("  ✓ rejected incompatible species");

    // D — 4-move replace flow
    log("── D: 4-move replace flow ──");
    replaceNeeded = null; lastError = null;
    socket.emit("inventory:teach-move", { itemId: "item-hm01", targetPokemonId: "p_four" });
    const rn = await waitFor("D teach-replace-needed", () => (replaceNeeded ? replaceNeeded : null));
    if (!/corte/i.test(rn.moveName || "")) fail(`replace-needed moveName not Corte (${rn.moveName})`);
    if (!Array.isArray(rn.moves) || rn.moves.length !== 4) fail("replace-needed did not carry 4 current moves");
    lastSession = null;
    socket.emit("inventory:teach-move", { itemId: "item-hm01", targetPokemonId: "p_four", replaceMoveName: "Placaje" });
    await waitFor("D auth:session", () => (lastSession ? lastSession : null));
    pty = await readParty();
    const fourMoves = movesOf(pty, "p_four");
    if (!ci(fourMoves, "Corte")) fail("p_four did not learn Corte after replace");
    if (ci(fourMoves, "Placaje")) fail("Placaje was not forgotten");
    if (fourMoves.length !== 4) fail(`p_four moveset len ${fourMoves.length}, expected 4`);
    log(`  ✓ replaced Placaje with Corte (moves=${fourMoves.join(", ")})`);

    // E — MT single-use consume
    log("── E: MT single-use (HoneClaws → CHARMANDER, consumed) ──");
    lastSession = null; lastError = null;
    socket.emit("inventory:teach-move", { itemId: "item-tm01", targetPokemonId: "p_mt" });
    await waitFor("E auth:session", () => (lastSession ? lastSession : null));
    pty = await readParty(); inv = await readInv();
    if (movesOf(pty, "p_mt").length < 2) fail("p_mt did not learn the MT move");
    if (qtyOf(inv, "item-tm01") !== 0) fail(`MT not consumed (qty=${qtyOf(inv, "item-tm01")}, expected 0)`);
    log("  ✓ MT learned + consumed (qty → 0)");
    lastError = null;
    socket.emit("inventory:teach-move", { itemId: "item-tm01", targetPokemonId: "p_mt" });
    await waitFor("E second-teach error", () => (lastError ? lastError : null));
    if (!/no longer available/i.test(lastError || "")) fail(`expected "no longer available", got "${lastError}"`);
    log("  ✓ second MT teach rejected (out of stock)");

    log("\n✅ ALL TEACH-RAIL ASSERTIONS PASSED");
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n❌", e?.message || e); process.exit(1); });
