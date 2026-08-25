/**
 * E2E: global berry plots against a REAL server + redis.
 *
 *   SEED       — the 17 imported "BerryPlant" events become plots in
 *                `world:berry-plots`; authored trees seed ripe (Ruta1 ev10 =
 *                ORANBERRY, stage 5), soil patches seed empty.
 *   SYNC       — joining the map delivers berry:sync with every plot.
 *   TOO-FAR    — acting on a plot 3 tiles away is refused (berry.reason.tooFar).
 *   HARVEST    — the ripe Oran tree yields 2..5 berries (PBS yield range),
 *                lands in the bag, empties the plot for EVERYONE (observer
 *                socket gets berry:update) and persists in redis.
 *   PLANT      — a Cheri berry from the bag goes into the empty soil (bag -1,
 *                plot = CHERIBERRY stage 1, plantedBy = character name,
 *                observer notified, persisted).
 *   NOT-RIPE   — harvesting right away is refused.
 *   GROW       — with BERRY_GROWTH_SCALE the 4 stages elapse in seconds on
 *                the SERVER clock; then harvest yields 2..5 Cheri.
 *   CLEAR      — clearing a planted plot empties it without any berries.
 *   NO-BERRIES — an empty bag cannot plant (advisory reason).
 *   INTERACT   — event:interact on a plot placement never runs the imported
 *                pbPickBerry script (no event dialog), it re-syncs the plots.
 *   PERSIST    — a server restart keeps the harvested tree EMPTY (plots are
 *                seeded once, never re-seeded from the authored page).
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-berries.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { resolve } from "path";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = resolve(__dirname, "..");
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3995;
const PLOTS_KEY = "world:berry-plots";
/** 3h/stage Cheri -> 3*3600000*0.0002 = 2160 ms per stage, ripe in ~8.6 s. */
const GROWTH_SCALE = "0.0002";

const TEST_MAP = "map-essentials-020"; // Ruta1
const ORAN_TREE = "npc-map-essentials-020-ev10"; // (34,37) authored ripe Oran tree
const SOIL = "npc-map-essentials-020-ev17"; // (34,38) empty soil
const FAR_TREE = "npc-map-essentials-020-ev12"; // (34,39) Chesto tree
const START = { x: 33, y: 37 }; // adjacent to ORAN_TREE only
const SOIL_SIDE = { x: 33, y: 38 }; // adjacent to SOIL
const OBSERVER_AT = { x: 33, y: 40 };

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const fail = (msg: string): never => { throw new Error(`ASSERTION FAILED: ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}
async function waitFor<T>(what: string, fn: () => T | Promise<T>, { timeoutMs = 15000, everyMs = 120 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${lastErr}` : ""}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
function mon(id: string) {
  return {
    id, sourcePokemonId: "pokemon-BULBASAUR", name: id, level: 12, types: ["Grass"],
    hp: 40, maxHp: 40, ivs: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 },
    moves: ["Placaje"], movePp: { Placaje: 35 }, experience: 0, experienceCurve: "medium",
    nextLevelExperience: 3000, statBonuses: {}
  };
}

type Client = {
  socket: Socket;
  session: any;
  token: string;
  userId: number;
  characterId: number;
  syncs: any[];
  updates: any[];
  results: any[];
  actions: any[];
  eventSteps: any[];
  infos: any[];
  lastMove: any;
};

