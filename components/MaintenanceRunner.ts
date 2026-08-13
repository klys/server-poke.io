/**
 * Admin-panel maintenance actions: a fixed whitelist of repair/diagnostic
 * operations runnable from the frontend "Maintenance" tab so applying them on
 * production needs no SSH/docker access.
 *
 * Two kinds of action exist:
 *  - "script": spawns one of the CLI tools in tools/ as a child process and
 *    streams its output back to the requesting admin socket. In dev (running
 *    under ts-node) the .ts source runs via ts-node; when the server runs
 *    compiled (docker: node dist/index.js) the tsc-emitted dist/tools/*.js
 *    runs under plain node — the runtime image has neither the .ts sources
 *    nor ts-node.
 *  - "inline": runs inside the server process against the live Auth/World/IO
 *    services (e.g. resetting every account's adventure, which must reuse
 *    Auth's reset semantics instead of duplicating them in a tool).
 *
 * Every run's full console transcript is recorded in Redis so the panel can
 * re-open it later, render it as an HTML report, and email it.
 *
 * The rxdata_json dump the event repair needs ships with the server in
 * migration-data/rxdata_json; an admin-uploaded replacement staged by
 * RxdataUploadStore takes precedence when present.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import type { RedisClientType } from "redis";
import type { Server } from "socket.io";
import type Auth from "./Auth";
import RxdataUploadStore from "./RxdataUploadStore";
import type World from "./world";

// Compiled: <root>/dist/components/MaintenanceRunner.js. Dev (ts-node keeps
// .ts filenames): <root>/components/MaintenanceRunner.ts.
const IS_COMPILED = __filename.endsWith(".js");
const SERVER_ROOT = IS_COMPILED ? path.join(__dirname, "..", "..") : path.join(__dirname, "..");
export { SERVER_ROOT as MAINTENANCE_SERVER_ROOT };
const LAST_RUN_KEY = "admin:maintenance:last-run";
const LAST_OUTPUT_KEY = "admin:maintenance:last-output";
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
// Transcript caps: keep the record well under Redis payload-size limits while
// preserving the head (command + early context) and the tail (the summary).
const MAX_TRANSCRIPT_LINES = 8000;
const MAX_OUTPUT_CHARS = 300_000;

/** Live server services inline actions run against. */
export type MaintenanceServices = {
  auth: Auth;
  world: World;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  io: Server<any, any, any, any>;
};

type InlineRunContext = {
  dryRun: boolean;
  onLine: (line: string) => void;
  services: MaintenanceServices;
};

export type MaintenanceActionDefinition = {
  id: string;
  name: string;
  description: string;
  /** Mutates game data — the UI asks for confirmation before a real run. */
  dangerous: boolean;
  supportsDryRun: boolean;
} & (
  | {
      kind: "script";
      script: string;
      /** Static args, or resolved per run (e.g. bundled vs uploaded data dir). */
      resolveInput?: () => { args: string[] } | { unavailableReason: string };
      args: string[];
    }
  | {
      kind: "inline";
      execute: (context: InlineRunContext) => Promise<{ ok: boolean; exitCode: number | null }>;
    }
);

export type MaintenanceLastRun = {
  at: string;
  ok: boolean;
  dryRun: boolean;
  exitCode: number | null;
  summary: string;
  by: string;
};

/** Full recorded transcript of the most recent run of one action. */
export type MaintenanceRunRecord = {
  actionId: string;
  actionName: string;
  startedAt: string;
  at: string;
  ok: boolean;
  dryRun: boolean;
  exitCode: number | null;
  by: string;
  output: string;
  truncated: boolean;
};

export type MaintenanceDataSource = {
  source: "uploaded" | "bundled";
  uploadedAt?: string;
  uploadedBy?: string;
  mapCount?: number;
};

export type MaintenanceActionStatus = {
  id: string;
  name: string;
  description: string;
  dangerous: boolean;
  supportsDryRun: boolean;
  available: boolean;
  unavailableReason: string | null;
  lastRun: MaintenanceLastRun | null;
  /** A stored transcript exists — the panel can open/email its report. */
  hasReport: boolean;
  /** Which rxdata dump the action would read (repair-essentials-events only). */
  dataSource: MaintenanceDataSource | null;
};

/**
 * Resets every account's adventure progress (party, inventory, money, event
 * switches, badges, saved location) using Auth's per-user reset semantics,
 * then disconnects every in-game player so no live session keeps playing on
 * top of wiped state.
 */
