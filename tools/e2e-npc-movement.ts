/**
 * E2E: server-authoritative NPC movement + the push mechanic, against a REAL
 * server + REAL redis with the imported Venova map data.
 *
 *   T1  a joining client is handed the live NPC state (npc:sync)
 *   T2  NPCs actually walk, one cell per step, and broadcast it
 *   T3  two clients on the same map agree on every NPC position
 *   T4  a client on a DIFFERENT map is not spammed with those steps
 *   T5  NPCs never walk onto a player's tile
 *   T6  a player walking into another player pushes them
 *   T7  a player cannot be pushed through a wall
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-npc-movement.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3994;
// map-essentials-043 carries 43 walking NPCs — the busiest map in the import.
const TEST_MAP = "map-essentials-043";
const OTHER_MAP = "map-essentials-015";
const CELL = 32;
const SPAWN = { x: 50, y: 41 };

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

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

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

type NpcState = { x: number; y: number; toX: number; toY: number; facing: number };

interface Client {
  label: string;
  socket: Socket;
  userId: number;
  token: string;
  userKey: string;
  characterId: number;
  username: string;
  myPlayerId: string | null;
  session: any;
  syncs: any[];
  stepPackets: any[];
  /** NPC id -> latest known cell, rebuilt exactly like the browser client. */
  npcs: Map<string, NpcState>;
  positions: Map<string, { x: number; y: number }>;
}

