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
  | "magnitude"
  | "return"
  | "frustration"
  | "low-kick"
  | "heavy-slam"
  | "double-if-user-no-item"
  | "retaliate"
  | "rollout";

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
  /** Needs mechanics (abilities, doubles) this engine doesn't model: "But it failed!" */
  failsAlways: boolean;
  // --- move restrictions & harassment ---
  /** Disable: seal the target's last used move for 5 turns */
  disableTarget: boolean;
  /** Encore: lock the target into repeating its last move for 4 turns */
  encoreTarget: boolean;
  /** Taunt: target can't use status moves for 4 turns */
  tauntTarget: boolean;
  /** Torment: target can't use the same move twice in a row */
  tormentTarget: boolean;
  /** Heal Block: target can't heal for 5 turns */
  healBlockTarget: boolean;
  /** Imprison: opponents can't use moves the user also knows */
  imprisonUser: boolean;
  /** Embargo: target's held item stops working for 5 turns */
  embargoTarget: boolean;
  /** Spite: cut 4 PP from the target's last used move */
  spiteTarget: boolean;
  /** Attract: infatuate the target (opposite genders only) */
  attractTarget: boolean;
  /** Yawn: the target falls asleep at the end of the next turn */
  yawnTarget: boolean;
  /** Snore: only usable while the user is asleep */
  usableOnlyIfAsleep: boolean;
  /** Fake Out: fails unless this is the user's first turn on the field */
  failsIfNotFirstTurn: boolean;
  /** Dream Eater: fails unless the target is asleep */
  failsUnlessTargetAsleep: boolean;
  /** Synchronoise: fails unless the target shares a type with the user */
  failsUnlessTargetSharesType: boolean;
  /** Focus Punch: fails if the user was damaged earlier this turn */
  focusPunch: boolean;
  /** Last Resort: fails while the user still has an unused other move */
  lastResort: boolean;
  /** Belch: fails unless the user has eaten a berry this battle */
  belch: boolean;
  // --- held items ---
  removeTargetItem: boolean;
  stealTargetItem: boolean;
  swapItems: boolean;
  bestowItem: boolean;
  eatTargetBerry: boolean;
  incinerateBerry: boolean;
  recycleItem: boolean;
  flingItem: boolean;
  /** Natural Gift: consumes the held berry to attack (fails without one) */
  naturalGift: boolean;
  payDay: boolean;
  doubleMoney: boolean;
  // --- entry hazards ---
  hazard: "spikes" | "toxic-spikes" | "stealth-rock" | "sticky-web" | null;
  /** Rapid Spin: frees the user side of binding/seeding/hazards */
  clearUserHazards: boolean;
  /** Defog: also clears the target side's screens and hazards */
  defog: boolean;
  // --- call moves ---
  callMove: "metronome" | "mirror-move" | "copycat" | "sleep-talk" | "assist" | "nature-power" | "me-first" | null;
  // --- delayed & lethal bonds ---
  /** Future Sight/Doom Desire: the hit lands 2 turns later */
  futureSight: boolean;
  /** Wish: heal the user's position at the end of the next turn */
  wishUser: boolean;
  /** Perish Song: every battler faints in 3 turns unless switched out */
  perishSong: boolean;
  /** Destiny Bond: if the user faints before acting again, the attacker faints */
  destinyBond: boolean;
  /** Grudge: the KOing move loses all its PP */
  grudgeUser: boolean;
  /** Bide: endure 2 turns, then return double the damage taken */
  bide: boolean;
  /** Healing Wish: user faints; its replacement is fully healed */
  healingWish: boolean;
  /** Lunar Dance: like Healing Wish, also restores PP */
  lunarDance: boolean;
  // --- transform & substitute & curse ---
  transformUser: boolean;
  substitute: boolean;
  /** Curse: Ghost types pay half HP to curse; others get -Spd +Atk +Def */
  curse: boolean;
  // --- switching ---
  /** Roar/Whirlwind/Dragon Tail: drag a random replacement out */
  forceTargetSwitch: boolean;
  /** U-turn/Volt Switch: user switches out after a successful hit */
  switchOutUser: boolean;
  /** Baton Pass: switch out, passing stat stages and volatiles along */
  batonPass: boolean;
  /** Teleport: escape a wild battle */
  teleportUser: boolean;
  /** Pursuit: intercepts a switching target at double power */
  pursuit: boolean;
  // --- field-wide effects ---
  startFieldEffect:
    | "gravity"
    | "trick-room"
    | "magic-room"
    | "wonder-room"
    | "electric-terrain"
    | "grassy-terrain"
    | "ion-deluge"
    | null;
  startSideEffect: "tailwind" | "safeguard" | "mist" | "lucky-chant" | null;
  /** Mud Sport / Water Sport: weaken Electric/Fire while the user is active */
  sport: "mud" | "water" | null;
  magnetRiseUser: boolean;
  telekinesisTarget: boolean;
  // --- targeting helpers ---
  /** Lock-On/Mind Reader: the user's moves can't miss this and next turn */
  lockOnUser: boolean;
  /** Foresight ("normal") / Miracle Eye ("psychic"): negate immunities+evasion */
  foresight: "normal" | "psychic" | null;
  /** Feint: hits through protection and lifts it */
  feint: boolean;
  /** Electrify: the target's move becomes Electric-type this turn */
  electrifyTarget: boolean;
  /** Powder: the target explodes if it uses a Fire move this turn */
  powderTarget: boolean;
  // --- stats & types ---
  /** Acupressure: sharply raise one random stat */
  acupressure: boolean;
  swapStages: "offense" | "defense" | "all" | null;
  copyTargetStages: boolean;
  /** Power Trick: swap the user's Attack and Defense stats */
  powerTrick: boolean;
  /** Power Split / Guard Split: average the raw stats with the target */
  averageStats: "offense" | "defense" | null;
  /** Topsy-Turvy: invert the target's stat stages */
  topsyTurvy: boolean;
  /** Mimic: copy the target's last move over this one (this battle) */
  mimic: boolean;
  /** Sketch: like Mimic (kept battle-only in this engine) */
  sketch: boolean;
  /** Conversion 2: become a type that resists the target's last move */
  conversion2: boolean;
  /** Camouflage: type change based on the battle environment */
  camouflage: boolean;
  /** Psycho Shift: pass the user's status problem to the target */
  psychoShift: boolean;
  /** Aromatherapy/Heal Bell: cure the whole party's status problems */
  curePartyStatus: boolean;
  /** Heal Pulse: restore half the target's max HP */
  healTargetHalf: boolean;
  /** Flower Shield / Rototiller: boost every active Grass-type */
  grassStatBoost: "defense" | "offense" | null;
  // --- special damage ---
  /** Hidden Power: type and power derived from the user's IVs */
  hiddenPower: boolean;
  /** Present: random 40/80/120 power, or heals the target 1/4 */
  present: boolean;
  /** Beat Up: one hit per healthy party member */
  beatUp: boolean;
  stockpileUser: boolean;
  spitUp: boolean;
  swallow: boolean;
  /** Thrash/Outrage, Rollout, Uproar: locked-in multi-turn attacks */
  rampage: "thrash" | "rollout" | "uproar" | null;
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
    doesNothing: false,
    failsAlways: false,
    disableTarget: false,
    encoreTarget: false,
    tauntTarget: false,
    tormentTarget: false,
    healBlockTarget: false,
    imprisonUser: false,
    embargoTarget: false,
    spiteTarget: false,
    attractTarget: false,
    yawnTarget: false,
    usableOnlyIfAsleep: false,
    failsIfNotFirstTurn: false,
    failsUnlessTargetAsleep: false,
    failsUnlessTargetSharesType: false,
    focusPunch: false,
    lastResort: false,
    belch: false,
    removeTargetItem: false,
    stealTargetItem: false,
    swapItems: false,
    bestowItem: false,
    eatTargetBerry: false,
    incinerateBerry: false,
    recycleItem: false,
    flingItem: false,
    naturalGift: false,
    payDay: false,
    doubleMoney: false,
    hazard: null,
    clearUserHazards: false,
    defog: false,
    callMove: null,
    futureSight: false,
    wishUser: false,
    perishSong: false,
    destinyBond: false,
    grudgeUser: false,
    bide: false,
    healingWish: false,
    lunarDance: false,
    transformUser: false,
    substitute: false,
    curse: false,
    forceTargetSwitch: false,
    switchOutUser: false,
    batonPass: false,
    teleportUser: false,
    pursuit: false,
    startFieldEffect: null,
    startSideEffect: null,
    sport: null,
    magnetRiseUser: false,
    telekinesisTarget: false,
    lockOnUser: false,
    foresight: null,
    feint: false,
    electrifyTarget: false,
    powderTarget: false,
    acupressure: false,
    swapStages: null,
    copyTargetStages: false,
    powerTrick: false,
    averageStats: null,
    topsyTurvy: false,
    mimic: false,
    sketch: false,
    conversion2: false,
    camouflage: false,
    psychoShift: false,
    curePartyStatus: false,
    healTargetHalf: false,
    grassStatBoost: null,
    hiddenPower: false,
    present: false,
    beatUp: false,
    stockpileUser: false,
    spitUp: false,
    swallow: false,
    rampage: null
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
  HitThreeTimesPowersUpWithEachHit: { multiHit: { min: 3, max: 3 }, multiHitPowersUp: true },
  // parser false-positive fixes: these names contain status tokens ("Sleep",
  // "Confuse"...) that must not be treated as inflicted statuses
  SleepTargetNextTurn: { yawnTarget: true },
  FlinchTargetFailsIfUserNotAsleep: { flinchTarget: true, usableOnlyIfAsleep: true },
  FlinchTargetFailsIfNotUserFirstTurn: { flinchTarget: true, failsIfNotFirstTurn: true },
  HealUserByHalfOfDamageDoneIfTargetAsleep: { drainFraction: 0.5, failsUnlessTargetAsleep: true },
  MultiTurnAttackPreventSleeping: { rampage: "uproar" },
  MultiTurnAttackConfuseUserAtEnd: { rampage: "thrash" },
  MultiTurnAttackPowersUpEachTurn: { rampage: "rollout", powerModifier: "rollout" },
  MultiTurnAttackBideThenReturnDoubleDamage: { bide: true },
  // restrictions & harassment
  DisableTargetLastMoveUsed: { disableTarget: true },
  DisableTargetUsingDifferentMove: { encoreTarget: true },
  DisableTargetStatusMoves: { tauntTarget: true },
  DisableTargetUsingSameMoveConsecutively: { tormentTarget: true },
  DisableTargetHealingMoves: { healBlockTarget: true },
  DisableTargetMovesKnownByUser: { imprisonUser: true },
  StartTargetCannotUseItem: { embargoTarget: true },
  LowerPPOfTargetLastMoveBy4: { spiteTarget: true },
  AttractTarget: { attractTarget: true },
  FailsIfUserDamagedThisTurn: { focusPunch: true },
  FailsIfUserHasUnusedMove: { lastResort: true },
  FailsIfUserNotConsumedBerry: { belch: true },
  FailsUnlessTargetSharesTypeWithUser: { failsUnlessTargetSharesType: true },
  // held items
  RemoveTargetItem: { removeTargetItem: true },
  UserTakesTargetItem: { stealTargetItem: true },
  UserTargetSwapItems: { swapItems: true },
  TargetTakesUserItem: { bestowItem: true },
  UserConsumeTargetBerry: { eatTargetBerry: true },
  DestroyTargetBerryOrGem: { incinerateBerry: true },
  RestoreUserConsumedItem: { recycleItem: true },
  ThrowUserItemAtTarget: { flingItem: true },
  TypeAndPowerDependOnUserBerry: { naturalGift: true },
  DoublePowerIfUserHasNoItem: { powerModifier: "double-if-user-no-item" },
  AddMoneyGainedFromBattle: { payDay: true },
  DoubleMoneyGainedFromBattle: { doubleMoney: true },
  // entry hazards
  AddSpikesToFoeSide: { hazard: "spikes" },
  AddToxicSpikesToFoeSide: { hazard: "toxic-spikes" },
  AddStealthRocksToFoeSide: { hazard: "stealth-rock" },
  AddStickyWebToFoeSide: { hazard: "sticky-web" },
  RemoveUserBindingAndEntryHazards: { clearUserHazards: true },
  LowerTargetEvasion1RemoveSideEffects: {
    statChanges: [{ target: "target", stat: "evasion", delta: -1 }],
    defog: true
  },
  // call moves
  UseRandomMove: { callMove: "metronome" },
  UseLastMoveUsedByTarget: { callMove: "mirror-move" },
  UseLastMoveUsed: { callMove: "copycat" },
  UseRandomUserMoveIfAsleep: { callMove: "sleep-talk" },
  UseRandomMoveFromUserParty: { callMove: "assist" },
  UseMoveDependingOnEnvironment: { callMove: "nature-power" },
  UseMoveTargetIsAboutToUse: { callMove: "me-first" },
  // delayed effects & lethal bonds
  AttackTwoTurnsLater: { futureSight: true },
  HealUserPositionNextTurn: { wishUser: true },
  StartPerishCountsForAllBattlers: { perishSong: true },
  AttackerFaintsIfUserFaints: { destinyBond: true },
  SetAttackerMovePPTo0IfUserFaints: { grudgeUser: true },
  UserFaintsHealAndCureReplacement: { healingWish: true },
  UserFaintsHealAndCureReplacementRestorePP: { lunarDance: true },
  // transform, substitute, curse
  TransformUserIntoTarget: { transformUser: true },
  UserMakeSubstitute: { substitute: true },
  CurseTargetOrLowerUserSpd1RaiseUserAtkDef1: { curse: true },
  // switching
  SwitchOutTargetStatusMove: { forceTargetSwitch: true },
  SwitchOutTargetDamagingMove: { forceTargetSwitch: true },
  SwitchOutUserDamagingMove: { switchOutUser: true },
  SwitchOutUserPassOnEffects: { batonPass: true },
  SwitchOutUserStatusMove: { teleportUser: true },
  PursueSwitchingFoe: { pursuit: true },
  // field-wide effects
  StartGravity: { startFieldEffect: "gravity" },
  StartSlowerBattlersActFirst: { startFieldEffect: "trick-room" },
  StartNegateHeldItems: { startFieldEffect: "magic-room" },
  StartSwapAllBattlersBaseDefensiveStats: { startFieldEffect: "wonder-room" },
  StartElectricTerrain: { startFieldEffect: "electric-terrain" },
  StartGrassyTerrain: { startFieldEffect: "grassy-terrain" },
  NormalMovesBecomeElectric: { startFieldEffect: "ion-deluge" },
  StartUserSideDoubleSpeed: { startSideEffect: "tailwind" },
  StartUserSideImmunityToInflictedStatus: { startSideEffect: "safeguard" },
  StartUserSideImmunityToStatStageLowering: { startSideEffect: "mist" },
  StartPreventCriticalHitsAgainstUserSide: { startSideEffect: "lucky-chant" },
  StartWeakenElectricMoves: { sport: "mud" },
  StartWeakenFireMoves: { sport: "water" },
  StartUserAirborne: { magnetRiseUser: true },
  StartTargetAirborneAndAlwaysHitByMoves: { telekinesisTarget: true },
  // targeting helpers
  EnsureNextMoveAlwaysHits: { lockOnUser: true },
  StartNegateTargetEvasionStatStageAndGhostImmunity: { foresight: "normal" },
  StartNegateTargetEvasionStatStageAndDarkImmunity: { foresight: "psychic" },
  RemoveProtections: { feint: true },
  TargetMovesBecomeElectric: { electrifyTarget: true },
  TargetNextFireMoveDamagesTarget: { powderTarget: true },
  // stats & types
  RaiseTargetRandomStat2: { acupressure: true },
  UserTargetSwapAtkSpAtkStages: { swapStages: "offense" },
  UserTargetSwapDefSpDefStages: { swapStages: "defense" },
  UserTargetSwapStatStages: { swapStages: "all" },
  UserCopyTargetStatStages: { copyTargetStages: true },
  UserSwapBaseAtkDef: { powerTrick: true },
  UserTargetAverageBaseAtkSpAtk: { averageStats: "offense" },
  UserTargetAverageBaseDefSpDef: { averageStats: "defense" },
  InvertTargetStatStages: { topsyTurvy: true },
  ReplaceMoveThisBattleWithTargetLastMoveUsed: { mimic: true },
  ReplaceMoveWithTargetLastMoveUsed: { sketch: true },
  SetUserTypesToResistLastAttack: { conversion2: true },
  SetUserTypesBasedOnEnvironment: { camouflage: true },
  GiveUserStatusToTarget: { psychoShift: true },
  CureUserPartyStatus: { curePartyStatus: true },
  HealTargetHalfOfTotalHP: { healTargetHalf: true },
  RaiseGrassBattlersDef1: { grassStatBoost: "defense" },
  RaiseGroundedGrassBattlersAtkSpAtk1: { grassStatBoost: "offense" },
  // special damage
  TypeDependsOnUserIVs: { hiddenPower: true },
  RandomlyDamageOrHealTarget: { present: true },
  HitOncePerUserTeamMember: { beatUp: true },
  UserAddStockpileRaiseDefSpDef1: { stockpileUser: true },
  PowerDependsOnUserStockpile: { spitUp: true },
  HealUserDependingOnUserStockpile: { swallow: true },
  PowerHigherWithUserHappiness: { powerModifier: "return" },
  PowerLowerWithUserHappiness: { powerModifier: "frustration" },
  PowerHigherWithTargetWeight: { powerModifier: "low-kick" },
  PowerHigherWithUserHeavierThanTarget: { powerModifier: "heavy-slam" },
  DoublePowerIfAllyFaintedLastTurn: { powerModifier: "retaliate" },
  // Secret Power: the default (building/plain) secondary is paralysis
  EffectDependsOnEnvironment: { status: { target: "target", id: "paralysis" } },
  // plain damage in a 1v1 engine (combo/ally mechanics can't trigger)
  DoublePowerAfterFusionFlare: {},
  DoublePowerAfterFusionBolt: {},
  UsedAfterAllyRoundWithDoublePower: {},
  DamageTargetAlly: {},
  FirePledge: {},
  TypeDependsOnUserPlate: {},
  // needs abilities or multiple allies, neither of which exists here
  SetTargetAbilityToSimple: { failsAlways: true },
  SetTargetAbilityToInsomnia: { failsAlways: true },
  SetUserAbilityToTargetAbility: { failsAlways: true },
  SetTargetAbilityToUserAbility: { failsAlways: true },
  UserTargetSwapAbilities: { failsAlways: true },
  NegateTargetAbility: { failsAlways: true },
  BounceBackProblemCausingStatusMoves: { failsAlways: true },
  StealAndUseBeneficialStatusMove: { failsAlways: true },
  RaisePlusMinusUserAndAlliesDefSpDef1: { failsAlways: true },
  PowerUpAllyMove: { failsAlways: true },
  RedirectAllMovesToUser: { failsAlways: true },
  UserSwapsPositionsWithAlly: { failsAlways: true },
  TargetActsNext: { failsAlways: true },
  TargetActsLast: { failsAlways: true }
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
  /** base happiness (Return/Frustration); Essentials default is 70 */
  userHappiness: number;
  userWeightKg: number;
  targetWeightKg: number;
  userHasItem: boolean;
  /** a party member of the user's side fainted last turn (Retaliate) */
  allyFaintedLastTurn: boolean;
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
    case "return":
      return { power: Math.max(1, Math.floor(ctx.userHappiness / 2.5)), message: null };
    case "frustration":
      return { power: Math.max(1, Math.floor((255 - ctx.userHappiness) / 2.5)), message: null };
    case "low-kick": {
      const kg = ctx.targetWeightKg;
      const power = kg <= 10 ? 20 : kg <= 25 ? 40 : kg <= 50 ? 60 : kg <= 100 ? 80 : kg <= 200 ? 100 : 120;
      return { power, message: null };
    }
    case "heavy-slam": {
      const ratio = ctx.userWeightKg / Math.max(0.1, ctx.targetWeightKg);
      const power = ratio >= 5 ? 120 : ratio >= 4 ? 100 : ratio >= 3 ? 80 : ratio >= 2 ? 60 : 40;
      return { power, message: null };
    }
    case "double-if-user-no-item":
      return double(!ctx.userHasItem);
    case "retaliate":
      return double(ctx.allyFaintedLastTurn);
    case "rollout":
      // Rollout/Ice Ball: doubles with each successive successful use.
      return { power: basePower * Math.pow(2, Math.min(4, ctx.consecutiveUses)), message: null };
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

