/**
 * E2E: follower venomon + /pelota beach ball against a REAL server + redis.
 *
 *   T1  the party leader materializes as a follower (charset from its dex number)
 *   T2  walking emits follower:steps that trail the owner
 *   T3  follower:set-enabled toggles the follower off (follower:remove) and back on
 *   T4  /pelota spawns one ball on the facing cell (ball:spawn)
 *   T5  walking into the ball rolls it (ball:step, pushesLeft decrements)
 *   T6  a second /pelota on the same map spawns a ball that deflates instantly
 *   T7  push chain (depth 2): pushing the ball into another player shoves both
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-follower-ball.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3996;
const TEST_MAP = "map-essentials-043";
const CELL = 32;
/** Open ground on the chat-test map (see e2e-chat.ts). */
const BASE_X = 50;
const BASE_Y = 41;

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

interface Client {
  label: string;
  socket: Socket;
  userId: number;
  token: string;
  characterId: number;
  myPlayerId: string | null;
  session: any;
  chatErrors: string[];
  followerUpdates: any[];
  followerSyncs: any[];
  followerSteps: any[];
  followerRemoves: any[];
  ballSpawns: any[];
  ballSteps: any[];
  ballDeflates: any[];
  moves: Map<string, any[]>;
}

const charKeyOf = (characterId: number) => `auth:character:${characterId}`;

