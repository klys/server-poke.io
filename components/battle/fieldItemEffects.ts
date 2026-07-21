/**
 * Field-usable item classification (the bag "Use" button, out of battle).
 *
 * Keyed on the Essentials internal id so behaviour is deterministic no matter
 * how lossily the migration tagged `effectKind` (most medicine collapsed to
 * "heal-hp"/"stat-modifier"/"none"). Unknown ids fall back to their heal
 * amount / status-cure table so custom potions still work.
 *
 * This is the single source of truth shared by the battle engine (which
 * applies the effect) and Auth (which stamps a `useTarget` hint on the
 * session inventory so the client modal knows whether to ask for a Venomon,
 * a move, or nothing).
 */
import type { BattleStatKey, BattleStatusId } from "./events";

/** EV rules (standard Essentials): 252/stat hard cap, 510 total, vitamins 100. */
export const MAX_STANDARD_EV_PER_STAT = 252;
export const MAX_TOTAL_EV = 510;
export const VITAMIN_EV_CAP = 100;

/** Which status ailments an item clears when used, keyed by Essentials id. */
export const STATUS_CURE_ITEMS: Record<
  string,
  { statuses: BattleStatusId[] | "any"; confusion: boolean }
> = {
  ANTIDOTE: { statuses: ["poison", "toxic"], confusion: false },
  PARLYZHEAL: { statuses: ["paralysis"], confusion: false },
  PARALYZEHEAL: { statuses: ["paralysis"], confusion: false },
  AWAKENING: { statuses: ["sleep"], confusion: false },
  BURNHEAL: { statuses: ["burn"], confusion: false },
  ICEHEAL: { statuses: ["freeze"], confusion: false },
  FULLHEAL: { statuses: "any", confusion: true },
  FULLRESTORE: { statuses: "any", confusion: true },
  LAVACOOKIE: { statuses: "any", confusion: true },
  OLDGATEAU: { statuses: "any", confusion: true },
  CASTELIACONE: { statuses: "any", confusion: true },
  RAGECANDYBAR: { statuses: "any", confusion: true },
  SWEETHEART: { statuses: "any", confusion: true },
  HEALPOWDER: { statuses: "any", confusion: true },
  LUMBERRY: { statuses: "any", confusion: true },
  CHERIBERRY: { statuses: ["paralysis"], confusion: false },
  CHESTOBERRY: { statuses: ["sleep"], confusion: false },
  PECHABERRY: { statuses: ["poison", "toxic"], confusion: false },
  RAWSTBERRY: { statuses: ["burn"], confusion: false },
  ASPEARBERRY: { statuses: ["freeze"], confusion: false },
  PERSIMBERRY: { statuses: [], confusion: true },
  MIRACLEBERRY: { statuses: "any", confusion: true },
  BITTERBERRY: { statuses: [], confusion: true },
  PRZCUREBERRY: { statuses: ["paralysis"], confusion: false },
  MINTBERRY: { statuses: ["sleep"], confusion: false },
  PSNCUREBERRY: { statuses: ["poison", "toxic"], confusion: false },
  ICEBERRY: { statuses: ["burn"], confusion: false },
  BURNTBERRY: { statuses: ["freeze"], confusion: false }
};

/** Revive a single fainted Venomon to this fraction of max HP. */
const REVIVE_ITEMS: Record<string, number> = {
  REVIVE: 0.5,
  MAXREVIVE: 1,
  REVIVALHERB: 1
};

/** Revive every fainted party member (Sacred Ash). */
const REVIVE_ALL_ITEMS: Record<string, number> = {
  SACREDASH: 1
};

/** Permanent EV boosts. `capped` items (vitamins) refuse past VITAMIN_EV_CAP. */
const VITAMIN_ITEMS: Record<
  string,
  { stat: BattleStatKey; amount: number; capped: boolean }
