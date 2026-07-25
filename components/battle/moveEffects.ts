import type { BattleStageKey, BattleStatusId } from "./events";

/**
 * Declarative description of what a move does beyond plain damage, parsed
 * from Pokemon Essentials v21 semantic function codes (legacy numeric codes
 * are translated first via functionCodeMap). Parsing is compositional:
 * combined names like "RecoilThirdOfDamageDealtParalyzeTarget" yield both a
 * recoil fraction and a status effect.
 */
/**
 * Conditional power formulas resolved at damage time (BattleManager provides
 * the battle context). Semantics mirror the original Venova/Essentials Ruby
 * classes (PokeBattle_MoveEffects.rb) for each function code.
 */
export type MovePowerModifier =
  | "double-if-target-poisoned"
  | "double-if-target-paralyzed-cure"
  | "double-if-target-asleep-cure"
  | "double-if-user-status"
  | "double-if-target-status"
  | "double-if-target-half-hp"
  | "double-if-user-lost-hp"
  | "double-if-target-lost-hp"
  | "double-if-target-acted"
  | "double-if-target-underwater"
  | "double-if-target-underground"
  | "double-if-target-in-sky"
  | "eruption"
  | "wring-out"
  | "gyro-ball"
  | "electro-ball"
  | "stored-power"
  | "punishment"
  | "fury-cutter"
  | "trump-card"
  | "flail"
  | "magnitude";

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
  fixedDamage:
    | { kind: "amount"; amount: number }
    | { kind: "user-level" }
    | { kind: "half-target-hp" }
    | { kind: "user-hp" }
    | { kind: "endeavor" }
    | { kind: "psywave" }
    | null;
  ohko: boolean;
  resetTargetStats: boolean;
  resetAllStats: boolean;
  protectUser: boolean;
  /** never misses (Aerial Ace family, legacy 0xA5) */
  alwaysHits: boolean;
  /** Bind/Wrap/Fire Spin: 4-5 end-of-turn chip ticks, prevents escape/switch */
  bindTarget: boolean;
  /** Mean Look/Block/Shadow Hold: prevents escape/switch, no chip damage */
  trapTarget: boolean;
  leechSeedTarget: boolean;
  /** Reflect Type (Clonatipo): user copies the target's types */
  copyTargetTypes: boolean;
  /** Conversion: user's types become the type of one of its own moves */
  userTypesToMoveType: boolean;
  /** Soak: target becomes pure Water */
  setTargetTypesToWater: boolean;
  /** Forest's Curse / Trick-or-Treat */
  addTypeToTarget: string | null;
  /** Sucker Punch: fails unless the target is preparing a damaging move */
  failsUnlessTargetPreparingDamagingMove: boolean;
  /** Hyper Beam family: skip the next turn recharging */
  rechargeNextTurn: boolean;
  /** Fly/Dig/Dive/Solar Beam...: charge turn, then attack */
  twoTurn: { invulnerable: "sky" | "underground" | "underwater" | null; skipChargeInSun: boolean } | null;
  /** Earthquake/Surf/Gust...: reaches a semi-invulnerable target */
  hitsInvulnerable: "sky" | "underground" | "underwater" | null;
  powerModifier: MovePowerModifier | null;
  /** Explosion/Self-Destruct: the user faints after attacking */
  userFaints: boolean;
  /** Shadow End: user loses half its current HP after hitting */
  halveUserCurrentHpAfter: boolean;
  /** Shadow Half: every battler loses half its current HP */
  halveAllBattlersHp: boolean;
  /** Jump Kick family: crash damage (half max HP) when the move misses */
  crashDamageOnMiss: boolean;
  /** False Swipe/Hold Back: always leaves the target at 1 HP minimum */
  neverFaintTarget: boolean;
  /** Endure: user survives fatal damage this turn with 1 HP */
  endureUser: boolean;
  /** Counter/Mirror Coat/Metal Burst */
  counter: "physical" | "special" | "any" | null;
  aquaRing: boolean;
  ingrain: boolean;
  /** Nightmare: sleeping target loses 1/4 max HP per turn */
  nightmareTarget: boolean;
  startWeather: "sun" | "rain" | "sandstorm" | "hail" | "shadowsky" | null;
  /** Moonlight/Morning Sun/Synthesis: heal amount depends on weather */
  healUserByWeather: boolean;
  /** Weather Ball: type (and power) change with the weather */
  weatherBall: boolean;
  startScreen: "reflect" | "light-screen" | null;
  /** Brick Break: destroys the target side's screens before dealing damage */
  removeTargetScreens: boolean;
  /** Shadow Shed: destroys every screen on both sides */
  removeAllScreens: boolean;
  /** Belly Drum: halve max HP, maximize Attack */
  bellyDrum: boolean;
  focusEnergy: boolean;
  painSplit: boolean;
  /** Foul Play: damage uses the target's Attack */
  foulPlay: boolean;
  /** Psyshock/Psystrike: physical defense against a special move */
  psyshock: boolean;
  ignoreDefensiveStages: boolean;
  /** Triple Kick: each successive hit adds another x(hit number) power */
  multiHitPowersUp: boolean;
  /** Struggle: recoil = 1/4 of the user's max HP */
  struggleRecoil: boolean;
  /** Splash/Celebrate: the move does nothing on purpose */
  doesNothing: boolean;
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
    protectUser: false,
    alwaysHits: false,
    bindTarget: false,
    trapTarget: false,
    leechSeedTarget: false,
    copyTargetTypes: false,
    userTypesToMoveType: false,
    setTargetTypesToWater: false,
    addTypeToTarget: null,
    failsUnlessTargetPreparingDamagingMove: false,
    rechargeNextTurn: false,
    twoTurn: null,
    hitsInvulnerable: null,
    powerModifier: null,
    userFaints: false,
    halveUserCurrentHpAfter: false,
    halveAllBattlersHp: false,
    crashDamageOnMiss: false,
    neverFaintTarget: false,
    endureUser: false,
    counter: null,
    aquaRing: false,
    ingrain: false,
    nightmareTarget: false,
    startWeather: null,
    healUserByWeather: false,
    weatherBall: false,
    startScreen: null,
    removeTargetScreens: false,
    removeAllScreens: false,
    bellyDrum: false,
    focusEnergy: false,
    painSplit: false,
    foulPlay: false,
    psyshock: false,
    ignoreDefensiveStages: false,
    multiHitPowersUp: false,
    struggleRecoil: false,
    doesNothing: false
  };
}