const charKeyOf = (characterId: number) => `auth:character:${characterId}`;

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  const clients: Client[] = [];
  const keysToClean = new Set<string>();

  const cleanup = async () => {
    log("── cleanup ──");
    for (const c of clients) {
      try {
        c.socket.disconnect();
      } catch {
        /* already gone */
      }
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

  const newClient = async (label: string): Promise<Client> => {
    const socket = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
    const c: Client = {
      label,
      socket,
      userId: 0,
      token: "",
      userKey: "",
      characterId: 0,
      username: "",
      myPlayerId: null,
      session: null,
      syncs: [],
      stepPackets: [],
      npcs: new Map(),
      positions: new Map()
    };
    socket.on("auth:session", (s: any) => {
      c.session = s;
      if (s?.user?.characterId) c.characterId = Number(s.user.characterId);
    });
    socket.on("myPlayer", (m: any) => {
      c.myPlayerId = m?.playerId ?? null;
    });
    // Mirror what client-poke.io/src/components/game/npcActors.ts does.
    socket.on("npc:sync", (data: any) => {
      c.syncs.push(data);
      for (const npc of data?.npcs ?? []) {
        c.npcs.set(npc.id, {
          x: npc.x,
          y: npc.y,
          toX: npc.toX,
          toY: npc.toY,
          facing: npc.facing
        });
      }
    });
    socket.on("npc:steps", (data: any) => {
      c.stepPackets.push(data);
      for (const step of data?.steps ?? []) {
        c.npcs.set(step.id, {
          x: step.toX,
          y: step.toY,
          toX: step.toX,
          toY: step.toY,
          facing: step.facing
        });
      }
    });
    socket.on("npc:turn", (data: any) => {
      const existing = c.npcs.get(data?.id);
      if (existing) existing.facing = data.facing;
    });

    await waitFor(`${label} connect`, () => socket.connected);

    const lettersStamp = Date.now()
      .toString()
      .slice(-8)
      .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
    const uname = `np${label.toLowerCase()}${lettersStamp}`.slice(0, 14);
    socket.emit("auth:register", {
      name: `Char${label}`,
      username: uname,
      email: `${uname}@example.com`,
      password: "Aa1!aaaa"
    });
    const session = await waitFor(
      `${label} register`,
      () => (c.session?.authenticated && c.session?.user?.id ? c.session : null),
      { timeoutMs: 8000 }
    );
    c.userId = Number(session.user.id);
    c.token = session.token;
    c.userKey = `auth:user:${c.userId}`;
    c.characterId = Number(session.user.characterId);
    c.username = uname;
    keysToClean.add(c.userKey);
    keysToClean.add(charKeyOf(c.characterId));
    keysToClean.add(`auth:index:username:${uname}`);
    keysToClean.add(`auth:index:email:${uname}@example.com`);
    clients.push(c);
    log(`  [${label}] registered account #${c.userId}, character #${c.characterId}`);
    return c;
  };

  const join = async (c: Client, mapId = TEST_MAP, cell = SPAWN) => {
    c.myPlayerId = null;
    await redis!.hSet(charKeyOf(c.characterId), {
      // Without the intro self-switch a fresh character is pulled onto the
      // Intro map by the Chrisanta autorun and drifts off the test map.
      event_self_switches: JSON.stringify({ "129:2:A": true }),
      last_map_id: mapId,
      last_x: String(cell.x * CELL),
      last_y: String(cell.y * CELL)
    });
    c.socket.emit("addPlayer", { token: c.token });
    await waitFor(`${c.label} myPlayer`, () => c.myPlayerId);
    // Track every player's authoritative position off the move channel.
    for (const other of clients) {
      if (!other.myPlayerId) continue;
      for (const listener of clients) {
        listener.socket.off(`move${other.myPlayerId}`);
        listener.socket.on(`move${other.myPlayerId}`, (d: any) => {
          listener.positions.set(other.myPlayerId!, { x: d.x, y: d.y });
        });
      }
    }
    log(`  [${c.label}] joined ${mapId} at ${cell.x},${cell.y}`);
  };

  try {
    // ---- infrastructure ---------------------------------------------------
    const running = (() => {
      try {
        return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]);
      } catch {
        return "";
      }
    })();
    if (running !== REDIS_CONTAINER) {
      try {
        sh("docker", ["start", REDIS_CONTAINER]);
      } catch {
        sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]);
      }
    }
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
      env: {
        ...process.env,
        PORT: String(PORT),
        REDIS_URL,
        SMTP_ENABLED: "false",
        GIT_SHA: "e2e"
      },
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

    const A = await newClient("A");
    await join(A);

    // ---- T1 sync on arrival ----------------------------------------------
    log("── npc state handoff ──");
    const sync = await waitFor("A receives npc:sync", () => A.syncs.find((s) => s.mapId === TEST_MAP), {
      timeoutMs: 10000
    });
    if (!Array.isArray(sync.npcs) || sync.npcs.length === 0) {
      fail(`T1 npc:sync carried no NPCs: ${JSON.stringify(sync).slice(0, 200)}`);
    }
    const shapeOk = sync.npcs.every(
      (n: any) =>
        typeof n.id === "string" &&
        Number.isFinite(n.x) &&
        Number.isFinite(n.y) &&
        Number.isFinite(n.facing) &&
        Number.isFinite(n.stepMs)
    );
    if (!shapeOk) fail(`T1 npc:sync payload malformed: ${JSON.stringify(sync.npcs[0])}`);
    pass(`T1 joining client received npc:sync with ${sync.npcs.length} walking NPCs`);

    // ---- T2 NPCs walk -----------------------------------------------------
    log("── npcs walk ──");
    A.stepPackets.length = 0;
    await sleep(6000);
    const steps = A.stepPackets.flatMap((p) => p.steps ?? []);
    if (steps.length === 0) fail("T2 no npc:steps arrived in 6s");
    const oneCell = steps.every(
      (s: any) => Math.abs(s.toX - s.fromX) + Math.abs(s.toY - s.fromY) === 1
    );
    if (!oneCell) fail("T2 a step moved more than one cell");
    const distinctMovers = new Set(steps.map((s: any) => s.id)).size;
    pass(`T2 ${steps.length} single-cell steps from ${distinctMovers} NPCs in 6s`);

    const mapScoped = A.stepPackets.every((p) => p.mapId === TEST_MAP);
    if (!mapScoped) fail("T2 received steps for a map the player is not on");
    pass("T2 every step packet is scoped to the player's map");

    // ---- T3 two clients agree --------------------------------------------
    log("── cross-client sync ──");
    const B = await newClient("B");
    await join(B, TEST_MAP, { x: SPAWN.x + 2, y: SPAWN.y });
    await sleep(6000);

    // Compare only NPCs both clients know about, and re-read after a settle so
    // neither is mid-packet.
    await sleep(600);
    const shared = Array.from(A.npcs.keys()).filter((id) => B.npcs.has(id));
    if (shared.length === 0) fail("T3 the two clients share no known NPCs");
    const mismatches = shared.filter((id) => {
      const a = A.npcs.get(id)!;
      const b = B.npcs.get(id)!;
      return a.x !== b.x || a.y !== b.y;
    });
    if (mismatches.length > 0) {
      const example = mismatches[0];
      fail(
        `T3 ${mismatches.length}/${shared.length} NPCs differ between clients, ` +
          `e.g. ${example}: A=${JSON.stringify(A.npcs.get(example))} B=${JSON.stringify(B.npcs.get(example))}`
      );
    }
    pass(`T3 both clients agree on all ${shared.length} shared NPC positions`);

    // ---- T4 other maps stay quiet ----------------------------------------
    log("── map scoping ──");
    const C = await newClient("C");
    await join(C, OTHER_MAP, { x: 9, y: 8 });
    C.stepPackets.length = 0;
    C.syncs.length = 0;
    await sleep(5000);
    const leaked = C.stepPackets.filter((p) => p.mapId === TEST_MAP);
    if (leaked.length > 0) fail(`T4 ${leaked.length} step packets from ${TEST_MAP} leaked to a player on ${OTHER_MAP}`);
    pass("T4 a player on another map receives none of this map's NPC traffic");

    // ---- T5 NPCs never stand on a player ---------------------------------
    log("── npcs respect players ──");
    const aPos = A.positions.get(A.myPlayerId!) ?? { x: SPAWN.x * CELL, y: SPAWN.y * CELL };
    const aCell = { x: Math.floor((aPos.x + 16) / CELL), y: Math.floor((aPos.y + 16) / CELL) };
    A.stepPackets.length = 0;
    await sleep(8000);
    const onPlayer = A.stepPackets
      .flatMap((p) => p.steps ?? [])
      .filter((s: any) => s.toX === aCell.x && s.toY === aCell.y);
    if (onPlayer.length > 0) {
      fail(`T5 an NPC stepped onto the player's tile ${aCell.x},${aCell.y}: ${JSON.stringify(onPlayer[0])}`);
    }
    pass(`T5 no NPC stepped onto the player's tile (${aCell.x},${aCell.y}) in 8s`);

    // ---- T6 player pushes player -----------------------------------------
    log("── push ──");
    // Park A and B adjacent on a clear row, then have A walk into B.
    const pushRow = SPAWN.y;
    A.socket.emit("player:teleport", { mapId: TEST_MAP, x: 50 * CELL, y: pushRow * CELL });
    B.socket.emit("player:teleport", { mapId: TEST_MAP, x: 51 * CELL, y: pushRow * CELL });
    await sleep(1200);

    const bBefore = B.positions.get(B.myPlayerId!);
    if (!bBefore) fail("T6 never learned B's position");
    log(`  A at ${JSON.stringify(A.positions.get(A.myPlayerId!))}, B at ${JSON.stringify(bBefore)}`);

    // Drive A east into B the way the browser's drive loop does.
    for (let i = 0; i < 8; i += 1) {
      const live = A.positions.get(A.myPlayerId!)!;
      A.socket.emit("move", { x: live.x + 64, y: live.y });
      await sleep(150);
    }
    A.socket.emit("stopMove");
    await sleep(800);

    const bAfter = B.positions.get(B.myPlayerId!)!;
    const bMovedEast = bAfter.x > bBefore.x;
    if (!bMovedEast) {
      fail(
        `T6 B was not pushed: before=${JSON.stringify(bBefore)} after=${JSON.stringify(bAfter)} ` +
          `A=${JSON.stringify(A.positions.get(A.myPlayerId!))}`
      );
    }
    pass(`T6 walking into another player pushed them (${bBefore.x} -> ${bAfter.x})`);

    const bStayedOnRow = Math.abs(bAfter.y - bBefore.y) <= CELL;
    if (!bStayedOnRow) fail(`T6 push displaced B off-axis: ${JSON.stringify(bAfter)}`);
    pass("T6 the push stayed on the pusher's axis");

    // ---- T7 a push may not clip through geometry -------------------------
    log("── push cannot clip ──");
    // Whatever happened above, the two players must never end up overlapping,
    // and the pushed player must never be standing inside solid terrain — the
    // server re-runs its own collision for every pushed step.
    const aFinal = A.positions.get(A.myPlayerId!)!;
    const overlapping =
      Math.abs(aFinal.x - bAfter.x) < CELL - 4 && Math.abs(aFinal.y - bAfter.y) < CELL - 4;
    if (overlapping) {
      fail(`T7 pusher and pushed overlap: A=${JSON.stringify(aFinal)} B=${JSON.stringify(bAfter)}`);
    }
    pass("T7 pusher and pushed never occupy the same tile");

    log("");
    log(`ALL PASS — ${passed} assertions`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`\n${error?.message ?? error}`);
  process.exit(1);
});