async function resetAllAdventures(context: InlineRunContext): Promise<{ ok: boolean; exitCode: number | null }> {
  const { auth, world, io } = context.services;

  if (context.dryRun) {
    const userIds = await auth.listAllUserIds();
    context.onLine(`Dry run: ${userIds.length} account(s) would be reset to the start of the adventure.`);
    context.onLine(`Dry run: ${world.players.size} online player(s) would be disconnected.`);
    context.onLine("No data was modified.");
    return { ok: true, exitCode: 0 };
  }

  context.onLine("Resetting adventure progress for every account…");
  const result = await auth.resetAllUsersProgress((message) => context.onLine(message));
  context.onLine(`Reset ${result.reset}/${result.total} account(s); ${result.failed} failure(s).`);

  // Tell everyone what happened before their session drops (game language is
  // Spanish), then kick every in-game socket so clients reload fresh state.
  io.emit("chat:message", {
    id: `maintenance-${Date.now()}`,
    channel: "system",
    text: "La aventura ha sido reiniciada para todos los jugadores. Vuelve a entrar para comenzar de nuevo.",
    at: new Date().toISOString()
  });
  let kicked = 0;
  for (const socketId of Array.from(world.players.keys())) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.disconnect(true);
      kicked += 1;
    }
  }
  context.onLine(`Disconnected ${kicked} online player(s).`);
  return { ok: result.failed === 0, exitCode: result.failed === 0 ? 0 : 1 };
}

export function buildMaintenanceActions(uploadStore: RxdataUploadStore): MaintenanceActionDefinition[] {
  return [
    {
      id: "repair-essentials-events",
      name: "Repair Essentials Events",
      description:
        "Attaches full event pages to extracted portals and imports the System script-switch table (day/night NPCs, door templates, daily events like Kurt's balls). Idempotent — safe to re-run. Reads the bundled rxdata dump, or a zip uploaded from this panel.",
      dangerous: true,
      supportsDryRun: true,
      kind: "script",
      script: "tools/repairEssentialsEvents.ts",
      args: [],
      resolveInput: () => {
        const active = uploadStore.activeDataDir();
        return active
          ? { args: [active.dir] }
          : { unavailableReason: "No rxdata data present — upload an rxdata_json zip or ship migration-data/rxdata_json." };
      }
    },
    {
      id: "reset-consumed-item-balls",
      name: "Reset Consumed Item Balls",
      description:
        "Re-arms item balls that players opened while grants were broken (clears their Self Switches for every user). NPC gift events are deliberately left untouched.",
      dangerous: true,
      supportsDryRun: true,
      kind: "script",
      script: "tools/resetConsumedItemBalls.ts",
      args: []
    },
    {
      id: "derive-passage-terrain-tags",
      name: "Derive Passage Terrain Tags",
      description:
        "Rebuilds the passage terrain-tag grids (rocks over water, bridges) for every imported map from its tileset tables.",
      dangerous: true,
      supportsDryRun: false,
      kind: "script",
      script: "tools/derivePassageTerrainTags.ts",
      args: []
    },
    {
      id: "migrate-accounts-to-characters",
      name: "Migrate Accounts to Characters",
      description:
        "One-time schema v4 split: moves each legacy account's gameplay state onto its default character hash, stamps shared-box asset ownership, and converts PC money into owned deposits. Idempotent — already-migrated accounts are skipped (the server also migrates lazily on login).",
      dangerous: true,
      supportsDryRun: true,
      kind: "script",
      script: "tools/migrateAccountsToCharacters.ts",
      args: []
    },
    {
      id: "essentials-migration-report",
      name: "Essentials Migration Report",
      description:
        "Read-only audit of the imported events: unsupported script commands/conditions, blind portals and page-selection gaps, with severity counts.",
      dangerous: false,
      supportsDryRun: false,
      kind: "script",
      script: "tools/essentialsMigrationReport.ts",
      args: []
    },
    {
      id: "reset-all-adventures",
      name: "Reset Adventure for Everyone",
      description:
        "Sends EVERY account back to the start of the adventure: empty party (starter selection replays), default inventory/money, cleared badges and event progression, no saved location. Profiles, credentials and skins are kept. Online players are disconnected so they rejoin fresh.",
      dangerous: true,
      supportsDryRun: true,
      kind: "inline",
      execute: resetAllAdventures
    }
  ];
}

