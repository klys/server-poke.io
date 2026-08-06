/**
 * E2E: water interaction systems (Fishing / Surf / Dive / water encounters)
 * against a REAL server + redis-dev.
 *
 * Test bed: map-essentials-294 "Pueblo Citrus" — shore at (52,14), water at
 * (51,14); encounter tables Water (TENTACOOL/PERSIAN/HITMONLEE), OldRod
 * (MACHOKE/MAROWAK), SuperRod (TENTACOOL/MAROWAK), and NO GoodRod table.
 * Its dive pair map-essentials-149 "Ciudad Hundida" has a Land table used as
 * the underwater pool.
 *
 * Covers:
 *  1. field:actions availability (no rod / rods / distance spoof / land tile)
 *  2. fishing security: spoofed coords, forged rodItemId, no rod, facing land,
 *     rod without a table (GoodRod), duplicate cast lock
 *  3. surf: refused without the move, spoofed target, mount with target,
 *     map-wide surf-state broadcast to a second player, reconnect restore
 *  4. dive gate (deep water required)
 *  5. rod-table encounters: SuperRod and OldRod bites produce species from
 *     the matching table only
 *  6. surf encounters: moving over water triggers Water-table species
 *  7. underwater encounters: walking the dive map triggers its own table
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-water-actions.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";
import { decodeU8RleGrid } from "../components/terrainTags";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3996;

const MAP = "map-essentials-294";
const UNDERWATER_MAP = "map-essentials-149";
const LAND = { x: 52, y: 14 };
const WATER = { x: 51, y: 14 };

const WATER_SPECIES = ["pokemon-TENTACOOL", "pokemon-PERSIAN", "pokemon-HITMONLEE"];
const OLDROD_SPECIES = ["pokemon-MACHOKE", "pokemon-MAROWAK"];
const SUPERROD_SPECIES = ["pokemon-TENTACOOL", "pokemon-MAROWAK"];

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const fail = (msg: string): never => { throw new Error(`ASSERTION FAILED: ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}
async function waitFor<T>(what: string, fn: () => T | Promise<T>, { timeoutMs = 15000, everyMs = 150 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${lastErr}` : ""}`);
    await sleep(everyMs);
  }
}

function mon(id: string, moves: string[]) {
  const movePp: Record<string, number> = {};
  moves.forEach((m) => (movePp[m] = 15));
  return {
    id, sourcePokemonId: "pokemon-MAGIKARP", name: id, level: 20, types: ["Water"],
    hp: 40, maxHp: 40, ivs: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 },
    moves, movePp, experience: 0, experienceCurve: "medium", nextLevelExperience: 1000, statBonuses: {}
  };
}

interface Client {
  socket: Socket;
  userId: number;
  token: string;
  userKey: string;
  /** Active character (account/character split): gameplay state lives here. */
  characterId: number;
  charKey: string;
  fishingResults: any[];
  fieldErrors: any[];
  surfStates: any[];
  fieldActions: any[];
  battleStates: any[];
  addPlayers: any[];
  poses: any[];
  myPlayerId: string | null;
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  const clients: Client[] = [];
  const testUserIds: number[] = [];

  const cleanup = async () => {
    log("── cleanup ──");
    for (const c of clients) { try { c.socket.disconnect(); } catch {} }
    if (server && !server.killed) { server.kill("SIGTERM"); await sleep(800); if (!server.killed) server.kill("SIGKILL"); }
    if (redis?.isOpen) {
      for (const id of testUserIds) { try { await redis.del(`auth:user:${id}`); } catch {} }
      for (const c of clients) { try { if (c.charKey) await redis.del(c.charKey); } catch {} }
      await redis.quit();
    }
  };

  const newClient = async (label: string): Promise<Client> => {
    const socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    const c: Client = {
      socket, userId: 0, token: "", userKey: "", characterId: 0, charKey: "",
      fishingResults: [], fieldErrors: [], surfStates: [], fieldActions: [],
      battleStates: [], addPlayers: [], poses: [], myPlayerId: null
    };
    let lastSession: any = null;
    socket.on("auth:session", (s: any) => { lastSession = s; });
    socket.on("auth:error", (e: any) => { log(`  [${label}] auth:error →`, JSON.stringify(e)); });
    socket.on("fishing:result", (r: any) => { c.fishingResults.push(r); log(`  [${label}] fishing:result →`, JSON.stringify(r)); });
    socket.on("player:field-skill-error", (e: any) => { c.fieldErrors.push(e); log(`  [${label}] field-skill-error →`, JSON.stringify(e)); });
    socket.on("player:surf-state", (s: any) => { c.surfStates.push(s); log(`  [${label}] surf-state →`, JSON.stringify(s)); });
    socket.on("field:actions-result", (a: any) => { c.fieldActions.push(a); });
    socket.on("battle:state", (b: any) => { c.battleStates.push(b); });
    socket.on("addPlayer", (p: any) => { c.addPlayers.push(p); });
    socket.on("player:pose", (p: any) => { c.poses.push(p); });
    socket.on("myPlayer", (m: any) => { c.myPlayerId = m?.playerId ?? null; });
    await waitFor(`${label} connect`, () => socket.connected);
    // Usernames must be letters-only AND unique across runs — encode the
    // timestamp digits as letters (0->a … 9->j).
    const lettersStamp = Date.now()
      .toString()
      .slice(-8)
      .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
    const uname = `ew${label.toLowerCase()}${lettersStamp}`;
    const registerPayload = { name: `Water${label}`, username: uname.slice(0, 14), email: `${uname}@example.com`, password: "Aa1!aaaa" };
    let session: any = null;
    for (let attempt = 0; attempt < 3 && !session; attempt += 1) {
      socket.emit("auth:register", registerPayload);
      try {
        session = await waitFor(`${label} register`, () => (lastSession?.authenticated && lastSession?.user?.id ? lastSession : null), { timeoutMs: 8000 });
      } catch (error) {
        log(`  [${label}] register attempt ${attempt + 1} failed, retrying…`);
      }
    }
    if (!session) fail(`${label} could not register`);
    c.userId = Number(session.user.id);
    c.token = session.token;
    c.userKey = `auth:user:${c.userId}`;
    c.characterId = Number(session.user.characterId ?? c.userId);
    c.charKey = `auth:character:${c.characterId}`;
    testUserIds.push(c.userId);
    clients.push(c);
    log(`  [${label}] registered #${c.userId}`);
    return c;
  };

  const seedAndJoin = async (c: Client, opts: {
    mapId: string; x: number; y: number;
    moves: string[]; inventory?: Array<{ id: string; name: string; category: string; quantity: number }>;
    surfing?: boolean;
  }) => {
    // Post account/character split: gameplay fields live on the character
    // hash; the shared PC box stays on the account hash.
    await redis!.hSet(c.charKey, {
      last_map_id: opts.mapId,
      last_x: String(opts.x * 32),
      last_y: String(opts.y * 32),
      last_surfing: opts.surfing ? "1" : "0",
      pokemon_party: JSON.stringify([mon("m1", opts.moves)]),
      inventory: JSON.stringify(opts.inventory ?? [])
    });
    await redis!.hSet(c.userKey, {
      pokemon_box: JSON.stringify({ boxes: [] })
    });
    c.socket.emit("addPlayer", { token: c.token });
    await waitFor("myPlayer", () => c.myPlayerId);
    await sleep(900);
  };

  const lastFishing = (c: Client) => c.fishingResults[c.fishingResults.length - 1];

  const castAndWait = async (c: Client, target: { x: number; y: number }, rodItemId?: string) => {
    const before = c.fishingResults.length;
    c.socket.emit("fishing:cast", { x: target.x, y: target.y, rodItemId });
    await waitFor("fishing:result", () => c.fishingResults.length > before, { timeoutMs: 12000 });
    return lastFishing(c);
  };

  try {
    const running = (() => { try { return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]); } catch { return ""; } })();
    if (running !== REDIS_CONTAINER) { try { sh("docker", ["start", REDIS_CONTAINER]); } catch { sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]); } }
    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    redis.on("error", () => {});
    await waitFor("redis PING", async () => { if (!redis!.isOpen) await redis!.connect(); return (await redis!.ping()) === "PONG"; });

    // Species display names for encounter assertions (battle:state only
    // carries the localized name).
    const pokemonsRaw = await redis.get("designer:section:pokemons");
    const namesById = new Map<string, string>();
    if (pokemonsRaw) {
      for (const item of JSON.parse(pokemonsRaw).state.items ?? []) {
        if (item?.id && item?.name) namesById.set(item.id, String(item.name));
      }
    }
    const displayNames = (ids: string[]) => ids.map((id) => namesById.get(id) ?? id.replace("pokemon-", ""));

    // Rod inventory entries matching the migrated item ids.
    const itemsRaw = await redis.get("designer:section:items");
    const itemNameById = new Map<string, string>();
    for (const item of JSON.parse(itemsRaw!).state.items ?? []) {
      if (item?.id && item?.name) itemNameById.set(item.id, String(item.name));
    }
    const rod = (id: string) => ({ id, name: itemNameById.get(id) ?? id, category: "quest", quantity: 1, description: "e2e rod" });
    const ALL_RODS = [rod("item-oldrod"), rod("item-goodrod"), rod("item-superrod")];

    // A walkable floor cell on the underwater map (non-solid, open neighbor).
    const mapsRaw = await redis.get("designer:section:maps");
    const mapsPayload = JSON.parse(mapsRaw!);
    const underEd = mapsPayload.state.editorDataByMapId[UNDERWATER_MAP];
    if (!underEd?.tileMap) fail(`${UNDERWATER_MAP} missing tileMap`);
    const uw = underEd.tileMap.width;
    const uh = underEd.tileMap.height;
    const collision = underEd.tileMap.collision
      ? decodeU8RleGrid(underEd.tileMap.collision, uw * uh)
      : null;
    let underCell: { x: number; y: number } | null = null;
    if (collision) {
      // 0x0F = fully solid (RMXP directional passability bits).
      const open = (cx: number, cy: number) => (collision[cy * uw + cx] & 0x0f) === 0;
      outer: for (let y = 2; y < uh - 2; y += 1) {
        for (let x = 2; x < uw - 2; x += 1) {
          if (open(x, y) && open(x + 1, y) && open(x - 1, y) && open(x, y + 1)) {
            underCell = { x, y };
            break outer;
          }
        }
      }
    }
    log(`underwater walkable cell: ${JSON.stringify(underCell)} (map ${uw}x${uh})`);

    log(`starting server on :${PORT} …`);
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), REDIS_URL, SMTP_ENABLED: "false", GIT_SHA: "e2e" }, stdio: ["ignore", "pipe", "pipe"] });
    let serverLog = "";
    server.stdout!.on("data", (d) => {
      serverLog += d;
      const text = String(d);
      if (text.includes("surf-restore")) {
        process.stdout.write(`  [srv] ${text}`);
      }
    });
    server.stderr!.on("data", (d) => { serverLog += d; process.stderr.write(`  [srv!] ${d}`); });
    await waitFor("server listening", () => serverLog.includes(`Listening on port ${PORT}`), { timeoutMs: 60000 });
    log("server up");

    // ════ Player A: fishing security + surf + broadcast + reconnect ════
    const A = await newClient("A");
    await seedAndJoin(A, { mapId: MAP, x: LAND.x, y: LAND.y, moves: ["Salpicadura"], inventory: [] });

    // ── 1. field:actions without a rod ──
    log("── field:actions (no rod, no surf mon) ──");
    A.socket.emit("field:actions", { x: WATER.x, y: WATER.y });
    const fa1 = await waitFor("field:actions-result", () => A.fieldActions[0]);
    if (fa1.actions.fish.available) fail("fish available without a rod");
    if (!/caña/i.test(fa1.actions.fish.reason ?? "")) fail(`fish reason: ${fa1.actions.fish.reason}`);
    if (fa1.actions.surf.available) fail("surf available without the move");
    if (fa1.actions.dive.available) fail("dive available while not surfing");
    log("  ✓ all actions correctly unavailable, with reasons");

    // ── 2. fishing without a rod ──
    log("── fishing without a rod ──");
    let r = await castAndWait(A, WATER);
    if (r.status !== "error" || !/caña/i.test(r.message)) fail(`expected rod-needed error, got ${JSON.stringify(r)}`);
    log("  ✓ rejected: needs a rod");

    // Give every rod + a surf mon; re-query availability.
    await redis.hSet(A.charKey, {
      inventory: JSON.stringify(ALL_RODS),
      pokemon_party: JSON.stringify([mon("m1", ["Surf", "Buceo"])])
    });
    A.fieldActions.length = 0;
    A.socket.emit("field:actions", { x: WATER.x, y: WATER.y });
    const fa2 = await waitFor("field:actions-result 2", () => A.fieldActions[0]);
    if (!fa2.actions.fish.available) fail(`fish should be available: ${fa2.actions.fish.reason}`);
    if (fa2.actions.fish.rods.length !== 3) fail(`expected 3 rods, got ${JSON.stringify(fa2.actions.fish.rods)}`);
    if (!fa2.actions.surf.available) fail(`surf should be available: ${fa2.actions.surf.reason}`);
    if (fa2.actions.dive.available) fail("dive must require surfing over deep water");
    log("  ✓ fish (3 rods) + surf available; dive gated");

    // ── 3. spoofed / invalid fishing requests ──
    log("── fishing security ──");
    r = await castAndWait(A, { x: WATER.x - 5, y: WATER.y }); // distant water
    if (r.status !== "error" || !/Acércate/i.test(r.message)) fail(`distant cast: ${JSON.stringify(r)}`);
    r = await castAndWait(A, { x: LAND.x + 1, y: LAND.y }); // adjacent land
    if (r.status !== "error" || !/no se puede pescar/i.test(r.message)) fail(`land cast: ${JSON.stringify(r)}`);
    r = await castAndWait(A, WATER, "item-masterball"); // forged rod id
    if (r.status !== "error" || !/caña/i.test(r.message)) fail(`forged rod: ${JSON.stringify(r)}`);
    r = await castAndWait(A, WATER, "item-goodrod"); // owned rod, no GoodRod table here
    if (r.status !== "error" || !/no parece haber/i.test(r.message)) fail(`good rod no table: ${JSON.stringify(r)}`);
    log("  ✓ distant/land/forged-rod/no-table casts all rejected with specific messages");

    // ── 5. surf: spoofed target, then legit mount ──
    log("── surf ──");
    A.socket.emit("player:surf", { x: LAND.x - 4, y: LAND.y }); // spoofed distant target
    await waitFor("surf spoof error", () => A.fieldErrors.find((e) => /posición/i.test(e.message)));
    log("  ✓ distant surf target rejected");

    // ════ Player B watches from the same map ════
    const B = await newClient("B");
    await seedAndJoin(B, { mapId: MAP, x: LAND.x, y: LAND.y + 2, moves: ["Salpicadura"] });

    A.surfStates.length = 0; B.surfStates.length = 0;
    A.socket.emit("player:surf", { x: WATER.x, y: WATER.y });
    await waitFor("A surf-state on", () => A.surfStates.find((s) => s.surfing === true));
    const bSaw = await waitFor("B sees A's surf-state", () => B.surfStates.find((s) => s.surfing === true && s.playerId));
    log(`  ✓ mounted; remote player received surf-state for ${bSaw.playerId}`);

    // ── 6. reconnect while surfing ──
    log("── reconnect while surfing ──");
    A.socket.disconnect();
    await sleep(1200); // let the disconnect handler persist location+surfing
    const surfSaved = await redis.hGet(A.charKey, "last_surfing");
    if (surfSaved !== "1") fail(`last_surfing not persisted (got ${surfSaved})`);
    const A2 = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    const a2Players: any[] = [];
    let a2My: string | null = null;
    A2.on("addPlayer", (p: any) => a2Players.push(p));
    A2.on("myPlayer", (m: any) => { a2My = m?.playerId ?? null; });
    await waitFor("A2 connect", () => A2.connected);
    A2.emit("addPlayer", { token: A.token });
    await waitFor("A2 myPlayer", () => a2My);
    const self = await waitFor("A2 self snapshot", () => a2Players.find((p) => p.playerId === a2My));
    if (self.isSurfing !== true) fail(`snapshot lost surf state: ${JSON.stringify(self)}`);
    const waterCellX = Math.floor((self.x + 16) / 32);
    if (waterCellX !== WATER.x) fail(`reconnect relocated the surfer off the water (cellX ${waterCellX})`);
    // B also re-learns A's mount from the visibility snapshot.
    const bSnapshot = B.addPlayers.find((p) => p.playerId === a2My && p.isSurfing === true);
    if (!bSnapshot) fail("remote player snapshot missing isSurfing after reconnect");
    A2.disconnect();
    log("  ✓ surf state + water position survive reconnect; snapshot carries isSurfing");

    // ════ Rod-specific encounter tables ════
    log("── SuperRod encounter table ──");
    const C = await newClient("C");
    await seedAndJoin(C, { mapId: MAP, x: LAND.x, y: LAND.y, moves: ["Salpicadura"], inventory: ALL_RODS });
    {
      const allowed = displayNames(SUPERROD_SPECIES);

      // Duplicate-cast lock: a REAL cast holds the line out ~1.5s, so a
      // second concurrent cast must bounce off the lock.
      const before = C.fishingResults.length;
      C.socket.emit("fishing:cast", { x: WATER.x, y: WATER.y, rodItemId: "item-superrod" });
      C.socket.emit("fishing:cast", { x: WATER.x, y: WATER.y, rodItemId: "item-superrod" });
      await waitFor("two results", () => C.fishingResults.length >= before + 2, { timeoutMs: 12000 });
      const two = C.fishingResults.slice(before);
      if (!two.some((x: any) => /Ya estás pescando/i.test(x.message))) fail(`no duplicate-lock rejection: ${JSON.stringify(two)}`);
      log("  ✓ concurrent second cast rejected (Ya estás pescando)");

      let hooked: any = C.battleStates[0] ?? null; // the locked pair may already have hooked
      for (let attempt = 0; attempt < 10 && !hooked; attempt += 1) {
        const res = await castAndWait(C, WATER, "item-superrod");
        if (res.status === "bite") {
          hooked = await waitFor("battle:state", () => C.battleStates[0], { timeoutMs: 8000 });
        }
      }
      if (!hooked) fail("no SuperRod bite in 10 casts (p≈1e-10)");
      const species = hooked.opponent?.activePokemon?.name;
      if (!allowed.includes(species)) fail(`SuperRod species "${species}" not in ${JSON.stringify(allowed)}`);
      log(`  ✓ SuperRod hooked "${species}" (∈ SuperRod table)`);
    }

    log("── OldRod encounter table ──");
    const D = await newClient("D");
    await seedAndJoin(D, { mapId: MAP, x: LAND.x, y: LAND.y, moves: ["Salpicadura"], inventory: [rod("item-oldrod")] });
    {
      const allowed = displayNames(OLDROD_SPECIES);
      const waterAllowed = displayNames(WATER_SPECIES).filter((n) => !allowed.includes(n));
      let hooked: any = null;
      for (let attempt = 0; attempt < 14 && !hooked; attempt += 1) {
        const res = await castAndWait(D, WATER); // default rod = only owned rod
        if (res.status === "bite") {
          hooked = await waitFor("battle:state", () => D.battleStates[0], { timeoutMs: 8000 });
        }
      }
      if (!hooked) fail("no OldRod bite in 14 casts (p≈6e-5)");
      const species = hooked.opponent?.activePokemon?.name;
      if (!allowed.includes(species)) fail(`OldRod species "${species}" not in ${JSON.stringify(allowed)}`);
      if (waterAllowed.includes(species)) fail(`OldRod drew from the Water (surf) table: ${species}`);
      log(`  ✓ OldRod hooked "${species}" (∈ OldRod table, ∉ surf table)`);
    }

    // ════ Surf step encounters (Water table) ════
    log("── surf step encounters ──");
    const E = await newClient("E");
    await seedAndJoin(E, { mapId: MAP, x: LAND.x, y: LAND.y, moves: ["Surf"] });
    E.socket.emit("player:surf", { x: WATER.x, y: WATER.y });
    await waitFor("E surfing", () => E.surfStates.find((s) => s.surfing === true));
    {
      const allowed = displayNames(WATER_SPECIES);
      // Pace back and forth over open water; each entered cell rolls at the
      // water density (10%).
      let battle: any = null;
      for (let i = 0; i < 140 && !battle; i += 1) {
        const targetX = (i % 2 === 0 ? WATER.x - 1 : WATER.x) * 32;
        E.socket.emit("move", { x: targetX, y: WATER.y * 32 });
        await sleep(220);
        battle = E.battleStates[0] ?? null;
      }
      if (!battle) fail("no surf encounter after 140 water steps (rate 10%)");
      const species = battle.opponent?.activePokemon?.name;
      if (!allowed.includes(species)) fail(`surf species "${species}" not in Water table ${JSON.stringify(allowed)}`);
      log(`  ✓ surfing encountered "${species}" (∈ Water table)`);
    }

    // ════ Underwater encounters (dive map's own Land table) ════
    if (underCell) {
      log("── underwater step encounters ──");
      const F = await newClient("F");
      await seedAndJoin(F, { mapId: UNDERWATER_MAP, x: underCell.x, y: underCell.y, moves: ["Salpicadura"] });
      const underRaw = await redis.get("designer:section:encounters");
      const underTables = JSON.parse(underRaw!).state.items
        .map((i: any) => i.encounterProfile)
        .find((p: any) => String(p.mapId).replace(/^0+/, "") === "149");
      const landRows = underTables?.tables?.find((t: any) => t.method === "Land")?.rows ?? [];
      const allowed = landRows.map((row: any) => namesById.get(row.pokemonId) ?? row.pokemonId);
      let battle: any = null;
      for (let i = 0; i < 100 && !battle; i += 1) {
        const targetX = (underCell.x + (i % 2 === 0 ? 1 : 0)) * 32;
        F.socket.emit("move", { x: targetX, y: underCell.y * 32 });
        await sleep(220);
        battle = F.battleStates[0] ?? null;
      }
      if (!battle) fail("no underwater encounter after 100 steps (rate 25%)");
      const species = battle.opponent?.activePokemon?.name;
      if (!allowed.includes(species)) fail(`underwater species "${species}" not in map-149 Land table ${JSON.stringify(allowed)}`);
      log(`  ✓ underwater encountered "${species}" (∈ Ciudad Hundida table)`);
    } else {
      log("⚠ no walkable underwater cell found — underwater encounter test skipped");
    }

    // ════ Obstacles drawn over water (rocks/cliffs) block surf + fishing ════
    // (61,14) is walkable shore; (61,13) has an impassable tile over sea water
    // — its terrain tag is still "water", but passageTerrainTags marks the
    // deciding tile as non-water, so every water action must refuse it.
    log("── water-obstacle (rock) cells ──");
    {
      const G = await newClient("G");
      await seedAndJoin(G, {
        mapId: MAP, x: 61, y: 14,
        moves: ["Surf"], inventory: [rod("item-superrod")]
      });
      const ROCK = { x: 61, y: 13 };

      G.socket.emit("field:actions", { x: ROCK.x, y: ROCK.y });
      const rockActions = await waitFor("rock field:actions", () =>
        G.fieldActions.find((a) => a.x === ROCK.x && a.y === ROCK.y)
      );
      if (rockActions.actions.fish.available) fail("fishing offered on a rock-over-water cell");
      if (rockActions.actions.surf.available) fail("surf offered on a rock-over-water cell");

      G.socket.emit("player:surf", { x: ROCK.x, y: ROCK.y });
      await waitFor("rock surf rejected", () =>
        G.fieldErrors.find((e) => e.skill === "surf" && /agua/i.test(e.message))
      );
      if (G.surfStates.some((s) => s.surfing === true && s.playerId?.includes(String(G.userId)))) {
        fail("player mounted a rock-over-water cell");
      }

      const rockCast = await castAndWait(G, ROCK, "item-superrod");
      if (rockCast.status !== "error" || !/no se puede pescar/i.test(rockCast.message)) {
        fail(`rock cast should be rejected: ${JSON.stringify(rockCast)}`);
      }
      log("  ✓ rock-over-water cell refuses surf, fishing, and menu availability");
    }

    // ── land-walk must NOT roll water tables: B walks the shore ──
    log("── land walk near water (no water-table encounters) ──");
    {
      for (let i = 0; i < 20; i += 1) {
        const targetX = (i % 2 === 0 ? LAND.x + 1 : LAND.x) * 32;
        B.socket.emit("move", { x: targetX, y: (LAND.y + 2) * 32 });
        await sleep(120);
      }
      if (B.battleStates.length > 0) {
        const species = B.battleStates[0].opponent?.activePokemon?.name;
        if (displayNames(WATER_SPECIES).includes(species)) fail(`land walk drew a Water-table species: ${species}`);
      }
      log("  ✓ shore walking never drew from the Water table");
    }

    log("\n✅ ALL WATER-ACTION ASSERTIONS PASSED");
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n❌", e?.message || e); process.exit(1); });
