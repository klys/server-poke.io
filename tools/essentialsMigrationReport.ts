/**
 * Migration validation report: compares the imported event data the server
 * actually runs (Redis designer:section:maps) against RPG Maker / Pokemon
 * Essentials semantics and lists every place where behavior can diverge —
 * before players find the divergence for you.
 *
 * Checks:
 *   - Essentials portals that still blind-teleport (no page-aware owner)   BLOCKER
 *   - Portals whose target map is missing                                   HIGH
 *   - Script conditional-branches with no runtime handler (fail closed)     HIGH
 *   - Script commands with no runtime handler (skipped)                     MEDIUM
 *   - Page conditions on script switches the evaluator can't run            HIGH
 *   - Page conditions on script switches with no imported table             BLOCKER
 *   - Parallel-process pages (trigger 4) that write state (never run)       MEDIUM
 *   - Unknown item symbols referenced by item/quantity scripts              MEDIUM
 *
 * Usage:
 *   npx ts-node tools/essentialsMigrationReport.ts [--json out.json] [--md out.md]
 *
 * Read-only: never writes to Redis.
 */
import { promises as fs } from "fs";
import { createClient } from "redis";
import {
  isScriptConditionHandled,
  isScriptCommandHandled
} from "../components/essentialsScriptAdapters";
import {
  evaluateScriptSwitchExpression,
  type EventPlayerState
} from "../components/eventPageSelection";

const MAPS_REDIS_KEY = "designer:section:maps";
const ITEMS_REDIS_KEY = "designer:section:items";

type Severity = "BLOCKER" | "HIGH" | "MEDIUM" | "LOW";

type ReportEntry = {
  severity: Severity;
  check: string;
  mapId: string;
  mapName: string;
  eventId: number | null;
  eventName: string;
  page: number | null;
  original: string;
  currentBehavior: string;
  expectedBehavior: string;
  recommendation: string;
};

type RawCommand = { code: number; indent?: number; parameters?: unknown[] };
type RawPage = {
  conditions?: { switch1?: number; switch2?: number };
  trigger?: number;
  commands?: RawCommand[];
};
type RawEvent = { eventId: number; essentialsMapId: number; pages?: RawPage[] };
type RawPlacement = Record<string, unknown> & {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  essentialsEvent?: RawEvent;
};

function scriptTextsOf(page: RawPage): { conditions: string[]; commands: string[] } {
  const conditions: string[] = [];
  const commands: string[] = [];
  const list = page.commands ?? [];
  for (let index = 0; index < list.length; index += 1) {
    const command = list[index];
    if (command.code === 111 && command.parameters?.[0] === 12 && typeof command.parameters?.[1] === "string") {
      conditions.push(command.parameters[1] as string);
    }
    if (command.code === 355) {
      let text = typeof command.parameters?.[0] === "string" ? (command.parameters[0] as string) : "";
      let next = index + 1;
      while (next < list.length && list[next].code === 655) {
        const continuation = list[next].parameters?.[0];
        if (typeof continuation === "string") {
          text += `\n${continuation}`;
        }
        next += 1;
      }
      if (text.trim().length > 0) {
        commands.push(text);
      }
      index = next - 1;
    }
  }
  return { conditions, commands };
}

