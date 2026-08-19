/**
 * Repairs imported Pokemon Essentials event data in the live Redis maps
 * payload so progression matches the original RPG Maker XP project:
 *
 * 1. Every event referenced by an extracted portal (and any other event the
 *    original map defines) gets a placement carrying its FULL page data
 *    (conditions, triggers, commands). The runtime then routes those portals
 *    through real event execution — page conditions, dialogue and conditional
 *    branches included — instead of blind teleporting. Designer-owned fields
 *    of existing placements (position, names, store stock…) are never
 *    modified, but their essentialsEvent PAGES are refreshed from the dump:
 *    placements written by older importer versions carry command lists with
 *    then-unsupported codes stripped (Scroll Map, Screen Shake, Show
 *    Animation…), and the runtime can only play what the placement holds.
 * 2. The System.rxdata switch/variable tables are imported as
 *    `state.essentialsSystem`: script switches ("s:" names — day/night, temp
 *    switches) become evaluable page conditions, and the plain names feed
 *    diagnostics.
 *
 * Usage:
 *   npx ts-node tools/repairEssentialsEvents.ts "<rxdata_json dir>" [--dry-run]
 *
 * The rxdata_json directory is the raw rxdata->JSON dump of the original
 * project (maps/Map###.json + data/System.json). Re-running is idempotent.
 */
import { promises as fs } from "fs";
import path from "path";
import { createClient } from "redis";
import { sanitizePlayableMapsStateSnapshot } from "../components/PlayableMapsState";

const MAPS_REDIS_KEY = "designer:section:maps";
const PROBE_KEY = `${MAPS_REDIS_KEY}:probe`;

type RawRxPage = {
  condition?: {
    switch1_valid?: boolean;
    switch1_id?: number;
    switch2_valid?: boolean;
    switch2_id?: number;
    self_switch_valid?: boolean;
    self_switch_ch?: string;
    variable_valid?: boolean;
    variable_id?: number;
    variable_value?: number;
  };
  graphic?: {
    character_name?: string;
    direction?: number;
    pattern?: number;
    character_hue?: number;
  };
  trigger?: number;
  through?: boolean;
  move_type?: number;
  move_speed?: number;
  move_frequency?: number;
  direction_fix?: boolean;
  walk_anime?: boolean;
  step_anime?: boolean;
  always_on_top?: boolean;
  list?: Array<{ code: number; indent: number; parameters?: unknown[] }>;
};

type RawRxEvent = { id: number; name?: string; x: number; y: number; pages?: RawRxPage[] };

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function convertPage(page: RawRxPage) {
  const condition = page.condition ?? {};
  const conditions: Record<string, unknown> = {};
  if (condition.switch1_valid && condition.switch1_id) {
    conditions.switch1 = condition.switch1_id;
  }
  if (condition.switch2_valid && condition.switch2_id) {
    conditions.switch2 = condition.switch2_id;
  }
  if (condition.self_switch_valid && condition.self_switch_ch) {
    conditions.selfSwitch = condition.self_switch_ch;
  }
  if (condition.variable_valid && condition.variable_id) {
    conditions.variable = {
      id: condition.variable_id,
      value: condition.variable_value ?? 0
    };
  }

  return {
    conditions,
    graphic: {
      characterName: page.graphic?.character_name ?? "",
      direction: page.graphic?.direction ?? 2,
      pattern: page.graphic?.pattern ?? 0
    },
    trigger: page.trigger ?? 0,
    move: {
      type: page.move_type ?? 0,
      speed: page.move_speed ?? 3,
      frequency: page.move_frequency ?? 3,
      route: null,
      directionFix: page.direction_fix === true,
      through: page.through === true,
      walkAnime: page.walk_anime !== false,
      stepAnime: page.step_anime === true,
      alwaysOnTop: page.always_on_top === true
    },
    commands: (page.list ?? []).map((command) => ({
      code: command.code,
      indent: command.indent ?? 0,
      parameters: command.parameters ?? []
    }))
  };
}