> = {
  HPUP: { stat: "hp", amount: 10, capped: true },
  PROTEIN: { stat: "attack", amount: 10, capped: true },
  IRON: { stat: "defense", amount: 10, capped: true },
  CALCIUM: { stat: "specialAttack", amount: 10, capped: true },
  ZINC: { stat: "specialDefense", amount: 10, capped: true },
  CARBOS: { stat: "speed", amount: 10, capped: true },
  HEALTHWING: { stat: "hp", amount: 1, capped: false },
  MUSCLEWING: { stat: "attack", amount: 1, capped: false },
  RESISTWING: { stat: "defense", amount: 1, capped: false },
  GENIUSWING: { stat: "specialAttack", amount: 1, capped: false },
  CLEVERWING: { stat: "specialDefense", amount: 1, capped: false },
  SWIFTWING: { stat: "speed", amount: 1, capped: false }
};

/** Restore a move's PP. `amount` 9999 = fully. `all` targets every move. */
const PP_RESTORE_ITEMS: Record<string, { scope: "one" | "all"; amount: number }> = {
  ETHER: { scope: "one", amount: 10 },
  MAXETHER: { scope: "one", amount: 9999 },
  ELIXIR: { scope: "all", amount: 10 },
  MAXELIXIR: { scope: "all", amount: 9999 },
  LEPPABERRY: { scope: "one", amount: 10 }
};

/** PP Up / PP Max: raise a move's maximum PP (in 20%-of-base "stages"). */
const PP_UP_ITEMS: Record<string, "up" | "max"> = {
  PPUP: "up",
  PPMAX: "max"
};

/**
 * Items that trigger an item/stone evolution. The species must actually have a
 * matching item-evolution method or nothing happens ("It had no effect...").
 */
const EVOLUTION_STONE_ITEMS = new Set([
  "FIRESTONE", "WATERSTONE", "THUNDERSTONE", "LEAFSTONE", "MOONSTONE", "SUNSTONE",
  "SHINYSTONE", "DUSKSTONE", "DAWNSTONE", "ICESTONE", "OVALSTONE", "METALCOAT",
  "DRAGONSCALE", "KINGSROCK", "UPGRADE", "DUBIOUSDISC", "PROTECTOR", "ELECTIRIZER",
  "MAGMARIZER", "REAPERCLOTH", "PRISMSCALE", "WHIPPEDDREAM", "SACHET",
  "DEEPSEATOOTH", "DEEPSEASCALE", "RAZORCLAW", "RAZORFANG", "LINKINGCORD", "LINKCABLE"
]);

/** Wild-encounter repellents: value = number of steps of suppression. */
const REPEL_ITEMS: Record<string, number> = {
  REPEL: 100,
  SUPERREPEL: 200,
  MAXREPEL: 250
};

/** Flutes that wake the whole party from sleep. */
const WAKE_FLUTE_ITEMS = new Set(["POKEFLUTE", "BLUEFLUTE"]);

export type FieldItemKeyAction = "town-map" | "bicycle" | "dowsing" | "fishing" | "generic";

/** Key items that open a client UI or toggle a mode instead of a party effect. */
const KEY_ITEM_ACTIONS: Record<string, FieldItemKeyAction> = {
  TOWNMAP: "town-map",
  POKERADAR: "generic",
  BICYCLE: "bicycle",
  ITEMFINDER: "dowsing",
  DOWSINGMACHINE: "dowsing",
  OLDROD: "fishing",
  GOODROD: "fishing",
  SUPERROD: "fishing"
};

export type FieldItemEffect =
  | { kind: "heal-hp"; amount: number }
  | { kind: "cure-status"; statuses: BattleStatusId[] | "any"; confusion: boolean }
  | { kind: "full-restore"; amount: number }
  | { kind: "revive"; hpFraction: number }
  | { kind: "revive-all"; hpFraction: number }
  | { kind: "pp-restore"; scope: "one" | "all"; amount: number }
  | { kind: "pp-up"; mode: "up" | "max" }
  | { kind: "vitamin"; stat: BattleStatKey; amount: number; capped: boolean }
  | { kind: "level-up" }
  | { kind: "evolution-stone" }
  | { kind: "repel"; steps: number }
  | { kind: "escape-rope" }
  | { kind: "wake-flute" }
  | { kind: "key-item"; action: FieldItemKeyAction };