export default class MaintenanceRunner {
  private redis: RedisClientType;
  private uploadStore: RxdataUploadStore;
  private actions: MaintenanceActionDefinition[];
  private services: MaintenanceServices | null = null;
  private runningActionId: string | null = null;

  constructor(redis: RedisClientType, uploadStore?: RxdataUploadStore) {
    this.redis = redis;
    this.uploadStore = uploadStore ?? new RxdataUploadStore();
    this.actions = buildMaintenanceActions(this.uploadStore);
  }

  /** Live services inline actions need; without them inline actions are listed unavailable. */
  public setServices(services: MaintenanceServices) {
    this.services = services;
  }

  public get rxdataUploads(): RxdataUploadStore {
    return this.uploadStore;
  }

  public get running(): string | null {
    return this.runningActionId;
  }

  public getAction(actionId: string): MaintenanceActionDefinition | undefined {
    return this.actions.find((candidate) => candidate.id === actionId);
  }

  /** Absolute path of the file a script action actually executes on this deploy. */
  private runnableScriptPath(script: string): string {
    return IS_COMPILED
      ? path.join(SERVER_ROOT, "dist", script.replace(/\.ts$/, ".js"))
      : path.join(SERVER_ROOT, script);
  }

  private unavailableReason(action: MaintenanceActionDefinition): string | null {
    if (action.kind === "inline") {
      return this.services ? null : "Server services are still starting up.";
    }
    if (!existsSync(this.runnableScriptPath(action.script))) {
      return `Tool not shipped on this deploy: ${path.relative(SERVER_ROOT, this.runnableScriptPath(action.script))}`;
    }
    if (action.resolveInput) {
      const input = action.resolveInput();
      if ("unavailableReason" in input) {
        return input.unavailableReason;
      }
    }
    return null;
  }

  public async listActions(): Promise<MaintenanceActionStatus[]> {
    const [lastRuns, storedOutputs, uploadMeta] = await Promise.all([
      this.redis.hGetAll(LAST_RUN_KEY).catch(() => ({} as Record<string, string>)),
      this.redis.hKeys(LAST_OUTPUT_KEY).catch(() => [] as string[]),
      this.uploadStore.readUploadMeta()
    ]);
    const outputsAvailable = new Set(storedOutputs);

    return this.actions.map((action) => {
      let lastRun: MaintenanceLastRun | null = null;
      try {
        lastRun = lastRuns[action.id] ? (JSON.parse(lastRuns[action.id]) as MaintenanceLastRun) : null;
      } catch {
        lastRun = null;
      }

      let dataSource: MaintenanceDataSource | null = null;
      if (action.id === "repair-essentials-events") {
        const active = this.uploadStore.activeDataDir();
        if (active) {
          dataSource =
            active.source === "uploaded" && uploadMeta
              ? {
                  source: "uploaded",
                  uploadedAt: uploadMeta.uploadedAt,
                  uploadedBy: uploadMeta.uploadedBy,
                  mapCount: uploadMeta.mapCount
                }
              : { source: active.source };
        }
      }

      const unavailableReason = this.unavailableReason(action);
      return {
        id: action.id,
        name: action.name,
        description: action.description,
        dangerous: action.dangerous,
        supportsDryRun: action.supportsDryRun,
        available: unavailableReason === null,
        unavailableReason,
        lastRun,
        hasReport: outputsAvailable.has(action.id),
        dataSource
      };
    });
  }

  /** The stored transcript of an action's most recent run, if any. */
  public async getRunRecord(actionId: string): Promise<MaintenanceRunRecord | null> {
    try {
      const raw = await this.redis.hGet(LAST_OUTPUT_KEY, actionId);
      return raw ? (JSON.parse(raw) as MaintenanceRunRecord) : null;
    } catch {
      return null;
    }
  }

  private persistRun(record: MaintenanceRunRecord) {
    const lastRun: MaintenanceLastRun = {
      at: record.at,
      ok: record.ok,
      dryRun: record.dryRun,
      exitCode: record.exitCode,
      summary: record.output.trimEnd().split("\n").pop()?.slice(0, 300) ?? "",
      by: record.by
    };
    void this.redis
      .hSet(LAST_RUN_KEY, { [record.actionId]: JSON.stringify(lastRun) })
      .catch((error) => console.error("Unable to record maintenance run:", error));
    void this.redis
      .hSet(LAST_OUTPUT_KEY, { [record.actionId]: JSON.stringify(record) })
      .catch((error) => console.error("Unable to record maintenance output:", error));
  }