/**
 * Exact-name effects that the compositional parser below cannot express.
 * Keyed by the v21 semantic function code name (or our custom names for the
 * Venova shadow moves); each patch mirrors the original Ruby class.
 */
const NAMED_EFFECTS: Record<string, Partial<MoveEffectSpec>> = {
  // does nothing on purpose
  DoesNothingUnusableInGravity: { doesNothing: true },
  DoesNothingCongratulations: { doesNothing: true },
  // never misses
  AlwaysHitsTarget: { alwaysHits: true },
  // Struggle
  Struggle: { struggleRecoil: true, alwaysHits: true },
  // binding / trapping
  BindTarget: { bindTarget: true },
  BindTargetDoublePowerIfTargetUnderwater: { bindTarget: true, powerModifier: "double-if-target-underwater", hitsInvulnerable: "underwater" },
  TrapTargetInBattle: { trapTarget: true },
  // leech seed
  StartLeechSeedTarget: { leechSeedTarget: true },
  // type changes
  SetUserTypesToTargetTypes: { copyTargetTypes: true },
  SetUserTypesToUserMoveType: { userTypesToMoveType: true },
  SetTargetTypesToWater: { setTargetTypesToWater: true },
  AddGrassTypeToTarget: { addTypeToTarget: "GRASS" },
  AddGhostTypeToTarget: { addTypeToTarget: "GHOST" },
  // sucker punch
  FailsIfTargetActed: { failsUnlessTargetPreparingDamagingMove: true },
  // recharge / two-turn attacks
  AttackAndSkipNextTurn: { rechargeNextTurn: true },
  TwoTurnAttack: { twoTurn: { invulnerable: null, skipChargeInSun: false } },
  TwoTurnAttackOneTurnInSun: { twoTurn: { invulnerable: null, skipChargeInSun: true } },
  TwoTurnAttackInvulnerableInSky: { twoTurn: { invulnerable: "sky", skipChargeInSun: false } },
  TwoTurnAttackInvulnerableUnderground: { twoTurn: { invulnerable: "underground", skipChargeInSun: false } },
  TwoTurnAttackInvulnerableUnderwater: { twoTurn: { invulnerable: "underwater", skipChargeInSun: false } },
  TwoTurnAttackInvulnerableRemoveProtections: { twoTurn: { invulnerable: null, skipChargeInSun: false } },
  TwoTurnAttackInvulnerableInSkyTargetCannotAct: { twoTurn: { invulnerable: "sky", skipChargeInSun: false } },
  // reaching semi-invulnerable targets
  DoublePowerIfTargetUnderwater: { powerModifier: "double-if-target-underwater", hitsInvulnerable: "underwater" },
  DoublePowerIfTargetUnderground: { powerModifier: "double-if-target-underground", hitsInvulnerable: "underground" },
  DoublePowerIfTargetInSky: { powerModifier: "double-if-target-in-sky", hitsInvulnerable: "sky" },
  HitsTargetInSky: { hitsInvulnerable: "sky" },
  HitsTargetInSkyGroundsTarget: { hitsInvulnerable: "sky" },
  RandomPowerDoublePowerIfTargetUnderground: { powerModifier: "magnitude", hitsInvulnerable: "underground" },
  // conditional power
  DoublePowerIfTargetPoisoned: { powerModifier: "double-if-target-poisoned" },
  DoublePowerIfTargetParalyzedCureTarget: { powerModifier: "double-if-target-paralyzed-cure" },
  DoublePowerIfTargetAsleepCureTarget: { powerModifier: "double-if-target-asleep-cure" },
  DoublePowerIfUserPoisonedBurnedParalyzed: { powerModifier: "double-if-user-status" },
  DoublePowerIfTargetStatusProblem: { powerModifier: "double-if-target-status" },
  DoublePowerIfTargetHPLessThanHalf: { powerModifier: "double-if-target-half-hp" },
  DoublePowerIfUserLostHPThisTurn: { powerModifier: "double-if-user-lost-hp" },
  DoublePowerIfTargetLostHPThisTurn: { powerModifier: "double-if-target-lost-hp" },
  DoublePowerIfTargetActed: { powerModifier: "double-if-target-acted" },
  PowerHigherWithUserHP: { powerModifier: "eruption" },
  PowerHigherWithTargetHP: { powerModifier: "wring-out" },
  PowerHigherWithTargetFasterThanUser: { powerModifier: "gyro-ball" },
  PowerHigherWithUserFasterThanTarget: { powerModifier: "electro-ball" },
  PowerHigherWithUserPositiveStatStages: { powerModifier: "stored-power" },
  PowerHigherWithTargetPositiveStatStages: { powerModifier: "punishment" },
  PowerHigherWithConsecutiveUse: { powerModifier: "fury-cutter" },
  PowerHigherWithConsecutiveUseOnUserSide: { powerModifier: "fury-cutter" },
  PowerHigherWithLessPP: { powerModifier: "trump-card" },
  PowerLowerWithUserHP: { powerModifier: "flail" },
  // fixed damage variants
  LowerTargetHPToUserHP: { fixedDamage: { kind: "endeavor" } },
  FixedDamageUserLevelRandom: { fixedDamage: { kind: "psywave" } },
  UserFaintsFixedDamageUserHP: { fixedDamage: { kind: "user-hp" }, userFaints: true },
  // self-sacrifice / self-damage
  UserFaintsExplosive: { userFaints: true },
  RecoilHalfOfUserCurrentHP: { halveUserCurrentHpAfter: true },
  HalveHPOfAllBattlersAndRecharge: { halveAllBattlersHp: true, rechargeNextTurn: true },
  CrashDamageIfFailsUnusableInGravity: { crashDamageOnMiss: true },
  // survival clamps
  CannotMakeTargetFaint: { neverFaintTarget: true },
  UserEnduresFaintingThisTurn: { endureUser: true },
  // counters
  CounterPhysicalDamage: { counter: "physical" },
  CounterSpecialDamage: { counter: "special" },
  CounterDamagePlusHalf: { counter: "any" },
  // residual healing
  StartHealUserEachTurn: { aquaRing: true },
  StartHealUserEachTurnTrapUserInBattle: { ingrain: true },
  StartDamageTargetEachTurnIfTargetAsleep: { nightmareTarget: true },
  // weather
  StartSunWeather: { startWeather: "sun" },
  StartRainWeather: { startWeather: "rain" },
  StartSandstormWeather: { startWeather: "sandstorm" },
  StartHailWeather: { startWeather: "hail" },
  StartShadowSkyWeather: { startWeather: "shadowsky" },
  HealUserDependingOnWeather: { healUserByWeather: true },
  TypeAndPowerDependOnWeather: { weatherBall: true },
  // screens
  StartWeakenPhysicalDamageAgainstUserSide: { startScreen: "reflect" },
  StartWeakenSpecialDamageAgainstUserSide: { startScreen: "light-screen" },
  RemoveScreens: { removeTargetScreens: true },
  RemoveAllScreens: { removeAllScreens: true },
  // misc
  MaxUserAttackLoseHalfOfTotalHP: { bellyDrum: true },
  RaiseUserCriticalHitRate2: { focusEnergy: true },
  UserTargetAverageHP: { painSplit: true },
  UseTargetAttackInsteadOfUserAttack: { foulPlay: true },
  UseTargetDefenseInsteadOfTargetSpDef: { psyshock: true },
  IgnoreTargetDefSpDefEvaStatStages: { ignoreDefensiveStages: true },
  HitThreeTimesPowersUpWithEachHit: { multiHit: { min: 3, max: 3 }, multiHitPowersUp: true }
};

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

  // Exact-name effects are complete descriptions — never run the token
  // parsers over them (e.g. "DoublePowerIfTargetPoisoned" must NOT match the
  // "Poison" status token and start poisoning targets).
  const namedPatch = NAMED_EFFECTS[name];
  if (namedPatch) {
    Object.assign(spec, namedPatch);
    spec.recognized = true;
    return spec;
  }

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

