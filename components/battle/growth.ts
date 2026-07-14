/**
 * Species experience growth curves matching Pokemon Essentials semantics.
 *
 * Stored player experience stays "progress into the current level" (the
 * pre-existing PokemonSummary contract); the curve defines how much progress
 * each level requires and how much a defeated foe yields.
 */
export type GrowthRateId =
  | "Medium"
  | "Erratic"
  | "Fluctuating"
  | "Parabolic"
  | "Fast"
  | "Slow";

const GROWTH_RATE_ALIASES: Record<string, GrowthRateId> = {
  medium: "Medium",
  mediumfast: "Medium",
  erratic: "Erratic",
  fluctuating: "Fluctuating",
  parabolic: "Parabolic",
  mediumslow: "Parabolic",
  fast: "Fast",
  slow: "Slow"
};

export function normalizeGrowthRate(raw: unknown): GrowthRateId | null {
  if (typeof raw !== "string") {
    return null;
  }

  return GROWTH_RATE_ALIASES[raw.trim().toLowerCase().replace(/[\s_-]/g, "")] ?? null;
}

/** Total experience required to reach `level` from level 1. */
export function totalExpForLevel(rate: GrowthRateId, level: number): number {
  const n = Math.max(1, Math.min(100, Math.round(level)));
  if (n === 1) {
    return 0;
  }

  switch (rate) {
    case "Medium":
      return n ** 3;
    case "Fast":
      return Math.floor((4 * n ** 3) / 5);
    case "Slow":
      return Math.floor((5 * n ** 3) / 4);
    case "Parabolic":
      return Math.max(0, Math.floor((6 / 5) * n ** 3) - 15 * n ** 2 + 100 * n - 140);
    case "Erratic":
      if (n <= 50) {
        return Math.floor((n ** 3 * (100 - n)) / 50);
      }
      if (n <= 68) {
        return Math.floor((n ** 3 * (150 - n)) / 100);
      }
      if (n <= 98) {
        return Math.floor((n ** 3 * Math.floor((1911 - 10 * n) / 3)) / 500);
      }
      return Math.floor((n ** 3 * (160 - n)) / 100);
    case "Fluctuating":
      if (n <= 15) {
        return Math.floor((n ** 3 * (Math.floor((n + 1) / 3) + 24)) / 50);
      }
      if (n <= 36) {
        return Math.floor((n ** 3 * (n + 14)) / 50);
      }
      return Math.floor((n ** 3 * (Math.floor(n / 2) + 32)) / 50);
  }
}

/** Experience needed to advance from `level` to `level + 1`. */
export function expToNextLevel(rate: GrowthRateId, level: number): number {
  const n = Math.max(1, Math.min(100, Math.round(level)));
  if (n >= 100) {
    return 0;
  }

  return Math.max(1, totalExpForLevel(rate, n + 1) - totalExpForLevel(rate, n));
}

/**
 * Experience yielded by a defeated foe (Gen III flat formula):
 * floor(baseExp * foeLevel / 7), x1.5 for trainer battles, split among
 * participants.
 */
export function computeFoeExperience(options: {
  baseExp: number;
  foeLevel: number;
  isTrainerBattle: boolean;
  participantCount: number;
}): number {
  const baseExp = Math.max(1, Math.round(options.baseExp));
  const level = Math.max(1, Math.min(100, Math.round(options.foeLevel)));
  const participants = Math.max(1, Math.round(options.participantCount));
  const raw = Math.floor((baseExp * level) / 7 / participants);
  const withTrainerBonus = options.isTrainerBattle ? Math.floor(raw * 1.5) : raw;

  return Math.max(1, withTrainerBonus);
}