const RE_ITEM_SYMBOLS = /(?:PBItems::|pbQuantity\(\s*:|pbItemBall\(\s*:|pbReceiveItem\(\s*:|pbStoreItem\(\s*:)(\w+)/gi;

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : "migration-report.json";
  const mdOut = args.includes("--md") ? args[args.indexOf("--md") + 1] : "migration-report.md";

  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });
  await redis.connect();

  let payload: {
    state: {
      items?: Array<{ id: string; name?: string }>;
      editorDataByMapId: Record<string, {
        portals?: Array<{ id?: string; x: number; y: number; targetMapId?: string; essentialsConnection?: unknown }>;
        npcs?: RawPlacement[];
      }>;
      essentialsSystem?: { scriptSwitches?: Record<string, string> };
    };
  };
  let itemSymbols = new Set<string>();

  try {
    const raw = await redis.get(MAPS_REDIS_KEY);
    if (!raw) {
      console.error(`No ${MAPS_REDIS_KEY} in Redis.`);
      process.exit(1);
    }
    payload = JSON.parse(raw);

    const rawItems = await redis.get(ITEMS_REDIS_KEY);
    if (rawItems) {
      try {
        const parsed = JSON.parse(rawItems);
        for (const item of parsed?.state?.items ?? []) {
          const essentialsId = item?.itemProfile?.essentialsId ?? item?.essentialsId ?? null;
          if (typeof essentialsId === "string") {
            itemSymbols.add(essentialsId.toUpperCase());
          }
          if (typeof item?.id === "string" && item.id.startsWith("item-")) {
            itemSymbols.add(item.id.slice(5).toUpperCase());
          }
        }
      } catch {
        itemSymbols = new Set();
      }
    }
  } finally {
    await redis.quit();
  }

  const entries: ReportEntry[] = [];
  const mapNames = new Map<string, string>(
    (payload.state.items ?? []).map((item) => [item.id, item.name ?? item.id])
  );
  const scriptSwitchTable = payload.state.essentialsSystem?.scriptSwitches ?? null;
  const dummyState: EventPlayerState = { switches: {}, variables: {}, selfSwitches: {}, tempSwitches: {} };
  const dummyEnv = { hour: 12, weekday: 1 };

  const seen = new Set<string>();
  const once = (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  for (const [mapId, mapData] of Object.entries(payload.state.editorDataByMapId ?? {})) {
    const mapName = mapNames.get(mapId) ?? mapId;
    const placements = (mapData.npcs ?? []).filter((npc) => npc.essentialsEvent);

    // ---- portals ----------------------------------------------------------
    for (const portal of mapData.portals ?? []) {
      if (!portal.essentialsConnection) continue;

      const owner = placements.find(
        (npc) =>
          npc.x === portal.x &&
          npc.y === portal.y &&
          npc.essentialsEvent?.pages?.some((page) =>
            (page.commands ?? []).some((command) => command.code === 201)
          )
      );
      if (!owner) {
        entries.push({
          severity: "BLOCKER",
          check: "blind-portal",
          mapId,
          mapName,
          eventId: null,
          eventName: portal.id ?? `portal@${portal.x},${portal.y}`,
          page: null,
          original: "Transfer Player extracted from an event whose page data is not attached",
          currentBehavior: "Teleports any player on contact, ignoring the original conditions",
          expectedBehavior: "Transfer only through the source event's active page and command flow",
          recommendation: "Run tools/repairEssentialsEvents.ts to attach the source event placement"
        });
      }

      if (portal.targetMapId && !payload.state.editorDataByMapId[portal.targetMapId]) {
        entries.push({
          severity: "HIGH",
          check: "missing-destination",
          mapId,
          mapName,
          eventId: null,
          eventName: portal.id ?? `portal@${portal.x},${portal.y}`,
          page: null,
          original: `targetMapId ${portal.targetMapId}`,
          currentBehavior: "Transfer target map is not imported; portal fizzles",
          expectedBehavior: "Destination map exists",
          recommendation: "Import the missing map or remove the portal"
        });
      }
    }

    // ---- events -----------------------------------------------------------
    for (const npc of placements) {
      const event = npc.essentialsEvent as RawEvent;
      const eventName = typeof npc.name === "string" ? npc.name : `event ${event.eventId}`;

      (event.pages ?? []).forEach((page, pageIndex) => {
        // Script-switch page conditions.
        for (const switchId of [page.conditions?.switch1, page.conditions?.switch2]) {
          if (!switchId) continue;
          const expression = scriptSwitchTable?.[String(switchId)];
          if (expression === undefined) continue;
          const result = evaluateScriptSwitchExpression(
            expression,
            { essentialsMapId: event.essentialsMapId, eventId: event.eventId },
            dummyState,
            dummyEnv
          );
          if (result === null && once(`ssw:${expression}`)) {
            entries.push({
              severity: "HIGH",
              check: "unsupported-script-switch",
              mapId,
              mapName,
              eventId: event.eventId,
              eventName,
              page: pageIndex,
              original: `s:${expression}`,
              currentBehavior: "Evaluates false; the page never activates",
              expectedBehavior: "Expression evaluated like the original engine",
              recommendation: "Add a handler in eventPageSelection.evaluateScriptSwitchExpression"
            });
          }
        }

        // Parallel pages that write state.
        if (
          page.trigger === 4 &&
          (page.commands ?? []).some((command) => [121, 122, 123].includes(command.code))
        ) {
          entries.push({
            severity: "MEDIUM",
            check: "parallel-page-writes-state",
            mapId,
            mapName,
            eventId: event.eventId,
            eventName,
            page: pageIndex,
            original: "Parallel-process page containing Control Switches/Variables/Self Switch",
            currentBehavior: "Parallel pages are not executed online; its writes never happen",
            expectedBehavior: "Background loop applying the writes while the page is active",
            recommendation: "Review the event; port the logic to an autorun/touch handler if progression depends on it"
          });
        }

        const { conditions, commands } = scriptTextsOf(page);
        for (const text of conditions) {
          if (!isScriptConditionHandled(text) && once(`cond:${text}`)) {
            entries.push({
              severity: "HIGH",
              check: "unsupported-script-condition",
              mapId,
              mapName,
              eventId: event.eventId,
              eventName,
              page: pageIndex,
              original: text.split("\n")[0].slice(0, 160),
              currentBehavior: "Fails closed (else-branch runs); progression cannot leak but content may hide",
              expectedBehavior: "Condition evaluated like the original engine",
              recommendation: "Add a recognizer to essentialsScriptAdapters"
            });
          }
        }
        for (const text of commands) {
          if (!isScriptCommandHandled(text) && once(`cmd:${text}`)) {
            entries.push({
              severity: "MEDIUM",
              check: "unsupported-script-command",
              mapId,
              mapName,
              eventId: event.eventId,
              eventName,
              page: pageIndex,
              original: text.split("\n")[0].slice(0, 160),
              currentBehavior: "Skipped (no-op) and logged at runtime",
              expectedBehavior: "Command effect applied like the original engine",
              recommendation: "Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters"
            });
          }
        }

        // Unknown item symbols.
        if (itemSymbols.size > 0) {
          for (const text of [...conditions, ...commands]) {
            for (const match of text.matchAll(RE_ITEM_SYMBOLS)) {
              const symbol = match[1].toUpperCase();
              if (!itemSymbols.has(symbol) && once(`item:${symbol}`)) {
                entries.push({
                  severity: "MEDIUM",
                  check: "unknown-item-symbol",
                  mapId,
                  mapName,
                  eventId: event.eventId,
                  eventName,
                  page: pageIndex,
                  original: symbol,
                  currentBehavior: "Item resolves to nothing: grants no-op, quantity gates fail closed",
                  expectedBehavior: "Item exists in the imported catalog",
                  recommendation: "Import the item into designer:section:items (or map the symbol)"
                });
              }
            }
          }
        }
      });
    }
  }

  if (!scriptSwitchTable) {
    entries.unshift({
      severity: "BLOCKER",
      check: "missing-script-switch-table",
      mapId: "-",
      mapName: "-",
      eventId: null,
      eventName: "-",
      page: null,
      original: "state.essentialsSystem.scriptSwitches",
      currentBehavior: "Script switches (s: names) are treated as plain never-set switches; day/night NPCs and door templates resolve the wrong page",
      expectedBehavior: "System.rxdata script-switch table imported",
      recommendation: "Run tools/repairEssentialsEvents.ts"
    });
  }

  const order: Severity[] = ["BLOCKER", "HIGH", "MEDIUM", "LOW"];
  entries.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

  const counts = order.map((severity) => ({
    severity,
    count: entries.filter((entry) => entry.severity === severity).length
  }));
  console.log(
    `Report: ${entries.length} findings — ` +
      counts.map(({ severity, count }) => `${severity}: ${count}`).join(", ")
  );

  await fs.writeFile(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), counts, entries }, null, 2));

  const md = [
    "# Essentials Migration Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    counts.map(({ severity, count }) => `- **${severity}**: ${count}`).join("\n"),
    "",
    ...entries.map(
      (entry) =>
        `## [${entry.severity}] ${entry.check} — ${entry.mapName} (${entry.mapId})\n` +
        `- Event: ${entry.eventName}${entry.eventId !== null ? ` (id ${entry.eventId})` : ""}` +
        `${entry.page !== null ? `, page ${entry.page}` : ""}\n` +
        `- Original: \`${entry.original.replace(/`/g, "'")}\`\n` +
        `- Current: ${entry.currentBehavior}\n` +
        `- Expected: ${entry.expectedBehavior}\n` +
        `- Fix: ${entry.recommendation}\n`
    )
  ].join("\n");
  await fs.writeFile(mdOut, md);
  console.log(`Wrote ${jsonOut} and ${mdOut}.`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