  /**
   * Runs one whitelisted action. Only one action may run at a time across the
   * whole server (they rewrite shared payloads). Output lines stream through
   * `onLine`; the full transcript is recorded for later report viewing/email.
   */
  public run(
    actionId: string,
    options: { dryRun: boolean; requestedBy: string },
    onLine: (line: string) => void,
    onDone: (result: { ok: boolean; exitCode: number | null }) => void
  ): { started: false; message: string } | { started: true } {
    const action = this.getAction(actionId);
    if (!action) {
      return { started: false, message: "Unknown maintenance action." };
    }
    const unavailableReason = this.unavailableReason(action);
    if (unavailableReason) {
      return { started: false, message: unavailableReason };
    }
    if (this.runningActionId) {
      return { started: false, message: `Another action (${this.runningActionId}) is still running.` };
    }

    const dryRun = options.dryRun && action.supportsDryRun;
    const startedAt = new Date().toISOString();
    const transcript: string[] = [];
    let transcriptTruncated = false;
    const record = (line: string) => {
      if (transcript.length >= MAX_TRANSCRIPT_LINES) {
        // Drop from the middle: the head keeps the command/context, the tail
        // keeps the summary the report cares about most.
        transcript.splice(Math.floor(MAX_TRANSCRIPT_LINES / 2), 1);
        transcriptTruncated = true;
      }
      transcript.push(line);
      onLine(line);
    };

    let finished = false;
    const finish = (ok: boolean, exitCode: number | null) => {
      // "error" and "exit" can both fire on the same child — record one outcome.
      if (finished) {
        return;
      }
      finished = true;
      this.runningActionId = null;
      let output = transcript.join("\n");
      if (output.length > MAX_OUTPUT_CHARS) {
        output =
          output.slice(0, MAX_OUTPUT_CHARS / 3) +
          "\n… [output truncated] …\n" +
          output.slice(-(MAX_OUTPUT_CHARS / 3) * 2);
        transcriptTruncated = true;
      }
      this.persistRun({
        actionId: action.id,
        actionName: action.name,
        startedAt,
        at: new Date().toISOString(),
        ok,
        dryRun,
        exitCode,
        by: options.requestedBy,
        output,
        truncated: transcriptTruncated
      });
      onDone({ ok, exitCode });
    };

    this.runningActionId = action.id;

    if (action.kind === "inline") {
      record(`# ${action.name}${dryRun ? " (dry run)" : ""}`);
      // The same wedged-tool guard script actions have: a hung inline action
      // must not hold the one-at-a-time lock forever. The promise itself
      // cannot be killed, but its result is ignored after the timeout.
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          record("Timed out — abandoning the action.");
          finish(false, null);
        }
      }, RUN_TIMEOUT_MS);
      action
        .execute({ dryRun, onLine: record, services: this.services as MaintenanceServices })
        .then((result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            finish(result.ok, result.exitCode);
          }
        })
        .catch((error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            record(`Failed: ${(error as Error).message}`);
            finish(false, null);
          }
        });
      return { started: true };
    }

    let toolArgs = [...action.args];
    if (action.resolveInput) {
      const input = action.resolveInput();
      if ("unavailableReason" in input) {
        this.runningActionId = null;
        return { started: false, message: input.unavailableReason };
      }
      toolArgs = [...input.args, ...toolArgs];
    }
    if (dryRun) {
      toolArgs.push("--dry-run");
    }
    const scriptPath = this.runnableScriptPath(action.script);
    const command = IS_COMPILED ? process.execPath : "npx";
    const args = IS_COMPILED ? [scriptPath, ...toolArgs] : ["ts-node", action.script, ...toolArgs];
    record(`$ ${IS_COMPILED ? "node" : "npx"} ${args.join(" ")}`);

    const child = spawn(command, args, {
      cwd: SERVER_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let buffered = "";
    const consume = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trimEnd();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) {
          record(line);
        }
        newline = buffered.indexOf("\n");
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);

    // A wedged tool must never leave the panel (and the one-at-a-time lock)
    // stuck forever.
    const timeout = setTimeout(() => {
      record("Timed out — killing the action.");
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timeout);
      record(`Failed to start: ${error.message}`);
      finish(false, null);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (buffered.trim().length > 0) {
        record(buffered.trim());
      }
      finish(code === 0, code);
    });

    return { started: true };
  }
}