/** What the bag modal must collect before the item can be used. */
export type FieldItemTargetKind = "pokemon" | "pokemon-move" | "none";

export interface FieldItemDescriptor {
  /** Essentials internal id, upper-cased (e.g. "REVIVE", "RARECANDY"). */
  essentialsId: string;
  /** HP the item restores (from statModifiers.hp; 9999 = full). */
  healHp: number;
  /** Bag pocket category so we never treat a TM/key item as medicine. */
  category: "usable" | "berries" | "moves" | "quest" | string;
}

/**
 * Resolves what a field item does. Returns null when the item has no
 * meaningful out-of-battle effect (e.g. pure in-battle X-items, plain quest
 * items with no handler).
 */
export function classifyFieldItem(descriptor: FieldItemDescriptor): FieldItemEffect | null {
  const id = (descriptor.essentialsId || "").toUpperCase();

  if (id in REVIVE_ALL_ITEMS) {
    return { kind: "revive-all", hpFraction: REVIVE_ALL_ITEMS[id] };
  }
  if (id in REVIVE_ITEMS) {
    return { kind: "revive", hpFraction: REVIVE_ITEMS[id] };
  }
  if (id === "FULLRESTORE") {
    return { kind: "full-restore", amount: 9999 };
  }
  if (id in VITAMIN_ITEMS) {
    const vitamin = VITAMIN_ITEMS[id];
    return { kind: "vitamin", stat: vitamin.stat, amount: vitamin.amount, capped: vitamin.capped };
  }
  if (id in PP_RESTORE_ITEMS) {
    const pp = PP_RESTORE_ITEMS[id];
    return { kind: "pp-restore", scope: pp.scope, amount: pp.amount };
  }
  if (id in PP_UP_ITEMS) {
    return { kind: "pp-up", mode: PP_UP_ITEMS[id] };
  }
  if (id === "RARECANDY") {
    return { kind: "level-up" };
  }
  if (EVOLUTION_STONE_ITEMS.has(id)) {
    return { kind: "evolution-stone" };
  }
  if (id in REPEL_ITEMS) {
    return { kind: "repel", steps: REPEL_ITEMS[id] };
  }
  if (id === "ESCAPEROPE") {
    return { kind: "escape-rope" };
  }
  if (WAKE_FLUTE_ITEMS.has(id)) {
    return { kind: "wake-flute" };
  }
  if (id in KEY_ITEM_ACTIONS) {
    return { kind: "key-item", action: KEY_ITEM_ACTIONS[id] };
  }

  const cure = STATUS_CURE_ITEMS[id];
  if (cure) {
    return { kind: "cure-status", statuses: cure.statuses, confusion: cure.confusion };
  }

  if (descriptor.healHp > 0) {
    return { kind: "heal-hp", amount: descriptor.healHp };
  }

  return null;
}

/** What the client modal must prompt for before sending `inventory:use-item`. */
export function fieldItemTargetKind(effect: FieldItemEffect | null): FieldItemTargetKind {
  if (!effect) {
    return "none";
  }
  switch (effect.kind) {
    case "heal-hp":
    case "cure-status":
    case "full-restore":
    case "revive":
    case "vitamin":
    case "level-up":
    case "evolution-stone":
      return "pokemon";
    case "pp-restore":
      return effect.scope === "one" ? "pokemon-move" : "pokemon";
    case "pp-up":
      return "pokemon-move";
    case "revive-all":
    case "repel":
    case "escape-rope":
    case "wake-flute":
    case "key-item":
      return "none";
    default:
      return "none";
  }
}

/** Effective max PP for a move given `stages` PP-Ups applied (0-3, +20% each). */
export function maxPpForMove(baseMaxPp: number, stages: number): number {
  const boundedStages = Math.max(0, Math.min(3, Math.round(stages)));
  return baseMaxPp + Math.floor(baseMaxPp / 5) * boundedStages;
}
