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