export type PowerModifierContext = {
  userHp: number;
  userMaxHp: number;
  targetHp: number;
  targetMaxHp: number;
  userStatusId: BattleStatusId | null;
  targetStatusId: BattleStatusId | null;
  userSpeed: number;
  targetSpeed: number;
  userPositiveStages: number;
  targetPositiveStages: number;
  userLostHpThisTurn: boolean;
  targetLostHpThisTurn: boolean;
  targetActedThisTurn: boolean;
  targetInvulnerable: "sky" | "underground" | "underwater" | null;
  /** completed consecutive uses of this same move before this one */
  consecutiveUses: number;
  /** PP remaining after this use (Trump Card) */
  movePpLeft: number;
};

/**
 * Resolves a conditional power formula. Numbers mirror the original
 * Essentials implementations the Venova scripts inherit.
 */
export function computeModifiedPower(
  basePower: number,
  modifier: MovePowerModifier,
  ctx: PowerModifierContext
): { power: number; message: string | null } {
  const double = (condition: boolean) => ({
    power: condition ? basePower * 2 : basePower,
    message: null
  });

  switch (modifier) {
    case "double-if-target-poisoned":
      return double(ctx.targetStatusId === "poison" || ctx.targetStatusId === "toxic");
    case "double-if-target-paralyzed-cure":
      return double(ctx.targetStatusId === "paralysis");
    case "double-if-target-asleep-cure":
      return double(ctx.targetStatusId === "sleep");
    case "double-if-user-status":
      return double(
        ctx.userStatusId === "poison" ||
          ctx.userStatusId === "toxic" ||
          ctx.userStatusId === "burn" ||
          ctx.userStatusId === "paralysis"
      );
    case "double-if-target-status":
      return double(ctx.targetStatusId !== null);
    case "double-if-target-half-hp":
      return double(ctx.targetHp * 2 <= ctx.targetMaxHp);
    case "double-if-user-lost-hp":
      return double(ctx.userLostHpThisTurn);
    case "double-if-target-lost-hp":
      return double(ctx.targetLostHpThisTurn);
    case "double-if-target-acted":
      return double(ctx.targetActedThisTurn);
    case "double-if-target-underwater":
      return double(ctx.targetInvulnerable === "underwater");
    case "double-if-target-underground":
      return double(ctx.targetInvulnerable === "underground");
    case "double-if-target-in-sky":
      return double(ctx.targetInvulnerable === "sky");
    case "eruption":
      return { power: Math.max(1, Math.floor((150 * ctx.userHp) / Math.max(1, ctx.userMaxHp))), message: null };
    case "wring-out":
      return { power: Math.floor((120 * ctx.targetHp) / Math.max(1, ctx.targetMaxHp)) + 1, message: null };
    case "gyro-ball":
      return {
        power: Math.min(150, Math.floor((25 * ctx.targetSpeed) / Math.max(1, ctx.userSpeed)) + 1),
        message: null
      };
    case "electro-ball": {
      const ratio = ctx.userSpeed / Math.max(1, ctx.targetSpeed);
      const power = ratio >= 4 ? 150 : ratio >= 3 ? 120 : ratio >= 2 ? 80 : ratio >= 1 ? 60 : 40;
      return { power, message: null };
    }
    case "stored-power":
      return { power: 20 + 20 * ctx.userPositiveStages, message: null };
    case "punishment":
      return { power: Math.min(200, 60 + 20 * ctx.targetPositiveStages), message: null };
    case "fury-cutter":
      return {
        power: Math.min(160, basePower * Math.pow(2, Math.min(4, ctx.consecutiveUses))),
        message: null
      };
    case "trump-card": {
      const pp = ctx.movePpLeft;
      const power = pp <= 0 ? 200 : pp === 1 ? 80 : pp === 2 ? 60 : pp === 3 ? 50 : 40;
      return { power, message: null };
    }
    case "flail": {
      const ratio = Math.floor((48 * ctx.userHp) / Math.max(1, ctx.userMaxHp));
      const power =
        ratio <= 1 ? 200 : ratio <= 4 ? 150 : ratio <= 9 ? 100 : ratio <= 16 ? 80 : ratio <= 32 ? 40 : 20;
      return { power, message: null };
    }
    case "magnitude": {
      const roll = Math.random() * 100;
      const [magnitude, power] =
        roll < 5 ? [4, 10] :
        roll < 15 ? [5, 30] :
        roll < 35 ? [6, 50] :
        roll < 65 ? [7, 70] :
        roll < 85 ? [8, 90] :
        roll < 95 ? [9, 110] : [10, 150];
      return {
        power: ctx.targetInvulnerable === "underground" ? power * 2 : power,
        message: `Magnitude ${magnitude}!`
      };
    }
    default:
      return { power: basePower, message: null };
  }
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
