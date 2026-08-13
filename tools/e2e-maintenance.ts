/**
 * E2E: the admin-panel Maintenance surface against a REAL server + REAL redis.
 *
 *   T1  non-admin is denied the maintenance list
 *   T2  admin sees the action list (incl. reset-all-adventures) + emailEnabled flag
 *   T3  running the migration report streams logs and records a report
 *   T4  the stored report renders as an HTML document with the console output
 *   T5  emailing a report without SMTP fails with a clear message
 *   T6  rxdata zip upload over HTTP: non-admin 401/403, bad zip 422, good zip staged
 *   T7  repair-essentials-events lists the uploaded zip as its data source; clear restores bundled
 *   T8  global broadcast reaches an in-game player and reports recipients
 *   T9  reset-all-adventures dry run counts accounts without modifying data
 *
 * The real (non-dry) reset-all-adventures run is deliberately NOT exercised —
 * it would wipe every account on the shared dev redis.
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/e2e-maintenance.ts
 */
import AdmZip from "adm-zip";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { createClient, type RedisClientType } from "redis";
import { io, type Socket } from "socket.io-client";

const SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io";
const REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_CONTAINER = "redis-dev";
const PORT = 3996;
const TEST_MAP = "map-essentials-043";

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
  { timeoutMs = 20000, everyMs = 100 } = {}
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
  username: string;
  myPlayerId: string | null;
  session: any;
  chatMessages: any[];
  adminErrors: string[];
  maintenanceLists: any[];
  maintenanceLogs: any[];
  maintenanceDones: any[];
  maintenanceReports: any[];
  emailResults: any[];
  broadcastResults: any[];
}

const charKeyOf = (characterId: number) => `auth:character:${characterId}`;

function wireClient(label: string, socket: Socket): Client {
  const c: Client = {
    label,
    socket,
    userId: 0,
    token: "",
    characterId: 0,
    username: "",
    myPlayerId: null,
    session: null,
    chatMessages: [],
    adminErrors: [],
    maintenanceLists: [],
    maintenanceLogs: [],
    maintenanceDones: [],
    maintenanceReports: [],
    emailResults: [],
    broadcastResults: []
  };
  socket.on("auth:session", (s: any) => {
    c.session = s;
    if (s?.user?.characterId) c.characterId = Number(s.user.characterId);
  });
  socket.on("myPlayer", (m: any) => {
    c.myPlayerId = m?.playerId ?? null;
  });
  socket.on("chat:message", (m: any) => c.chatMessages.push(m));
  socket.on("admin:error", (e: any) => c.adminErrors.push(String(e?.message ?? "")));
  socket.on("admin:maintenance:list", (d: any) => c.maintenanceLists.push(d));
  socket.on("admin:maintenance:log", (d: any) => c.maintenanceLogs.push(d));
  socket.on("admin:maintenance:done", (d: any) => c.maintenanceDones.push(d));
  socket.on("admin:maintenance:report", (d: any) => c.maintenanceReports.push(d));
  socket.on("admin:maintenance:email-result", (d: any) => c.emailResults.push(d));
  socket.on("admin:maintenance:broadcast-result", (d: any) => c.broadcastResults.push(d));
  return c;
}