/**
 * Hidden Power type and power from IVs, using the classic Gen III formulas
 * (bit 0 of each IV selects the type; bit 1 scales power between 30 and 70).
 * IV order: HP, Attack, Defense, Speed, Sp. Atk, Sp. Def.
 */
const HIDDEN_POWER_TYPES = [
  "FIGHTING", "FLYING", "POISON", "GROUND", "ROCK", "BUG", "GHOST", "STEEL",
  "FIRE", "WATER", "GRASS", "ELECTRIC", "PSYCHIC", "ICE", "DRAGON", "DARK"
];

export function computeHiddenPower(ivs: {
  hp: number;
  attack: number;
  defense: number;
  specialAttack: number;
  specialDefense: number;
  speed: number;
}): { type: string; power: number } {
  const order = [ivs.hp, ivs.attack, ivs.defense, ivs.speed, ivs.specialAttack, ivs.specialDefense];
  const typeSum = order.reduce((sum, iv, index) => sum + (iv & 1) * Math.pow(2, index), 0);
  const powerSum = order.reduce((sum, iv, index) => sum + ((iv >> 1) & 1) * Math.pow(2, index), 0);
  return {
    type: HIDDEN_POWER_TYPES[Math.floor((typeSum * 15) / 63)],
    power: 30 + Math.floor((powerSum * 40) / 63)
  };
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
