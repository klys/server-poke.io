/**
 * Admin-panel maintenance actions: a fixed whitelist of the repair/diagnostic
 * tools in tools/, runnable from the frontend "Maintenance" tab so applying
 * them on production no longer needs SSH/docker access. Each action spawns
 * the existing CLI tool as a child process and streams its output back to
 * the requesting admin socket. In dev (running under ts-node) the .ts source
 * runs via ts-node; when the server runs compiled (docker: node dist/index.js)
 * the tsc-emitted dist/tools/*.js runs under plain node — the runtime image
 * has neither the .ts sources nor ts-node.
 *
 * The rxdata_json dump the event repair needs ships with the server in
 * migration-data/rxdata_json, so the action is self-contained on any deploy.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import type { RedisClientType } from "redis";

// Compiled: <root>/dist/components/MaintenanceRunner.js. Dev (ts-node keeps
// .ts filenames): <root>/components/MaintenanceRunner.ts.
const IS_COMPILED = __filename.endsWith(".js");
const SERVER_ROOT = IS_COMPILED ? path.join(__dirname, "..", "..") : path.join(__dirname, "..");
const RXDATA_DIR = path.join(SERVER_ROOT, "migration-data", "rxdata_json");
const LAST_RUN_KEY = "admin:maintenance:last-run";
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

export type MaintenanceActionDefinition = {
  id: string;
  name: string;
  description: string;
  /** Mutates game data — the UI asks for confirmation before a real run. */
  dangerous: boolean;
  supportsDryRun: boolean;
  script: string;
  args: string[];
  /** Absent or existing path — actions with missing requirements are listed disabled. */
  requiresPath?: string;
};

export type MaintenanceLastRun = {
  at: string;
  ok: boolean;
  dryRun: boolean;
  exitCode: number | null;
  summary: string;
  by: string;
};

export type MaintenanceActionStatus = Omit<MaintenanceActionDefinition, "script" | "args" | "requiresPath"> & {
  available: boolean;
  unavailableReason: string | null;
  lastRun: MaintenanceLastRun | null;
};

export const MAINTENANCE_ACTIONS: MaintenanceActionDefinition[] = [
  {
    id: "repair-essentials-events",
    name: "Repair Essentials Events",
    description:
      "Attaches full event pages to extracted portals and imports the System script-switch table (day/night NPCs, door templates, daily events like Kurt's balls). Idempotent — safe to re-run.",
    dangerous: true,
    supportsDryRun: true,
    script: "tools/repairEssentialsEvents.ts",
    args: [RXDATA_DIR],
    requiresPath: RXDATA_DIR
  },
  {
    id: "reset-consumed-item-balls",
    name: "Reset Consumed Item Balls",
    description:
      "Re-arms item balls that players opened while grants were broken (clears their Self Switches for every user). NPC gift events are deliberately left untouched.",
    dangerous: true,
    supportsDryRun: true,
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
    script: "tools/essentialsMigrationReport.ts",
    args: []
  }
];

/** Absolute path of the file this action actually executes on this deploy. */
function runnableScriptPath(action: MaintenanceActionDefinition): string {
  return IS_COMPILED
    ? path.join(SERVER_ROOT, "dist", action.script.replace(/\.ts$/, ".js"))
    : path.join(SERVER_ROOT, action.script);
}

export default class MaintenanceRunner {
  private redis: RedisClientType;
  private runningActionId: string | null = null;

  constructor(redis: RedisClientType) {
    this.redis = redis;
  }

  public get running(): string | null {
    return this.runningActionId;
  }

  public async listActions(): Promise<MaintenanceActionStatus[]> {
    const lastRuns = await this.redis.hGetAll(LAST_RUN_KEY).catch(() => ({} as Record<string, string>));
    return MAINTENANCE_ACTIONS.map((action) => {
      const missingData = action.requiresPath && !existsSync(action.requiresPath);
      const missingScript = !existsSync(runnableScriptPath(action));
      let lastRun: MaintenanceLastRun | null = null;
      try {
        lastRun = lastRuns[action.id] ? (JSON.parse(lastRuns[action.id]) as MaintenanceLastRun) : null;
      } catch {
        lastRun = null;
      }
      return {
        id: action.id,
        name: action.name,
        description: action.description,
        dangerous: action.dangerous,
        supportsDryRun: action.supportsDryRun,
        available: !missingData && !missingScript,
        unavailableReason: missingData
          ? `Missing bundled data: ${path.relative(SERVER_ROOT, action.requiresPath as string)}`
          : missingScript
            ? `Tool not shipped on this deploy: ${path.relative(SERVER_ROOT, runnableScriptPath(action))}`
            : null,
        lastRun
      };
    });
  }

  /**
   * Runs one whitelisted action. Only one action may run at a time across the
   * whole server (they rewrite shared payloads). Output lines stream through
   * `onLine`; the recorded last-run summary is the tool's final output line.
   */
  public run(
    actionId: string,
    options: { dryRun: boolean; requestedBy: string },
    onLine: (line: string) => void,
    onDone: (result: { ok: boolean; exitCode: number | null }) => void
  ): { started: false; message: string } | { started: true } {
    const action = MAINTENANCE_ACTIONS.find((candidate) => candidate.id === actionId);
    if (!action) {
      return { started: false, message: "Unknown maintenance action." };
    }
    if (action.requiresPath && !existsSync(action.requiresPath)) {
      return { started: false, message: "This action's bundled data is missing on this server." };
    }
    const scriptPath = runnableScriptPath(action);
    if (!existsSync(scriptPath)) {
      return { started: false, message: "This action's tool is not shipped on this deploy." };
    }
    if (this.runningActionId) {
      return { started: false, message: `Another action (${this.runningActionId}) is still running.` };
    }

    const dryRun = options.dryRun && action.supportsDryRun;
    const toolArgs = [...action.args, ...(dryRun ? ["--dry-run"] : [])];
    const command = IS_COMPILED ? process.execPath : "npx";
    const args = IS_COMPILED ? [scriptPath, ...toolArgs] : ["ts-node", action.script, ...toolArgs];
    this.runningActionId = action.id;
    onLine(`$ ${IS_COMPILED ? "node" : "npx"} ${args.join(" ")}`);

    const child = spawn(command, args, {
      cwd: SERVER_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let lastLine = "";
    let buffered = "";
    const consume = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trimEnd();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) {
          lastLine = line;
          onLine(line);
        }
        newline = buffered.indexOf("\n");
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);

    // A wedged tool must never leave the panel (and the one-at-a-time lock)
    // stuck forever.
    const timeout = setTimeout(() => {
      onLine("Timed out — killing the action.");
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timeout);
      this.runningActionId = null;
      onLine(`Failed to start: ${error.message}`);
      onDone({ ok: false, exitCode: null });
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (buffered.trim().length > 0) {
        lastLine = buffered.trim();
        onLine(lastLine);
      }
      this.runningActionId = null;
      const ok = code === 0;
      const record: MaintenanceLastRun = {
        at: new Date().toISOString(),
        ok,
        dryRun,
        exitCode: code,
        summary: lastLine.slice(0, 300),
        by: options.requestedBy
      };
      void this.redis
        .hSet(LAST_RUN_KEY, { [action.id]: JSON.stringify(record) })
        .catch((error) => console.error("Unable to record maintenance run:", error));
      onDone({ ok, exitCode: code });
    });

    return { started: true };
  }
}
