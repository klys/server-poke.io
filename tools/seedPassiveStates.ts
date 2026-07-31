/**
 * Seeds designer:section:passiveStates with the battle engine's six
 * non-volatile status conditions (components/battle/statuses.ts), replacing
 * the old demo placeholders (Focused / Slowed / generic Burn).
 *
 * Usage:
 *   npx ts-node tools/seedPassiveStates.ts [--dry-run]
 *
 * Idempotent: canonical statuses are merged by id, any other designer-made
 * items are preserved, and the legacy demo ids (state-focused, state-slowed)
 * are removed.
 */
import { createClient } from "redis";

const SECTION_KEY = "designer:section:passiveStates";
const LEGACY_DEMO_IDS = new Set(["state-focused", "state-slowed"]);

type SectionItem = {
  id: string;
  name: string;
  category: string;
  details: Array<{ label: string; value: string }>;
};

const detail = (label: string, value: string) => ({ label, value });

// Mirrors STATUS_DISPLAY_NAMES / STATUS_TYPE_IMMUNITIES in
// components/battle/statuses.ts.
const CANONICAL_STATUSES: SectionItem[] = [
  {
    id: "state-poison",
    name: "Poison",
    category: "Status",
    details: [
      detail("Status ID", "poison"),
      detail("Effect", "Loses 1/8 max HP at end of each turn"),
      detail("Immune Types", "POISON, STEEL"),
    ],
  },
  {
    id: "state-toxic",
    name: "Toxic (bad poison)",
    category: "Status",
    details: [
      detail("Status ID", "toxic"),
      detail("Effect", "Escalating poison damage each turn"),
      detail("Immune Types", "POISON, STEEL"),
    ],
  },
  {
    id: "state-burn",
    name: "Burn",
    category: "Status",
    details: [
      detail("Status ID", "burn"),
      detail("Effect", "End-of-turn damage and halved physical attack"),
      detail("Immune Types", "FIRE"),
    ],
  },
  {
    id: "state-paralysis",
    name: "Paralysis",
    category: "Status",
    details: [
      detail("Status ID", "paralysis"),
      detail("Effect", "Speed reduced; may be unable to act"),
      detail("Immune Types", "ELECTRIC"),
    ],
  },
  {
    id: "state-sleep",
    name: "Sleep",
    category: "Status",
    details: [
      detail("Status ID", "sleep"),
      detail("Effect", "Cannot act for 2-5 turns"),
      detail("Immune Types", "None"),
    ],
  },
  {
    id: "state-freeze",
    name: "Freeze",
    category: "Status",
    details: [
      detail("Status ID", "freeze"),
      detail("Effect", "Cannot act until thawed"),
      detail("Immune Types", "ICE"),
    ],
  },
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const redis = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });

  await redis.connect();

  try {
    const raw = await redis.get(SECTION_KEY);
    const payload = raw
      ? JSON.parse(raw)
      : {
          sectionKey: "passiveStates",
          state: { categories: ["Status"], items: [] },
          version: 0,
          updatedAt: null,
          updatedByUserId: null,
          updatedByUsername: null,
        };

    const existingItems: SectionItem[] = Array.isArray(payload?.state?.items)
      ? payload.state.items
      : [];
    const canonicalIds = new Set(CANONICAL_STATUSES.map((item) => item.id));
    const keptItems = existingItems.filter(
      (item) => !canonicalIds.has(item?.id) && !LEGACY_DEMO_IDS.has(item?.id)
    );
    const nextItems = [...CANONICAL_STATUSES, ...keptItems];

    const categories = Array.isArray(payload?.state?.categories)
      ? payload.state.categories.filter((c: unknown): c is string => typeof c === "string")
      : [];
    const nextCategories = categories.includes("Status") ? categories : ["Status", ...categories];

    payload.sectionKey = "passiveStates";
    payload.state = { categories: nextCategories, items: nextItems };
    payload.version = (typeof payload.version === "number" ? payload.version : 0) + 1;
    payload.updatedAt = new Date().toISOString();
    payload.updatedByUsername = "seed-passive-states";

    console.log(
      `passiveStates: ${CANONICAL_STATUSES.length} canonical statuses, ` +
        `${keptItems.length} custom items kept, ` +
        `${existingItems.length - keptItems.length} replaced/removed. ` +
        `New version: ${payload.version}.`
    );

    if (dryRun) {
      console.log("--dry-run: nothing written.");
      return;
    }

    await redis.set(SECTION_KEY, JSON.stringify(payload));
    console.log(`Wrote ${SECTION_KEY}. Restart or re-join the section to broadcast it.`);
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
