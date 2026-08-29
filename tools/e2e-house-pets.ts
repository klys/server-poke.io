/**
 * E2E: house pets (HousePets.ts + HouseRoamers.ts) against a REAL server +
 * redis, with pet time accelerated (PET_TIME_SCALE) so a pet's whole life
 * plays out in seconds.
 *
 *   SEED     — maps blob gets one HOUSE template + a door on Ruta1 and the
 *              items section a berry (bag ids must exist in the catalog).
 *   GENDER   — every party venomon carries a persisted gender; one seeded
 *              without gets one assigned on login (lazy migration).
 *   LEAVE    — house:pet-leave moves a party venomon into the house: it
 *              leaves the party (auth:session), shows up on the follower
 *              channel for everyone inside (roam:<char>:<id>), is persisted
 *              in world:house-pets; leaving the LAST non-egg venomon is refused;
 *              a visitor may leave a pet in someone else's house.
 *   WALK     — pets walk multi-cell paths (consecutive chained steps) and
 *              visit several distinct cells.
 *   PUSH     — a player walking into a pet displaces it (shove step, 180ms).
 *   HUNGER   — hunger climbs on the wall clock: a "hungry" alert reaches the
 *              owner live (pet:notification) and is persisted on the character;
 *              feeding with a berry (bag -1) resets it.
 *   MATING   — a fed male + female pair courts (❤️, courting flag) and the
 *              female lays an egg on the floor; only the mother's owner can
 *              collect it (party +1 egg).
 *   PUKE     — a starving pet throws up (mess on the floor, "sick" alert);
 *              anyone inside can clean it.
 *   TAKE     — house:pet-take returns the pet to the party (follower:remove).
 *   OFFLINE  — with everybody outside, pets keep living: alerts still arrive
 *              (persisted), and a reconnecting owner gets pet:notifications;
 *              dismiss removes one; a server restart keeps the pets.
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-house-pets.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { resolve } from "path";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = resolve(__dirname, "..");
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3995;
const HOUSES_KEY = "world:houses";
const PETS_KEY = "world:house-pets";
const MAPS_KEY = "designer:section:maps";
const MAPS_PROBE_KEY = "designer:section:maps:probe";
const ITEMS_KEY = "designer:section:items";
const ITEMS_PROBE_KEY = "designer:section:items:probe";
const TEST_MAP = "map-essentials-020"; // Ruta1
const DOOR = { id: "housedoor-pets-e2e", x: 33, y: 36 };
const START = { x: 33, y: 37 };
const BERRY = { id: "item-e2epetberry", name: "Baya Mascota", category: "berries", quantity: 12, description: "Comida de prueba" };
const INSTANCE_MARKER = "--house-";
/** 8h of pet life per 12s of wall clock. */
const TIME_SCALE = "2400";
const SLOW_TICK_MS = "700";

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const fail = (msg: string): never => { throw new Error(`ASSERTION FAILED: ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const pass = (msg: string) => { passed += 1; log(`  ✓ ${msg}`); };
function sh(cmd: string, args: string[]): string { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); }
async function waitFor<T>(what: string, fn: () => T | Promise<T>, { timeoutMs = 15000, everyMs = 120 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${lastErr}` : ""}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
function mon(id: string, gender?: string) {
  return {
    id, sourcePokemonId: "pokemon-BULBASAUR", name: id, level: 12, types: ["Grass"], ...(gender ? { gender } : {}),
    hp: 40, maxHp: 40, ivs: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 },
    moves: ["Placaje"], movePp: { Placaje: 35 }, experience: 0, experienceCurve: "medium",
    nextLevelExperience: 3000, statBonuses: {}
  };
}

type Client = {
  name: string; socket: Socket; session: any; token: string; userId: number; characterId: number; myPlayerId: string;
  results: any[]; petResults: any[]; houseSyncs: any[]; petSyncs: any[]; petUpdates: any[]; petEmotes: any[];
  petNotifications: any[]; petNotificationLists: any[]; followerUpdates: any[]; followerRemoves: any[]; followerSteps: any[];
  moves: any[]; addPlayers: any[];
};

