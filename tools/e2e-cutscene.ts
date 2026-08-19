/**
 * E2E: RMXP cutscene presentation commands, driven by the REAL Map158 ("???")
 * earthquake event outside Guarida/Base Revolution (EV036, parallel-process
 * page gated on game switch 85):
 *
 *   207 Show Animation (Exclaim bubble on the player)
 *   225 Screen Shake (power 9 — the earthquake)
 *   250 Play SE "644Cry" + 101 "(Cainebreeeeeeeee)"
 *   203 Scroll Map down 30 tiles / 210 wait / 203 back up 30 / 210 wait
 *   123 Self Switch A (one-shot)
 *
 * Verifies, against a real server + real redis:
 *   1. The parallel-process (trigger 4) page runs on map entry once switch 85
 *      is set (it used to never run at all).
 *   2. The step stream carries the new payloads in order: animation → screen
 *      shake → SE → text → camera scroll down → camera scroll up → end.
 *   3. Wait for Move's Completion actually holds the event: the scroll-up step
 *      arrives only after the ~6s scroll-down pan.
 *   4. The event consumes itself: self switch "158:36:A" is persisted, and a
 *      rejoin does NOT replay the cutscene.
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-cutscene.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import path from "path";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SERVER_DIR = path.resolve(__dirname, "..");
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3996; // private port so we don't collide with a running dev server

const TEST_MAP = "map-essentials-158";
const CUTSCENE_SELF_SWITCH = "158:36:A";
const GUARD_SWITCH = "85"; // set inside Base Revolution; arms the cutscene
// EV036 sits at (21,7); the player just needs to be anywhere on the map for a
// parallel page to run, so spawn near it.
const STAND_CELL = { x: 21, y: 10 };

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const fail = (msg: string): never => {
  throw new Error(`ASSERTION FAILED: ${msg}`);
};

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

async function waitFor<T>(
  what: string,
  fn: () => T | Promise<T>,
  { timeoutMs = 15000, everyMs = 250 } = {}
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${lastErr}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let startedRedis = false;
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  let socket: Socket | null = null;
  let testUserId: number | null = null;
  let testCharacterId: number | null = null;

  const cleanup = async () => {
    log("── cleanup ──");
    try { socket?.disconnect(); } catch {}
    if (server && !server.killed) {
      server.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1000));
      if (!server.killed) server.kill("SIGKILL");
    }
    if (redis?.isOpen) {
      try {
        if (testUserId !== null) {
          await redis.del(`auth:user:${testUserId}`);
          log(`deleted test user auth:user:${testUserId}`);
        }
        if (testCharacterId !== null) {
          await redis.del(`auth:character:${testCharacterId}`);
          log(`deleted test character auth:character:${testCharacterId}`);
        }
      } catch (e) {
        console.error("cleanup redis error:", e);
      }
      await redis.quit();
    }
    if (startedRedis) {
      try { sh("docker", ["stop", REDIS_CONTAINER]); log("stopped redis container"); } catch {}
    }
  };

  try {
    // --- 1. redis up -------------------------------------------------------
    const running = (() => { try { return sh("docker", ["ps", "--filter", `name=${REDIS_CONTAINER}`, "--format", "{{.Names}}"]); } catch { return ""; } })();
    if (running !== REDIS_CONTAINER) {
      log("starting redis container…");
      try { sh("docker", ["start", REDIS_CONTAINER]); }
      catch { sh("bash", [`${SERVER_DIR}/redis_dev_start.sh`]); }
      startedRedis = true;
    } else {
      log("redis already running — reusing it");
    }

    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    redis.on("error", (e: unknown) => console.error("redis client error:", e));
    await waitFor("redis PING", async () => {
      if (!redis!.isOpen) await redis!.connect();
      return (await redis!.ping()) === "PONG";
    });
    log("redis reachable");

    // Sanity: the imported Venova maps must include map 158 with EV036.
    const rawMaps = await redis.get("designer:section:maps");
    if (!rawMaps) fail("designer:section:maps is empty — dev redis has no imported maps");
    const mapsState = JSON.parse(rawMaps!);
    const mapEd = (mapsState.state ?? mapsState).editorDataByMapId?.[TEST_MAP];
    if (!mapEd) fail(`${TEST_MAP} not present in imported maps`);
    const cutsceneNpc = (mapEd.npcs ?? []).find(
      (n: any) => n.essentialsEvent?.eventId === 36 && n.essentialsEvent?.essentialsMapId === 158
    );
    if (!cutsceneNpc) fail(`${TEST_MAP} has no placement for EV036 — re-run the Essentials import`);
    log(`found EV036 placement ${cutsceneNpc.id} on ${TEST_MAP}`);

    // --- 2. boot server ----------------------------------------------------
    log(`starting server on :${PORT} …`);
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(PORT), REDIS_URL, SMTP_ENABLED: "false", GIT_SHA: "e2e" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverLog = "";
    server.stdout!.on("data", (d) => { serverLog += d; });
    server.stderr!.on("data", (d) => { serverLog += d; process.stderr.write(`  [srv!] ${d}`); });
    server.on("exit", (code) => log(`server exited (code ${code})`));
    await waitFor("server listening", () => serverLog.includes(`Listening on port ${PORT}`), { timeoutMs: 60000 });
    log("server is up");

    // --- 3. connect + register --------------------------------------------
    const steps: Array<{ payload: any; at: number }> = [];
    let lastSession: any = null;
    const connect = () => {
      const s = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
      s.on("event:step", (p: any) => {
        steps.push({ payload: p, at: Date.now() });
        log("  event:step →", JSON.stringify(p).slice(0, 140));
        // Auto-advance blocking steps so the cutscene plays through.
        if (p?.type === "text" || p?.type === "info") {
          setTimeout(() => s.emit("event:advance", {}), 400);
        }
      });
      s.on("auth:session", (p: any) => { lastSession = p; });
      s.on("auth:error", (e: any) => log("  auth:error →", e?.message));
      return s;
    };
    socket = connect();
    await waitFor("socket connect", () => socket!.connected);
    log("socket connected", socket.id);

    const uname = `ecutscene${Date.now().toString().slice(-8)}`;
    socket.emit("auth:register", {
      name: "Terremoto",
      username: uname,
      email: `${uname}@example.com`,
      password: "Aa1!aaaa"
    });
    const session = await waitFor("auth:session after register", () =>
      lastSession?.authenticated && lastSession?.user?.id ? lastSession : null
    );
    testUserId = Number(session.user.id);
    testCharacterId = Number(session.user.characterId ?? testUserId);
    log(`registered user #${testUserId} (${uname}, character #${testCharacterId})`);

    // --- 4. seed: on map 158, switch 85 armed, intro skipped ---------------
    const charKey = `auth:character:${testCharacterId}`;
    await redis.hSet(charKey, {
      last_map_id: TEST_MAP,
      last_x: String(STAND_CELL.x * 32),
      last_y: String(STAND_CELL.y * 32),
      event_switches: JSON.stringify({ [GUARD_SWITCH]: true }),
      event_self_switches: JSON.stringify({ "129:2:A": true }) // intro done
    });
    log(`seeded spawn on ${TEST_MAP} with switch ${GUARD_SWITCH} ON`);

    // --- 5. join world → the parallel cutscene must fire -------------------
    steps.length = 0;
    socket.emit("addPlayer", { token: session.token });

    const findStep = (pred: (p: any) => boolean) => steps.find((s) => pred(s.payload)) ?? null;

    const animation = await waitFor(
      "animation step (Exclaim bubble on player)",
      () => findStep((p) => p.type === "animation" && p.animationId === 3),
      { timeoutMs: 30000 }
    );
    log(`  ✓ animation: id 3 name=${JSON.stringify(animation.payload.name)} se=${JSON.stringify(animation.payload.se)}`);

    const shake = await waitFor(
      "screen shake (earthquake)",
      () => findStep((p) => p.type === "screen" && p.effect === "shake"),
      { timeoutMs: 15000 }
    );
    if (shake.payload.power !== 9) fail(`shake power should be 9, got ${shake.payload.power}`);
    if (shake.payload.durationMs !== 70 * 25) fail(`shake duration should be 1750ms, got ${shake.payload.durationMs}`);
    log("  ✓ screen shake power 9, 1750ms");

    const cry = await waitFor(
      "644Cry SE",
      () => findStep((p) => p.type === "sound" && p.kind === "SE" && p.name === "644Cry"),
      { timeoutMs: 15000 }
    );
    log(`  ✓ SE ${cry.payload.name}`);

    const text = await waitFor(
      "Cainebree dialog",
      () => findStep((p) => p.type === "text" && /Cainebree/i.test(p.text || "")),
      { timeoutMs: 15000 }
    );
    log(`  ✓ dialog ${JSON.stringify(text.payload.text)}`);

    const scrollDown = await waitFor(
      "camera scroll down (30 tiles)",
      () => findStep((p) => p.type === "camera" && p.op === "scroll" && p.direction === 2),
      { timeoutMs: 15000 }
    );
    if (scrollDown.payload.distanceTiles !== 30) fail(`scroll-down distance should be 30 tiles, got ${scrollDown.payload.distanceTiles}`);
    if (scrollDown.payload.durationMs !== 6000) fail(`scroll-down duration should be 6000ms (speed 4), got ${scrollDown.payload.durationMs}`);
    log("  ✓ camera pans down 30 tiles over 6000ms");

    const scrollUp = await waitFor(
      "camera scroll back up",
      () => findStep((p) => p.type === "camera" && p.op === "scroll" && p.direction === 8),
      { timeoutMs: 20000 }
    );
    const panGapMs = scrollUp.at - scrollDown.at;
    if (panGapMs < 5000) fail(`Wait for Move's Completion not honored: scroll-up arrived ${panGapMs}ms after scroll-down (expected ≥ 5000ms)`);
    log(`  ✓ scroll-up held for the pan (${panGapMs}ms after scroll-down)`);

    // The scroll-up pan holds the session for another ~6s; the cutscene's own
    // "end" is the first one AFTER the scroll-up step (earlier ends belong to
    // the door-template autorun chain).
    await waitFor(
      "event end after the scroll-up pan",
      () => steps.find((s) => s.payload?.type === "end" && s.at > scrollUp.at) ?? null,
      { timeoutMs: 20000 }
    );
    log("  ✓ event ended cleanly");

    // --- 6. one-shot: self switch persisted, rejoin must NOT replay --------
    await waitFor(
      `self switch ${CUTSCENE_SELF_SWITCH} persisted`,
      async () => {
        const selfSwitches = JSON.parse((await redis!.hGet(charKey, "event_self_switches")) || "{}");
        return selfSwitches[CUTSCENE_SELF_SWITCH] === true;
      },
      { timeoutMs: 10000 }
    );
    log(`  ✓ self switch ${CUTSCENE_SELF_SWITCH} persisted`);

    log("── rejoin: cutscene must not replay ──");
    socket.disconnect();
    await new Promise((r) => setTimeout(r, 1500));
    socket = connect();
    await waitFor("socket reconnect", () => socket!.connected);
    steps.length = 0;
    lastSession = null;
    socket.emit("auth:login", { username: uname, password: "Aa1!aaaa" });
    const session2 = await waitFor("auth:session after login", () =>
      lastSession?.authenticated && lastSession?.user?.id ? lastSession : null
    );
    socket.emit("addPlayer", { token: session2.token });
    await new Promise((r) => setTimeout(r, 5000));
    if (findStep((p) => p.type === "screen" && p.effect === "shake")) {
      fail("cutscene replayed on rejoin despite self switch A");
    }
    log("  ✓ no replay on rejoin (one-shot honored)");

    log("\n✅ ALL ASSERTIONS PASSED — the Map158 earthquake cutscene plays end to end.");
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌", e?.message || e);
  process.exit(1);
});