/** A minimal but storage-sane party leader (PIKACHU -> dex 25 -> charset 025). */
function leaderSummary() {
  return {
    id: `e2e-leader-${Date.now()}`,
    sourcePokemonId: "pokemon-PIKACHU",
    name: "Lapitta",
    level: 12,
    types: ["ELECTRIC"],
    hp: 30,
    maxHp: 30,
    moves: ["Impactrueno"],
    experience: 0,
    experienceCurve: "medium",
    nextLevelExperience: 100,
    statBonuses: { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 }
  };
}

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
      characterId: 0,
      myPlayerId: null,
      session: null,
      chatErrors: [],
      followerUpdates: [],
      followerSyncs: [],
      followerSteps: [],
      followerRemoves: [],
      ballSpawns: [],
      ballSteps: [],
      ballDeflates: [],
      moves: new Map()
    };
    socket.on("auth:session", (s: any) => {
      c.session = s;
      if (s?.user?.characterId) c.characterId = Number(s.user.characterId);
    });
    socket.on("myPlayer", (m: any) => {
      c.myPlayerId = m?.playerId ?? null;
    });
    socket.on("chat:error", (e: any) => c.chatErrors.push(String(e?.message ?? "")));
    socket.on("follower:update", (d: any) => c.followerUpdates.push(d));
    socket.on("follower:sync", (d: any) => c.followerSyncs.push(d));
    socket.on("follower:steps", (d: any) => c.followerSteps.push(d));
    socket.on("follower:remove", (d: any) => c.followerRemoves.push(d));
    socket.on("ball:spawn", (d: any) => c.ballSpawns.push(d));
    socket.on("ball:step", (d: any) => c.ballSteps.push(d));
    socket.on("ball:deflate", (d: any) => c.ballDeflates.push(d));
    socket.onAny((event: string, data: any) => {
      if (event.startsWith("move")) {
        const bucket = c.moves.get(event) ?? [];
        bucket.push(data);
        c.moves.set(event, bucket);
      }
    });

    await waitFor(`${label} connect`, () => socket.connected);

    const lettersStamp = Date.now()
      .toString()
      .slice(-8)
      .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
    const uname = `fb${label.toLowerCase()}${lettersStamp}`.slice(0, 14);
    socket.emit("auth:register", {
      name: `Foll${label}`,
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
    c.characterId = Number(session.user.characterId);
    keysToClean.add(`auth:user:${c.userId}`);
    keysToClean.add(charKeyOf(c.characterId));
    keysToClean.add(`auth:index:username:${uname}`);
    keysToClean.add(`auth:index:email:${uname}@example.com`);
    clients.push(c);
    log(`  [${label}] registered account #${c.userId}, character #${c.characterId}`);
    return c;
  };

  const join = async (c: Client, cellX: number, cellY: number, withLeader = true) => {
    c.myPlayerId = null;
    await redis!.hSet(charKeyOf(c.characterId), {
      // Without the intro self-switch a fresh character is pulled onto the
      // Intro map by the Chrisanta autorun and drifts off the test map.
      event_self_switches: JSON.stringify({ "129:2:A": true }),
      last_map_id: TEST_MAP,
      last_x: String(cellX * CELL),
      last_y: String(cellY * CELL),
      ...(withLeader ? { pokemon_party: JSON.stringify([leaderSummary()]) } : {})
    });
    c.socket.emit("addPlayer", { token: c.token });
    await waitFor(`${c.label} myPlayer`, () => c.myPlayerId);
    log(`  [${c.label}] joined as ${c.myPlayerId} at cell (${cellX}, ${cellY})`);
  };

  /** Drive-loop imitation: re-emits a pixel-target move until timeout or check passes. */
  const driveUntil = async (
    c: Client,
    targetX: number,
    targetY: number,
    what: string,
    check: () => boolean,
    timeoutMs = 8000
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      c.socket.emit("move", { x: targetX, y: targetY });
      await sleep(150);
    }
    return check();
  };

  try {
    const running = (() => {
      try {
        return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]);
      } catch {
        return "";
      }
    })();
    if (running !== REDIS_CONTAINER) {
      sh("docker", ["start", REDIS_CONTAINER]);
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
    await join(A, BASE_X, BASE_Y);

    // ---- T1 follower appears ---------------------------------------------
    log("── T1 follower appears ──");
    const followerBirth = await waitFor(
      "A's follower to materialize",
      () =>
        A.followerUpdates.find((d) => d?.follower?.ownerId === A.myPlayerId) ??
        A.followerSyncs
          .flatMap((d) => d?.followers ?? [])
          .find((f: any) => f?.ownerId === A.myPlayerId),
      { timeoutMs: 10000 }
    );
    const bornFollower = followerBirth.follower ?? followerBirth;
    if (bornFollower.charset !== "025") {
      fail(`expected charset 025 for PIKACHU leader, got ${bornFollower.charset}`);
    }
    if (bornFollower.hidden) fail("follower should be visible on land");
    pass(`follower materialized with charset ${bornFollower.charset}`);

    // ---- T2 follower walks behind the owner ------------------------------
    log("── T2 follower trails the walk ──");
    A.followerSteps.length = 0;
    const walkTarget = { x: (BASE_X + 3) * CELL, y: BASE_Y * CELL };
    await driveUntil(
      A,
      walkTarget.x,
      walkTarget.y,
      "walk right 3 cells",
      () => A.followerSteps.flatMap((d) => d?.steps ?? []).length >= 2,
      10000
    );
    const trailSteps = A.followerSteps.flatMap((d) => d?.steps ?? []);
    if (trailSteps.length < 2) fail(`expected >=2 follower steps, got ${trailSteps.length}`);
    pass(`follower stepped ${trailSteps.length} times behind the walk`);

    // ---- T3 toggle off / on ----------------------------------------------
    log("── T3 follower toggle ──");
    A.socket.emit("follower:set-enabled", { enabled: false });
    await waitFor("follower:remove after disable", () =>
      A.followerRemoves.find((d) => d?.ownerId === A.myPlayerId)
    );
    pass("disabling the follower removed it from the map");
    A.followerUpdates.length = 0;
    A.socket.emit("follower:set-enabled", { enabled: true });
    await waitFor("follower back after enable", () =>
      A.followerUpdates.find((d) => d?.follower?.ownerId === A.myPlayerId)
    );
    pass("re-enabling the follower brought it back");

    // ---- T4 /pelota spawns a ball ----------------------------------------
    log("── T4 /pelota ──");
    A.socket.emit("chat:map-message", { text: "/pelota" });
    const spawn1 = await waitFor("ball:spawn", () => A.ballSpawns[0]);
    if (spawn1.ball?.deflated) fail("first ball must not spawn deflated");
    if (spawn1.ball?.pushesLeft !== 30) fail(`expected 30 pushes, got ${spawn1.ball?.pushesLeft}`);
    pass(`ball spawned at cell (${spawn1.ball.x}, ${spawn1.ball.y}) with 30 pushes`);

    // ---- T5 pushing the ball ---------------------------------------------
    log("── T5 push the ball ──");
    A.ballSteps.length = 0;
    // Walk into the ball's CURRENT cell each drive tick — it rolls away, so a
    // fixed target would leave the player parked on the vacated cell.
    const ballCell = () => {
      const step = A.ballSteps[A.ballSteps.length - 1];
      return step ? { x: step.toX, y: step.toY } : { x: spawn1.ball.x, y: spawn1.ball.y };
    };
    {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && A.ballSteps.length < 2) {
        const cell = ballCell();
        A.socket.emit("move", { x: cell.x * CELL, y: cell.y * CELL });
        await sleep(150);
      }
    }
    if (A.ballSteps.length < 2) fail(`expected >=2 ball steps, got ${A.ballSteps.length}`);
    const lastStep = A.ballSteps[A.ballSteps.length - 1];
    if (typeof lastStep.pushesLeft !== "number" || lastStep.pushesLeft >= 30) {
      fail(`pushesLeft should decrement, got ${lastStep.pushesLeft}`);
    }
    pass(`ball rolled ${A.ballSteps.length} cells (pushesLeft now ${lastStep.pushesLeft})`);

    // ---- T6 one ball per map ---------------------------------------------
    log("── T6 second /pelota deflates instantly ──");
    // Chat rate limit: 6 messages / 5s — the earlier command counts, so pace it.
    await sleep(1000);
    A.ballDeflates.length = 0;
    const spawnsBefore = A.ballSpawns.length;
    A.socket.emit("chat:map-message", { text: "/ball" });
    await waitFor("second ball spawn", () => A.ballSpawns.length > spawnsBefore);
    const spawn2 = A.ballSpawns[A.ballSpawns.length - 1];
    await waitFor("second ball deflate", () =>
      A.ballDeflates.find((d) => d?.id === spawn2.ball.id)
    );
    pass("second ball on the map deflated immediately (one-per-map rule)");

    // ---- T7 push chain (depth 2) -----------------------------------------
    log("── T7 push-over-push chain ──");
    // B (no venomon, so no follower in the lane) stands on the far side of the
    // ball along A's push axis; A pushes the ball INTO B — depth 2 displaces both.
    const ballCellX = ballCell().x as number;
    const ballCellY = ballCell().y as number;
    const aMoves = A.moves.get(`move${A.myPlayerId}`) ?? [];
    const aLast = aMoves[aMoves.length - 1] ?? { x: BASE_X * CELL, y: BASE_Y * CELL };
    const aCellX = Math.floor((aLast.x + CELL / 2) / CELL);
    const aCellY = Math.floor((aLast.y + CELL / 2) / CELL);
    const pushDx = Math.abs(ballCellX - aCellX) >= Math.abs(ballCellY - aCellY)
      ? Math.sign(ballCellX - aCellX)
      : 0;
    const pushDy = pushDx === 0 ? Math.sign(ballCellY - aCellY) : 0;
    log(`  A at (${aCellX}, ${aCellY}), ball at (${ballCellX}, ${ballCellY}), push axis (${pushDx}, ${pushDy})`);
    const B = await newClient("B");
    await join(B, ballCellX + pushDx, ballCellY + pushDy, false);
    await sleep(600);

    A.ballSteps.length = 0;
    const bMoveEvents = () => B.moves.get(`move${B.myPlayerId}`) ?? [];
    const bMovesBefore = bMoveEvents().length;
    {
      const deadline = Date.now() + 12000;
      while (
        Date.now() < deadline &&
        !(A.ballSteps.length >= 1 && bMoveEvents().length > bMovesBefore)
      ) {
        const step = A.ballSteps[A.ballSteps.length - 1];
        const cell = step ? { x: step.toX, y: step.toY } : { x: ballCellX, y: ballCellY };
        A.socket.emit("move", { x: cell.x * CELL, y: cell.y * CELL });
        await sleep(150);
      }
    }
    if (A.ballSteps.length < 1) fail("chain: ball never moved");
    if (bMoveEvents().length <= bMovesBefore) fail("chain: player B was never displaced");
    pass("depth-2 chain: the ball pushed into B displaced B and then rolled on");

    log("");
    log(`ALL ${passed} CHECKS PASSED ✔`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