function wire(c: Client) {
  const s = c.socket;
  s.on("auth:session", (d: any) => { if (d?.authenticated) c.session = d; });
  s.on("myPlayer", (d: any) => { c.myPlayerId = d?.playerId ?? ""; });
  s.on("addPlayer", (d: any) => c.addPlayers.push(d));
  s.on("house:result", (d: any) => c.results.push(d));
  s.on("pet:result", (d: any) => { c.petResults.push(d); log(`  [${c.name}] pet → ${d.action} ${d.ok ? "ok" : "refused"} ${d.messageKey} ${JSON.stringify(d.params ?? {})}`); });
  s.on("house:sync", (d: any) => c.houseSyncs.push(d));
  s.on("pet:sync", (d: any) => c.petSyncs.push(d));
  s.on("pet:update", (d: any) => c.petUpdates.push(d));
  s.on("pet:emote", (d: any) => c.petEmotes.push(d));
  s.on("pet:notification", (d: any) => { c.petNotifications.push(d); log(`  [${c.name}] 🔔 ${d.notification?.kind}: ${d.notification?.text}`); });
  s.on("pet:notifications", (d: any) => c.petNotificationLists.push(d));
  s.on("follower:update", (d: any) => c.followerUpdates.push(d));
  s.on("follower:remove", (d: any) => c.followerRemoves.push(d));
  s.on("follower:steps", (d: any) => c.followerSteps.push(d));
  s.onAny((event: string, data: any) => { if (event.startsWith("move") && data?.playerId === c.myPlayerId) c.moves.push(data); });
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  const backups = new Map<string, string | null>();
  const clients: Client[] = [];

  const startServer = async () => {
    log(`starting server on :${PORT} (PET_TIME_SCALE=${TIME_SCALE}) …`);
    const child = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(PORT), REDIS_URL, SMTP_ENABLED: "false", GIT_SHA: "e2e", PET_TIME_SCALE: TIME_SCALE, PET_SLOW_TICK_MS: SLOW_TICK_MS },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverLog = "";
    child.stdout!.on("data", (d) => { serverLog += d; if (process.env.E2E_DEBUG) process.stdout.write(`  [srv] ${d}`); });
    child.stderr!.on("data", (d) => { serverLog += d; process.stderr.write(`  [srv!] ${d}`); });
    await waitFor("server listening", () => serverLog.includes(`Listening on port ${PORT}`), { timeoutMs: 90000 });
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
      for (const [key, value] of backups) { if (value !== null) await redis.set(key, value); else await redis.del(key); }
      for (const c of clients) { try { await redis.del(`auth:user:${c.userId}`); await redis.del(`auth:character:${c.characterId}`); } catch {} }
      await redis.quit();
    }
  };
  const connect = (): Socket => io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
  const newClient = (name: string, socket: Socket): Client => ({
    name, socket, session: null, token: "", userId: 0, characterId: 0, myPlayerId: "", results: [], petResults: [], houseSyncs: [],
    petSyncs: [], petUpdates: [], petEmotes: [], petNotifications: [], petNotificationLists: [], followerUpdates: [], followerRemoves: [],
    followerSteps: [], moves: [], addPlayers: []
  });
  const register = async (name: string, party: unknown[], money: number, inventory: unknown[]): Promise<Client> => {
    const c = newClient(name, connect());
    wire(c);
    await waitFor("connect", () => c.socket.connected);
    const uname = `e2epet${name.toLowerCase()}${Date.now().toString().slice(-7)}`;
    c.socket.emit("auth:register", { name, username: uname, email: `${uname}@example.com`, password: "Aa1!aaaa" });
    const session = await waitFor("register session", () => (c.session?.user?.id ? c.session : null));
    c.token = session.token;
    c.userId = Number(session.user.id);
    c.characterId = Number(session.user.characterId ?? c.userId);
    await redis!.hSet(`auth:character:${c.characterId}`, {
      last_map_id: TEST_MAP, last_x: String(START.x * 32), last_y: String(START.y * 32),
      event_self_switches: JSON.stringify({ "129:2:A": true }),
      follower_enabled: "0", money: String(money),
      pokemon_party: JSON.stringify(party), inventory: JSON.stringify(inventory)
    });
    await redis!.hSet(`auth:user:${c.userId}`, { pokemon_box: JSON.stringify({ boxes: [] }) });
    clients.push(c);
    log(`registered ${name} #${c.userId} (character #${c.characterId})`);
    return c;
  };
  const join = async (c: Client) => {
    c.socket.emit("addPlayer", { token: c.token });
    await waitFor("myPlayer", () => c.myPlayerId);
    await sleep(900);
  };
  const rejoin = async (c: Client) => {
    c.socket.disconnect();
    c.socket = connect();
    wire(c);
    await waitFor("reconnect", () => c.socket.connected);
    await join(c);
  };
  const charField = async (c: Client, field: string) => (await redis!.hGet(`auth:character:${c.characterId}`, field)) ?? "";
  const party = async (c: Client) => JSON.parse((await charField(c, "pokemon_party")) || "[]") as any[];
  const bagQty = async (c: Client, id: string) => (JSON.parse((await charField(c, "inventory")) || "[]") as any[]).find((i) => i.id === id)?.quantity ?? 0;
  const petsRedis = async () => JSON.parse((await redis!.get(PETS_KEY)) || '{"pets":[],"ground":[]}') as { pets: any[]; ground: any[] };
  const lastMove = (c: Client) => c.moves[c.moves.length - 1] ?? null;
  const currentMap = (c: Client) => lastMove(c)?.currentMapId ?? [...c.addPlayers].reverse().find((p) => p.playerId === c.myPlayerId)?.currentMapId ?? null;
  const act = async (c: Client, event: string, payload: any, action: string) => {
    const before = c.results.length;
    c.socket.emit(event, payload);
    return waitFor(`${event} result`, () => c.results.slice(before).find((r) => r.action === action) ?? null);
  };
  const petAct = async (c: Client, event: string, payload: any, action: string) => {
    const before = c.petResults.length;
    c.socket.emit(event, payload);
    return waitFor(`${event} result`, () => c.petResults.slice(before).find((r) => r.action === action) ?? null);
  };
  const walkTo = async (c: Client, cell: { x: number; y: number }, timeoutMs = 8000) => {
    const drive = setInterval(() => c.socket.emit("move", { x: cell.x * 32, y: cell.y * 32 }), 150);
    try {
      c.socket.emit("move", { x: cell.x * 32, y: cell.y * 32 });
      await waitFor(`arrive (${cell.x},${cell.y})`, () => { const m = lastMove(c); return m && m.x === cell.x * 32 && m.y === cell.y * 32 ? m : null; }, { timeoutMs });
    } finally { clearInterval(drive); }
    c.socket.emit("stopMove");
    await sleep(200);
  };
  const tryWalkTo = async (c: Client, cell: { x: number; y: number }, timeoutMs = 3000) => {
    try { await walkTo(c, cell, timeoutMs); return true; } catch { c.socket.emit("stopMove"); return false; }
  };
  /** Latest known cell of a follower-channel actor from what a client saw. */
  const actorCell = (c: Client, ownerId: string) => {
    let cell: { x: number; y: number; at: number } | null = null;
    for (const u of c.followerUpdates) if (u.follower?.ownerId === ownerId) cell = { x: u.follower.toX, y: u.follower.toY, at: u.t };
    for (const p of c.followerSteps) for (const s of p.steps ?? []) if (s.ownerId === ownerId && (!cell || p.t >= cell.at)) cell = { x: s.toX, y: s.toY, at: p.t };
    return cell;
  };
  const latestPetView = (c: Client, petId: string) => {
    let view: any = null;
    for (const s of c.petSyncs) for (const p of s.pets ?? []) if (p.id === petId) view = p;
    for (const u of c.petUpdates) if (u.pet?.id === petId) view = u.pet;
    return view;
  };

  try {
    const running = (() => { try { return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]); } catch { return ""; } })();
    if (!running) { log("redis-dev not running; starting it …"); try { sh("docker", ["start", REDIS_CONTAINER]); } catch { sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]); } }
    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    await redis.connect();
    await waitFor("redis PING", async () => (await redis!.ping()) === "PONG");

    // ── SEED ───────────────────────────────────────────────────────────
    log("── SEED ──");
    for (const key of [HOUSES_KEY, PETS_KEY, MAPS_KEY, MAPS_PROBE_KEY, ITEMS_KEY, ITEMS_PROBE_KEY]) backups.set(key, await redis.get(key));
    const itemsBackup = backups.get(ITEMS_KEY);
    if (!itemsBackup) fail("designer:section:items missing — import items first");
    const itemsPayload = JSON.parse(itemsBackup!);
    const itemsState = itemsPayload.state ?? itemsPayload;
    itemsState.items = (itemsState.items as any[]).filter((item) => item.id !== BERRY.id);
    itemsState.items.push({
      id: BERRY.id, name: BERRY.name, category: "berries", details: [],
      itemProfile: {
        essentialsId: "E2EPETBERRY", iconSrc: "/objects/Rock.png", description: BERRY.description, price: 10,
        pokemonDbCategory: "berries", effectText: "", effectKind: "none", useCondition: "none", type: "berries",
        statModifiers: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 },
        skillId: "", skillName: "", pokeballBonusElements: [], pokeballBonusRatio: 0
      }
    });
    if (Array.isArray(itemsState.categories) && !itemsState.categories.includes("berries")) itemsState.categories.push("berries");
    itemsPayload.version = (itemsPayload.version ?? 0) + 1;
    itemsPayload.updatedAt = new Date().toISOString();
    await redis.set(ITEMS_KEY, JSON.stringify(itemsPayload));
    await redis.del(ITEMS_PROBE_KEY);
    const mapsBackup = backups.get(MAPS_KEY);
    if (!mapsBackup) fail("designer:section:maps missing — import maps first");
    const payload = JSON.parse(mapsBackup!);
    const state = payload.state ?? payload;
    const items: any[] = state.items;
    const editorDataByMapId: Record<string, any> = state.editorDataByMapId;
    const candidates = items
      .filter((item) => item.id !== TEST_MAP && item.playableMapConfig && editorDataByMapId[item.id]?.tileMap?.collision)
      .map((item) => ({ item, area: (item.playableMapConfig.width ?? 999) * (item.playableMapConfig.height ?? 999) }))
      .filter((entry) => entry.area >= 64)
      .sort((a, b) => a.area - b.area);
    const template = candidates[0]?.item ?? fail("no candidate house template map");
    template.playableMapConfig.isHouse = true;
    editorDataByMapId[TEST_MAP].houseDoors = [{ id: DOOR.id, x: DOOR.x, y: DOOR.y, name: "Edificio Mascotas", apartments: [{ price: 100, mapId: template.id }] }];
    payload.version = (payload.version ?? 0) + 1;
    payload.updatedAt = new Date().toISOString();
    await redis.set(MAPS_KEY, JSON.stringify(payload));
    await redis.del(MAPS_PROBE_KEY);
    await redis.del(HOUSES_KEY);
    await redis.del(PETS_KEY);
    const APT0 = `${DOOR.id}-0`;
    const INSTANCE0 = `${template.id}${INSTANCE_MARKER}${APT0}`;
    log(`house template: ${template.id} (${template.name}, ${template.playableMapConfig.width}x${template.playableMapConfig.height}); instance ${INSTANCE0}`);

    server = await startServer();
    // Ana: one venomon WITHOUT a gender (lazy assignment), a male and a female.
    const A = await register("Ana", [mon("Ana-m1"), mon("Ana-m2", "male"), mon("Ana-m3", "female")], 1000, [BERRY]);
    const B = await register("Beto", [mon("Beto-m1", "male"), mon("Beto-m2", "female")], 1000, [BERRY]);
    await join(A);
    await join(B);
    await waitFor("A on Ruta1", () => currentMap(A) === TEST_MAP);

    // ── GENDER ─────────────────────────────────────────────────────────
    log("── GENDER ──");
    const partyA = A.session.user.pokemonParty as any[];
    for (const p of partyA) if (!["male", "female", "genderless"].includes(p.gender)) fail(`no gender on ${p.id}: ${JSON.stringify(p.gender)}`);
    if (partyA.find((p) => p.id === "Ana-m2").gender !== "male" || partyA.find((p) => p.id === "Ana-m3").gender !== "female") fail("seeded genders not preserved");
    const stored = await party(A);
    if (!stored.find((p) => p.id === "Ana-m1")?.gender) fail("lazy gender not persisted");
    pass(`genders in session + persisted (Ana-m1 got "${stored.find((p) => p.id === "Ana-m1").gender}")`);

    // ── ENTER ──────────────────────────────────────────────────────────
    let r = await act(A, "house:buy", { apartmentId: APT0 }, "buy");
    if (!r.ok) fail(`buy: ${JSON.stringify(r)}`);
    r = await act(A, "house:enter", { apartmentId: APT0 }, "enter");
    if (!r.ok) fail(`enter: ${JSON.stringify(r)}`);
    r = await act(B, "house:enter", { apartmentId: APT0 }, "enter");
    if (!r.ok) fail(`B enter: ${JSON.stringify(r)}`);
    await waitFor("both inside", () => currentMap(A) === INSTANCE0 && currentMap(B) === INSTANCE0);
    await waitFor("pet:sync on arrival", () => A.petSyncs.find((s) => s.mapId === INSTANCE0) ?? null);

    // ── LEAVE ──────────────────────────────────────────────────────────
    log("── LEAVE ──");
    const roamM2 = `roam:${A.characterId}:Ana-m2`;
    const roamM3 = `roam:${A.characterId}:Ana-m3`;
    let pr = await petAct(A, "house:pet-leave", { pokemonId: "Ana-m2" }, "leave");
    if (!pr.ok) fail(`pet-leave: ${JSON.stringify(pr)}`);
    await waitFor("A session party 2", () => A.session?.user?.pokemonParty?.length === 2);
    await waitFor("pet on follower channel (A)", () => A.followerUpdates.find((u) => u.follower?.ownerId === roamM2) ?? null);
    await waitFor("pet on follower channel (B)", () => B.followerUpdates.find((u) => u.follower?.ownerId === roamM2) ?? null);
    const petView = await waitFor("pet:update for B", () => B.petUpdates.find((u) => u.pet?.id === "Ana-m2")?.pet ?? null);
    if (petView.gender !== "male" || petView.ownerCharacterId !== A.characterId || petView.mapId !== INSTANCE0) fail(`pet view: ${JSON.stringify(petView)}`);
    if (!(await petsRedis()).pets.some((p) => p.id === "Ana-m2")) fail("pet not persisted");
    if ((await party(A)).some((p) => p.id === "Ana-m2")) fail("pet still in party");
    pass("Ana-m2 lives in the house (out of the party, follower channel, pet:update, persisted)");
    // ── WALK ───────────────────────────────────────────────────────────
    log("── WALK ──");
    const walkStart = B.followerSteps.length;
    await sleep(7000);
    const steps = B.followerSteps.slice(walkStart).flatMap((p) => (p.steps ?? []).filter((s: any) => s.ownerId === roamM2 && s.stepMs !== 180).map((s: any) => ({ ...s, t: p.t })));
    let longestRun = 0, run = 0;
    for (let i = 0; i < steps.length; i += 1) {
      const prev = steps[i - 1];
      run = prev && prev.toX === steps[i].fromX && prev.toY === steps[i].fromY && steps[i].t - prev.t < 700 ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
    }
    const cells = new Set(steps.map((s) => `${s.toX},${s.toY}`));
    if (steps.length < 3) fail(`pet barely walked: ${steps.length} steps`);
    if (longestRun < 2) fail(`no multi-cell walk (longest chained run ${longestRun})`);
    if (cells.size < 3) fail(`pet visited only ${cells.size} cells`);
    pass(`pet walks multi-cell paths (${steps.length} steps, longest chain ${longestRun}, ${cells.size} distinct cells)`);

    // ── PUSH ───────────────────────────────────────────────────────────
    log("── PUSH ──");
    // Petting it makes it stop and look at you for a moment (HouseRoamers
    // faceToward); bump into it while it stands still. Alternate who pets it
    // (20s caress cooldown per player) and retry: the destination cell may be
    // a wall, in which case the shove is (correctly) refused.
    let pushed = false;
    for (let attempt = 0; attempt < 8 && !pushed; attempt += 1) {
      const petter = attempt % 2 === 0 ? A : B;
      await petAct(petter, "house:pet-caress", { petId: "Ana-m2" }, "caress");
      const cell = actorCell(A, roamM2);
      if (!cell) continue;
      const before = A.followerSteps.length;
      const drive = setInterval(() => A.socket.emit("move", { x: cell.x * 32, y: cell.y * 32 }), 100);
      try {
        await waitFor("shove step", () => A.followerSteps.slice(before).some((p) => p.steps?.some((s: any) => s.ownerId === roamM2 && s.stepMs === 180)), { timeoutMs: 2400 });
        pushed = true;
      } catch {
        const me = lastMove(A);
        const roamSteps = A.followerSteps.slice(before).flatMap((p) => (p.steps ?? []).filter((s: any) => s.ownerId === roamM2).map((s: any) => `${s.fromX},${s.fromY}→${s.toX},${s.toY}@${s.stepMs}`));
        log(`  (attempt ${attempt}: pet at ${cell.x},${cell.y}; me at ${me ? `${me.x / 32},${me.y / 32}` : "?"}; pet steps ${roamSteps.join(" ") || "none"}; now ${JSON.stringify(actorCell(A, roamM2))})`);
      } finally { clearInterval(drive); A.socket.emit("stopMove"); }
      // Caress cooldown is 20s per player: after both petted it, wait it out.
      if (!pushed) await sleep(attempt % 2 === 1 ? 18000 : 500);
    }
    if (!pushed) fail("walking into the pet never displaced it");
    pass("player pushes the pet (shove step)");

    // ── MORE PETS ──────────────────────────────────────────────────────
    // (after WALK/PUSH so a single pet has the room to itself there)
    log("── MORE PETS ──");
    pr = await petAct(A, "house:pet-leave", { pokemonId: "Ana-m3" }, "leave");
    if (!pr.ok) fail(`pet-leave m3: ${JSON.stringify(pr)}`);
    await waitFor("m3 on channel", () => B.followerUpdates.find((u) => u.follower?.ownerId === roamM3) ?? null);
    pr = await petAct(A, "house:pet-leave", { pokemonId: "Ana-m1" }, "leave");
    if (pr.ok || pr.messageKey !== "pet.reason.lastVenomon") fail(`last venomon should be refused: ${JSON.stringify(pr)}`);
    pass("the last venomon in hands cannot be left");
    const roamB = `roam:${B.characterId}:Beto-m2`;
    pr = await petAct(B, "house:pet-leave", { pokemonId: "Beto-m2" }, "leave");
    if (!pr.ok) fail(`visitor pet-leave: ${JSON.stringify(pr)}`);
    await waitFor("B's pet on channel (A)", () => A.followerUpdates.find((u) => u.follower?.ownerId === roamB) ?? null);
    pass("a visitor left a venomon in someone else's house");
    // Beto's female would compete for Ana's male below: take her back now.
    pr = await petAct(B, "house:pet-take", { petId: "Beto-m2" }, "take");
    if (!pr.ok) fail(`B take: ${JSON.stringify(pr)}`);
    await waitFor("B's pet removed", () => A.followerRemoves.find((u) => u.ownerId === roamB) ?? null);

    // ── HUNGER ─────────────────────────────────────────────────────────
    log("── HUNGER ──");
    const hungry = await waitFor("hungry alert (A)", () => A.petNotifications.find((n) => n.notification?.kind === "hungry" && n.notification.petId === "Ana-m2") ?? null, { timeoutMs: 25000 });
    if (hungry.notification.mapId !== INSTANCE0) fail(`alert map: ${hungry.notification.mapId}`);
    const persisted = JSON.parse((await charField(A, "pet_notifications")) || "[]") as any[];
    if (!persisted.some((n) => n.id === hungry.notification.id)) fail("hungry alert not persisted on the character");
    if (B.petNotifications.some((n) => n.notification?.petId === "Ana-m2")) fail("B got Ana's alert");
    pass("hungry alert reached the owner live and was persisted (not the visitor)");
    pr = await petAct(B, "house:pet-feed", { petId: "Ana-m2", itemId: "item-nope" }, "feed");
    if (pr.ok || pr.messageKey !== "house.reason.noItem") fail(`feeding with a missing item: ${JSON.stringify(pr)}`);
    pr = await petAct(A, "house:pet-feed", { petId: "Ana-m2", itemId: BERRY.id }, "feed");
    if (!pr.ok) fail(`feed: ${JSON.stringify(pr)}`);
    if ((await bagQty(A, BERRY.id)) !== BERRY.quantity - 1) fail(`bag after feed: ${await bagQty(A, BERRY.id)}`);
    await waitFor("hunger reset", () => { const v = latestPetView(B, "Ana-m2"); return v && v.hunger <= 5 ? v : null; });
    await waitFor("eating emote", () => B.petEmotes.find((e) => e.ownerId === roamM2 && e.emoji === "🍖") ?? null);
    pass("fed with a berry (bag -1, hunger reset, 🍖 emote)");

    // ── MATING ─────────────────────────────────────────────────────────
    log("── MATING ──");
    // The pair may already have courted while we were busy: any egg laid
    // since they moved in counts.
    const eggBefore = 0;
    let egg: any = null;
    const feedDeadline = Date.now() + 90000;
    while (Date.now() < feedDeadline && !egg) {
      await petAct(A, "house:pet-feed", { petId: "Ana-m2", itemId: BERRY.id }, "feed");
      await petAct(A, "house:pet-feed", { petId: "Ana-m3", itemId: BERRY.id }, "feed");
      const until = Date.now() + 5000;
      while (Date.now() < until && !egg) {
        egg = A.petUpdates.slice(eggBefore).find((u) => u.ground?.kind === "egg" && u.ground.byPetName === "Ana-m3")?.ground ?? null;
        await sleep(150);
      }
    }
    if (!egg) fail("Ana-m3 laid no egg");
    if (!A.petEmotes.some((e) => e.emoji === "❤️" && (e.ownerId === roamM2 || e.ownerId === roamM3))) fail("no ❤️ emote during courtship");
    if (!A.petUpdates.some((u) => u.pet?.id === "Ana-m3" && u.pet.courting)) fail("female never flagged as courting");
    if (egg.ownerCharacterId !== A.characterId || egg.byPetName !== "Ana-m3") fail(`egg: ${JSON.stringify(egg)}`);
    if (!A.petNotifications.some((n) => n.notification?.kind === "egg")) fail("no egg alert");
    pass(`courtship (❤️) and an egg laid at ${egg.x},${egg.y} by Ana-m3`);
    pr = await petAct(B, "house:pet-collect-egg", { groundId: egg.id }, "egg");
    if (pr.ok || pr.messageKey !== "pet.reason.notYourEgg") fail(`B collecting Ana's egg: ${JSON.stringify(pr)}`);
    pr = await petAct(A, "house:pet-collect-egg", { groundId: egg.id }, "egg");
    if (!pr.ok) fail(`collect egg: ${JSON.stringify(pr)}`);
    const withEgg = await party(A);
    if (!withEgg.some((p) => p.isEgg === true && p.sourcePokemonId === "pokemon-BULBASAUR")) fail(`no egg in party: ${JSON.stringify(withEgg.map((p) => [p.id, p.isEgg]))}`);
    await waitFor("egg removed for B", () => B.petUpdates.find((u) => u.removedGroundId === egg.id) ?? null);
    pass("only the mother's owner collects the egg (party +1 egg, floor cleared for everyone)");

    // ── PUKE ───────────────────────────────────────────────────────────
    log("── PUKE ──");
    const mess = await waitFor("mess on the floor", () => A.petUpdates.find((u) => u.ground?.kind === "mess")?.ground ?? null, { timeoutMs: 40000 });
    await waitFor("sick alert", () => A.petNotifications.find((n) => n.notification?.kind === "sick") ?? null, { timeoutMs: 5000 });
    if (!A.petEmotes.some((e) => e.emoji === "🤢")) fail("no 🤢 emote");
    pass(`a starving pet threw up at ${mess.x},${mess.y} (sick alert, 🤢)`);
    pr = await petAct(B, "house:pet-clean", { groundId: mess.id }, "clean");
    if (!pr.ok) fail(`visitor cleaning: ${JSON.stringify(pr)}`);
    await waitFor("mess removed (A)", () => A.petUpdates.find((u) => u.removedGroundId === mess.id) ?? null);
    pass("anyone inside can clean the mess");

    // ── TAKE ───────────────────────────────────────────────────────────
    log("── TAKE ──");
    pr = await petAct(B, "house:pet-take", { petId: "Ana-m2" }, "take");
    if (pr.ok || pr.messageKey !== "pet.reason.notYours") fail(`B taking Ana's pet: ${JSON.stringify(pr)}`);
    pr = await petAct(A, "house:pet-take", { petId: "Ana-m2" }, "take");
    if (!pr.ok) fail(`take: ${JSON.stringify(pr)}`);
    await waitFor("follower removed (B)", () => B.followerRemoves.find((u) => u.ownerId === roamM2) ?? null);
    await waitFor("pet removed (B)", () => B.petUpdates.find((u) => u.removedPetId === "Ana-m2") ?? null);
    if (!(await party(A)).some((p) => p.id === "Ana-m2")) fail("pet not back in the party");
    if ((await petsRedis()).pets.some((p) => p.id === "Ana-m2")) fail("pet still persisted");
    pass("pet taken back into the party (follower:remove, pet:update, persisted)");

    // ── OFFLINE ────────────────────────────────────────────────────────
    log("── OFFLINE ──");
    await petAct(A, "house:pet-feed", { petId: "Ana-m3", itemId: BERRY.id }, "feed");
    await act(A, "house:leave", {}, "leave");
    await act(B, "house:leave", {}, "leave");
    await waitFor("both outside", () => currentMap(A) === TEST_MAP && currentMap(B) === TEST_MAP);
    const offlineBefore = A.petNotifications.length;
    A.socket.disconnect();
    await sleep(200);
    // Nobody home, owner offline: the pet still gets hungry.
    await waitFor("hungry alert persisted while offline", async () => {
      const list = JSON.parse((await charField(A, "pet_notifications")) || "[]") as any[];
      return list.find((n) => n.kind === "hungry" && n.petId === "Ana-m3" && n.at > Date.now() - 60000) ?? null;
    }, { timeoutMs: 30000 });
    pass("pets keep living with nobody home: alert persisted for the offline owner");
    void offlineBefore;
    const listsBefore = A.petNotificationLists.length;
    await rejoin(A);
    const list = await waitFor("pet:notifications on join", () => A.petNotificationLists.slice(listsBefore)[0] ?? null);
    if (!list.notifications.some((n: any) => n.kind === "hungry" && n.petId === "Ana-m3")) fail(`pending alerts: ${JSON.stringify(list.notifications.map((n: any) => n.kind))}`);
    const target = list.notifications[0];
    A.socket.emit("pet:notification-dismiss", { id: target.id });
    await waitFor("dismissed", async () => !(JSON.parse((await charField(A, "pet_notifications")) || "[]") as any[]).some((n) => n.id === target.id));
    pass(`reconnecting owner got ${list.notifications.length} pending alerts; dismiss removes one`);
    await stopServer();
    server = await startServer();
    if (!(await petsRedis()).pets.some((p) => p.id === "Ana-m3")) fail("pet lost after restart");
    await rejoin(A);
    r = await act(A, "house:enter", { apartmentId: APT0 }, "enter");
    if (!r.ok) fail(`re-enter: ${JSON.stringify(r)}`);
    await waitFor("pet re-materializes", () => A.followerUpdates.find((u) => u.follower?.ownerId === roamM3) ?? null);
    const sync = await waitFor("pet:sync after restart", () => A.petSyncs.find((s) => s.mapId === INSTANCE0 && s.pets?.some((p: any) => p.id === "Ana-m3")) ?? null);
    if (sync.pets.find((p: any) => p.id === "Ana-m3").gender !== "female") fail("pet gender lost");
    pass("server restart keeps the pets; re-entering the house shows them again");

    log(`\n${passed} checks passed ✔`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
