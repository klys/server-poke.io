/**
 * E2E: housing (apartments, house instances, furniture, roaming venomons)
 * against a REAL server + redis.
 *
 *   SEED      — the maps blob gets one HOUSE template + one 2-apartment door
 *               on Ruta1 (restored on exit). Server reads it at startup.
 *   DOOR      — house:door-info lists both apartments unowned at their price;
 *               3 tiles away is refused (house.reason.tooFar).
 *   VISIT     — an unowned apartment is open: enter → the player lands on the
 *               instance map `<template>--house-<apt>`, receives house:sync
 *               (not owner), leave → back on Ruta1 at the door.
 *   BUY       — A buys apt 1 ($500): wallet 1000 → 500; door-info shows A as
 *               owner for everybody; buying again is refused.
 *   KEY       — A sets key 1234; B is refused without it, with a wrong one,
 *               and enters with the right one (owner enters without a key).
 *   FURNITURE — A places a sofa from the bag (bag -1, house:furniture-update
 *               reaches B inside, redis persisted); the cell is now solid
 *               (A cannot walk onto it); picking it up returns it to the bag.
 *   PETS      — house:pet-leave (sent over a SECOND, auth-only socket like the
 *               party window does) moves a party member into the house: it
 *               leaves the party, shows up on the follower channel
 *               (follower:update ownerId roam:<char>:<mon>) and walks;
 *               house:pet-take brings it back. Full pet life: e2e-house-pets.
 *   CUSTOM    — the owner renames the house (banner/door name follow, 30 char
 *               cap) and picks a BGM from house:music-list (unknown tracks and
 *               visitors are refused); house:sync carries both.
 *   SALE      — A lists the house for $800; B sees "for sale" and buys it:
 *               B pays 800, A's character is credited 800 even while A is
 *               outside; the key code is cleared and B is the owner in redis.
 *   PERSIST   — a server restart keeps B as the owner (state in world:houses).
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-housing.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { resolve } from "path";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = resolve(__dirname, "..");
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3994;
const HOUSES_KEY = "world:houses";
const MAPS_KEY = "designer:section:maps";
const MAPS_PROBE_KEY = "designer:section:maps:probe";
const ITEMS_KEY = "designer:section:items";
const ITEMS_PROBE_KEY = "designer:section:items:probe";
const OBJECTS_KEY = "designer:section:objects";
const OBJECTS_PROBE_KEY = "designer:section:objects:probe";

const TEST_MAP = "map-essentials-020"; // Ruta1
const DOOR = { id: "housedoor-e2e", x: 33, y: 36 };
const START = { x: 33, y: 37 }; // adjacent to the door
const FAR = { x: 33, y: 40 };
const SOFA = { id: "item-e2esofa", name: "Sofá E2E", category: "furniture", quantity: 2, description: "Un sofá de prueba" };
// Map object the sofa is linked to: 2 tiles wide, solid (objectType obstacle).
const OBJ = { id: "object-e2esofa", name: "Sofá objeto E2E", imageSrc: "/objects/Rock.png", width: 64, height: 32, objectType: "obstacle" };
const INSTANCE_MARKER = "--house-";

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const fail = (msg: string): never => { throw new Error(`ASSERTION FAILED: ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const pass = (msg: string) => { passed += 1; log(`  ✓ ${msg}`); };

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
  name: string;
  socket: Socket;
  session: any;
  token: string;
  userId: number;
  characterId: number;
  myPlayerId: string;
  results: any[];
  doorInfos: any[];
  houseSyncs: any[];
  furnitureUpdates: any[];
  followerUpdates: any[];
  followerRemoves: any[];
  followerSteps: any[];
  moves: any[];
  addPlayers: any[];
};

function wire(c: Client) {
  const s = c.socket;
  s.on("auth:session", (d: any) => { if (d?.authenticated) c.session = d; });
  s.on("myPlayer", (d: any) => { c.myPlayerId = d?.playerId ?? ""; });
  s.on("addPlayer", (d: any) => c.addPlayers.push(d));
  s.on("house:result", (d: any) => { c.results.push(d); log(`  [${c.name}] result → ${d.action} ${d.ok ? "ok" : "refused"} ${d.messageKey} ${JSON.stringify(d.params ?? {})}${d.mapId ? " → " + d.mapId : ""}`); });
  s.on("house:door-info", (d: any) => c.doorInfos.push(d));
  s.on("house:sync", (d: any) => c.houseSyncs.push(d));
  s.on("house:furniture-update", (d: any) => c.furnitureUpdates.push(d));
  s.on("follower:update", (d: any) => c.followerUpdates.push(d));
  s.on("follower:remove", (d: any) => c.followerRemoves.push(d));
  s.on("follower:steps", (d: any) => c.followerSteps.push(d));
  s.onAny((event: string, data: any) => { if (event.startsWith("move") && data?.playerId === c.myPlayerId) c.moves.push(data); });
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  let housesBackup: string | null = null;
  let mapsBackup: string | null = null;
  let probeBackup: string | null = null;
  let itemsBackup: string | null = null;
  let itemsProbeBackup: string | null = null;
  let objectsBackup: string | null = null;
  let objectsProbeBackup: string | null = null;
  const clients: Client[] = [];

  const startServer = async () => {
    log(`starting server on :${PORT} …`);
    const child = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(PORT), REDIS_URL, SMTP_ENABLED: "false", GIT_SHA: "e2e" },
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
      if (housesBackup !== null) await redis.set(HOUSES_KEY, housesBackup); else await redis.del(HOUSES_KEY);
      if (mapsBackup !== null) await redis.set(MAPS_KEY, mapsBackup);
      if (probeBackup !== null) await redis.set(MAPS_PROBE_KEY, probeBackup); else await redis.del(MAPS_PROBE_KEY);
      if (itemsBackup !== null) await redis.set(ITEMS_KEY, itemsBackup);
      if (itemsProbeBackup !== null) await redis.set(ITEMS_PROBE_KEY, itemsProbeBackup); else await redis.del(ITEMS_PROBE_KEY);
      if (objectsBackup !== null) await redis.set(OBJECTS_KEY, objectsBackup);
      if (objectsProbeBackup !== null) await redis.set(OBJECTS_PROBE_KEY, objectsProbeBackup); else await redis.del(OBJECTS_PROBE_KEY);
      for (const c of clients) {
        try { await redis.del(`auth:user:${c.userId}`); await redis.del(`auth:character:${c.characterId}`); } catch {}
      }
      await redis.quit();
    }
  };

  const connect = (): Socket => io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });

  const register = async (name: string, at: { x: number; y: number }, money: number, inventory: unknown[]): Promise<Client> => {
    const socket = connect();
    const c: Client = { name, socket, session: null, token: "", userId: 0, characterId: 0, myPlayerId: "", results: [], doorInfos: [], houseSyncs: [], furnitureUpdates: [], followerUpdates: [], followerRemoves: [], followerSteps: [], moves: [], addPlayers: [] };
    wire(c);
    await waitFor("connect", () => socket.connected);
    const uname = `e2ehouse${name.toLowerCase()}${Date.now().toString().slice(-7)}`;
    socket.emit("auth:register", { name, username: uname, email: `${uname}@example.com`, password: "Aa1!aaaa" });
    const session = await waitFor("register session", () => (c.session?.user?.id ? c.session : null));
    c.token = session.token;
    c.userId = Number(session.user.id);
    c.characterId = Number(session.user.characterId ?? c.userId);
    await redis!.hSet(`auth:character:${c.characterId}`, {
      last_map_id: TEST_MAP, last_x: String(at.x * 32), last_y: String(at.y * 32),
      event_self_switches: JSON.stringify({ "129:2:A": true }),
      follower_enabled: "0",
      money: String(money),
      pokemon_party: JSON.stringify([mon(`${name}-m1`), mon(`${name}-m2`)]),
      inventory: JSON.stringify(inventory)
    });
    await redis!.hSet(`auth:user:${c.userId}`, { pokemon_box: JSON.stringify({ boxes: [] }) });
    clients.push(c);
    log(`registered ${name} #${c.userId} (character #${c.characterId})`);
    return c;
  };
  const rejoin = async (c: Client) => {
    c.socket.disconnect();
    c.socket = connect();
    wire(c);
    await waitFor("reconnect", () => c.socket.connected);
    c.socket.emit("addPlayer", { token: c.token });
    await waitFor("myPlayer", () => c.myPlayerId);
    await sleep(800);
  };
  const join = async (c: Client) => {
    c.socket.emit("addPlayer", { token: c.token });
    await waitFor("myPlayer", () => c.myPlayerId);
    await sleep(1000);
  };
  const charField = async (c: Client, field: string) => (await redis!.hGet(`auth:character:${c.characterId}`, field)) ?? "";
  const bagQty = async (c: Client, id: string) => {
    const inv = JSON.parse((await charField(c, "inventory")) || "[]") as Array<{ id: string; quantity: number }>;
    return inv.find((i) => i.id === id)?.quantity ?? 0;
  };
  const redisApartment = async (id: string) => {
    const all = JSON.parse((await redis!.get(HOUSES_KEY)) || "[]") as any[];
    return all.find((a) => a.id === id) ?? null;
  };
  const lastMove = (c: Client) => c.moves[c.moves.length - 1] ?? null;
  // Map = latest move packet, else the addPlayer announcement (joins don't move).
  const currentMap = (c: Client) =>
    lastMove(c)?.currentMapId ??
    [...c.addPlayers].reverse().find((p) => p.playerId === c.myPlayerId)?.currentMapId ??
    null;
  const act = async (c: Client, event: string, payload: any, action: string) => {
    const before = c.results.length;
    c.socket.emit(event, payload);
    return waitFor(`${event} result`, () => c.results.slice(before).find((r) => r.action === action) ?? null);
  };
  const doorInfo = async (c: Client) => {
    const before = c.doorInfos.length;
    const resultsBefore = c.results.length;
    c.socket.emit("house:door-info", { doorId: DOOR.id });
    return waitFor("door-info", () =>
      c.doorInfos.slice(before)[0]?.door ?? c.results.slice(resultsBefore).find((r) => r.action === "door-info") ?? null
    );
  };
  const walkTo = async (c: Client, cell: { x: number; y: number }, timeoutMs = 8000) => {
    const drive = setInterval(() => c.socket.emit("move", { x: cell.x * 32, y: cell.y * 32 }), 150);
    try {
      c.socket.emit("move", { x: cell.x * 32, y: cell.y * 32 });
      await waitFor(`arrive (${cell.x},${cell.y})`, () => { const m = lastMove(c); return m && m.x === cell.x * 32 && m.y === cell.y * 32 ? m : null; }, { timeoutMs });
    } finally { clearInterval(drive); }
    c.socket.emit("stopMove");
    await sleep(250);
  };
  const tryWalkTo = async (c: Client, cell: { x: number; y: number }) => {
    try { await walkTo(c, cell, 3000); return true; } catch { c.socket.emit("stopMove"); return false; }
  };

  try {
    const running = (() => { try { return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]); } catch { return ""; } })();
    if (!running) {
      log("redis-dev not running; starting it …");
      try { sh("docker", ["start", REDIS_CONTAINER]); } catch { sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]); }
    }
    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    await redis.connect();
    await waitFor("redis PING", async () => (await redis!.ping()) === "PONG");

    // ── SEED ───────────────────────────────────────────────────────────
    log("── SEED ──");
    housesBackup = await redis.get(HOUSES_KEY);
    mapsBackup = await redis.get(MAPS_KEY);
    probeBackup = await redis.get(MAPS_PROBE_KEY);
    itemsBackup = await redis.get(ITEMS_KEY);
    itemsProbeBackup = await redis.get(ITEMS_PROBE_KEY);
    // A "furniture" catalog item: unknown bag ids are dropped on join, and
    // placement checks the catalog type, so the sofa must exist in the items
    // designer section (restored on exit).
    if (!itemsBackup) fail("designer:section:items missing — import items first");
    const itemsPayload = JSON.parse(itemsBackup!);
    const itemsState = itemsPayload.state ?? itemsPayload;
    itemsState.items = (itemsState.items as any[]).filter((item) => item.id !== SOFA.id);
    itemsState.items.push({
      id: SOFA.id, name: SOFA.name, category: "furniture", details: [],
      itemProfile: {
        essentialsId: "E2ESOFA", iconSrc: "/objects/Rock.png", description: SOFA.description, price: 100,
        pokemonDbCategory: "furniture", effectText: "", effectKind: "none", useCondition: "none", type: "furniture", furnitureObjectId: OBJ.id,
        statModifiers: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 },
        skillId: "", skillName: "", pokeballBonusElements: [], pokeballBonusRatio: 0
      }
    });
    if (Array.isArray(itemsState.categories) && !itemsState.categories.includes("furniture")) itemsState.categories.push("furniture");
    itemsPayload.version = (itemsPayload.version ?? 0) + 1;
    itemsPayload.updatedAt = new Date().toISOString();
    await redis.set(ITEMS_KEY, JSON.stringify(itemsPayload));
    await redis.del(ITEMS_PROBE_KEY);
    // The map object the sofa draws (objects section, restored on exit).
    objectsBackup = await redis.get(OBJECTS_KEY);
    objectsProbeBackup = await redis.get(OBJECTS_PROBE_KEY);
    const objectsPayload = objectsBackup ? JSON.parse(objectsBackup) : { state: { categories: ["E2E"], items: [] } };
    const objectsState = objectsPayload.state ?? objectsPayload;
    objectsState.items = (objectsState.items as any[]).filter((item) => item.id !== OBJ.id);
    objectsState.items.push({
      id: OBJ.id, name: OBJ.name, category: "E2E", details: [],
      mapObjectAsset: { imageSrc: OBJ.imageSrc, width: OBJ.width, height: OBJ.height, objectType: OBJ.objectType }
    });
    if (Array.isArray(objectsState.categories) && !objectsState.categories.includes("E2E")) objectsState.categories.push("E2E");
    objectsPayload.version = (objectsPayload.version ?? 0) + 1;
    objectsPayload.updatedAt = new Date().toISOString();
    await redis.set(OBJECTS_KEY, JSON.stringify(objectsPayload));
    await redis.del(OBJECTS_PROBE_KEY);
    if (!mapsBackup) fail("designer:section:maps missing — import maps first");
    const payload = JSON.parse(mapsBackup!);
    const state = payload.state ?? payload;
    const items: any[] = state.items;
    const editorDataByMapId: Record<string, any> = state.editorDataByMapId;
    // Smallest imported map with a baked collision grid becomes the HOUSE template.
    const candidates = items
      .filter((item) => item.id !== TEST_MAP && item.playableMapConfig && editorDataByMapId[item.id]?.tileMap?.collision)
      .map((item) => ({ item, area: (item.playableMapConfig.width ?? 999) * (item.playableMapConfig.height ?? 999) }))
      .filter((entry) => entry.area >= 36)
      .sort((a, b) => a.area - b.area);
    const template = candidates[0]?.item ?? fail("no candidate house template map");
    template.playableMapConfig.isHouse = true;
    editorDataByMapId[TEST_MAP].houseDoors = [{
      id: DOOR.id, x: DOOR.x, y: DOOR.y, name: "Edificio E2E",
      apartments: [{ price: 500, mapId: template.id }, { price: 700, mapId: template.id }]
    }];
    payload.version = (payload.version ?? 0) + 1;
    payload.updatedAt = new Date().toISOString();
    await redis.set(MAPS_KEY, JSON.stringify(payload));
    await redis.del(MAPS_PROBE_KEY);
    await redis.del(HOUSES_KEY);
    const APT0 = `${DOOR.id}-0`;
    const INSTANCE0 = `${template.id}${INSTANCE_MARKER}${APT0}`;
    log(`house template: ${template.id} (${template.name}, ${template.playableMapConfig.width}x${template.playableMapConfig.height}); instance ${INSTANCE0}`);

    server = await startServer();

    const A = await register("Ana", START, 1000, [SOFA]);
    const B = await register("Beto", START, 5000, []);
    await join(A);
    await join(B);
    await waitFor("A on Ruta1", () => currentMap(A) === TEST_MAP);

    // ── DOOR ───────────────────────────────────────────────────────────
    log("── DOOR ──");
    let door = await doorInfo(A);
    if (!door.apartments) fail(`door-info refused: ${JSON.stringify(door)}`);
    if (door.apartments.length !== 2) fail(`expected 2 apartments, got ${door.apartments.length}`);
    if (door.apartments[0].price !== 500 || door.apartments[0].owned) fail("apt 1 should be unowned at 500");
    if (door.apartments[1].price !== 700) fail("apt 2 price");
    pass(`door lists ${door.apartments.length} apartments (${door.apartments.map((a: any) => `${a.name} $${a.price}`).join(", ")})`);
    await walkTo(A, FAR);
    const far = await doorInfo(A);
    if (far.messageKey !== "house.reason.tooFar") fail(`far door-info should be refused: ${JSON.stringify(far)}`);
    pass("door menu refused 3 tiles away");
    await walkTo(A, START);

    // ── VISIT ──────────────────────────────────────────────────────────
    log("── VISIT ──");
    let r = await act(A, "house:enter", { apartmentId: APT0 }, "enter");
    if (!r.ok || r.mapId !== INSTANCE0) fail(`enter unowned apartment: ${JSON.stringify(r)}`);
    await waitFor("A inside instance", () => currentMap(A) === INSTANCE0);
    const sync0 = await waitFor("house:sync", () => A.houseSyncs.find((s) => s.house?.mapId === INSTANCE0) ?? null);
    if (sync0.house.isOwner || sync0.house.ownerCharacterId !== null) fail("unowned house sync should have no owner");
    pass(`entered ${INSTANCE0}; house:sync received (no owner)`);
    r = await act(A, "house:leave", {}, "leave");
    if (!r.ok || r.mapId !== TEST_MAP) fail(`leave: ${JSON.stringify(r)}`);
    await waitFor("A back on Ruta1", () => currentMap(A) === TEST_MAP);
    const back = lastMove(A);
    if (Math.abs(back.x / 32 - DOOR.x) + Math.abs(back.y / 32 - DOOR.y) > 2) fail(`left far from the door: ${back.x / 32},${back.y / 32}`);
    pass("left the house next to its door");

    // ── BUY ────────────────────────────────────────────────────────────
    log("── BUY ──");
    r = await act(A, "house:buy", { apartmentId: APT0 }, "buy");
    if (!r.ok) fail(`buy: ${JSON.stringify(r)}`);
    if ((await charField(A, "money")) !== "500") fail(`A money after buy: ${await charField(A, "money")}`);
    door = await doorInfo(A);
    if (!door.apartments[0].isOwner || !door.apartments[0].owned) fail("A should own apt 1");
    const doorB = await doorInfo(B);
    if (doorB.apartments[0].ownerName !== "Ana" || doorB.apartments[0].isOwner) fail(`B view: ${JSON.stringify(doorB.apartments[0])}`);
    r = await act(A, "house:buy", { apartmentId: APT0 }, "buy");
    if (r.ok || r.messageKey !== "house.reason.alreadyOwner") fail(`double buy: ${JSON.stringify(r)}`);
    const aptRedis = await redisApartment(APT0);
    if (aptRedis?.ownerCharacterId !== A.characterId) fail(`redis owner: ${JSON.stringify(aptRedis)}`);
    pass("A bought apt 1 for $500 (wallet 1000→500, owner visible to B, persisted)");

    // ── KEY ────────────────────────────────────────────────────────────
    log("── KEY ──");
    r = await act(A, "house:set-key", { apartmentId: APT0, keyCode: "12" }, "key");
    if (r.ok) fail("2-digit key must be refused");
    r = await act(A, "house:set-key", { apartmentId: APT0, keyCode: "1234" }, "key");
    if (!r.ok) fail(`set key: ${JSON.stringify(r)}`);
    r = await act(B, "house:enter", { apartmentId: APT0 }, "enter");
    if (r.ok || r.messageKey !== "house.reason.keyRequired") fail(`B without key: ${JSON.stringify(r)}`);
    r = await act(B, "house:enter", { apartmentId: APT0, keyCode: "0000" }, "enter");
    if (r.ok || r.messageKey !== "house.reason.wrongKey") fail(`B wrong key: ${JSON.stringify(r)}`);
    r = await act(B, "house:enter", { apartmentId: APT0, keyCode: "1234" }, "enter");
    if (!r.ok) fail(`B right key: ${JSON.stringify(r)}`);
    await waitFor("B inside", () => currentMap(B) === INSTANCE0);
    const syncB = await waitFor("B house:sync", () => B.houseSyncs.find((s) => s.house?.mapId === INSTANCE0) ?? null);
    if (syncB.house.ownerName !== "Ana" || syncB.house.isOwner) fail("B sync should show Ana as owner");
    r = await act(A, "house:enter", { apartmentId: APT0 }, "enter");
    if (!r.ok) fail(`owner enters without key: ${JSON.stringify(r)}`);
    await waitFor("A inside", () => currentMap(A) === INSTANCE0);
    pass("key code: refused without/with wrong key, accepted with 1234, owner needs none");

    // ── FURNITURE ──────────────────────────────────────────────────────
    log("── FURNITURE ──");
    const me = lastMove(A);
    const myCell = { x: Math.round(me.x / 32), y: Math.round(me.y / 32) };
    let placedAt: { x: number; y: number } | null = null;
    for (const d of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      const cell = { x: myCell.x + d.x, y: myCell.y + d.y };
      r = await act(A, "house:furniture-place", { itemId: SOFA.id, x: cell.x, y: cell.y }, "place");
      if (r.ok) { placedAt = cell; break; }
      log(`  (cell ${cell.x},${cell.y} refused: ${r.messageKey})`);
    }
    if (!placedAt) fail("could not place the sofa on any neighbouring cell");
    if ((await bagQty(A, SOFA.id)) !== 1) fail(`bag after place: ${await bagQty(A, SOFA.id)}`);
    const upd = await waitFor("B furniture-update", () => B.furnitureUpdates.find((u) => u.placed?.itemId === SOFA.id) ?? null);
    if (upd.mapId !== INSTANCE0) fail("furniture update map");
    const aptWithSofa = await redisApartment(APT0);
    if (!aptWithSofa?.furniture?.some((f: any) => f.itemId === SOFA.id)) fail("sofa not persisted");
    pass(`sofa placed at ${placedAt!.x},${placedAt!.y} (bag 2→1, B notified, persisted)`);
    const piece = upd.placed;
    if (piece.objectId !== OBJ.id || piece.imageSrc !== OBJ.imageSrc || piece.width !== OBJ.width || piece.height !== OBJ.height || piece.solid !== true) {
      fail(`placed piece should carry the linked map object: ${JSON.stringify(piece)}`);
    }
    pass("placed piece carries the linked map object (image, 64x32 px, solid)");
    // 64px wide on 32px tiles = the cell to the right is part of the footprint.
    const secondCell = { x: placedAt!.x + 1, y: placedAt!.y };
    r = await act(A, "house:furniture-place", { itemId: SOFA.id, x: secondCell.x, y: secondCell.y }, "place");
    if (r.ok || r.messageKey !== "house.reason.cellTaken") fail(`placing on the footprint's 2nd cell: ${JSON.stringify(r)}`);
    if ((await bagQty(A, SOFA.id)) !== 1) fail(`bag after refused place: ${await bagQty(A, SOFA.id)}`);
    const reached2 = await tryWalkTo(A, secondCell);
    const afterWalk2 = lastMove(A);
    if (reached2 && Math.round(afterWalk2.x / 32) === secondCell.x && Math.round(afterWalk2.y / 32) === secondCell.y) fail("player ended on the sofa's 2nd cell");
    pass("2-tile footprint: 2nd cell is taken and solid");
    r = await act(B, "house:furniture-place", { itemId: SOFA.id, x: placedAt!.x, y: placedAt!.y }, "place");
    if (r.ok || r.messageKey !== "house.reason.notOwner") fail(`visitor placing: ${JSON.stringify(r)}`);
    pass("visitor cannot place furniture");
    const reached = await tryWalkTo(A, placedAt!);
    if (reached) fail("furniture cell should be solid");
    const afterWalk = lastMove(A);
    if (Math.round(afterWalk.x / 32) === placedAt!.x && Math.round(afterWalk.y / 32) === placedAt!.y) fail("player ended on the sofa");
    pass("furniture is solid (walk onto it refused)");
    r = await act(A, "house:furniture-pick", { furnitureId: upd.placed.id }, "pick");
    if (!r.ok) fail(`pick: ${JSON.stringify(r)}`);
    if ((await bagQty(A, SOFA.id)) !== 2) fail(`bag after pick: ${await bagQty(A, SOFA.id)}`);
    await waitFor("B removal update", () => B.furnitureUpdates.find((u) => u.removedId === upd.placed.id) ?? null);
    pass("sofa picked up (bag back to 2, B notified)");

    // ── PETS ───────────────────────────────────────────────────────────
    // The full pet life-cycle lives in tools/e2e-house-pets.ts; here only
    // the party <-> house hand-off that replaced house:set-roam.
    log("── PETS ──");
    const roamId = `roam:${A.characterId}:Ana-m2`;
    // The party window talks over the shared auth socket (handshake token,
    // never addPlayer) — the handler must resolve the player by account.
    const authSocket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true, auth: { token: A.token } });
    const petResults: any[] = [];
    authSocket.on("pet:result", (d: any) => petResults.push(d));
    await waitFor("auth socket connect", () => authSocket.connected);
    await sleep(400);
    authSocket.emit("house:pet-leave", { pokemonId: "Ana-m2" });
    r = await waitFor("pet-leave result (auth socket)", () => petResults.find((d) => d.action === "leave") ?? null);
    if (!r.ok) fail(`pet-leave over auth socket: ${JSON.stringify(r)}`);
    authSocket.disconnect();
    await waitFor("pet appears (A)", () => A.followerUpdates.find((u) => u.follower?.ownerId === roamId) ?? null);
    await waitFor("pet appears (B)", () => B.followerUpdates.find((u) => u.follower?.ownerId === roamId) ?? null);
    const partyAfterLeave = JSON.parse(await charField(A, "pokemon_party"));
    if (partyAfterLeave.length !== 1 || partyAfterLeave[0].id !== "Ana-m1") fail(`party after pet-leave: ${JSON.stringify(partyAfterLeave.map((p: any) => p.id))}`);
    await waitFor("pet walks", () => B.followerSteps.some((p) => p.steps?.some((s: any) => s.ownerId === roamId)), { timeoutMs: 12000 });
    pass("party venomon left in the house (follower channel, out of the party, walks)");
    const takeResults: any[] = [];
    A.socket.on("pet:result", (d: any) => takeResults.push(d));
    A.socket.emit("house:pet-take", { petId: "Ana-m2" });
    r = await waitFor("pet-take result", () => takeResults.find((d) => d.action === "take") ?? null);
    if (!r.ok) fail(`pet-take: ${JSON.stringify(r)}`);
    await waitFor("pet removed", () => B.followerRemoves.find((u) => u.ownerId === roamId) ?? null);
    if (JSON.parse(await charField(A, "pokemon_party")).length !== 2) fail("party after pet-take");
    pass("pet taken back into the party");

    // ── CUSTOM ─────────────────────────────────────────────────────────
    log("── CUSTOM ──");
    r = await act(B, "house:set-name", { apartmentId: APT0, name: "Casa de Beto" }, "name");
    if (r.ok || r.messageKey !== "house.reason.notOwner") fail(`visitor rename: ${JSON.stringify(r)}`);
    r = await act(A, "house:set-name", { apartmentId: APT0, name: "  La Cabaña de Ana   " + "x".repeat(40) }, "name");
    if (!r.ok || r.params?.name?.length !== 30) fail(`rename (30 cap): ${JSON.stringify(r)}`);
    r = await act(A, "house:set-name", { apartmentId: APT0, name: "La Cabaña de Ana" }, "name");
    if (!r.ok) fail(`rename: ${JSON.stringify(r)}`);
    await waitFor("A sync with name", () => A.houseSyncs.some((s) => s.house?.name === "La Cabaña de Ana" && s.house.customName === true));
    await waitFor("B sync with name", () => B.houseSyncs.some((s) => s.house?.name === "La Cabaña de Ana"));
    if ((await redisApartment(APT0))?.name !== "La Cabaña de Ana") fail("name not persisted");
    pass("owner renamed the house (visitor refused, 30-char cap, synced to everyone, persisted)");
    const musicBefore = A.results.length;
    const bgms: string[] = await new Promise((resolveList) => {
      A.socket.once("house:music-list", (d: any) => resolveList(d?.bgms ?? []));
      A.socket.emit("house:music-list");
    });
    void musicBefore;
    if (bgms.length === 0) fail("no BGM offered");
    r = await act(A, "house:set-music", { apartmentId: APT0, bgm: "definitely-not-a-track" }, "music");
    if (r.ok || r.messageKey !== "house.reason.badMusic") fail(`unknown track: ${JSON.stringify(r)}`);
    r = await act(A, "house:set-music", { apartmentId: APT0, bgm: bgms[0] }, "music");
    if (!r.ok) fail(`set music: ${JSON.stringify(r)}`);
    await waitFor("sync with bgm", () => B.houseSyncs.some((s) => s.house?.bgm === bgms[0]));
    if ((await redisApartment(APT0))?.bgm !== bgms[0]) fail("bgm not persisted");
    r = await act(A, "house:set-music", { apartmentId: APT0, bgm: null }, "music");
    if (!r.ok) fail(`clear music: ${JSON.stringify(r)}`);
    pass(`owner picked house music "${bgms[0]}" of ${bgms.length} tracks (unknown refused, synced, persisted, cleared)`);

    // ── SALE ───────────────────────────────────────────────────────────
    log("── SALE ──");
    r = await act(B, "house:set-sale", { apartmentId: APT0, price: 800 }, "sale");
    if (r.ok || r.messageKey !== "house.reason.notOwner") fail(`visitor selling: ${JSON.stringify(r)}`);
    r = await act(A, "house:set-sale", { apartmentId: APT0, price: 800 }, "sale");
    if (!r.ok) fail(`list for sale: ${JSON.stringify(r)}`);
    await act(A, "house:leave", {}, "leave");
    await act(B, "house:leave", {}, "leave");
    await waitFor("both outside", () => currentMap(A) === TEST_MAP && currentMap(B) === TEST_MAP);
    await walkTo(B, START);
    const forSale = await doorInfo(B);
    if (!forSale.apartments[0].forSale || forSale.apartments[0].price !== 800) fail(`B should see it for sale at 800: ${JSON.stringify(forSale.apartments[0])}`);
    r = await act(B, "house:buy", { apartmentId: APT0 }, "buy");
    if (!r.ok || r.messageKey !== "house.msg.boughtFromPlayer") fail(`B buys from A: ${JSON.stringify(r)}`);
    if ((await charField(B, "money")) !== "4200") fail(`B money: ${await charField(B, "money")}`);
    if ((await charField(A, "money")) !== "1300") fail(`A money (seller credited): ${await charField(A, "money")}`);
    const sold = await redisApartment(APT0);
    if (sold?.ownerCharacterId !== B.characterId || sold.keyCode !== null || sold.salePrice !== null) fail(`after sale: ${JSON.stringify(sold)}`);
    if (sold.name !== null) fail("custom name should reset on sale");
    r = await act(A, "house:enter", { apartmentId: APT0 }, "enter");
    if (!r.ok) fail(`A enters B's unlocked house: ${JSON.stringify(r)}`);
    await act(A, "house:leave", {}, "leave");
    pass("B bought A's house for $800 (B 5000→4200, A 500→1300, key cleared, owner B)");

    // ── PERSIST ────────────────────────────────────────────────────────
    log("── PERSIST ──");
    await stopServer();
    server = await startServer();
    await rejoin(B);
    await waitFor("B on Ruta1", () => currentMap(B) === TEST_MAP);
    await walkTo(B, START);
    const after = await doorInfo(B);
    if (!after.apartments[0].isOwner) fail("B should still own apt 1 after restart");
    pass("ownership survives a server restart");

    log(`ALL PASSED (${passed} checks)`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
