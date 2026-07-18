/**
 * Un-consumes item balls that players opened while item grants were broken.
 *
 * Before EventRuntime learned to grant pbItemBall items, interacting with a
 * ball still ran its "Set Self Switch A" command, so the ball vanished for
 * that player without giving anything. This tool walks every imported map
 * event whose script commands call pbItemBall (ground balls and apricorn
 * trees — events with no other side effects), collects their self-switch
 * prefixes (`<essentialsMapId>:<eventId>:`), and deletes matching keys from
 * every user's event_self_switches hash field so the balls become
 * collectible again.
 *
 * pbReceiveItem / pbStoreItem events are intentionally NOT reset: those are
 * NPC dialogs and vending machines whose other effects (Pokemon grants,
 * money changes) did work, so replaying them could duplicate rewards.
 *
 * Usage:
 *   npx ts-node tools/resetConsumedItemBalls.ts [--dry-run]
 */
import { createClient } from "redis";

const MAPS_REDIS_KEY = "designer:section:maps";
const RE_ITEM_BALL = /pbItemBall\(/i;

type RawCommand = { code: number; parameters: unknown[] };
type EssentialsEvent = {
  eventId: number;
  essentialsMapId: number;
  pages: Array<{ commands: RawCommand[] }>;
};

function commandMentionsItemBall(command: RawCommand): boolean {
  return command.parameters.some(
    (parameter) => typeof parameter === "string" && RE_ITEM_BALL.test(parameter)
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });

  await redis.connect();

  try {
    const rawMaps = await redis.get(MAPS_REDIS_KEY);
    if (!rawMaps) {
      console.error(`ERROR: No ${MAPS_REDIS_KEY} payload in Redis.`);
      process.exit(1);
    }

    const mapsPayload = JSON.parse(rawMaps);
    const editorDataByMapId: Record<string, { npcs?: Array<{ essentialsEvent?: EssentialsEvent }> }> =
      mapsPayload?.state?.editorDataByMapId ?? {};

    const prefixes: string[] = [];
    for (const editorData of Object.values(editorDataByMapId)) {
      for (const npc of editorData?.npcs ?? []) {
        const essentials = npc.essentialsEvent;
        if (!essentials) continue;
        const isItemBall = essentials.pages.some((page) =>
          page.commands.some(commandMentionsItemBall)
        );
        if (isItemBall) {
          prefixes.push(`${essentials.essentialsMapId}:${essentials.eventId}:`);
        }
      }
    }
    console.log(`Found ${prefixes.length} item-ball events across imported maps.`);

    let usersTouched = 0;
    let switchesCleared = 0;
    for await (const keys of redis.scanIterator({ MATCH: "auth:user:*", COUNT: 100 })) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        // Only user hashes (auth:user:<id>); the namespace also holds string
        // keys like auth:user:id:sequence and email lookups.
        if (!/^auth:user:\d+$/.test(String(key))) continue;
        const raw = await redis.hGet(String(key), "event_self_switches");
        if (!raw) continue;
        let selfSwitches: Record<string, boolean>;
        try {
          selfSwitches = JSON.parse(raw);
        } catch {
          continue;
        }
        const cleared = Object.keys(selfSwitches).filter((switchKey) =>
          prefixes.some((prefix) => switchKey.startsWith(prefix))
        );
        if (cleared.length === 0) continue;
        for (const switchKey of cleared) {
          delete selfSwitches[switchKey];
        }
        usersTouched += 1;
        switchesCleared += cleared.length;
        console.log(`${dryRun ? "[dry-run] " : ""}${key}: clearing ${cleared.length} consumed ball(s)`);
        if (!dryRun) {
          await redis.hSet(String(key), { event_self_switches: JSON.stringify(selfSwitches) });
        }
      }
    }
    console.log(
      `${dryRun ? "[dry-run] " : ""}Cleared ${switchesCleared} self-switches across ${usersTouched} user(s).`
    );
  } finally {
    await redis.quit();
  }
}

void main();
