/**
 * E2E: the chat system against a REAL server + REAL redis.
 *
 * Two live socket clients stand on the same map and exercise every chat
 * channel the ChatBar can drive:
 *
 *   T1  map message reaches every player on the map (sender included)
 *   T2  map message payload carries account + character identity
 *   T3  /w whisper reaches the target and echoes back to the sender
 *   T4  /global reaches players on other maps
 *   T5  /help answers with a system message
 *   T6  private chat: create → invite → accept → message
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-chat.ts
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3995;
const TEST_MAP = "map-essentials-043";
const OTHER_MAP = "map-essentials-015";

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
  userKey: string;
  characterId: number;
  username: string;
  myPlayerId: string | null;
  session: any;
  chatMessages: any[];
  chatErrors: string[];
  privateStates: any[];
  privateMessages: any[];
  chatInvites: any[];
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
      chatMessages: [],
      chatErrors: [],
      privateStates: [],
      privateMessages: [],
      chatInvites: []
    };
    socket.on("auth:session", (s: any) => {
      c.session = s;
      if (s?.user?.characterId) c.characterId = Number(s.user.characterId);
    });
    socket.on("myPlayer", (m: any) => {
      c.myPlayerId = m?.playerId ?? null;
    });
    socket.on("chat:message", (m: any) => c.chatMessages.push(m));
    socket.on("chat:error", (e: any) => c.chatErrors.push(String(e?.message ?? "")));
    socket.on("chat:private-state", (s: any) => c.privateStates.push(s));
    socket.on("chat:private-message", (m: any) => c.privateMessages.push(m));
    socket.on("chat:invite-received", (i: any) => c.chatInvites.push(i));

    await waitFor(`${label} connect`, () => socket.connected);

    const lettersStamp = Date.now()
      .toString()
      .slice(-8)
      .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
    const uname = `ch${label.toLowerCase()}${lettersStamp}`.slice(0, 14);
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
    log(`  [${label}] registered account #${c.userId}, character #${c.characterId} (@${uname})`);
    return c;
  };

  const join = async (c: Client, mapId = TEST_MAP) => {
    c.myPlayerId = null;
    await redis!.hSet(charKeyOf(c.characterId), {
      // Without the intro self-switch a fresh character is pulled onto the
      // Intro map by the Chrisanta autorun and drifts off the test map.
      event_self_switches: JSON.stringify({ "129:2:A": true }),
      last_map_id: mapId,
      last_x: String(50 * 32),
      last_y: String(41 * 32)
    });
    c.socket.emit("addPlayer", { token: c.token });
    await waitFor(`${c.label} myPlayer`, () => c.myPlayerId);
    log(
      `  [${c.label}] joined as ${c.myPlayerId} on ` +
        `${await redis!.hGet(charKeyOf(c.characterId), "last_map_id")}`
    );
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
    const B = await newClient("B");
    await join(A);
    await join(B);
    log(`both clients standing on ${TEST_MAP}`);

    // ---- T1/T2 map chat ---------------------------------------------------
    log("── map chat ──");
    A.chatMessages.length = 0;
    B.chatMessages.length = 0;
    A.chatErrors.length = 0;
    A.socket.emit("chat:map-message", { text: "hola mundo" });

    const bGot = await waitFor(
      "B receives A's map message",
      () => B.chatMessages.find((m) => m.text === "hola mundo"),
      { timeoutMs: 6000 }
    ).catch((e) => {
      log(`  ✗ ${e}`);
      log(`  A chat errors: ${JSON.stringify(A.chatErrors)}`);
      return null;
    });
    if (!bGot) fail(`T1 map message never reached B (A errors: ${JSON.stringify(A.chatErrors)})`);
    pass("T1 map message reaches another player on the map");

    const aEcho = A.chatMessages.find((m) => m.text === "hola mundo");
    if (!aEcho) fail("T1 sender never saw its own map message");
    pass("T1 sender sees its own map message");

    if (bGot.channel !== "map") fail(`T2 channel wrong: ${bGot.channel}`);
    if (bGot.fromAccountId !== A.userId) fail(`T2 fromAccountId wrong: ${bGot.fromAccountId}`);
    if (bGot.fromCharacterId !== A.characterId) fail(`T2 fromCharacterId wrong: ${bGot.fromCharacterId}`);
    if (!bGot.fromCharacterName) fail("T2 fromCharacterName missing");
    if ("email" in bGot) fail("T2 payload leaks email");
    pass("T2 map payload carries account + character identity");

    // ---- T3 whisper -------------------------------------------------------
    log("── whisper ──");
    A.chatMessages.length = 0;
    B.chatMessages.length = 0;
    A.chatErrors.length = 0;
    A.socket.emit("chat:map-message", { text: `/w ${B.username} secreto` });

    const bWhisper = await waitFor(
      "B receives whisper",
      () => B.chatMessages.find((m) => m.channel === "whisper" && m.text === "secreto"),
      { timeoutMs: 6000 }
    ).catch(() => null);
    if (!bWhisper) fail(`T3 whisper never reached B (A errors: ${JSON.stringify(A.chatErrors)})`);
    pass("T3 whisper reaches the target");

    const aWhisperEcho = A.chatMessages.find((m) => m.channel === "whisper" && m.text === "secreto");
    if (!aWhisperEcho) fail("T3 whisper never echoed back to the sender");
    pass("T3 whisper echoes back to the sender");

    // ---- T4 global --------------------------------------------------------
    log("── global ──");
    const C = await newClient("C");
    await join(C, OTHER_MAP);

    // A plain trainer may not broadcast.
    A.chatErrors.length = 0;
    C.chatMessages.length = 0;
    A.socket.emit("chat:map-message", { text: "/global no deberia salir" });
    await waitFor(
      "A is refused the /global broadcast",
      () => A.chatErrors.some((e) => /moderator|admin/i.test(e)),
      { timeoutMs: 6000 }
    );
    if (C.chatMessages.some((m) => m.text === "no deberia salir")) {
      fail("T4 an unprivileged /global still went out");
    }
    pass("T4 /global is refused for a plain trainer");

    // Promote A to moderator on the ACCOUNT hash, then re-auth so the socket
    // picks up the new permissions.
    await redis!.hSet(A.userKey, { role: "moderator" });
    A.session = null;
    A.socket.emit("auth:session", { token: A.token });
    await waitFor(
      "A session carries moderator permissions",
      () => (A.session?.user?.permissions ?? []).includes("moderator.access"),
      { timeoutMs: 8000 }
    );

    A.chatMessages.length = 0;
    C.chatMessages.length = 0;
    A.chatErrors.length = 0;
    A.socket.emit("chat:map-message", { text: "/global buenas a todos" });

    const cGlobal = await waitFor(
      "C receives global",
      () => C.chatMessages.find((m) => m.channel === "global" && m.text === "buenas a todos"),
      { timeoutMs: 6000 }
    ).catch(() => null);
    if (!cGlobal) fail(`T4 global never crossed maps (A errors: ${JSON.stringify(A.chatErrors)})`);
    pass("T4 a moderator's /global reaches players on other maps");

    // ---- T6 private chat --------------------------------------------------
    log("── private chat ──");
    A.privateStates.length = 0;
    B.chatInvites.length = 0;
    A.chatErrors.length = 0;
    A.socket.emit("chat:private-create", { userIds: [B.userId] });

    const invite = await waitFor(
      "B receives a chat invite",
      () => B.chatInvites[0],
      { timeoutMs: 6000 }
    ).catch(() => null);
    if (!invite) fail(`T6 private-chat invite never arrived (A errors: ${JSON.stringify(A.chatErrors)})`);
    pass("T6 private chat invite reaches the target");

    B.privateStates.length = 0;
    B.socket.emit("chat:invite-respond", { inviteId: invite.inviteId, accepted: true });
    const joinedState = await waitFor(
      "B joins the private chat",
      () => B.privateStates.find((s) => s.chatId === invite.chatId),
      { timeoutMs: 6000 }
    ).catch(() => null);
    if (!joinedState) fail("T6 accepting the invite produced no private-state");
    pass("T6 accepting the invite joins the chat");

    A.privateMessages.length = 0;
    B.privateMessages.length = 0;
    B.socket.emit("chat:private-message", { chatId: invite.chatId, text: "privado hola" });
    const aPrivate = await waitFor(
      "A receives the private message",
      () => A.privateMessages.find((m) => m.text === "privado hola" || m?.message?.text === "privado hola"),
      { timeoutMs: 6000 }
    ).catch(() => null);
    if (!aPrivate) fail("T6 private message never reached the other member");
    pass("T6 private message reaches the other member");

    // ---- T7 blocks still filter map chat ----------------------------------
    // The block filter is the reason map delivery is per-recipient; make sure
    // it still drops the blocker's copy WITHOUT dropping everyone else's.
    log("── blocks ──");
    const D = await newClient("D");
    await join(D, TEST_MAP);
    B.socket.emit("friends:block", { accountId: A.userId });
    await sleep(500);

    A.chatMessages.length = 0;
    B.chatMessages.length = 0;
    D.chatMessages.length = 0;
    A.chatErrors.length = 0;
    A.socket.emit("chat:map-message", { text: "mensaje bloqueado" });

    const dGotBlocked = await waitFor(
      "D still receives A's map message",
      () => D.chatMessages.find((m) => m.text === "mensaje bloqueado"),
      { timeoutMs: 6000 }
    ).catch(() => null);
    if (!dGotBlocked) fail("T7 a block silenced A for everyone, not just the blocker");
    pass("T7 a block does not disturb other listeners on the map");

    if (B.chatMessages.some((m) => m.text === "mensaje bloqueado")) {
      fail("T7 the blocking account still received the message");
    }
    pass("T7 the blocking account does not receive the message");

    // ---- T5 /help rescue (last: it teleports the sender away) --------------
    // In this game "/help" ("/ayuda") is the rescue command, not a command
    // list — it returns the player to the last Venomon Center.
    log("── /help rescue ──");
    D.chatMessages.length = 0;
    D.chatErrors.length = 0;
    D.socket.emit("chat:map-message", { text: "/help" });
    const rescueReply = await waitFor(
      "D receives the rescue system message",
      () => D.chatMessages.find((m) => m.channel === "system"),
      { timeoutMs: 6000 }
    ).catch(() => null);
    if (!rescueReply) fail(`T5 /help did not rescue (errors: ${JSON.stringify(D.chatErrors)})`);
    pass("T5 /help returns the player to safety with a system message");

    log("");
    log(`ALL CHAT CHECKS PASSED (${passed} assertions)`);
  } finally {
    await cleanup();
  }
}

main().catch(async (e) => {
  console.error("");
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
