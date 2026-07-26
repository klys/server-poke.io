import type { BattleStatusId } from "./events";

/**
 * Held item battle behaviors. A pokemon holding an item uses it on its own
 * when the trigger condition is met (classic in-battle berry/Leftovers
 * semantics). Effects resolve from the item's Essentials internal id first,
 * then from designer profile hints (effectKind / useCondition).
 */
export type HeldItemEffect =
  | { trigger: "hp-below-half"; action: "heal-amount"; amount: number; consumed: true }
  | { trigger: "hp-below-half"; action: "heal-fraction"; fraction: number; consumed: true }
  | { trigger: "status"; cures: BattleStatusId[] | "any"; curesConfusion: boolean; consumed: true }
  | { trigger: "end-of-turn"; action: "heal-fraction"; fraction: number; consumed: false };

const HELD_EFFECTS_BY_INTERNAL_ID: Record<string, HeldItemEffect> = {
  // Modern berry names.
  ORANBERRY: { trigger: "hp-below-half", action: "heal-amount", amount: 10, consumed: true },
  SITRUSBERRY: { trigger: "hp-below-half", action: "heal-fraction", fraction: 0.25, consumed: true },
  CHERIBERRY: { trigger: "status", cures: ["paralysis"], curesConfusion: false, consumed: true },
  CHESTOBERRY: { trigger: "status", cures: ["sleep"], curesConfusion: false, consumed: true },
  PECHABERRY: { trigger: "status", cures: ["poison", "toxic"], curesConfusion: false, consumed: true },
  RAWSTBERRY: { trigger: "status", cures: ["burn"], curesConfusion: false, consumed: true },
  ASPEARBERRY: { trigger: "status", cures: ["freeze"], curesConfusion: false, consumed: true },
  PERSIMBERRY: { trigger: "status", cures: [], curesConfusion: true, consumed: true },
  LUMBERRY: { trigger: "status", cures: "any", curesConfusion: true, consumed: true },
  // Gen II era names kept by older Essentials projects.
  BERRY: { trigger: "hp-below-half", action: "heal-amount", amount: 10, consumed: true },
  GOLDBERRY: { trigger: "hp-below-half", action: "heal-amount", amount: 30, consumed: true },
  PRZCUREBERRY: { trigger: "status", cures: ["paralysis"], curesConfusion: false, consumed: true },
  MINTBERRY: { trigger: "status", cures: ["sleep"], curesConfusion: false, consumed: true },
  PSNCUREBERRY: { trigger: "status", cures: ["poison", "toxic"], curesConfusion: false, consumed: true },
  ICEBERRY: { trigger: "status", cures: ["burn"], curesConfusion: false, consumed: true },
  BURNTBERRY: { trigger: "status", cures: ["freeze"], curesConfusion: false, consumed: true },
  BITTERBERRY: { trigger: "status", cures: [], curesConfusion: true, consumed: true },
  MIRACLEBERRY: { trigger: "status", cures: "any", curesConfusion: true, consumed: true },
  LEFTOVERS: { trigger: "end-of-turn", action: "heal-fraction", fraction: 1 / 16, consumed: false }
};

/**
 * Passive bonuses granted by an equipped item while it is held (as opposed to
 * the consumable trigger effects above). Applied by BattleManager at the
 * relevant battle hook; multipliers default to "no change" when absent.
 */
export type HeldBonusEffect = {
  /** Damaging moves of this type hit harder (Charcoal, Mystic Water...). */
  boostType?: string;
  boostTypeMultiplier?: number;
  /** Damage-class-wide power multipliers (Muscle Band / Wise Glasses). */
  physicalPowerMultiplier?: number;
  specialPowerMultiplier?: number;
  /** Every damaging move (Life Orb). */
  allPowerMultiplier?: number;
  /** Fraction of the holder's max HP lost after landing a damaging move (Life Orb). */
  selfDamageFraction?: number;
  /** Raw stat multipliers (Choice trio, Eviolite, Thick Club, Light Ball). */
  attackMultiplier?: number;
  specialAttackMultiplier?: number;
  defenseMultiplier?: number;
  specialDefenseMultiplier?: number;
  speedMultiplier?: number;
  /** Choice items: the holder is locked into the first move it uses. */
  choiceLock?: boolean;
  /** Restrict the bonus to these species internal names (Thick Club...). */
  onlySpecies?: string[];
  /** Eviolite: only while the holder can still evolve. */
  onlyIfCanEvolve?: boolean;
  /** Extra critical-hit stage (Scope Lens). */
  critStageBonus?: number;
  /** Chance for the holder's damaging moves to flinch the target (King's Rock). */
  flinchChance?: number;
  /** Chance to act first within the same priority bracket (Quick Claw). */
  quickClawChance?: number;
  /** Chance to survive a lethal hit at 1 HP (Focus Band). */
  focusBandChance?: number;
  /** Incoming accuracy is multiplied by this while the holder is targeted (BrightPowder). */
  incomingAccuracyMultiplier?: number;
  /** Battle EXP multiplier for the holder (Lucky Egg). */
  expMultiplier?: number;
  /** Trainer prize-money multiplier when the holder is in the winning party (Amulet Coin). */
  moneyMultiplier?: number;
};