async function main() {
  let server: ChildProcess | null = null;
  let redis: RedisClientType | null = null;
  const clients: Client[] = [];
  const keysToClean = new Set<string>();
  const UPLOADED_DIR = path.join(SERVER_DIR, "migration-data", "rxdata_json_uploaded");

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
    await fs.rm(UPLOADED_DIR, { recursive: true, force: true }).catch(() => undefined);
    if (redis?.isOpen) {
      for (const key of keysToClean) {
        try {
          await redis.del(key);
        } catch {
          /* best effort */
        }
      }
      // The test runs live in the shared last-run/last-output hashes; drop
      // only the fields the suite touched.
      await redis.hDel("admin:maintenance:last-run", ["essentials-migration-report", "reset-all-adventures"]).catch(() => undefined);
      await redis.hDel("admin:maintenance:last-output", ["essentials-migration-report", "reset-all-adventures"]).catch(() => undefined);
      await redis.quit();
    }
  };

  const newClient = async (label: string, token?: string): Promise<Client> => {
    const socket = io(`http://localhost:${PORT}`, {
      transports: ["websocket"],
      forceNew: true,
      auth: token ? { token, platform: "web" } : { platform: "web" }
    });
    const c = wireClient(label, socket);
    await waitFor(`${label} connect`, () => socket.connected);
    clients.push(c);
    return c;
  };

  const register = async (c: Client) => {
    const lettersStamp = Date.now()
      .toString()
      .slice(-8)
      .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
    const uname = `mt${c.label.toLowerCase()}${lettersStamp}`.slice(0, 14);
    c.socket.emit("auth:register", {
      name: `Maint${c.label}`,
      username: uname,
      email: `${uname}@example.com`,
      password: "Aa1!aaaa"
    });
    const session = await waitFor(
      `${c.label} register`,
      () => (c.session?.authenticated && c.session?.user?.id ? c.session : null),
      { timeoutMs: 8000 }
    );
    c.userId = Number(session.user.id);
    c.token = session.token;
    c.characterId = Number(session.user.characterId);
    c.username = uname;
    keysToClean.add(`auth:user:${c.userId}`);
    keysToClean.add(charKeyOf(c.characterId));
    keysToClean.add(`auth:index:username:${uname}`);
    keysToClean.add(`auth:index:email:${uname}@example.com`);
    log(`  [${c.label}] registered account #${c.userId} (@${uname})`);
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
    await fs.rm(UPLOADED_DIR, { recursive: true, force: true }).catch(() => undefined);

    log(`starting server on :${PORT} …`);
    server = spawn(`${SERVER_DIR}/node_modules/.bin/ts-node`, ["index.ts"], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(PORT),
        REDIS_URL,
        SMTP_ENABLED: "false",
        GIT_SHA: "e2e-maintenance"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout?.on("data", () => {});
    server.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      if (/error/i.test(text)) log(`[server] ${text.trim().slice(0, 400)}`);
    });
    await waitFor(
      "server /healthz",
      async () => {
        const res = await fetch(`http://localhost:${PORT}/healthz`).catch(() => null);
        return res?.ok ?? false;
      },
      { timeoutMs: 60000, everyMs: 500 }
    );
    log("server up");

    // ---- accounts ---------------------------------------------------------
    const admin = await newClient("Admin");
    await register(admin);
    const player = await newClient("Player");
    await register(player);

    // ---- T1: non-admin denied --------------------------------------------
    log("T1 non-admin denied");
    admin.socket.emit("admin:maintenance:list");
    await waitFor("denial", () => admin.adminErrors.length > 0);
    if (admin.maintenanceLists.length > 0) fail("non-admin received the action list");
    pass("non-admin is denied the maintenance list");

    // ---- promote + reconnect (role is read at session build) --------------
    await redis.hSet(`auth:user:${admin.userId}`, { role: "admin" });
    admin.socket.disconnect();
    const adminSocket = io(`http://localhost:${PORT}`, {
      transports: ["websocket"],
      forceNew: true,
      auth: { token: admin.token, platform: "web" }
    });
    const adm = wireClient("Admin2", adminSocket);
    adm.token = admin.token;
    adm.userId = admin.userId;
    clients.push(adm);
    await waitFor("admin reconnect", () => adminSocket.connected);

    // ---- T2: action list ---------------------------------------------------
    log("T2 admin action list");
    adm.socket.emit("admin:maintenance:list");
    const list = await waitFor("action list", () => adm.maintenanceLists[0]);
    const ids = list.actions.map((a: any) => a.id);
    if (!ids.includes("reset-all-adventures")) fail(`reset-all-adventures missing from ${ids}`);
    if (!ids.includes("repair-essentials-events")) fail("repair-essentials-events missing");
    if (list.emailEnabled !== false) fail("emailEnabled should be false with SMTP disabled");
    const repair = list.actions.find((a: any) => a.id === "repair-essentials-events");
    if (repair.dataSource?.source !== "bundled") fail(`expected bundled data source, got ${JSON.stringify(repair.dataSource)}`);
    const resetAll = list.actions.find((a: any) => a.id === "reset-all-adventures");
    if (!resetAll.available) fail(`reset-all-adventures unavailable: ${resetAll.unavailableReason}`);
    pass("action list has the new actions, emailEnabled flag and bundled data source");

    // ---- T3: run migration report ------------------------------------------
    log("T3 migration report run");
    adm.socket.emit("admin:maintenance:run", { id: "essentials-migration-report", dryRun: false });
    const done = await waitFor("report done", () => adm.maintenanceDones[0], { timeoutMs: 180000 });
    if (!done.ok) fail(`migration report failed: exit ${done.exitCode}`);
    if (adm.maintenanceLogs.length === 0) fail("no log lines streamed");
    const refreshed = await waitFor(
      "refreshed list",
      () => adm.maintenanceLists.find((l: any) => l.actions.some((a: any) => a.id === "essentials-migration-report" && a.hasReport))
    );
    const reportAction = refreshed.actions.find((a: any) => a.id === "essentials-migration-report");
    if (!reportAction.lastRun?.ok) fail("lastRun not recorded");
    pass(`migration report ran (${adm.maintenanceLogs.length} lines) and recorded a report`);

    // ---- T4: stored HTML report ---------------------------------------------
    log("T4 stored HTML report");
    adm.socket.emit("admin:maintenance:report", { id: "essentials-migration-report" });
    const report = await waitFor("report payload", () => adm.maintenanceReports[0]);
    if (!report.available) fail("report unavailable");
    if (!String(report.html).startsWith("<!DOCTYPE html>")) fail("report is not an HTML document");
    if (!String(report.html).includes("Console output")) fail("report is missing the console section");
    if (report.meta?.ok !== true) fail("report meta wrong");
    pass(`stored report renders as HTML (${Math.round(String(report.html).length / 1024)}KB)`);

    // ---- T5: email without SMTP ----------------------------------------------
    log("T5 email without SMTP");
    adm.socket.emit("admin:maintenance:email-report", { id: "essentials-migration-report", to: "admin@example.com" });
    const emailResult = await waitFor("email result", () => adm.emailResults[0]);
    if (emailResult.ok !== false) fail("email should fail with SMTP disabled");
    if (!/SMTP/i.test(emailResult.message)) fail(`unexpected message: ${emailResult.message}`);
    pass(`email refused cleanly: "${emailResult.message}"`);

    // ---- T6: rxdata zip upload over HTTP --------------------------------------
    log("T6 rxdata zip upload");
    const bundled = path.join(SERVER_DIR, "migration-data", "rxdata_json");
    const zip = new AdmZip();
    zip.addFile("rxdata_json/data/System.json", await fs.readFile(path.join(bundled, "data", "System.json")));
    for (const mapName of ["Map001.json", "Map002.json", "Map003.json"]) {
      zip.addFile(`rxdata_json/maps/${mapName}`, await fs.readFile(path.join(bundled, "maps", mapName)));
    }
    const zipBuffer = zip.toBuffer();
    const uploadUrl = `http://localhost:${PORT}/admin/maintenance/rxdata-upload`;

    const anonUpload = await fetch(uploadUrl, { method: "POST", body: zipBuffer as any });
    if (anonUpload.status !== 401) fail(`anonymous upload got ${anonUpload.status}, expected 401`);
    const playerUpload = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${player.token}` },
      body: zipBuffer as any
    });
    if (playerUpload.status !== 403) fail(`non-admin upload got ${playerUpload.status}, expected 403`);

    const badUpload = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${adm.token}` },
      body: Buffer.from("definitely not a zip") as any
    });
    if (badUpload.status !== 422) fail(`bad zip got ${badUpload.status}, expected 422`);

    const goodUpload = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adm.token}`,
        "Content-Type": "application/zip",
        "X-File-Name": encodeURIComponent("venova-test.zip")
      },
      body: zipBuffer as any
    });
    const goodPayload: any = await goodUpload.json();
    if (!goodUpload.ok || goodPayload.ok !== true) fail(`good zip rejected: ${JSON.stringify(goodPayload)}`);
    if (goodPayload.mapCount !== 3) fail(`expected 3 maps, got ${goodPayload.mapCount}`);
    pass("upload auth enforced (401/403), bad zip 422, valid zip staged with 3 maps");

    // ---- T7: data source switches + clear --------------------------------------
    log("T7 data source switch + clear");
    adm.maintenanceLists.length = 0;
    adm.socket.emit("admin:maintenance:list");
    const listUploaded = await waitFor("list after upload", () => adm.maintenanceLists[0]);
    const repairUploaded = listUploaded.actions.find((a: any) => a.id === "repair-essentials-events");
    if (repairUploaded.dataSource?.source !== "uploaded") fail(`expected uploaded source, got ${JSON.stringify(repairUploaded.dataSource)}`);
    if (repairUploaded.dataSource?.mapCount !== 3) fail("uploaded meta mapCount wrong");

    adm.maintenanceLists.length = 0;
    adm.socket.emit("admin:maintenance:rxdata-clear");
    const listCleared = await waitFor("list after clear", () => adm.maintenanceLists[0]);
    const repairCleared = listCleared.actions.find((a: any) => a.id === "repair-essentials-events");
    if (repairCleared.dataSource?.source !== "bundled") fail(`expected bundled source after clear, got ${JSON.stringify(repairCleared.dataSource)}`);
    pass("repair action tracks uploaded → cleared data source");

    // ---- T8: global broadcast ----------------------------------------------------
    log("T8 global broadcast");
    await redis.hSet(charKeyOf(player.characterId), {
      event_self_switches: JSON.stringify({ "129:2:A": true }),
      last_map_id: TEST_MAP,
      last_x: String(50 * 32),
      last_y: String(41 * 32)
    });
    player.socket.emit("addPlayer", { token: player.token });
    await waitFor("player joined world", () => player.myPlayerId);
    adm.socket.emit("admin:maintenance:broadcast", { message: "Mantenimiento en 10 minutos — guarden su progreso." });
    const broadcastResult = await waitFor("broadcast result", () => adm.broadcastResults[0]);
    if (!broadcastResult.ok) fail(`broadcast failed: ${broadcastResult.message}`);
    if (broadcastResult.recipients < 1) fail(`expected ≥1 recipient, got ${broadcastResult.recipients}`);
    const received = await waitFor("player received broadcast", () =>
      player.chatMessages.find((m: any) => m.channel === "global" && m.text.includes("Mantenimiento"))
    );
    if (!received) fail("player did not receive the global message");
    adm.broadcastResults.length = 0;
    adm.socket.emit("admin:maintenance:broadcast", { message: "   " });
    const emptyResult = await waitFor("empty broadcast result", () => adm.broadcastResults[0]);
    if (emptyResult.ok !== false) fail("empty broadcast should be refused");
    pass(`broadcast delivered to ${broadcastResult.recipients} player(s); empty message refused`);

    // ---- T9: reset-all-adventures dry run ------------------------------------------
    log("T9 reset-all dry run");
    const moneyBefore = await redis.hGet(charKeyOf(player.characterId), "money");
    adm.maintenanceDones.length = 0;
    adm.maintenanceLogs.length = 0;
    adm.socket.emit("admin:maintenance:run", { id: "reset-all-adventures", dryRun: true });
    const resetDone = await waitFor("reset dry-run done", () => adm.maintenanceDones[0], { timeoutMs: 120000 });
    if (!resetDone.ok) fail(`dry run failed: exit ${resetDone.exitCode}`);
    const dryLines = adm.maintenanceLogs.map((l: any) => l.line).join("\n");
    if (!/Dry run: \d+ account\(s\)/.test(dryLines)) fail(`dry-run output missing account count:\n${dryLines}`);
    if (!/No data was modified/.test(dryLines)) fail("dry-run output missing no-modification note");
    const moneyAfter = await redis.hGet(charKeyOf(player.characterId), "money");
    if (moneyBefore !== moneyAfter) fail("dry run modified character data!");
    if (!player.socket.connected) fail("dry run disconnected players");
    pass("reset-all dry run counts accounts and touches nothing");

    log(`\nALL ${passed} CHECKS PASSED`);
  } catch (error) {
    console.error(`\nFAILED after ${passed} passing checks:`, error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

void main();