function wire(c: Client) {
  const s = c.socket;
  s.on("auth:session", (d: any) => { if (d?.authenticated) c.session = d; });
  s.on("auth:info", (d: any) => c.infos.push(d));
  s.on("berry:sync", (d: any) => c.syncs.push(d));
  s.on("berry:update", (d: any) => c.updates.push(d));
  s.on("berry:result", (d: any) => { c.results.push(d); log("  result →", d.action, d.ok ? "ok" : "refused", d.messageKey, JSON.stringify(d.params ?? {})); });
  s.on("berry:actions-result", (d: any) => c.actions.push(d));
  s.on("event:step", (d: any) => c.eventSteps.push(d));
  s.onAny((event: string, data: any) => { if (event.startsWith("move")) c.lastMove = data; });
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  let plotsBackup: string | null = null;
  const clients: Client[] = [];

  const startServer = async () => {
    log(`starting server on :${PORT} (BERRY_GROWTH_SCALE=${GROWTH_SCALE}) …`);
    const child = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(PORT), REDIS_URL, SMTP_ENABLED: "false", GIT_SHA: "e2e", BERRY_GROWTH_SCALE: GROWTH_SCALE },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverLog = "";
    child.stdout!.on("data", (d) => { serverLog += d; if (process.env.E2E_DEBUG) process.stdout.write(`  [srv] ${d}`); });
    child.stderr!.on("data", (d) => { serverLog += d; process.stderr.write(`  [srv!] ${d}`); });
    await waitFor("server listening", () => serverLog.includes(`Listening on port ${PORT}`), { timeoutMs: 60000 });
    log("server up");
    return child;
  };
  const stopServer = async () => {
    if (server && !server.killed) { server.kill("SIGTERM"); await sleep(800); if (!server.killed) server.kill("SIGKILL"); }
    server = null;
  };

  const cleanup = async () => {
    log("── cleanup ──");
    for (const c of clients) { try { c.socket.disconnect(); } catch {} }
    await stopServer();
    if (redis?.isOpen) {
      if (plotsBackup !== null) await redis.set(PLOTS_KEY, plotsBackup); else await redis.del(PLOTS_KEY);
      for (const c of clients) {
        try { await redis.del(`auth:user:${c.userId}`); await redis.del(`auth:character:${c.characterId}`); } catch {}
      }
      await redis.quit();
    }
  };

  const connect = (): Socket => io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });

  const register = async (name: string, at: { x: number; y: number }, inventory: unknown[]): Promise<Client> => {
    const socket = connect();
    const c: Client = { socket, session: null, token: "", userId: 0, characterId: 0, syncs: [], updates: [], results: [], actions: [], eventSteps: [], infos: [], lastMove: null };
    wire(c);
    await waitFor("connect", () => socket.connected);
    const uname = `e2eberry${name.toLowerCase()}${Date.now().toString().slice(-7)}`;
    socket.emit("auth:register", { name, username: uname, email: `${uname}@example.com`, password: "Aa1!aaaa" });
    const session = await waitFor("register session", () => (c.session?.user?.id ? c.session : null));
    c.token = session.token;
    c.userId = Number(session.user.id);
    c.characterId = Number(session.user.characterId ?? c.userId);
    await redis!.hSet(`auth:character:${c.characterId}`, {
      last_map_id: TEST_MAP, last_x: String(at.x * 32), last_y: String(at.y * 32),
      event_self_switches: JSON.stringify({ "129:2:A": true }),
      follower_enabled: "0",
      pokemon_party: JSON.stringify([mon(`${name}-m1`)]),
      inventory: JSON.stringify(inventory)
    });
    await redis!.hSet(`auth:user:${c.userId}`, { pokemon_box: JSON.stringify({ boxes: [] }) });
    clients.push(c);
    log(`registered ${name} #${c.userId} (character #${c.characterId})`);
    return c;
  };

  const join = async (c: Client) => {
    c.socket.emit("addPlayer", { token: c.token });
    await sleep(1200);
  };
  const bagQty = async (c: Client, id: string) => {
    const inv = JSON.parse((await redis!.hGet(`auth:character:${c.characterId}`, "inventory")) || "[]") as Array<{ id: string; quantity: number }>;
    return inv.find((i) => i.id === id)?.quantity ?? 0;
  };
  const redisPlot = async (id: string) => {
    const all = JSON.parse((await redis!.get(PLOTS_KEY)) || "[]") as any[];
    return all.find((p) => p.id === id) ?? null;
  };
  const walkTo = async (c: Client, cell: { x: number; y: number }) => {
    c.lastMove = null;
    const drive = setInterval(() => c.socket.emit("move", { x: cell.x * 32, y: cell.y * 32 }), 150);
    try {
      c.socket.emit("move", { x: cell.x * 32, y: cell.y * 32 });
      await waitFor(`arrive (${cell.x},${cell.y})`, () => (c.lastMove && c.lastMove.x === cell.x * 32 && c.lastMove.y === cell.y * 32 ? c.lastMove : null), { timeoutMs: 8000 });
    } finally { clearInterval(drive); }
    c.socket.emit("stopMove");
    await sleep(250);
  };
  const act = async (c: Client, event: string, payload: any, action: string) => {
    const before = c.results.length;
    c.socket.emit(event, payload);
    return waitFor(`${event} result`, () => c.results.slice(before).find((r) => r.action === action) ?? null);
  };
  const ask = async (c: Client, plotId: string) => {
    const before = c.actions.length;
    c.socket.emit("berry:actions", { plotId });
    return waitFor("berry:actions-result", () => c.actions.slice(before).find((r) => r.plotId === plotId) ?? null);
  };
  const lastUpdateFor = (c: Client, plotId: string) => [...c.updates].reverse().find((u) => u.plot?.id === plotId)?.plot ?? null;

  try {
    const running = (() => { try { return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]); } catch { return ""; } })();
    if (running !== REDIS_CONTAINER) { try { sh("docker", ["start", REDIS_CONTAINER]); } catch { sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]); } }
    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    redis.on("error", () => {});
    await waitFor("redis PING", async () => { if (!redis!.isOpen) await redis!.connect(); return (await redis!.ping()) === "PONG"; });

    // Fresh plot state so seeding is observable; the live state is restored on exit.
    plotsBackup = await redis.get(PLOTS_KEY);
    await redis.del(PLOTS_KEY);

    server = await startServer();

    // ── SYNC ──
    log("── SYNC ──");
    const actor = await register("Bayero", START, [
      { id: "item-cheriberry", name: "Baya Zreza", category: "berries", quantity: 2, description: "Baya" }
    ]);
    const observer = await register("Mirona", OBSERVER_AT, []);
    await join(actor);
    await join(observer);
    // ── SEED (plots are discovered when the maps snapshot is first applied,
    // i.e. on the first join — the multi-MB maps parse is deliberately lazy) ──
    log("── SEED ──");
    const seeded = (await waitFor("seeded plots", async () => { const raw = await redis!.get(PLOTS_KEY); return raw ? (JSON.parse(raw) as any[]) : null; }, { timeoutMs: 10000 })) as any[];
    if (seeded.length < 17) fail(`expected >= 17 seeded plots, got ${seeded.length}`);
    const oranSeed = seeded.find((p) => p.id === ORAN_TREE);
    const soilSeed = seeded.find((p) => p.id === SOIL);
    if (oranSeed?.berryId !== "ORANBERRY" || typeof oranSeed?.plantedAt !== "number") fail(`Oran tree should seed as ORANBERRY: ${JSON.stringify(oranSeed)}`);
    if (!soilSeed || soilSeed.berryId !== null) fail(`soil should seed empty: ${JSON.stringify(soilSeed)}`);
    log(`  ✓ ${seeded.length} plots seeded; ev10=ORANBERRY, ev17=empty`);

    const sync = await waitFor("actor berry:sync", () => actor.syncs.find((s) => s.mapId === TEST_MAP) ?? null);
    const oranSynced = sync.plots.find((p: any) => p.id === ORAN_TREE);
    const soilSynced = sync.plots.find((p: any) => p.id === SOIL);
    if (sync.plots.length !== 5) fail(`Ruta1 should sync 5 plots, got ${sync.plots.length}`);
    if (oranSynced?.stage !== 5 || oranSynced?.berryId !== "ORANBERRY" || oranSynced?.itemId !== "item-oranberry") fail(`Oran tree sync wrong: ${JSON.stringify(oranSynced)}`);
    if (soilSynced?.berryId !== null || soilSynced?.stage !== 0) fail(`soil sync wrong: ${JSON.stringify(soilSynced)}`);
    if (typeof sync.t !== "number") fail("berry:sync must carry the server clock t");
    if (!observer.syncs.find((s) => s.mapId === TEST_MAP)) fail("observer did not get berry:sync");
    log("  ✓ berry:sync: 5 plots, Oran ripe (stage 5), soil empty, server clock present");

    // ── TOO-FAR ──
    log("── TOO-FAR ──");
    const far = await act(actor, "berry:clear", { plotId: FAR_TREE }, "clear");
    if (far.ok || far.messageKey !== "berry.reason.tooFar") fail(`expected tooFar, got ${JSON.stringify(far)}`);
    if ((await redisPlot(FAR_TREE))?.berryId !== "CHESTOBERRY") fail("far tree must be untouched");
    log("  ✓ plot 3 tiles away refused, untouched");

    // ── HARVEST ──
    log("── HARVEST ripe Oran tree ──");
    const before = await ask(actor, ORAN_TREE);
    if (!before.canHarvest || !before.canClear || before.canPlant) fail(`ripe tree actions wrong: ${JSON.stringify(before)}`);
    observer.updates = [];
    const harvest = await act(actor, "berry:harvest", { plotId: ORAN_TREE }, "harvest");
    if (!harvest.ok || harvest.messageKey !== "berry.msg.harvested") fail(`harvest failed: ${JSON.stringify(harvest)}`);
    const oranCount = Number(harvest.params?.count);
    if (!(oranCount >= 2 && oranCount <= 5)) fail(`Oran yield must be 2..5, got ${harvest.params?.count}`);
    if (harvest.params?.name !== "Baya Aranja") fail(`expected Spanish item name, got ${harvest.params?.name}`);
    if ((await bagQty(actor, "item-oranberry")) !== oranCount) fail(`bag should hold ${oranCount} Oran`);
    await waitFor("observer update", () => lastUpdateFor(observer, ORAN_TREE));
    if (lastUpdateFor(observer, ORAN_TREE)?.berryId !== null) fail("observer should see the tree emptied");
    if ((await redisPlot(ORAN_TREE))?.berryId !== null) fail("harvested tree must persist as empty");
    if (!(actor.session?.user?.inventory ?? []).find((i: any) => i.id === "item-oranberry" && i.quantity === oranCount)) fail("auth:session refresh should carry the harvested berries");
    log(`  ✓ harvested Baya Aranja x${oranCount}; plot emptied for everyone; persisted; bag refreshed`);

    // ── PLANT ──
    log("── PLANT Cheri in the soil ──");
    await walkTo(actor, SOIL_SIDE);
    const soilActions = await ask(actor, SOIL);
    if (!soilActions.canPlant || soilActions.canHarvest || soilActions.canClear) fail(`soil actions wrong: ${JSON.stringify(soilActions)}`);
    const cheriOption = soilActions.berries.find((b: any) => b.itemId === "item-cheriberry");
    if (!cheriOption || cheriOption.quantity !== 2 || cheriOption.berryId !== "CHERIBERRY" || cheriOption.hoursPerStage !== 3) fail(`plantable list wrong: ${JSON.stringify(soilActions.berries)}`);
    observer.updates = [];
    const plant = await act(actor, "berry:plant", { plotId: SOIL, itemId: "item-cheriberry" }, "plant");
    if (!plant.ok || plant.messageKey !== "berry.msg.planted" || plant.params?.hours !== "12") fail(`plant failed: ${JSON.stringify(plant)}`);
    if ((await bagQty(actor, "item-cheriberry")) !== 1) fail("planting must consume one Cheri");
    const planted = await waitFor("observer plant update", () => lastUpdateFor(observer, SOIL));
    if (planted.berryId !== "CHERIBERRY" || planted.stage !== 1 || planted.plantedBy !== "Bayero" || typeof planted.ripeAt !== "number") fail(`planted plot wrong: ${JSON.stringify(planted)}`);
    const persisted = await redisPlot(SOIL);
    if (persisted?.berryId !== "CHERIBERRY" || persisted?.plantedBy !== "Bayero") fail(`plant not persisted: ${JSON.stringify(persisted)}`);
    log("  ✓ planted CHERIBERRY (stage 1, by Bayero), bag 2→1, observer notified, persisted");

    // ── NOT-RIPE ──
    log("── NOT-RIPE ──");
    const early = await act(actor, "berry:harvest", { plotId: SOIL }, "harvest");
    if (early.ok || early.messageKey !== "berry.reason.notRipe") fail(`expected notRipe, got ${JSON.stringify(early)}`);
    if ((await redisPlot(SOIL))?.berryId !== "CHERIBERRY") fail("refused harvest must not touch the plot");
    log("  ✓ harvesting a sprout is refused");

    // ── GROW ──
    log("── GROW (server clock) ──");
    const ripe = await waitFor("plot ripe", async () => { const a = await ask(actor, SOIL); return a.canHarvest ? a : null; }, { timeoutMs: 30000, everyMs: 700 });
    if (ripe.plot?.stage !== 5) fail(`ripe plot should report stage 5: ${JSON.stringify(ripe.plot)}`);
    const grown = await act(actor, "berry:harvest", { plotId: SOIL }, "harvest");
    const cheriCount = Number(grown.params?.count);
    if (!grown.ok || !(cheriCount >= 2 && cheriCount <= 5)) fail(`grown harvest wrong: ${JSON.stringify(grown)}`);
    if ((await bagQty(actor, "item-cheriberry")) !== 1 + cheriCount) fail("bag should hold 1 + harvested Cheri");
    log(`  ✓ grew through 4 stages on the server clock, harvested Baya Zreza x${cheriCount}`);

    // ── CLEAR ──
    log("── CLEAR ──");
    const replant = await act(actor, "berry:plant", { plotId: SOIL, itemId: "item-cheriberry" }, "plant");
    if (!replant.ok) fail(`replant failed: ${JSON.stringify(replant)}`);
    const cheriBeforeClear = await bagQty(actor, "item-cheriberry");
    observer.updates = [];
    const cleared = await act(actor, "berry:clear", { plotId: SOIL }, "clear");
    if (!cleared.ok || cleared.messageKey !== "berry.msg.cleared") fail(`clear failed: ${JSON.stringify(cleared)}`);
    if ((await bagQty(actor, "item-cheriberry")) !== cheriBeforeClear) fail("clearing must not yield berries");
    await waitFor("observer clear update", () => lastUpdateFor(observer, SOIL));
    if (lastUpdateFor(observer, SOIL)?.berryId !== null) fail("observer should see the plot cleared");
    if ((await redisPlot(SOIL))?.berryId !== null) fail("cleared plot must persist empty");
    const emptyAgain = await act(actor, "berry:clear", { plotId: SOIL }, "clear");
    if (emptyAgain.ok || emptyAgain.messageKey !== "berry.reason.empty") fail(`clearing empty soil should refuse: ${JSON.stringify(emptyAgain)}`);
    log("  ✓ cleared without yield, observer notified, persisted; clearing empty soil refused");

    // ── NO-BERRIES ──
    log("── NO-BERRIES ──");
    await redis.hSet(`auth:character:${actor.characterId}`, { inventory: "[]" });
    const bare = await ask(actor, SOIL);
    if (bare.canPlant || bare.reasonKey !== "berry.reason.noBerries" || bare.berries.length !== 0) fail(`empty bag actions wrong: ${JSON.stringify(bare)}`);
    const bareResult = await act(actor, "berry:plant", { plotId: SOIL, itemId: "item-cheriberry" }, "plant");
    if (bareResult.ok || bareResult.messageKey !== "berry.reason.noBerries") fail(`planting from an empty bag should refuse: ${JSON.stringify(bareResult)}`);
    log("  ✓ empty bag cannot plant (advisory + enforced)");

    // ── INTERACT guard ──
    log("── INTERACT guard ──");
    actor.syncs = []; actor.eventSteps = [];
    actor.socket.emit("event:interact", { npcPlacementId: SOIL });
    await waitFor("re-sync", () => actor.syncs.find((s) => s.mapId === TEST_MAP) ?? null);
    await sleep(800);
    if (actor.eventSteps.length > 0) fail("event:interact on a plot must not run the imported script");
    log("  ✓ event:interact on a plot re-syncs and never opens the pbBerryPlant/pbPickBerry event");

    // ── PERSIST across restart ──
    log("── PERSIST (server restart) ──");
    await stopServer();
    server = await startServer();
    actor.socket.disconnect();
    await sleep(300);
    actor.socket = connect(); wire(actor); actor.syncs = [];
    await waitFor("reconnect", () => actor.socket.connected);
    await join(actor);
    const after = await waitFor("post-restart sync", () => actor.syncs.find((s) => s.mapId === TEST_MAP) ?? null);
    const oranAfter = after.plots.find((p: any) => p.id === ORAN_TREE);
    if (!oranAfter || oranAfter.berryId !== null) fail(`harvested tree must stay empty after restart: ${JSON.stringify(oranAfter)}`);
    if (after.plots.find((p: any) => p.id === FAR_TREE)?.berryId !== "CHESTOBERRY") fail("untouched tree must survive restart");
    log("  ✓ restart keeps the harvested tree empty and the untouched tree ripe");

    log("\n✅ ALL BERRY ASSERTIONS PASSED");
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n❌", e?.message || e); process.exit(1); });