const TYPE_BOOST_ITEMS: Record<string, string> = {
  CHARCOAL: "FIRE",
  MYSTICWATER: "WATER",
  MIRACLESEED: "GRASS",
  MAGNET: "ELECTRIC",
  TWISTEDSPOON: "PSYCHIC",
  SILKSCARF: "NORMAL",
  BLACKBELT: "FIGHTING",
  SHARPBEAK: "FLYING",
  POISONBARB: "POISON",
  SOFTSAND: "GROUND",
  HARDSTONE: "ROCK",
  SILVERPOWDER: "BUG",
  SPELLTAG: "GHOST",
  NEVERMELTICE: "ICE",
  DRAGONFANG: "DRAGON",
  METALCOAT: "STEEL",
  BLACKGLASSES: "DARK"
};

const HELD_BONUSES_BY_INTERNAL_ID: Record<string, HeldBonusEffect> = {
  ...Object.fromEntries(
    Object.entries(TYPE_BOOST_ITEMS).map(([itemId, type]) => [
      itemId,
      { boostType: type, boostTypeMultiplier: 1.2 } satisfies HeldBonusEffect
    ])
  ),
  MUSCLEBAND: { physicalPowerMultiplier: 1.1 },
  WISEGLASSES: { specialPowerMultiplier: 1.1 },
  CHOICEBAND: { attackMultiplier: 1.5, choiceLock: true },
  CHOICESPECS: { specialAttackMultiplier: 1.5, choiceLock: true },
  CHOICESCARF: { speedMultiplier: 1.5, choiceLock: true },
  LIFEORB: { allPowerMultiplier: 1.3, selfDamageFraction: 0.1 },
  SCOPELENS: { critStageBonus: 1 },
  KINGSROCK: { flinchChance: 0.1 },
  QUICKCLAW: { quickClawChance: 0.2 },
  FOCUSBAND: { focusBandChance: 0.1 },
  BRIGHTPOWDER: { incomingAccuracyMultiplier: 0.9 },
  LUCKYEGG: { expMultiplier: 1.5 },
  AMULETCOIN: { moneyMultiplier: 2 },
  THICKCLUB: { attackMultiplier: 2, onlySpecies: ["CUBONE", "MAROWAK"] },
  LIGHTBALL: { attackMultiplier: 2, specialAttackMultiplier: 2, onlySpecies: ["PIKACHU"] },
  EVIOLITE: { defenseMultiplier: 1.5, specialDefenseMultiplier: 1.5, onlyIfCanEvolve: true }
};

export function resolveHeldBonus(essentialsId?: string): HeldBonusEffect | null {
  const internalId = (essentialsId ?? "").trim().toUpperCase();
  return HELD_BONUSES_BY_INTERNAL_ID[internalId] ?? null;
}

/**
 * Internal ids the client offers under "Equip item" — every passive-bonus item
 * plus Leftovers (a trigger effect, but an equipment-style hold item all the
 * same). Berries stay in their own "Give Berry" flow.
 * KEEP IN SYNC with client-poke.io src/components/ux/game/equipableItems.ts.
 */
export const EQUIPABLE_INTERNAL_IDS: readonly string[] = [
  ...Object.keys(HELD_BONUSES_BY_INTERNAL_ID),
  "LEFTOVERS"
];

export function resolveHeldItemEffect(options: {
  essentialsId?: string;
  effectKind?: string;
  useCondition?: string;
  healAmount?: number;
}): HeldItemEffect | null {
  const internalId = (options.essentialsId ?? "").trim().toUpperCase();
  if (internalId && HELD_EFFECTS_BY_INTERNAL_ID[internalId]) {
    return HELD_EFFECTS_BY_INTERNAL_ID[internalId];
  }

  const effectKind = (options.effectKind ?? "").trim().toLowerCase();
  const useCondition = (options.useCondition ?? "").trim().toLowerCase();

  if (effectKind === "heal" && (useCondition.includes("half") || useCondition.includes("pinch"))) {
    return {
      trigger: "hp-below-half",
      action: "heal-amount",
      amount: Math.max(1, Math.round(options.healAmount ?? 10)),
      consumed: true
    };
  }

  if (effectKind === "cure-status" || effectKind === "status-cure") {
    return { trigger: "status", cures: "any", curesConfusion: true, consumed: true };
  }

  return null;
}