const INTERACTABLE_CODES = new Set([101, 102, 111, 125, 126, 355]);

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rxdataDir = args.find((argument) => !argument.startsWith("--"));

  if (!rxdataDir) {
    fail('Usage: npx ts-node tools/repairEssentialsEvents.ts "<rxdata_json dir>" [--dry-run]');
  }

  const resolvedDir = path.resolve(rxdataDir);

  // ---- System switch/variable tables --------------------------------------
  const system = await readJson<{ data: { switches?: Array<string | null>; variables?: Array<string | null> } }>(
    path.join(resolvedDir, "data", "System.json")
  ).catch(() => fail(`No readable data/System.json under ${resolvedDir}`));

  const scriptSwitches: Record<string, string> = {};
  const switchNames: Record<string, string> = {};
  const variableNames: Record<string, string> = {};
  (system.data.switches ?? []).forEach((name, id) => {
    if (typeof name !== "string" || name.length === 0) return;
    switchNames[String(id)] = name;
    if (name.startsWith("s:")) {
      scriptSwitches[String(id)] = name.slice(2).trim();
    }
  });
  (system.data.variables ?? []).forEach((name, id) => {
    if (typeof name === "string" && name.length > 0) {
      variableNames[String(id)] = name;
    }
  });

  // ---- Live payload --------------------------------------------------------
  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });
  await redis.connect();

  try {
    const raw = await redis.get(MAPS_REDIS_KEY);
    if (!raw) {
      fail(`No ${MAPS_REDIS_KEY} payload in Redis.`);
    }
    const payload = JSON.parse(raw) as {
      state: {
        editorDataByMapId: Record<string, {
          portals?: Array<{ x: number; y: number; essentialsConnection?: unknown }>;
          npcs?: Array<Record<string, unknown> & { eventId?: number; x?: number; y?: number }>;
          essentials?: { mapId?: string };
        }>;
        essentialsSystem?: unknown;
      };
      version?: number;
    };

    const editorData = payload.state.editorDataByMapId ?? {};
    let addedPlacements = 0;
    let refreshedPlacements = 0;
    let portalsNowGated = 0;
    let mapsTouched = 0;
    let missingRxMaps = 0;

    for (const [runtimeMapId, mapData] of Object.entries(editorData)) {
      const essentialsMapId = Number(
        (mapData.essentials?.mapId ?? runtimeMapId.match(/^map-essentials-0*(\d+)$/)?.[1]) ?? NaN
      );
      if (!Number.isFinite(essentialsMapId)) {
        continue;
      }

      const rxPath = path.join(
        resolvedDir,
        "maps",
        `Map${String(essentialsMapId).padStart(3, "0")}.json`
      );
      const rxMap = await readJson<{ data: { events?: Record<string, RawRxEvent> } }>(rxPath).catch(
        () => null
      );
      if (!rxMap) {
        missingRxMaps += 1;
        continue;
      }

      const npcs = mapData.npcs ?? (mapData.npcs = []);
      const existingEventIds = new Set(
        npcs
          .filter((npc) => (npc as { essentialsEvent?: unknown }).essentialsEvent)
          .map((npc) => Number(npc.eventId))
          .filter((id) => Number.isFinite(id))
      );

      let addedHere = 0;
      let refreshedHere = 0;
      for (const rawEvent of Object.values(rxMap.data.events ?? {})) {
        if (existingEventIds.has(rawEvent.id)) {
          // Refresh stale page data in place: only the essentialsEvent pages
          // are replaced, never the designer-owned placement fields.
          const freshPages = (rawEvent.pages ?? []).map(convertPage);
          if (freshPages.length === 0) {
            continue;
          }
          for (const npc of npcs) {
            const holder = npc as { essentialsEvent?: { pages?: unknown } };
            if (Number(npc.eventId) === rawEvent.id && holder.essentialsEvent) {
              if (JSON.stringify(holder.essentialsEvent.pages) !== JSON.stringify(freshPages)) {
                holder.essentialsEvent.pages = freshPages;
                refreshedHere += 1;
              }
            }
          }
          continue;
        }
        const pages = (rawEvent.pages ?? []).map(convertPage);
        if (pages.length === 0) {
          continue;
        }
        // Skip pure decoration: no page has commands, and no page has a
        // graphic that would block or render.
        const meaningful = pages.some(
          (page) =>
            page.commands.some((command) => command.code !== 0) ||
            page.graphic.characterName.length > 0
        );
        if (!meaningful) {
          continue;
        }

        const graphicPage = pages.find((page) => page.graphic.characterName.length > 0);
        const interactable = pages.some(
          (page) =>
            page.trigger <= 2 &&
            page.commands.some((command) => INTERACTABLE_CODES.has(command.code))
        );

        npcs.push({
          id: `npc-${runtimeMapId}-ev${rawEvent.id}`,
          npcId: `essentials-event-${essentialsMapId}-${rawEvent.id}`,
          name: rawEvent.name || "Event",
          category: "Pokemon Essentials",
          previewImageSrc: "",
          npcType: "sign",
          aiType: "standing",
          interactionDistanceSquares: 2,
          x: rawEvent.x,
          y: rawEvent.y,
          eventId: rawEvent.id,
          eventPageIndex: 0,
          eventCommands: [],
          ...(graphicPage
            ? {
                essentialsGraphic: {
                  characterName: graphicPage.graphic.characterName,
                  direction: graphicPage.graphic.direction,
                  pattern: graphicPage.graphic.pattern
                },
                movement: graphicPage.move
              }
            : {}),
          interactable,
          essentialsEvent: {
            eventId: rawEvent.id,
            essentialsMapId,
            pages
          }
        });
        existingEventIds.add(rawEvent.id);
        addedHere += 1;
      }

      if (addedHere > 0 || refreshedHere > 0) {
        mapsTouched += 1;
        addedPlacements += addedHere;
        refreshedPlacements += refreshedHere;
      }

      // Count portals that now have a page-aware owner on their cell.
      for (const portal of mapData.portals ?? []) {
        if (!portal.essentialsConnection) continue;
        const owner = npcs.find(
          (npc) =>
            npc.x === portal.x &&
            npc.y === portal.y &&
            (npc as { essentialsEvent?: { pages?: Array<{ commands?: Array<{ code: number }> }> } })
              .essentialsEvent?.pages?.some((page) =>
                (page.commands ?? []).some((command) => command.code === 201)
              )
        );
        if (owner) {
          portalsNowGated += 1;
        }
      }
    }

    (payload.state as Record<string, unknown>).essentialsSystem = {
      scriptSwitches,
      switchNames,
      variableNames
    };

    console.log(
      `Placements added: ${addedPlacements}, event pages refreshed: ${refreshedPlacements} across ${mapsTouched} maps ` +
        `(rxdata missing for ${missingRxMaps} maps). ` +
        `Essentials portals with page-aware owners: ${portalsNowGated}. ` +
        `Script switches: ${Object.keys(scriptSwitches).length}, ` +
        `named switches: ${Object.keys(switchNames).length}, ` +
        `named variables: ${Object.keys(variableNames).length}.`
    );

    const sanitized = sanitizePlayableMapsStateSnapshot(payload.state);
    if (!sanitized) {
      fail("Repaired state failed sanitization; nothing was written.");
    }
    if (!sanitized.essentialsSystem) {
      fail("Sanitizer dropped essentialsSystem; nothing was written.");
    }

    if (dryRun) {
      console.log("Dry run: nothing was written.");
      return;
    }

    const nextPayload = {
      ...payload,
      state: sanitized,
      version: (payload.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserId: null,
      updatedByUsername: "essentials-repair"
    };
    const serialized = JSON.stringify(nextPayload);
    await redis.set(MAPS_REDIS_KEY, serialized);
    // Bump the probe marker exactly like PlayableMapsStore.save so running
    // servers notice the change on their next cache refresh.
    await redis.set(PROBE_KEY, `${nextPayload.version}:${nextPayload.updatedAt}`);
    console.log(`Wrote repaired maps payload at version ${nextPayload.version}.`);
  } finally {
    await redis.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
