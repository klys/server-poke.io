import type { BattleStageKey, BattleStatusId } from "./events";

/**
 * Declarative description of what a move does beyond plain damage, parsed
 * from Pokemon Essentials v21 semantic function codes (legacy numeric codes
 * are translated first via functionCodeMap). Parsing is compositional:
 * combined names like "RecoilThirdOfDamageDealtParalyzeTarget" yield both a
 * recoil fraction and a status effect.
 */
export type MoveEffectSpec = {
  recognized: boolean;
  statChanges: Array<{ target: "user" | "target"; stat: BattleStageKey; delta: number }>;
  status: { target: "user" | "target"; id: BattleStatusId; random?: BattleStatusId[] } | null;
  confuseTarget: boolean;
  flinchTarget: boolean;
  healUserFraction: number;
  sleepUserAfterFullHeal: boolean;
  drainFraction: number;
  recoilFraction: number;
  multiHit: { min: number; max: number } | null;
  alwaysCrit: boolean;
  fixedDamage: { kind: "amount"; amount: number } | { kind: "user-level" } | { kind: "half-target-hp" } | null;
  ohko: boolean;
  resetTargetStats: boolean;
  resetAllStats: boolean;
  protectUser: boolean;
};

const STAT_TOKEN_PATTERN =
  "MainStats|AllStats|SpAtk|SpDef|Attack|Defense|Accuracy|Evasion|Speed|Atk|Def|Acc|Eva|Spd";

const STAT_TOKEN_MAP: Record<string, BattleStageKey[]> = {
  Atk: ["attack"],
  Attack: ["attack"],
  Def: ["defense"],
  Defense: ["defense"],
  SpAtk: ["specialAttack"],
  SpDef: ["specialDefense"],
  Spd: ["speed"],
  Speed: ["speed"],
  Acc: ["accuracy"],
  Accuracy: ["accuracy"],
  Eva: ["evasion"],
  Evasion: ["evasion"],
  MainStats: ["attack", "defense", "specialAttack", "specialDefense", "speed"],
  AllStats: ["attack", "defense", "specialAttack", "specialDefense", "speed", "accuracy", "evasion"]
};

function emptySpec(recognized: boolean): MoveEffectSpec {
  return {
    recognized,
    statChanges: [],
    status: null,
    confuseTarget: false,
    flinchTarget: false,
    healUserFraction: 0,
    sleepUserAfterFullHeal: false,
    drainFraction: 0,
    recoilFraction: 0,
    multiHit: null,
    alwaysCrit: false,
    fixedDamage: null,
    ohko: false,
    resetTargetStats: false,
    resetAllStats: false,
    protectUser: false
  };
}

function parseStatChangeSegments(name: string, spec: MoveEffectSpec) {
  const segmentPattern = new RegExp(
    `(Raise|Lower)(User|Target)((?:${STAT_TOKEN_PATTERN})+)([1-3])`,
    "g"
  );
  const tokenPattern = new RegExp(`(?:${STAT_TOKEN_PATTERN})`, "g");
  let matched = false;

  for (const match of name.matchAll(segmentPattern)) {
    matched = true;
    const direction = match[1] === "Raise" ? 1 : -1;
    const target = match[2] === "User" ? "user" : "target";
    const magnitude = Number.parseInt(match[4], 10);

    for (const tokenMatch of match[3].matchAll(tokenPattern)) {
      const stats = STAT_TOKEN_MAP[tokenMatch[0]] ?? [];
      stats.forEach((stat) => {
        spec.statChanges.push({ target, stat, delta: direction * magnitude });
      });
    }
  }

  return matched;
}

function parseStatusSegment(name: string, spec: MoveEffectSpec) {
  // Tri Attack style random status.
  if (name.includes("ParalyzeBurnOrFreezeTarget")) {
    spec.status = { target: "target", id: "paralysis", random: ["paralysis", "burn", "freeze"] };
    return true;
  }

  const statusTokens: Array<[string, BattleStatusId]> = [
    ["BadPoison", "toxic"],
    ["Poison", "poison"],
    ["Paralyze", "paralysis"],
    ["Burn", "burn"],
    ["Freeze", "freeze"],
    ["Sleep", "sleep"]
  ];

  for (const [token, statusId] of statusTokens) {
    const index = name.indexOf(token);
    if (index < 0) {
      continue;
    }
    // Avoid matching e.g. "Poison" inside "BadPoison" twice.
    if (token === "Poison" && name.includes("BadPoison")) {
      continue;
    }

    const rest = name.slice(index + token.length);
    const target = rest.startsWith("User") ? "user" : "target";
    spec.status = { target, id: statusId };
    return true;
  }

  return false;
}

/** Parse a v21 semantic function code name into an effect spec. */
export function parseMoveEffect(functionCode: string): MoveEffectSpec {
  const name = functionCode.trim();
  if (!name || name === "None") {
    return emptySpec(true);
  }

  const spec = emptySpec(false);
  let matchedAnything = false;

  if (parseStatChangeSegments(name, spec)) {
    matchedAnything = true;
  }

  if (name === "HealUserFullyAndFallAsleep") {
    spec.healUserFraction = 1;
    spec.sleepUserAfterFullHeal = true;
    matchedAnything = true;
  } else if (parseStatusSegment(name, spec)) {
    matchedAnything = true;
  }

  if (name.includes("Confuse")) {
    spec.confuseTarget = !name.includes("ConfuseUser");
    matchedAnything = true;
  }

  if (name.includes("Flinch") && name.includes("Target")) {
    spec.flinchTarget = true;
    matchedAnything = true;
  }

  if (/^HealUser(Half|DependingOn)/.test(name)) {
    spec.healUserFraction = 0.5;
    matchedAnything = true;
  }

  if (name.startsWith("HealUserBy") && name.includes("OfDamageDone")) {
    spec.drainFraction = name.includes("ThreeQuarters") ? 0.75 : 0.5;
    matchedAnything = true;
  }

  const recoilMatch = name.match(/Recoil(Quarter|Third|Half)OfDamageDealt/);
  if (recoilMatch) {
    spec.recoilFraction =
      recoilMatch[1] === "Quarter" ? 0.25 : recoilMatch[1] === "Third" ? 1 / 3 : 0.5;
    matchedAnything = true;
  }

  if (name.includes("HitTwoToFiveTimes")) {
    spec.multiHit = { min: 2, max: 5 };
    matchedAnything = true;
  } else if (name.includes("HitTwoTimes")) {
    spec.multiHit = { min: 2, max: 2 };
    matchedAnything = true;
  } else if (name.includes("HitThreeTimes")) {
    spec.multiHit = { min: 3, max: 3 };
    matchedAnything = true;
  }

  if (name.includes("AlwaysCriticalHit")) {
    spec.alwaysCrit = true;
    matchedAnything = true;
  }

  const fixedAmountMatch = name.match(/^FixedDamage(\d+)$/);
  if (fixedAmountMatch) {
    spec.fixedDamage = { kind: "amount", amount: Number.parseInt(fixedAmountMatch[1], 10) };
    matchedAnything = true;
  } else if (name === "FixedDamageUserLevel") {
    spec.fixedDamage = { kind: "user-level" };
    matchedAnything = true;
  } else if (name === "FixedDamageHalfTargetHP") {
    spec.fixedDamage = { kind: "half-target-hp" };
    matchedAnything = true;
  }

  if (name.startsWith("OHKO")) {
    spec.ohko = true;
    matchedAnything = true;
  }

  if (name === "ResetTargetStatStages") {
    spec.resetTargetStats = true;
    matchedAnything = true;
  }

  if (name === "ResetAllBattlersStatStages") {
    spec.resetAllStats = true;
    matchedAnything = true;
  }

  if (name.includes("ProtectUser")) {
    spec.protectUser = true;
    matchedAnything = true;
  }

  spec.recognized = matchedAnything;
  return spec;
}

export function rollMultiHitCount(multiHit: { min: number; max: number }): number {
  if (multiHit.min === multiHit.max) {
    return multiHit.min;
  }

  // Classic 2-5 hit distribution: 2 and 3 hits are three times as likely.
  const roll = Math.random();
  if (roll < 0.375) {
    return 2;
  }
  if (roll < 0.75) {
    return 3;
  }
  if (roll < 0.875) {
    return 4;
  }
  return 5;
}

export const STAGE_DISPLAY_NAMES: Record<BattleStageKey, string> = {
  attack: "Attack",
  defense: "Defense",
  specialAttack: "Sp. Atk",
  specialDefense: "Sp. Def",
  speed: "Speed",
  accuracy: "accuracy",
  evasion: "evasiveness"
};
