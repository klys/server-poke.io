import crypto from "crypto";
import { templateMapIdFor } from "./Housing";
import type { Server } from "socket.io";
import type { AuthenticatedUser, InventoryItem, PokemonSummary } from "./Auth";
import Auth from "./Auth";
import type DesignerSectionStore from "./DesignerSectionStore";
import type { DesignerSectionItem } from "./DesignerSectionStore";
import type { GroundItem } from "./GroundItemStore";
import LEGACY_ITEM_INTERNAL_BY_NUMBER from "./legacyItemNumbers";
import {
  computeBattleExperience,
  createEmptyPokemonStatBonuses,
  getExperienceForNextLevel,
  getLevelingCurveConfigFromItems,
  sanitizePokemonStatBonuses,
  type LevelingCurveConfig,
  type PokemonStatBonuses
} from "./LevelingCurve";
import type {
  BattlePublicEvent,
  BattleSequencedEvent,
  BattleStageKey,
  BattleStatGain,
  BattleStatKey,
  BattleStatusId
} from "./battle/events";
import { resolveFunctionCode } from "./battle/functionCodeMap";
import {
  classifyFieldItem,
  fieldItemTargetKind,
  maxPpForMove,
  FISHING_ROD_TIERS,
  MAX_STANDARD_EV_PER_STAT,
  MAX_TOTAL_EV,
  STATUS_CURE_ITEMS,
  VITAMIN_EV_CAP,
  type FieldItemEffect,
  type FieldItemKeyAction,
  type FieldItemTargetKind,
  type FishingRodTier
} from "./battle/fieldItemEffects";
import { canSpeciesLearnMachineMove } from "./TmCompatibility";
import {
  applyAppearanceToBaseStats,
  applyAppearanceToSpritePath,
  applyAppearanceToTypes,
  classifyEquipmentSlot,
  resolveAppearanceEffect,
  resolveHeldBonus,
  resolveHeldItemEffect,
  toSpeciesInternalId,
  type AppearanceEffect,
  type EquipmentSlot,
  type HeldBonusEffect,
  type HeldItemEffect
} from "./battle/heldItems";
import {
  computeHiddenPower,
  computeModifiedPower,
  parseMoveEffect,
  rollMultiHitCount,
  STAGE_DISPLAY_NAMES,
  type MoveEffectSpec
} from "./battle/moveEffects";
import {
  applyStatusEndOfTurn,
  checkStatusBeforeMove,
  createStatusState,
  getStatusCatchBonus,
  getStatusStatMultiplier,
  isImmuneToStatus,
  sanitizeStatusState,
  STATUS_DISPLAY_NAMES,
  type StatusState
} from "./battle/statuses";
import {
  computeFoeExperience,
  expToNextLevel,
  normalizeGrowthRate,
  type GrowthRateId
} from "./battle/growth";
import {
  buildTypeChart,
  getTypeEffectiveness,
  isSameType,
  resolveTypeId,
  type TypeChart
} from "./battle/typeChart";
import type Player from "./player";
import type World from "./world";
import { resolveInitialSpawnFromPlayableMapsState } from "./PlayableMapsState";
import { resolveDivePair } from "./diveMaps";
import { GRASS_TERRAIN_TAG, isDeepWaterTag, isSurfableWaterTag } from "./terrainTags";
import type ClientToServerEvents from "../Server/ClientToServerEvents";
import type InterServerEvents from "../Server/InterServerEvents";
import type { SocketData } from "../Server/registerSocketHandlers";
import type ServerToClientEvents from "../Server/ServerToClientEvents";

const PLAYER_ACTION_TIMEOUT_MS = 60_000;
const BATTLE_ACTION_STEP_DELAY_MS = 2_500;
const PVP_SURRENDER_REWARD = 300;
const NEUTRAL_NATURE = 1;
const MAX_PARTY_SIZE = 6;
const MAX_EV_PER_STAT = 255;

type TypedSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type BattleKind = "wild" | "trainer";
type BattleStatus = "active" | "ended";
type BattleSideId = "a" | "b";
type BattleActionType = "fight" | "bag" | "pokemon" | "run" | "surrender" | "pass";
type BattleDamageClass = "physical" | "special" | "status";

export type BattleClientAction =
  | { type: "fight"; moveId: string }
  | { type: "bag"; itemId: string; targetPokemonId?: string }
  | { type: "pokemon"; pokemonId: string }
  | { type: "run" }
  | { type: "surrender" };

export type BattleActionRequest = {
  battleId: string;
  action: BattleClientAction;
};

/** Terrain context a battle starts in, used to pick the backdrop variant. */
type BattleBackContext = "grass" | "water" | "underwater" | "cave";

export type BattleChallengePayload = {
  targetPlayerId: string;
};

export type BattleChallengeResponsePayload = {
  challengeId: string;
  accepted: boolean;
};

export type BattleTradeRequestPayload = {
  targetPlayerId: string;
};

export type BattleTradeResponsePayload = {
  requestId: string;
  accepted: boolean;
};

export type BattlePublicMove = {
  id: string;
  name: string;
  type: string;
  power: number;
  accuracy: number;
  category?: string;
  target?: string;
  functionCode?: string;
  flags?: string[];
  priority?: number;
  description?: string;
  effectText?: string;
  skillGfxId?: string;
  skillGfxName?: string;
  animationId?: string;
  animationName?: string;
  currentPp: number;
  maxPp: number;
};

export type BattlePublicPokemon = {
  id: string;
  name: string;
  nickname?: string;
  level: number;
  types: string[];
  hp: number;
  maxHp: number;
  experience: number;
  nextLevelExperience: number;
  status: BattleStatusId | null;
  confused: boolean;
  statStages: Record<BattleStageKey, number>;
  heldItemName: string | null;
  frontImageSrc: string;
  backImageSrc: string;
  moves: BattlePublicMove[];
};

export type BattlePublicItem = {
  id: string;
  name: string;
  category: InventoryItem["category"];
  quantity: number;
  description: string;
  canUse: boolean;
};

export type BattlePublicSide = {
  id: BattleSideId;
  trainerName: string;
  isPlayer: boolean;
  money: number;
  activePokemon: BattlePublicPokemon;
  party: BattlePublicPokemon[];
};

export type BattlePublicSummary = {
  battleId: string;
  kind: BattleKind;
  winnerName: string | null;
  loserName: string | null;
  result: string;
  startedAt: string;
  endedAt: string | null;
  log: string[];
};

export type BattlePublicState = {
  id: string;
  kind: BattleKind;
  status: BattleStatus;
  turn: number;
  self: BattlePublicSide;
  opponent: BattlePublicSide;
  availableItems: BattlePublicItem[];
  canAct: boolean;
  waitingForOpponent: boolean;
  /** True when this side's active mon fainted and the player must pick the replacement. */
  mustSelectReplacement: boolean;
  selectedActionType: BattleActionType | null;
  turnEndsAt: string | null;
  log: string[];
  result: string | null;
  summary: BattlePublicSummary | null;
  /** Essentials battleback name resolved from the map the battle started on. */
  battleBack: string | null;
};

type BattleStats = {
  hp: number;
  attack: number;
  defense: number;
  specialAttack: number;
  specialDefense: number;
  speed: number;
};

type BattleStatStages = Record<BattleStageKey, number>;

type BattleMove = BattlePublicMove & {
  damageClass: BattleDamageClass;
  effectChance: number;
};

type BattleSemiInvulnerableState = "sky" | "underground" | "underwater";

type BattleVolatileState = {
  confusionTurns: number;
  flinched: boolean;
  protected: boolean;
  /** Bind/Wrap/Fire Spin: chip damage each end of turn until freed. */
  binding: { turnsLeft: number; moveName: string; byPokemonId: string } | null;
  /** Mean Look/Block/Shadow Hold: can't flee or switch while trapper is active. */
  trappedByPokemonId: string | null;
  /** Leech Seed: seeded battler feeds the opposing active mon each turn. */
  seededBySideId: BattleSideId | null;
  /** Hyper Beam family: this turn is spent recharging. */
  recharging: boolean;
  /** Two-turn moves: set on the charge turn, released on the next. */
  charging: { moveId: string; invulnerable: BattleSemiInvulnerableState | null } | null;
  aquaRing: boolean;
  ingrain: boolean;
  nightmare: boolean;
  /** Endure: survive fatal hits with 1 HP this turn. */
  endure: boolean;
  focusEnergy: boolean;
  /** Damage received this turn, for Counter/Mirror Coat/Metal Burst and Revenge. */
  damageTakenThisTurn: { physical: number; special: number; any: number };
  /** Consecutive-use tracking (Fury Cutter). */
  lastMoveId: string | null;
  consecutiveMoveUses: number;
  /** Disable: this move is sealed while turns remain. */
  disable: { moveId: string; moveName: string; turns: number } | null;
  /** Encore: locked into repeating this move. */
  encore: { moveId: string; turns: number } | null;
  tauntTurns: number;
  /** Choice item lock: the first move used while holding one seals the rest. */
  choiceLockMoveId: string | null;
  torment: boolean;
  healBlockTurns: number;
  embargoTurns: number;
  /** Imprison is set on the USER; opponents can't use its move names. */
  imprison: boolean;
  attractedToPokemonId: string | null;
  /** Perish Song: 0 = off, otherwise counts down each end of turn; faint at 0. */
  perishCount: number;
  destinyBond: boolean;
  grudge: boolean;
  bide: { moveId: string; turnsLeft: number; storedDamage: number } | null;
  stockpile: number;
  substituteHp: number;
  /** Transform: what to restore when the battler leaves the field. */
  transformBackup: {
    types: string[];
    stats: BattleStats;
    moves: BattleMove[];
    frontImageSrc: string;
    backImageSrc: string;
  } | null;
  lockOnTurns: number;
  foresight: boolean;
  miracleEye: boolean;
  magnetRiseTurns: number;
  telekinesisTurns: number;
  electrified: boolean;
  powdered: boolean;
  /** Yawn: falls asleep when this reaches 0. */
  yawnTurns: number;
  /** Ghost-type Curse. */
  cursed: boolean;
  rampage: { moveId: string; turnsLeft: number; kind: "thrash" | "rollout" | "uproar" } | null;
  /** Move ids used since entering the field (Last Resort). */
  usedMoveIds: string[];
  turnsOnField: number;
  mudSport: boolean;
  waterSport: boolean;
};

type BattleGender = "male" | "female" | "genderless";

type BattlePokemon = {
  id: string;
  sourcePokemonId?: string;
  name: string;
  nickname?: string;
  level: number;
  types: string[];
  /** Species data used by Attract / Return / weight-based moves. */
  gender: BattleGender;
  baseHappiness: number;
  weightKg: number;
  /** Held item consumed this battle (Recycle) and berry-eaten flag (Belch). */
  consumedItem: { id: string; name: string; slot: "bonus" | "battle" } | null;
  ateBerry: boolean;
  hp: number;
  maxHp: number;
  experience: number;
  nextLevelExperience: number;
  growthRate: GrowthRateId | null;
  baseExp: number;
  catchRate: number;
  evYield: Partial<Record<BattleStatKey, number>>;
  baseStats: BattleStats;
  stats: BattleStats;
  statBonuses: PokemonStatBonuses;
  ivs: BattleStats;
  evs: BattleStats;
  stages: BattleStatStages;
  status: StatusState | null;
  volatile: BattleVolatileState;
  /** Bonus slot (passive equip bonuses; the historical single held slot). */
  heldItemId: string | null;
  heldItemName: string | null;
  /** Battle-use slot: consumable trigger items (berries, Focus Sash). */
  battleItemId: string | null;
  battleItemName: string | null;
  /** Appearance slot: unlosable in battle, already baked into the sprites. */
  appearanceItemId: string | null;
  appearanceItemName: string | null;
  learnset: Array<{ skillId: string; skillName: string; level: number }>;
  evolutions: PokemonEvolutionDefinition[];
  moves: BattleMove[];
  frontImageSrc: string;
  backImageSrc: string;
  originalSummary?: PokemonSummary;
};

type BattleSide = {
  id: BattleSideId;
  isAi: boolean;
  playerId?: string;
  userId?: number;
  trainerName: string;
  money: number;
  inventory: InventoryItem[];
  party: BattlePokemon[];
  /** Eggs held out of battle (can't fight); re-merged into the saved party. */
  heldEggs?: Array<{ index: number; summary: PokemonSummary }>;
  activeIndex: number;
  action: BattleQueuedAction | null;
  escapeAttempts: number;
  /** Reflect / Light Screen turns remaining (0 = down). */
  screens?: { reflect: number; lightScreen: number };
  /** Whether this side's fight action already executed this turn (Sucker Punch, Payback). */
  hasActedThisTurn?: boolean;
  /** Entry hazards laid on THIS side's field (hurt this side's switch-ins). */
  hazards?: { spikes: number; toxicSpikes: number; stealthRock: boolean; stickyWeb: boolean };
  /** Whole-side lingering effects, in turns remaining. */
  sideEffects?: { tailwind: number; safeguard: number; mist: number; luckyChant: number };
  /** Wish: heals whoever occupies the slot when the countdown ends. */
  wish?: { turns: number; amount: number; wisherName: string } | null;
  /** Future Sight aimed at this side's active slot. */
  futureSight?: { turns: number; damage: number; moveName: string } | null;
  /** Healing Wish/Lunar Dance blessing waiting for the next switch-in. */
  pendingSwitchHeal?: "heal" | "lunar" | null;
  /** A mon on this side fainted last turn (Retaliate). */
  allyFaintedLastTurn?: boolean;
  faintedThisTurn?: boolean;
};

type BattleQueuedAction =
  | { type: "fight"; moveId: string }
  | { type: "bag"; itemId: string; targetPokemonId?: string }
  | { type: "pokemon"; pokemonId: string }
  | { type: "run" }
  | { type: "surrender" }
  | { type: "pass" };

type BattleSession = {
  id: string;
  kind: BattleKind;
  status: BattleStatus;
  sides: [BattleSide, BattleSide];
  turn: number;
  turnEndsAt: number | null;
  timer: NodeJS.Timeout | null;
  log: string[];
  events: BattleSequencedEvent[];
  eventSeq: number;
  lastFlushedSeq: number;
  /** foe pokemon id -> ids of opposing pokemon that fought it (for exp split) */
  participation: Map<string, Set<string>>;
  /** pokemon ids that gained at least one level during this battle */
  leveledPokemonIds: Set<string>;
  result: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: BattlePublicSummary | null;
  /** Essentials battleback name for the map the battle started on. */
  battleBack: string | null;
  /** Active weather (Sunny Day/Rain Dance/Sandstorm/Hail/Shadow Sky). */
  weather: { kind: "sun" | "rain" | "sandstorm" | "hail" | "shadowsky"; turns: number } | null;
  /** Field-wide effects, in turns remaining (0 = inactive). */
  trickRoomTurns: number;
  gravityTurns: number;
  magicRoomTurns: number;
  wonderRoomTurns: number;
  terrain: { kind: "electric" | "grassy"; turns: number } | null;
  /** Ion Deluge: Normal moves become Electric for the rest of this turn. */
  ionDeluge: boolean;
  /** Last move used by anyone this battle (Copycat). */
  lastMoveUsed: { skillId: string; skillName: string } | null;
  /** Pay Day pot and Happy Hour multiplier, paid to a winning player. */
  extraMoney: number;
  moneyMultiplier: number;
  /** Set while a player must choose which mon replaces their fainted active one. */
  replacementRequest: {
    sideId: BattleSideId;
    resolve: (pokemonId: string | null) => void;
    timer: NodeJS.Timeout;
  } | null;
};

type PokemonEvolutionDefinition = {
  targetId: string;
  method: string;
  parameter: string | number | null;
};

type PokemonDefinition = {
  id: string;
  name: string;
  essentialsId: string;
  types: string[];
  baseStats: BattleStats;
  growthRate: GrowthRateId | null;
  baseExp: number;
  catchRate: number;
  evYield: Partial<Record<BattleStatKey, number>>;
  evolutions: PokemonEvolutionDefinition[];
  skills: Array<{ skillId: string; skillName: string; level: number }>;
  frontImageSrc: string;
  backImageSrc: string;
  /** Fraction of the species that is female; -1 = genderless. */
  femaleRatio: number;
  baseHappiness: number;
  weightKg: number;
};

type SkillDefinition = {
  id: string;
  name: string;
  essentialsId: string;
  type: string;
  power: number;
  powerPoint: number;
  accuracy: number;
  category: string;
  target: string;
  functionCode: string;
  flags: string[];
  priority: number;
  effectChance: number;
  description: string;
  effectText: string;
  skillGfxId: string;
  skillGfxName: string;
  animationId: string;
  animationName: string;
};

type ItemDefinition = {
  id: string;
  name: string;
  essentialsId: string;
  /** Catalog buy price (designer itemProfile.price); 0 = not purchasable. */
  price: number;
  type: string;
  category: InventoryItem["category"];
  description: string;
  iconSrc: string;
  /** Furniture: id of the designer map object drawn when placed ("" = icon). */
  furnitureObjectId: string;
  skillId: string;
  skillName: string;
  /** For MO/MT machines: the Essentials move internal (e.g. "CUT"), used as the
   * tm.txt compatibility key. "" for non-machine items. */
  moveInternal: string;
  /** "mo" = reusable HM (never consumed), "mt" = single-use TM (consumed once),
   * null = not a move machine. Derived from essentialsId (HM##/TM##). */
  machineKind: "mo" | "mt" | null;
  effectKind: string;
  useCondition: string;
  isPokeball: boolean;
  pokeballBonusRatio: number;
  curesStatuses: BattleStatusId[] | "any" | null;
  curesConfusion: boolean;
  heldEffect: HeldItemEffect | null;
  heldBonus: HeldBonusEffect | null;
  statModifiers: {
    hp: number;
    attack: number;
    defense: number;
    specialAttack: number;
    specialDefense: number;
    speed: number;
  };
};

/**
 * The original game never defines a RUNNINGSHOES item — running is a bare
 * `$PokemonGlobal.runningShoes` flag flipped by Mamá's gift event. The engine
 * models that flag as a quest item (visible in the bag, gates the run key),
 * so the definition is synthesized here instead of living in the catalog.
 */
const RUNNING_SHOES_DEFINITION: ItemDefinition = {
  id: "item-runningshoes",
  name: "Zapatos Nike",
  essentialsId: "RUNNINGSHOES",
  price: 0,
  type: "quest",
  category: "quest",
  description:
    "Los zapatos deportivos que te regaló mamá. Mantén pulsada la tecla de correr para ir más rápido.",
  iconSrc: "",
  furnitureObjectId: "",
  skillId: "",
  skillName: "",
  moveInternal: "",
  machineKind: null,
  effectKind: "",
  useCondition: "",
  isPokeball: false,
  pokeballBonusRatio: 0,
  curesStatuses: null,
  curesConfusion: false,
  heldEffect: null,
  heldBonus: null,
  statModifiers: {
    hp: 0,
    attack: 0,
    defense: 0,
    specialAttack: 0,
    specialDefense: 0,
    speed: 0
  }
};

type NpcStoreDefinition = {
  itemId: string;
  itemName: string;
  quantity: number;
  price: number;
};

type NpcTrainerPokemonDefinition = {
  pokemonId: string;
  pokemonName: string;
  level: number;
  moves: string[];
  itemId: string;
};

type NpcDefinition = {
  id: string;
  name: string;
  npcType: "healer" | "trainer" | "store" | "chest";
  healPrice: number;
  storeItems: NpcStoreDefinition[];
  trainerTypeId: string;
  trainerTypeName: string;
  loseText: string;
  trainerPokemons: NpcTrainerPokemonDefinition[];
};

type ResolvedNpcInteraction = {
  player: Player;
  placement: {
    id: string;
    npcId: string;
    name: string;
    interactionDistanceSquares: number;
    x: number;
    y: number;
  };
};

type ChallengeRequest = {
  id: string;
  challengerPlayerId: string;
  targetPlayerId: string;
  timeout: NodeJS.Timeout;
};

type TradeRequest = {
  id: string;
  requesterPlayerId: string;
  targetPlayerId: string;
  timeout: NodeJS.Timeout;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function normalizeType(value: string) {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    electricity: "Electric",
    electric: "Electric",
    fight: "Fighting",
    fighting: "Fighting"
  };

  if (aliases[normalized]) {
    return aliases[normalized];
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** Field-skill key -> Essentials move internal, for resolving its display name
 * and tm.txt compatibility. Keys are the lowercase ids used across the engine. */
const FIELD_SKILL_MOVE_INTERNALS: Record<string, string> = {
  cut: "CUT",
  fly: "FLY",
  surf: "SURF",
  strength: "STRENGTH",
  waterfall: "WATERFALL",
  dive: "DIVE",
  rocksmash: "ROCKSMASH",
  flash: "FLASH"
};

function toInventoryCategory(value: string): InventoryItem["category"] {
  switch (value.toLowerCase()) {
    case "berries":
      return "berries";
    case "skill item":
    case "machines":
      return "moves";
    case "quest item":
      return "quest";
    case "furniture":
      return "furniture";
    case "usable":
    case "medicine":
    case "battle item":
    case "battle items":
      return "usable";
    default:
      return "quest";
  }
}

function getStageMultiplier(stage: number) {
  const normalizedStage = clamp(Math.round(stage), -6, 6);
  return normalizedStage >= 0
    ? (2 + normalizedStage) / 2
    : 2 / (2 + Math.abs(normalizedStage));
}

/** Accuracy/evasion use the classic 3/3-based stage table. */
function getAccuracyStageMultiplier(stage: number) {
  const normalizedStage = clamp(Math.round(stage), -6, 6);
  return normalizedStage >= 0
    ? (3 + normalizedStage) / 3
    : 3 / (3 + Math.abs(normalizedStage));
}

function calculateHpStat(base: number, level: number, iv: number, ev: number) {
  return Math.max(
    1,
    Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10
  );
}

function calculateOtherStat(base: number, level: number, iv: number, ev: number) {
  return Math.max(
    1,
    Math.floor(
      (Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5) *
      NEUTRAL_NATURE
    )
  );
}

function createEmptyBattleStats(): BattleStats {
  return { hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 };
}

function sanitizeBattleStats(value: unknown, max: number): BattleStats {
  const stats = createEmptyBattleStats();
  if (!value || typeof value !== "object") {
    return stats;
  }

  const candidate = value as Partial<Record<keyof BattleStats, unknown>>;
  (Object.keys(stats) as Array<keyof BattleStats>).forEach((key) => {
    const raw = candidate[key];
    stats[key] =
      typeof raw === "number" && Number.isFinite(raw) ? clamp(Math.round(raw), 0, max) : 0;
  });

  return stats;
}

function calculateStats(
  baseStats: BattleStats,
  level: number,
  bonuses: PokemonStatBonuses = createEmptyPokemonStatBonuses(),
  ivs: BattleStats = createEmptyBattleStats(),
  evs: BattleStats = createEmptyBattleStats()
): BattleStats {
  return {
    hp: calculateHpStat(baseStats.hp, level, ivs.hp, evs.hp) + bonuses.hp,
    attack: calculateOtherStat(baseStats.attack, level, ivs.attack, evs.attack) + bonuses.attack,
    defense: calculateOtherStat(baseStats.defense, level, ivs.defense, evs.defense) + bonuses.defense,
    specialAttack:
      calculateOtherStat(baseStats.specialAttack, level, ivs.specialAttack, evs.specialAttack) +
      bonuses.specialAttack,
    specialDefense:
      calculateOtherStat(baseStats.specialDefense, level, ivs.specialDefense, evs.specialDefense) +
      bonuses.specialDefense,
    speed: calculateOtherStat(baseStats.speed, level, ivs.speed, evs.speed) + bonuses.speed
  };
}

function createEmptyStages(): BattleStatStages {
  return {
    attack: 0,
    defense: 0,
    specialAttack: 0,
    specialDefense: 0,
    speed: 0,
    accuracy: 0,
    evasion: 0
  };
}

function countPositiveStages(stages: BattleStatStages): number {
  return Object.values(stages).reduce((sum, stage) => sum + Math.max(0, stage), 0);
}

function createEmptyVolatile(): BattleVolatileState {
  return {
    confusionTurns: 0,
    flinched: false,
    protected: false,
    binding: null,
    trappedByPokemonId: null,
    seededBySideId: null,
    recharging: false,
    charging: null,
    aquaRing: false,
    ingrain: false,
    nightmare: false,
    endure: false,
    focusEnergy: false,
    damageTakenThisTurn: { physical: 0, special: 0, any: 0 },
    lastMoveId: null,
    consecutiveMoveUses: 0,
    disable: null,
    encore: null,
    tauntTurns: 0,
    choiceLockMoveId: null,
    torment: false,
    healBlockTurns: 0,
    embargoTurns: 0,
    imprison: false,
    attractedToPokemonId: null,
    perishCount: 0,
    destinyBond: false,
    grudge: false,
    bide: null,
    stockpile: 0,
    substituteHp: 0,
    transformBackup: null,
    lockOnTurns: 0,
    foresight: false,
    miracleEye: false,
    magnetRiseTurns: 0,
    telekinesisTurns: 0,
    electrified: false,
    powdered: false,
    yawnTurns: 0,
    cursed: false,
    rampage: null,
    usedMoveIds: [],
    turnsOnField: 0,
    mudSport: false,
    waterSport: false
  };
}

function rollIvs(): BattleStats {
  const roll = () => Math.floor(Math.random() * 32);
  return {
    hp: roll(),
    attack: roll(),
    defense: roll(),
    specialAttack: roll(),
    specialDefense: roll(),
    speed: roll()
  };
}

function getActivePokemon(side: BattleSide) {
  return side.party[side.activeIndex];
}

function isFainted(pokemon: BattlePokemon) {
  return pokemon.hp <= 0;
}

function chooseRandom<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function getUsableMoves(pokemon: BattlePokemon) {
  return pokemon.moves.filter((move) => move.currentPp > 0);
}

function getPublicPokemon(pokemon: BattlePokemon): BattlePublicPokemon {
  return {
    id: pokemon.id,
    name: pokemon.name,
    nickname: pokemon.nickname,
    level: pokemon.level,
    types: pokemon.types,
    hp: pokemon.hp,
    maxHp: pokemon.maxHp,
    experience: pokemon.experience,
    nextLevelExperience: pokemon.nextLevelExperience,
    status: pokemon.status?.id ?? null,
    confused: pokemon.volatile.confusionTurns > 0,
    statStages: { ...pokemon.stages },
    heldItemName: pokemon.heldItemName,
    frontImageSrc: pokemon.frontImageSrc,
    backImageSrc: pokemon.backImageSrc,
    moves: pokemon.moves.map((move) => ({
      id: move.id,
      name: move.name,
      type: move.type,
      power: move.power,
      accuracy: move.accuracy,
      category: move.category,
      description: move.description,
      priority: move.priority,
      skillGfxId: move.skillGfxId,
      skillGfxName: move.skillGfxName,
      animationId: move.animationId,
      animationName: move.animationName,
      currentPp: move.currentPp,
      maxPp: move.maxPp
    }))
  };
}

function getPokemonDisplayName(pokemon: Pick<BattlePokemon, "name" | "nickname">) {
  return pokemon.nickname ? `${pokemon.nickname} (${pokemon.name})` : pokemon.name;
}

function parseNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : fallback;
}

function parseFloatNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Essentials GenderRate names -> female fraction (-1 = genderless). */
function parseFemaleRatio(raw: unknown): number {
  switch (typeof raw === "string" ? raw.trim().toLowerCase() : "") {
    case "alwaysmale":
      return 0;
    case "alwaysfemale":
      return 1;
    case "genderless":
      return -1;
    case "femaleoneeighth":
      return 1 / 8;
    case "female25percent":
      return 0.25;
    case "female75percent":
      return 0.75;
    case "femaleseveneighths":
      return 7 / 8;
    default:
      return 0.5;
  }
}

/**
 * Stable per-individual gender: summaries don't persist one, so derive it
 * from the pokemon's id so the same mon is always the same gender.
 */
function deriveGender(id: string, femaleRatio: number): BattleGender {
  if (femaleRatio < 0) {
    return "genderless";
  }
  if (femaleRatio <= 0) {
    return "male";
  }
  if (femaleRatio >= 1) {
    return "female";
  }
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return (hash % 1000) / 1000 < femaleRatio ? "female" : "male";
}

function normalizeStatKey(raw: string): BattleStatKey | null {
  const normalized = raw.trim().toLowerCase().replace(/[\s_-]/g, "");
  switch (normalized) {
    case "hp":
      return "hp";
    case "attack":
    case "atk":
      return "attack";
    case "defense":
    case "def":
      return "defense";
    case "specialattack":
    case "spatk":
    case "spattack":
    case "specialatk":
      return "specialAttack";
    case "specialdefense":
    case "spdef":
    case "spdefense":
      return "specialDefense";
    case "speed":
    case "spd":
      return "speed";
    default:
      return null;
  }
}

export interface UseInventoryItemOptions {
  targetPokemonId?: string;
  /** For PP-restore-one / PP-up items: which move to affect. */
  targetMoveName?: string;
  /** The live world player, required for field items (Repel/Escape Rope). */
  player?: Player;
}

/** Client-side follow-up a bag item triggers (open a window, toggle a mode). */
export interface UseInventoryItemClientAction {
  type: FieldItemKeyAction;
}

export interface UseInventoryItemResult {
  ok: boolean;
  user?: AuthenticatedUser | null;
  message: string;
  clientAction?: UseInventoryItemClientAction;
  /** True when the action opened a wild battle (fishing bite / radar). */
  battleStarted?: boolean;
  /** Set when a repellent was armed: the charge the HUD should show. */
  repelSteps?: number;
}

export default class BattleManager {
  private readonly io: TypedSocketServer;
  private readonly world: World;
  private readonly auth: Auth;
  private readonly designerSectionStore: DesignerSectionStore;
  private readonly battles = new Map<string, BattleSession>();
  private readonly playerBattleIds = new Map<string, string>();
  private readonly lastGrassCellByPlayerId = new Map<string, string>();
  /** Per-cell dedupe for egg hatch steps (every tile, not just grass). */
  private readonly lastEggStepCellByPlayerId = new Map<string, string>();
  /** In-flight guard so a fast walker can't race two egg ticks at once. */
  private readonly pendingEggTicks = new Set<string>();
  private readonly pendingStepChecks = new Set<string>();
  /** Remaining repel steps per userId (step encounters skipped while >0).
   * Mirrors the character hash's `repel_steps` so it survives reconnects. */
  private readonly repelStepsByUserId = new Map<number, number>();
  /** Players with a cast in flight — blocks duplicate/spammed fishing casts. */
  private readonly activeFishingSocketIds = new Set<string>();
  /** Per-map encounter tables (designer:section:encounters), keyed by the
   * numeric Essentials map id as a string ("60"); refreshed by loadCatalogs. */
  private cachedEncounterProfiles: Map<
    string,
    {
      densities: { land?: number; cave?: number; water?: number };
      tables: Array<{
        method: string;
        density?: number;
        rows: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }>;
      }>;
    }
  > | null = null;
  /** Battleback names present in designer:section:battleBackgrounds (lower-
   * cased), loaded once by loadCatalogs so resolveBattleBackForPlayer can
   * prefer terrain variants ("CaveWater") that actually exist. */
  private cachedBattleBackNames: Set<string> | null = null;
  private readonly challenges = new Map<string, ChallengeRequest>();
  private readonly tradeRequests = new Map<string, TradeRequest>();
  /**
   * Set by registerSocketHandlers to TradeManager.isTrading. A battle would
   * mutate HP/PP/held items on Venomon that a live trade has reserved, so no
   * battle of any kind may start while the player is trading.
   */
  private tradeGuard: ((userId: number) => boolean) | null = null;
  private typeChart: TypeChart = buildTypeChart([]);

  constructor(
    io: TypedSocketServer,
    world: World,
    auth: Auth,
    designerSectionStore: DesignerSectionStore
  ) {
    this.io = io;
    this.world = world;
    this.auth = auth;
    this.designerSectionStore = designerSectionStore;
  }

  public setTradeGuard(guard: (userId: number) => boolean) {
    this.tradeGuard = guard;
  }

  /** True when a live trade has this player's assets reserved. */
  public isPlayerTrading(userId: number | null | undefined) {
    return typeof userId === "number" && Boolean(this.tradeGuard?.(userId));
  }

  /**
   * True while a wild battle is starting or running for this socket. The
   * pending flag is set SYNCHRONOUSLY on the encounter-roll step (before the
   * async battle setup lands), so touch/sight events fired on that same step
   * can tell "a battle just began" and queue themselves for after it.
   */
  public isWildStartPendingOrBattling(socketId: string) {
    return this.pendingStepChecks.has(socketId) || this.isPlayerBattling(socketId);
  }

  public isPlayerBattling(playerId: string) {
    return this.playerBattleIds.has(playerId);
  }

  public resumeBattleForPlayer(player: Player) {
    const battleId = this.playerBattleIds.get(player.socketId);

    if (!battleId) {
      player.leaveBattle();
      return false;
    }

    const battle = this.battles.get(battleId);
    if (!battle || battle.status !== "active") {
      this.playerBattleIds.delete(player.socketId);
      player.leaveBattle();
      return false;
    }

    const side = this.getBattleSideForPlayer(battle, player.socketId);
    if (!side) {
      this.playerBattleIds.delete(player.socketId);
      player.leaveBattle();
      return false;
    }

    player.enterBattle();
    this.emitToPlayer(player, "battle:state", this.toPublicState(battle, side));

    return true;
  }

  public async handleSocketDisconnect(socketId: string) {
    const player = this.world.getPlayerBySocket(socketId);

    if (!player || !player.socketConnections.has(socketId)) {
      return;
    }

    const remainingConnections = player.socketConnections.size - 1;
    if (remainingConnections > 0) {
      return;
    }

    const battleId = this.playerBattleIds.get(player.socketId);
    if (!battleId) {
      return;
    }

    const battle = this.battles.get(battleId);
    if (!battle || battle.status !== "active") {
      this.playerBattleIds.delete(player.socketId);
      return;
    }

    if (battle.kind !== "trainer") {
      return;
    }

    const side = this.getBattleSideForPlayer(battle, player.socketId);
    if (!side) {
      this.playerBattleIds.delete(player.socketId);
      return;
    }

    await this.finishBattle(
      battle,
      `${side.trainerName} surrendered.`,
      this.getOpponentSide(battle, side),
      side
    );
  }

  /**
   * Uses a field-usable item from the bag (out of battle). Dispatches across
   * every effect the item catalog can express — HP/PP restore, status cures,
   * revives, vitamins (EVs), Rare Candy, evolution stones, and field items
   * like Repel / Escape Rope / Town Map. In-battle item use goes through
   * {@link applyItemAction}; this path is blocked while battling.
   */
  public async useInventoryItem(
    userId: number,
    itemId: string,
    options: UseInventoryItemOptions = {}
  ): Promise<UseInventoryItemResult> {
    const { targetPokemonId, targetMoveName, player } = options;

    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false, message: "You can't use bag items during a battle." };
    }

    const user = await this.auth.getUserForBattle(userId);
    const catalogs = await this.loadCatalogs();
    const item = user?.inventory.find((candidate) => candidate.id === itemId);
    const itemDefinition = this.getCachedItemDefinition(itemId, item?.name ?? "");

    if (!user || !item || !itemDefinition || item.quantity <= 0) {
      return { ok: false, message: "That item is no longer available." };
    }

    if (!["usable", "berries", "quest"].includes(item.category)) {
      return { ok: false, message: "That item cannot be used from the bag." };
    }

    const effect = classifyFieldItem({
      essentialsId: itemDefinition.essentialsId,
      healHp: itemDefinition.statModifiers.hp,
      category: item.category
    });

    if (!effect) {
      return { ok: false, message: `${item.name} can't be used right now.` };
    }

    // ----- Field / party-wide effects (no single Venomon target) -----------
    if (effect.kind === "repel") {
      // Usable anywhere (no world player needed): the charge is keyed by
      // user and persisted, and only spends while walking encounter tiles.
      const activeSteps = this.repelStepsByUserId.get(userId) ?? 0;
      if (activeSteps > 0) {
        // Essentials refuses to stack repellents: the running charge must
        // wear off first, and the new item is NOT consumed.
        return {
          ok: false,
          message: `Aún queda repelente activo (${activeSteps} pasos restantes).`
        };
      }
      this.repelStepsByUserId.set(userId, effect.steps);
      await this.auth.saveRepelSteps(userId, effect.steps);
      return {
        ok: true,
        user: await this.consumeItem(userId, user, item),
        message: `${item.name} mantendrá alejados a los Venomon salvajes durante ${effect.steps} pasos.`,
        repelSteps: effect.steps
      };
    }

    if (effect.kind === "escape-rope") {
      if (!player) {
        return { ok: false, message: "Enter the world before using an Escape Rope." };
      }
      const destination = this.resolveEscapeDestination(player);
      if (!destination) {
        return { ok: false, message: "You can't use that here." };
      }
      const nextUser = await this.consumeItem(userId, user, item);
      this.teleportPlayerTo(player, destination);
      return { ok: true, user: nextUser, message: `${user.name} used the Escape Rope.` };
    }

    if (effect.kind === "key-item") {
      return this.applyKeyItem(effect.action, item, user, itemDefinition.essentialsId, player);
    }

    if (effect.kind === "revive-all") {
      const revived = user.pokemonParty.filter((pokemon) => pokemon.hp <= 0);
      if (revived.length === 0) {
        return { ok: false, message: "None of your Venomon have fainted." };
      }
      revived.forEach((pokemon) => {
        const definition = this.resolveSummaryDefinition(pokemon, catalogs);
        this.reviveSummary(pokemon, definition, effect.hpFraction, catalogs);
      });
      return {
        ok: true,
        user: await this.consumeItem(userId, user, item, {
          pokemonParty: user.pokemonParty
        }),
        message: `${item.name} revived your fainted Venomon.`
      };
    }

    if (effect.kind === "wake-flute") {
      const asleep = user.pokemonParty.filter((pokemon) => pokemon.status?.id === "sleep");
      if (asleep.length === 0) {
        return { ok: false, message: "None of your Venomon are asleep." };
      }
      asleep.forEach((pokemon) => {
        pokemon.status = null;
      });
      return {
        ok: true,
        user: await this.consumeItem(userId, user, item, {
          pokemonParty: user.pokemonParty
        }),
        message: `${item.name} woke your Venomon.`
      };
    }

    // ----- Single-target effects (require a party Venomon) -----------------
    const targetPokemon = user.pokemonParty.find((pokemon) => pokemon.id === targetPokemonId);
    if (!targetPokemon) {
      return { ok: false, message: "Choose a Venomon for this item." };
    }

    const definition = this.resolveSummaryDefinition(targetPokemon, catalogs);
    const displayName = getPokemonDisplayName(targetPokemon);
    const fainted = targetPokemon.hp <= 0;

    switch (effect.kind) {
      case "revive": {
        if (!fainted) {
          return { ok: false, message: `${displayName} isn't fainted.` };
        }
        this.reviveSummary(targetPokemon, definition, effect.hpFraction, catalogs);
        return {
          ok: true,
          user: await this.consumeItem(userId, user, item, { pokemonParty: user.pokemonParty }),
          message: `${displayName} was revived.`
        };
      }

      case "heal-hp":
      case "full-restore": {
        if (fainted) {
          return { ok: false, message: `${displayName} has fainted — use a Revive first.` };
        }
        const healed = targetPokemon.hp < targetPokemon.maxHp;
        const cured = effect.kind === "full-restore" && Boolean(targetPokemon.status);
        if (!healed && !cured) {
          return { ok: false, message: `${displayName} already has full HP.` };
        }
        const beforeHp = targetPokemon.hp;
        targetPokemon.hp = clamp(targetPokemon.hp + effect.amount, 0, targetPokemon.maxHp);
        let message = `${displayName} recovered ${targetPokemon.hp - beforeHp} HP.`;
        if (effect.kind === "full-restore" && targetPokemon.status) {
          targetPokemon.status = null;
          message = `${displayName} was fully restored.`;
        }
        return {
          ok: true,
          user: await this.consumeItem(userId, user, item, { pokemonParty: user.pokemonParty }),
          message
        };
      }

      case "cure-status": {
        if (fainted) {
          return { ok: false, message: `${displayName} has fainted — use a Revive first.` };
        }
        const status = targetPokemon.status;
        const canCure =
          status &&
          (effect.statuses === "any" ||
            effect.statuses.includes(status.id as BattleStatusId));
        if (!canCure) {
          return { ok: false, message: `${displayName} has no status ${item.name} can cure.` };
        }
        targetPokemon.status = null;
        return {
          ok: true,
          user: await this.consumeItem(userId, user, item, { pokemonParty: user.pokemonParty }),
          message: `${displayName} was cured.`
        };
      }

      case "pp-restore": {
        const result = this.applyPpRestore(targetPokemon, effect, targetMoveName, catalogs);
        if (!result.ok) {
          return { ok: false, message: result.message };
        }
        return {
          ok: true,
          user: await this.consumeItem(userId, user, item, { pokemonParty: user.pokemonParty }),
          message: result.message
        };
      }

      case "pp-up": {
        const result = this.applyPpUp(targetPokemon, effect, targetMoveName, catalogs);
        if (!result.ok) {
          return { ok: false, message: result.message };
        }
        return {
          ok: true,
          user: await this.consumeItem(userId, user, item, { pokemonParty: user.pokemonParty }),
          message: result.message
        };
      }

      case "vitamin": {
        const result = this.applyVitamin(targetPokemon, definition, effect);
        if (!result.ok) {
          return { ok: false, message: result.message };
        }
        return {
          ok: true,
          user: await this.consumeItem(userId, user, item, { pokemonParty: user.pokemonParty }),
          message: result.message
        };
      }

      case "level-up": {
        if (targetPokemon.level >= 100) {
          return { ok: false, message: `${displayName} is already at the level cap.` };
        }
        const result = this.applyRareCandy(targetPokemon, definition, catalogs);
        return {
          ok: true,
          user: await this.consumeItem(userId, user, item, { pokemonParty: user.pokemonParty }),
          message: result.message
        };
      }

      case "evolution-stone": {
        const target = this.findItemEvolutionTarget(
          targetPokemon,
          itemDefinition.essentialsId,
          catalogs
        );
        if (!target) {
          return { ok: false, message: `It had no effect on ${displayName}.` };
        }
        const fromName = displayName;
        this.evolveSummary(targetPokemon, target, catalogs);
        return {
          ok: true,
          user: await this.consumeItem(userId, user, item, { pokemonParty: user.pokemonParty }),
          message: `${fromName} evolved into ${target.name}!`
        };
      }

      default:
        return { ok: false, message: `${item.name} can't be used right now.` };
    }
  }

  /** Removes one of `item` from inventory and persists optional party changes. */
  private async consumeItem(
    userId: number,
    user: AuthenticatedUser,
    item: InventoryItem,
    extra: { pokemonParty?: PokemonSummary[] } = {}
  ) {
    const nextInventory = this.removeInventoryQuantity(user.inventory, item.id, 1);
    return this.auth.saveBattleState(userId, {
      inventory: nextInventory,
      ...(extra.pokemonParty ? { pokemonParty: extra.pokemonParty } : {})
    });
  }

  private resolveSummaryDefinition(
    summary: PokemonSummary,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): PokemonDefinition | null {
    return (
      (summary.sourcePokemonId ? catalogs.pokemonById.get(summary.sourcePokemonId) : undefined) ??
      this.resolvePokemonDefinition(summary.name, catalogs)
    );
  }

  /** Recomputes maxHp from the current level/EVs/IVs, preserving HP damage. */
  private recomputeSummaryMaxHp(summary: PokemonSummary, definition: PokemonDefinition | null) {
    const level = clamp(summary.level, 1, 100);
    const statBonuses = sanitizePokemonStatBonuses(summary.statBonuses);
    const ivs = sanitizeBattleStats(summary.ivs, 31);
    const evs = sanitizeBattleStats(summary.evs, MAX_EV_PER_STAT);
    const baseStats = definition?.baseStats ?? {
      hp: summary.maxHp,
      attack: Math.max(1, summary.maxHp),
      defense: Math.max(1, summary.maxHp),
      specialAttack: Math.max(1, summary.maxHp),
      specialDefense: Math.max(1, summary.maxHp),
      speed: Math.max(1, summary.maxHp)
    };
    const stats = calculateStats(baseStats, level, statBonuses, ivs, evs);
    const wasFainted = summary.hp <= 0;
    const missingHp = Math.max(0, summary.maxHp - summary.hp);
    summary.maxHp = stats.hp;
    summary.hp = wasFainted ? 0 : clamp(stats.hp - missingHp, 1, stats.hp);
    return stats;
  }

  private reviveSummary(
    summary: PokemonSummary,
    definition: PokemonDefinition | null,
    hpFraction: number,
    _catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ) {
    this.recomputeSummaryMaxHp(summary, definition);
    summary.status = null;
    summary.hp = clamp(Math.round(summary.maxHp * hpFraction), 1, summary.maxHp);
  }

  private applyPpRestore(
    summary: PokemonSummary,
    effect: Extract<FieldItemEffect, { kind: "pp-restore" }>,
    targetMoveName: string | undefined,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): { ok: true; message: string } | { ok: false; message: string } {
    const moves = Array.isArray(summary.moves) ? summary.moves : [];
    if (moves.length === 0) {
      return { ok: false, message: `${getPokemonDisplayName(summary)} knows no moves.` };
    }
    const movePp = { ...(summary.movePp ?? {}) };
    const ppUps = summary.movePpUps ?? {};
    const restoreOne = (moveName: string) => {
      const skill = catalogs.skillsByName.get(moveName.toLowerCase());
      const baseMax = Math.max(1, skill?.powerPoint ?? movePp[moveName] ?? 1);
      const max = maxPpForMove(baseMax, ppUps[moveName] ?? 0);
      const current = typeof movePp[moveName] === "number" ? movePp[moveName] : max;
      const next = effect.amount >= 9999 ? max : Math.min(max, current + effect.amount);
      movePp[moveName] = next;
      return next - current;
    };

    if (effect.scope === "all") {
      let restored = 0;
      moves.forEach((moveName) => {
        restored += restoreOne(moveName);
      });
      if (restored <= 0) {
        return { ok: false, message: `${getPokemonDisplayName(summary)}'s PP are already full.` };
      }
      summary.movePp = movePp;
      return { ok: true, message: `${getPokemonDisplayName(summary)}'s PP was restored.` };
    }

    const moveName = targetMoveName && moves.includes(targetMoveName) ? targetMoveName : undefined;
    if (!moveName) {
      return { ok: false, message: "Choose a move to restore." };
    }
    const gained = restoreOne(moveName);
    if (gained <= 0) {
      return { ok: false, message: `${moveName} already has full PP.` };
    }
    summary.movePp = movePp;
    return { ok: true, message: `${moveName}'s PP was restored.` };
  }

  private applyPpUp(
    summary: PokemonSummary,
    effect: Extract<FieldItemEffect, { kind: "pp-up" }>,
    targetMoveName: string | undefined,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): { ok: true; message: string } | { ok: false; message: string } {
    const moves = Array.isArray(summary.moves) ? summary.moves : [];
    const moveName = targetMoveName && moves.includes(targetMoveName) ? targetMoveName : undefined;
    if (!moveName) {
      return { ok: false, message: "Choose a move to boost." };
    }
    const ppUps = { ...(summary.movePpUps ?? {}) };
    const current = ppUps[moveName] ?? 0;
    if (current >= 3) {
      return { ok: false, message: `${moveName}'s PP can't go any higher.` };
    }
    const next = effect.mode === "max" ? 3 : current + 1;
    ppUps[moveName] = next;
    summary.movePpUps = ppUps;

    // Top the current PP up to the new maximum so the boost is immediately felt.
    const skill = catalogs.skillsByName.get(moveName.toLowerCase());
    const baseMax = Math.max(1, skill?.powerPoint ?? 1);
    const movePp = { ...(summary.movePp ?? {}) };
    movePp[moveName] = maxPpForMove(baseMax, next);
    summary.movePp = movePp;

    return { ok: true, message: `${moveName}'s max PP increased.` };
  }

  private applyVitamin(
    summary: PokemonSummary,
    definition: PokemonDefinition | null,
    effect: Extract<FieldItemEffect, { kind: "vitamin" }>
  ): { ok: true; message: string } | { ok: false; message: string } {
    const evs = { ...(summary.evs ?? {}) } as Record<string, number>;
    const statKeys: BattleStatKey[] = [
      "hp",
      "attack",
      "defense",
      "specialAttack",
      "specialDefense",
      "speed"
    ];
    const current = Math.max(0, Math.round(evs[effect.stat] ?? 0));
    const total = statKeys.reduce((sum, key) => sum + Math.max(0, Math.round(evs[key] ?? 0)), 0);

    if (effect.capped && current >= VITAMIN_EV_CAP) {
      return {
        ok: false,
        message: `${getPokemonDisplayName(summary)} won't benefit from any more of that.`
      };
    }
    if (current >= MAX_STANDARD_EV_PER_STAT || total >= MAX_TOTAL_EV) {
      return {
        ok: false,
        message: `${getPokemonDisplayName(summary)} won't benefit from any more of that.`
      };
    }

    const perStatCap = effect.capped
      ? Math.min(VITAMIN_EV_CAP, MAX_STANDARD_EV_PER_STAT)
      : MAX_STANDARD_EV_PER_STAT;
    const roomForStat = perStatCap - current;
    const roomForTotal = MAX_TOTAL_EV - total;
    const applied = Math.max(0, Math.min(effect.amount, roomForStat, roomForTotal));
    if (applied <= 0) {
      return {
        ok: false,
        message: `${getPokemonDisplayName(summary)} won't benefit from any more of that.`
      };
    }
    evs[effect.stat] = current + applied;
    summary.evs = evs;

    if (effect.stat === "hp") {
      this.recomputeSummaryMaxHp(summary, definition);
    }
    return { ok: true, message: `${getPokemonDisplayName(summary)}'s base stats rose.` };
  }

  /**
   * Rare Candy: one level, recomputed stats, any moves learnable at the new
   * level (appended or queued as a pending prompt), then a level-up evolution
   * check.
   */
  private applyRareCandy(
    summary: PokemonSummary,
    definition: PokemonDefinition | null,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): { message: string } {
    const nextLevel = Math.min(100, summary.level + 1);
    summary.level = nextLevel;
    summary.experience = 0;
    summary.nextLevelExperience = this.getExperienceRequirement(
      { growthRate: definition?.growthRate ?? null },
      nextLevel,
      catalogs.levelingCurveConfig
    );
    if (nextLevel >= 100) {
      summary.experience = 0;
      summary.nextLevelExperience = 0;
    }
    this.recomputeSummaryMaxHp(summary, definition);

    const messages = [`${getPokemonDisplayName(summary)} grew to level ${nextLevel}!`];
    this.learnLevelMovesForSummary(summary, definition, nextLevel, catalogs, messages);

    const evolveTarget = this.findLevelEvolutionTargetForSummary(summary, catalogs);
    if (evolveTarget) {
      const fromName = getPokemonDisplayName(summary);
      this.evolveSummary(summary, evolveTarget, catalogs);
      messages.push(`${fromName} evolved into ${evolveTarget.name}!`);
    }

    return { message: messages.join(" ") };
  }

  /** Appends moves learnable exactly at `level`, queuing extras as pending. */
  private learnLevelMovesForSummary(
    summary: PokemonSummary,
    definition: PokemonDefinition | null,
    level: number,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>,
    messages: string[]
  ) {
    const learnset = definition?.skills ?? [];
    const learnable = learnset.filter((entry) => entry.level === level);
    for (const entry of learnable) {
      if (summary.moves.some((move) => move.toLowerCase() === entry.skillName.toLowerCase())) {
        continue;
      }
      const skill =
        catalogs.skillsById.get(entry.skillId) ??
        catalogs.skillsByName.get(entry.skillName.toLowerCase());
      if (!skill) {
        continue;
      }
      if (summary.moves.length < 4) {
        summary.moves = [...summary.moves, skill.name];
        summary.movePp = { ...(summary.movePp ?? {}), [skill.name]: skill.powerPoint };
        messages.push(`It learned ${skill.name}!`);
      } else {
        const pending = summary.pendingMoveLearns ?? [];
        if (!pending.some((name) => name.toLowerCase() === skill.name.toLowerCase())) {
          summary.pendingMoveLearns = [...pending, skill.name];
        }
      }
    }
  }

  private findItemEvolutionTarget(
    summary: PokemonSummary,
    itemEssentialsId: string,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): PokemonDefinition | null {
    const definition = this.resolveSummaryDefinition(summary, catalogs);
    const wantedItem = itemEssentialsId.trim().toUpperCase();
    for (const evolution of definition?.evolutions ?? []) {
      const method = evolution.method.trim().toLowerCase().replace(/[\s_-]/g, "");
      if (method !== "item" && method !== "itemmale" && method !== "itemfemale") {
        continue;
      }
      const parameter = String(evolution.parameter ?? "").trim().toUpperCase();
      if (parameter && parameter !== wantedItem) {
        continue;
      }
      const target = this.resolvePokemonDefinition(evolution.targetId, catalogs);
      if (target && target.id !== summary.sourcePokemonId) {
        return target;
      }
    }
    return null;
  }

  private findLevelEvolutionTargetForSummary(
    summary: PokemonSummary,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): PokemonDefinition | null {
    const definition = this.resolveSummaryDefinition(summary, catalogs);
    for (const evolution of definition?.evolutions ?? []) {
      const method = evolution.method.trim().toLowerCase().replace(/[\s_-]/g, "");
      if (method !== "level" && method !== "levelup") {
        continue;
      }
      const requiredLevel =
        typeof evolution.parameter === "number"
          ? evolution.parameter
          : Number.parseInt(String(evolution.parameter ?? ""), 10);
      if (!Number.isFinite(requiredLevel) || requiredLevel <= 0 || summary.level < requiredLevel) {
        continue;
      }
      const target = this.resolvePokemonDefinition(evolution.targetId, catalogs);
      if (target && target.id !== summary.sourcePokemonId) {
        return target;
      }
    }
    return null;
  }

  /** Applies an evolution to a stored summary (stone or level triggered). */
  private evolveSummary(
    summary: PokemonSummary,
    target: PokemonDefinition,
    _catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ) {
    summary.sourcePokemonId = target.id;
    summary.name = target.name;
    summary.types = target.types;
    this.recomputeSummaryMaxHp(summary, target);
  }

  /**
   * Escape Rope destination: the current map's configured healing spot
   * (Essentials `HealSpot`, stored in tile cells → converted to pixels via the
   * destination map's cell size), falling back to the world's initial spawn.
   */
  private resolveEscapeDestination(
    player: Player
  ): { mapId: string; x: number; y: number } | null {
    const mapsState = this.world.getPlayableMapsState();
    if (!mapsState) {
      return null;
    }
    const currentMap = mapsState.items.find((item) => item.id === templateMapIdFor(player.currentMapId));
    const healingSpot = currentMap?.playableMapConfig?.healingSpot;
    if (healingSpot) {
      const targetMap =
        mapsState.items.find((item) => item.id === healingSpot.mapId) ?? currentMap;
      const cellSize = targetMap?.playableMapConfig?.cellSize ?? 32;
      return {
        mapId: healingSpot.mapId,
        x: Math.max(0, Math.round(healingSpot.x)) * cellSize,
        y: Math.max(0, Math.round(healingSpot.y)) * cellSize
      };
    }
    return resolveInitialSpawnFromPlayableMapsState(mapsState);
  }

  private teleportPlayerTo(
    player: Player,
    destination: { mapId: string; x: number; y: number }
  ) {
    player.stopMovement();
    player.teleport(destination.mapId, destination.x, destination.y);
    this.world.players.set(player.socketId, player);
    this.world.presentPlayerToMap(player);
    player.socketConnections.forEach((socketId) => {
      this.world.presentPlayersOnMapTo(socketId, player.currentMapId);
    });
  }

  /** Dispatches a used key item (Bicycle, Poke Radar, rods, Dowsing, Town Map). */
  private async applyKeyItem(
    action: FieldItemKeyAction,
    item: InventoryItem,
    user: AuthenticatedUser,
    essentialsId: string,
    player?: Player
  ): Promise<UseInventoryItemResult> {
    switch (action) {
      case "town-map":
        // Handled client-side (opens the world map); this is a safety fallback.
        return {
          ok: true,
          message: `${user.name} checked the ${item.name}.`,
          clientAction: { type: "town-map" }
        };

      case "bicycle": {
        if (!player) {
          return { ok: false, message: "Enter the world before using the Bicycle." };
        }
        const nowCycling = !player.cycling;
        player.setCycling(nowCycling);
        return {
          ok: true,
          message: nowCycling ? "You got on the Bicycle." : "You got off the Bicycle.",
          clientAction: { type: "bicycle" }
        };
      }

      case "running-shoes":
        // Passive key item: running happens by holding the run key, not by
        // "using" the shoes — so Use just reminds the player how it works.
        return {
          ok: true,
          message:
            "Mantén pulsada la tecla de correr mientras caminas para correr (configúrala en Ajustes → Controles)."
        };

      case "poke-radar": {
        if (!player) {
          return { ok: false, message: "Enter the world before using the Poke Radar." };
        }
        return this.usePokeRadar(player, user, item);
      }

      case "fishing": {
        if (!player) {
          return { ok: false, message: "Enter the world before fishing." };
        }
        const tier: FishingRodTier = FISHING_ROD_TIERS[essentialsId.toUpperCase()] ?? "old";
        return this.useFishingRod(player, user, tier, item);
      }

      case "dowsing": {
        if (!player) {
          return { ok: false, message: "Enter the world before using that." };
        }
        return this.useDowsing(player, item);
      }

      default:
        return { ok: true, message: `${user.name} used the ${item.name}.` };
    }
  }

  private partyCanBattle(user: AuthenticatedUser) {
    // Eggs can't fight even though they have hp, so they don't count here.
    return user.pokemonParty.some((pokemon) => !pokemon.isEgg && pokemon.hp > 0);
  }

  /** Poke Radar: forces a wild encounter from the tall grass you're standing in. */
  private async usePokeRadar(
    player: Player,
    user: AuthenticatedUser,
    item: InventoryItem
  ): Promise<UseInventoryItemResult> {
    if (!this.partyCanBattle(user)) {
      return { ok: false, message: "Your Venomon are in no condition to battle." };
    }
    const grass = this.getGrassCellForPlayer(player);
    if (!grass || (grass.pokemonIds.length === 0 && !grass.encounterRows?.length)) {
      return { ok: false, message: "There's no tall grass to search here." };
    }
    await this.startWildBattle(player, grass, "grass");
    return { ok: true, message: `The ${item.name} found a rustling patch of grass!` };
  }

  /**
   * Rock Smash body script (pbRockSmashRandomEncounter): after a rock is broken,
   * roll a chance to trigger a wild encounter drawn from the map's table.
   */
  public async tryRockSmashEncounter(userId: number, player: Player): Promise<void> {
    if (this.isPlayerTrading(userId)) {
      return;
    }
    const user = await this.auth.getUserForBattle(userId);
    if (!user || !this.partyCanBattle(user)) {
      return;
    }
    if (Math.random() > 0.25) {
      return; // ~25% like Essentials rock-smash encounters
    }
    const snapshot = this.world.getPlayableMapsState();
    const editorData = snapshot?.editorDataByMapId[templateMapIdFor(player.currentMapId)];
    const table = this.getMapEncounterTable(player.currentMapId, editorData);
    if (!table || (table.pokemonIds.length === 0 && !table.encounterRows?.length)) {
      return;
    }
    await this.startWildBattle(player, table);
  }

  /** The map's shared walking encounter pool: the grass-cell carrier table,
   * falling back to the Cave table on grass-less cave-style maps. */
  private getMapEncounterTable(
    mapId: string,
    editorData:
      | { grass: Array<{ pokemonIds: string[]; minLevel: number; maxLevel: number; encounterRows?: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }> }> }
      | undefined
  ) {
    const carrier = (editorData?.grass ?? []).find(
      (cell) => (cell.encounterRows?.length ?? 0) > 0 || cell.pokemonIds.length > 0
    );
    if (carrier) {
      return {
        pokemonIds: carrier.pokemonIds,
        minLevel: carrier.minLevel,
        maxLevel: carrier.maxLevel,
        encounterRows: carrier.encounterRows
      };
    }
    const cave = this.getEncounterTableForMap(mapId, "Cave");
    if (cave) {
      return { pokemonIds: [], minLevel: 1, maxLevel: 100, encounterRows: cave.rows };
    }
    return null;
  }

  /** Normalizes designer:section:encounters items into the per-map cache.
   * Malformed tables are logged instead of silently dropped. */
  private buildEncounterProfileCache(items: DesignerSectionItem[]) {
    const cache = new Map<
      string,
      {
        densities: { land?: number; cave?: number; water?: number };
        tables: Array<{
          method: string;
          density?: number;
          rows: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }>;
        }>;
      }
    >();
    for (const item of items) {
      const profile = (item as { encounterProfile?: unknown }).encounterProfile as
        | {
            mapId?: unknown;
            tables?: unknown;
            densities?: { land?: unknown; cave?: unknown; water?: unknown };
          }
        | undefined;
      if (!profile || typeof profile.mapId !== "string" || !Array.isArray(profile.tables)) {
        continue;
      }
      const numericId = Number.parseInt(profile.mapId, 10);
      const key = Number.isFinite(numericId) ? String(numericId) : profile.mapId;
      const tables: Array<{
        method: string;
        density?: number;
        rows: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }>;
      }> = [];
      for (const table of profile.tables as Array<{
        method?: unknown;
        density?: unknown;
        rows?: unknown;
      }>) {
        if (!table || typeof table.method !== "string" || !Array.isArray(table.rows)) {
          console.warn(`Encounter table without method/rows on map ${profile.mapId} — skipped.`);
          continue;
        }
        const rows = table.rows
          .filter((row): row is { weight: number; pokemonId: string; minLevel: number; maxLevel: number } => {
            const valid =
              row &&
              typeof (row as { pokemonId?: unknown }).pokemonId === "string" &&
              Number.isFinite((row as { weight?: unknown }).weight) &&
              ((row as { weight: number }).weight) > 0 &&
              Number.isFinite((row as { minLevel?: unknown }).minLevel) &&
              Number.isFinite((row as { maxLevel?: unknown }).maxLevel);
            if (!valid) {
              console.warn(
                `Malformed ${table.method} encounter row on map ${profile.mapId} — skipped:`,
                row
              );
            }
            return Boolean(valid);
          });
        tables.push({
          method: table.method,
          density: typeof table.density === "number" ? table.density : undefined,
          rows
        });
      }
      const densities = profile.densities ?? {};
      cache.set(key, {
        densities: {
          land: typeof densities.land === "number" ? densities.land : undefined,
          cave: typeof densities.cave === "number" ? densities.cave : undefined,
          water: typeof densities.water === "number" ? densities.water : undefined
        },
        tables
      });
    }
    return cache;
  }

  /** "map-essentials-060" -> "60" (the encounter cache key); null for
   * non-imported maps, which have no Essentials encounter data. */
  private encounterKeyForMapId(mapId: string): string | null {
    const match = /^map-essentials-0*(\d+)$/.exec(mapId);
    return match ? String(Number.parseInt(match[1], 10)) : null;
  }

  /** The map's encounter table for a specific Essentials method ("Water",
   * "OldRod", ...). Rate falls back to the matching PBS density column. */
  private getEncounterTableForMap(
    mapId: string,
    method: string
  ): { encounterRate: number; rows: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }> } | null {
    if (!this.cachedEncounterProfiles) {
      // Warm the cache for the next step; this one just misses.
      void this.loadCatalogs().catch(() => undefined);
      return null;
    }
    const key = this.encounterKeyForMapId(mapId);
    const profile = key ? this.cachedEncounterProfiles.get(key) : undefined;
    if (!profile) {
      return null;
    }
    const wanted = method.toLowerCase();
    const table = profile.tables.find((candidate) => candidate.method.toLowerCase() === wanted);
    if (!table || table.rows.length === 0) {
      return null;
    }
    const densityFallback =
      wanted === "land"
        ? profile.densities.land
        : wanted === "cave"
          ? profile.densities.cave
          : profile.densities.water;
    return { encounterRate: table.density ?? densityFallback ?? 10, rows: table.rows };
  }

  private isCellBlockedForPlayer(player: Player, cell: { x: number; y: number }, cellSize: number) {
    return this.world.isRectBlockedForPlayer(
      player,
      cell.x * cellSize,
      cell.y * cellSize,
      player.width,
      player.height
    );
  }

  /**
   * Fishing: casts at the water tile the player faces. Uses a fishing-spot
   * placement when one is in front (rod-tier gated), otherwise the map's
   * per-rod Essentials encounter table (OldRod/GoodRod/SuperRod). Tables stay
   * strictly per-method — there is no fallback into the Land pool.
   */
  private async useFishingRod(
    player: Player,
    user: AuthenticatedUser,
    tier: FishingRodTier,
    item: InventoryItem
  ): Promise<UseInventoryItemResult> {
    if (!this.partyCanBattle(user)) {
      return { ok: false, message: "Tus Venomon no están en condiciones de luchar." };
    }
    if (this.isPlayerBattling(player.socketId)) {
      return { ok: false, message: "No puedes pescar ahora." };
    }
    // Acquire the cast lock SYNCHRONOUSLY (before any await) so two rapid
    // casts can never both pass the guard and open two encounters.
    if (this.activeFishingSocketIds.has(player.socketId)) {
      return { ok: false, message: "Ya estás pescando." };
    }
    this.activeFishingSocketIds.add(player.socketId);
    try {
      await this.loadCatalogs();

      const snapshot = this.world.getPlayableMapsState();
      const map = snapshot?.items.find((candidate) => candidate.id === templateMapIdFor(player.currentMapId));
      const editorData = snapshot?.editorDataByMapId[templateMapIdFor(player.currentMapId)];
      const cellSize = map?.playableMapConfig?.cellSize ?? 32;
      const facing = player.getFacingCell(cellSize);
      const rodOrder: Record<FishingRodTier, number> = { old: 0, good: 1, super: 2 };

      const spot = (editorData?.fishingSpots ?? []).find(
        (candidate) => candidate.x === facing.x && candidate.y === facing.y
      );
      if (!spot && !this.world.isOpenWaterCell(player.currentMapId, facing.x, facing.y)) {
        // Decorative water (no water tag) and obstacles drawn over water
        // (rocks) are not fishable.
        return { ok: false, message: "Aquí no se puede pescar. Mira hacia el agua." };
      }
      if (spot) {
        if (spot.rod && rodOrder[tier] < rodOrder[spot.rod]) {
          return { ok: false, message: `La ${item.name} no es lo bastante buena para pescar aquí.` };
        }
        return await this.castFishing(
          player,
          { pokemonIds: spot.pokemonIds, minLevel: spot.minLevel, maxLevel: spot.maxLevel, encounterRows: spot.encounterRows },
          tier,
          item
        );
      }

      const rodMethod: Record<FishingRodTier, string> = {
        old: "OldRod",
        good: "GoodRod",
        super: "SuperRod"
      };
      const table = this.getEncounterTableForMap(player.currentMapId, rodMethod[tier]);
      if (!table) {
        return { ok: false, message: "No parece haber Venomon en estas aguas." };
      }
      return await this.castFishing(
        player,
        { pokemonIds: [], minLevel: 1, maxLevel: 100, encounterRows: table.rows },
        tier,
        item
      );
    } finally {
      this.activeFishingSocketIds.delete(player.socketId);
    }
  }

  private async castFishing(
    player: Player,
    table: { pokemonIds: string[]; minLevel: number; maxLevel: number; encounterRows?: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }> },
    tier: FishingRodTier,
    item: InventoryItem
  ): Promise<UseInventoryItemResult> {
    // The cast lock is held by useFishingRod (acquired synchronously there).
    const cellSize = this.world.getMapCellSize(player.currentMapId);
    const startCell = player.getCurrentCell(cellSize);
    player.stopMovement();
    // Public cast pose so nearby players see the rod come out; the encounter
    // itself (species, rarity) stays private to the fisher.
    this.world.emitToMap(player.currentMapId, "player:pose", {
      playerId: player.socketId,
      pose: "fishing"
    });
    try {
      // Suspense window before the bite roll; doubles as a rate limiter.
      await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 800));

      // Things can change while the line is out.
      if (this.isPlayerBattling(player.socketId)) {
        return { ok: false, message: "No puedes pescar ahora." };
      }
      const nowCell = player.getCurrentCell(cellSize);
      if (nowCell.x !== startCell.x || nowCell.y !== startCell.y) {
        return { ok: false, message: "La pesca se interrumpió al moverte." };
      }

      const biteChance = tier === "super" ? 0.9 : tier === "good" ? 0.7 : 0.5;
      if (Math.random() > biteChance) {
        return { ok: true, message: "No pica nada..." };
      }
      await this.startWildBattle(player, table, "water");
      return { ok: true, message: `¡Oh! ¡Algo ha picado en la ${item.name}!`, battleStarted: true };
    } finally {
      this.world.emitToMap(player.currentMapId, "player:pose", {
        playerId: player.socketId,
        pose: null
      });
    }
  }

  /**
   * Click-to-fish entry point: the player tapped an adjacent water tile and
   * chose "Fish". Picks the best rod they own, turns them to face the tile,
   * and reuses the standard fishing cast (spot lookup / grass fallback /
   * bite-chance). The wild battle, if any, arrives over `battle:state`.
   */
  /** Every fishing rod the user owns (validated against the item catalog). */
  public listOwnedFishingRods(user: AuthenticatedUser) {
    const rods: Array<{ item: InventoryItem; tier: FishingRodTier }> = [];
    for (const inv of user.inventory) {
      if (inv.quantity <= 0) {
        continue;
      }
      const definition = this.getCachedItemDefinition(inv.id, inv.name);
      const tier = definition
        ? FISHING_ROD_TIERS[(definition.essentialsId ?? "").toUpperCase()]
        : undefined;
      if (tier) {
        rods.push({ item: inv, tier });
      }
    }
    return rods;
  }

  public async fishAtCell(
    userId: number,
    player: Player,
    target: { x: number; y: number },
    rodItemId?: string
  ): Promise<UseInventoryItemResult> {
    const user = await this.auth.getUserForBattle(userId);
    if (!user) {
      return { ok: false, message: "No puedes pescar ahora." };
    }
    if (this.isPlayerBattling(player.socketId) || this.activeFishingSocketIds.has(player.socketId)) {
      return { ok: false, message: "No puedes pescar ahora." };
    }
    // Ensure item definitions are cached so essentialsId lookups resolve.
    await this.loadCatalogs();

    const rodOrder: Record<FishingRodTier, number> = { old: 0, good: 1, super: 2 };
    const ownedRods = this.listOwnedFishingRods(user);
    if (ownedRods.length === 0) {
      return { ok: false, message: "Necesitas una caña de pescar." };
    }
    let rod: { item: InventoryItem; tier: FishingRodTier } | null = null;
    if (typeof rodItemId === "string" && rodItemId.length > 0) {
      // Explicit rod choice: it must be one the user actually owns — a forged
      // or stale item id is rejected instead of silently swapped.
      rod = ownedRods.find((candidate) => candidate.item.id === rodItemId) ?? null;
      if (!rod) {
        return { ok: false, message: "No tienes esa caña de pescar." };
      }
    } else {
      for (const candidate of ownedRods) {
        if (!rod || rodOrder[candidate.tier] > rodOrder[rod.tier]) {
          rod = candidate;
        }
      }
    }
    if (!rod) {
      return { ok: false, message: "Necesitas una caña de pescar." };
    }

    const cellSize = this.world.getMapCellSize(player.currentMapId);
    const current = player.getCurrentCell(cellSize);
    const distance = Math.abs(current.x - target.x) + Math.abs(current.y - target.y);
    if (distance !== 1) {
      return { ok: false, message: "Acércate al agua para pescar." };
    }

    // Face the tapped tile, then run the standard facing-based cast.
    player.faceCell(target, cellSize);
    return this.useFishingRod(player, user, rod.tier, rod.item);
  }

  /**
   * Availability of the water context-menu actions for a targeted cell. This
   * only drives which menu entries light up — every action re-validates on
   * execution, so a stale/forged menu state can never grant anything.
   */
  public async getWaterActionsForCell(
    userId: number,
    player: Player,
    target: { x: number; y: number }
  ): Promise<{
    fish: {
      available: boolean;
      reason?: string;
      rods: Array<{ itemId: string; name: string; tier: FishingRodTier }>;
    };
    surf: { available: boolean; reason?: string };
    dive: { available: boolean; reason?: string };
  }> {
    await this.loadCatalogs();
    const user = await this.auth.getUserForBattle(userId);

    const cellSize = this.world.getMapCellSize(player.currentMapId);
    const current = player.getCurrentCell(cellSize);
    const distance = Math.abs(current.x - target.x) + Math.abs(current.y - target.y);
    const targetIsWater = this.world.isOpenWaterCell(player.currentMapId, target.x, target.y);
    const editorData = this.world.getPlayableMapsState()?.editorDataByMapId[templateMapIdFor(player.currentMapId)];
    const spot = (editorData?.fishingSpots ?? []).find(
      (candidate) => candidate.x === target.x && candidate.y === target.y
    );

    const rodMethod: Record<FishingRodTier, string> = {
      old: "OldRod",
      good: "GoodRod",
      super: "SuperRod"
    };
    const ownedRods = user ? this.listOwnedFishingRods(user) : [];
    const rods = ownedRods.map((rod) => ({
      itemId: rod.item.id,
      name: rod.item.name,
      tier: rod.tier
    }));

    let fish: { available: boolean; reason?: string };
    if (!targetIsWater && !spot) {
      fish = { available: false, reason: "Aquí no se puede pescar." };
    } else if (distance !== 1) {
      fish = { available: false, reason: "Acércate al agua para pescar." };
    } else if (rods.length === 0) {
      fish = { available: false, reason: "Necesitas una caña de pescar." };
    } else if (
      !spot &&
      !ownedRods.some((rod) => this.getEncounterTableForMap(player.currentMapId, rodMethod[rod.tier]))
    ) {
      fish = { available: false, reason: "No parece haber Venomon en estas aguas." };
    } else {
      fish = { available: true };
    }

    let surf: { available: boolean; reason?: string };
    if (player.isSurfing) {
      surf = { available: false, reason: "Ya estás surfeando." };
    } else if (!targetIsWater) {
      surf = { available: false, reason: "No hay agua por la que surfear." };
    } else if (distance !== 1) {
      surf = { available: false, reason: "No puedes surfear desde esta posición." };
    } else if (!(await this.partyKnowsFieldSkill(userId, "surf"))) {
      surf = { available: false, reason: "Ningún Venomon de tu equipo conoce Surf." };
    } else {
      surf = { available: true };
    }

    let dive: { available: boolean; reason?: string };
    const pair = resolveDivePair(player.currentMapId);
    if (!pair) {
      dive = { available: false, reason: "No puedes bucear aquí." };
    } else if (!(await this.partyKnowsFieldSkill(userId, "dive"))) {
      dive = { available: false, reason: "Ningún Venomon de tu equipo conoce Buceo." };
    } else if (pair.role === "surface") {
      if (!player.isSurfing || !isDeepWaterTag(this.world.getPlayerTerrainTag(player))) {
        dive = {
          available: false,
          reason: "Debes estar surfeando sobre aguas profundas para bucear."
        };
      } else {
        dive = { available: true };
      }
    } else {
      dive = { available: true }; // underwater: resurface
    }

    return { fish: { ...fish, rods }, surf, dive };
  }

  /**
   * Dowsing Machine / Itemfinder: pings the nearest hidden ground item on the
   * map, revealing it once you're on top of it.
   */
  private useDowsing(player: Player, item: InventoryItem): UseInventoryItemResult {
    const snapshot = this.world.getPlayableMapsState();
    const map = snapshot?.items.find((candidate) => candidate.id === templateMapIdFor(player.currentMapId));
    const cellSize = map?.playableMapConfig?.cellSize ?? 32;
    const nearest = this.world.findNearestHiddenGroundItem(player, cellSize);

    if (!nearest) {
      return { ok: true, message: `The ${item.name} stays silent... no response.` };
    }
    if (nearest.distanceTiles <= 1) {
      const revealed = this.world.revealGroundItem(nearest.item.id);
      return {
        ok: true,
        message: `The ${item.name} reacts! You found ${revealed?.itemName ?? "a hidden item"}!`
      };
    }
    return {
      ok: true,
      message: `The ${item.name} points ${nearest.direction} — about ${nearest.distanceTiles} tiles away.`
    };
  }

  public async teachInventoryMove(
    userId: number,
    itemId: string,
    targetPokemonId?: string,
    replaceMoveName?: string
  ) {
    const player = this.world.getPlayerByUserId(userId);
    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false, message: "You can't teach moves during a battle." };
    }

    const user = await this.auth.getUserForBattle(userId);
    const catalogs = await this.loadCatalogs();
    const item = user?.inventory.find((candidate) => candidate.id === itemId);
    const itemDefinition = this.getCachedItemDefinition(itemId, item?.name ?? "");

    if (!user || !item || !itemDefinition || item.quantity <= 0) {
      return { ok: false, message: "That move item is no longer available." };
    }

    if (item.category !== "moves" || !itemDefinition.skillName) {
      return { ok: false, message: "That item cannot teach a move." };
    }

    const targetPokemon = user.pokemonParty.find((pokemon) => pokemon.id === targetPokemonId);

    if (!targetPokemon) {
      return { ok: false, message: "Choose a Pokemon to teach." };
    }

    // The item carries the move internal (CUT) + a stale lowercased skillId; the
    // canonical stored name is the skill catalog's display name (Corte).
    const moveInternal = itemDefinition.moveInternal || itemDefinition.skillName.toUpperCase();
    const skillDefinition =
      catalogs.skillsById.get(itemDefinition.skillId) ??
      catalogs.skillsById.get(`skill-${moveInternal}`) ??
      catalogs.skillsByName.get(itemDefinition.skillName.toLowerCase());

    if (!skillDefinition) {
      return { ok: false, message: "That item cannot teach a move." };
    }

    const canonicalName = skillDefinition.name;
    const sameMove = (name: string) => name.toLowerCase() === canonicalName.toLowerCase();

    if (targetPokemon.moves.some(sameMove)) {
      return {
        ok: false,
        message: `${getPokemonDisplayName(targetPokemon)} already knows ${canonicalName}.`
      };
    }

    // Compatibility gate (tm.txt). MT, MO and Rock Smash TM are all gated when a
    // list exists; custom moves with no list stay teachable.
    const definition = targetPokemon.sourcePokemonId
      ? catalogs.pokemonById.get(targetPokemon.sourcePokemonId)
      : undefined;
    const speciesEssentialsId = (definition?.essentialsId ?? "").toUpperCase();
    if (!canSpeciesLearnMachineMove(moveInternal, speciesEssentialsId)) {
      return {
        ok: false,
        message: `${getPokemonDisplayName(targetPokemon)} can't learn ${canonicalName}.`
      };
    }

    const movePp = { ...(targetPokemon.movePp ?? {}) };
    if (targetPokemon.moves.length >= 4) {
      if (!replaceMoveName) {
        return {
          ok: false,
          needsReplace: true,
          moves: [...targetPokemon.moves],
          moveName: canonicalName,
          message: `${getPokemonDisplayName(targetPokemon)} already knows four moves. Choose one to replace.`
        };
      }
      const replaceIndex = targetPokemon.moves.indexOf(replaceMoveName);
      if (replaceIndex < 0) {
        return {
          ok: false,
          message: `${getPokemonDisplayName(targetPokemon)} does not know ${replaceMoveName}.`
        };
      }
      targetPokemon.moves = targetPokemon.moves.map((name, index) =>
        index === replaceIndex ? canonicalName : name
      );
      delete movePp[replaceMoveName];
    } else {
      targetPokemon.moves = [...targetPokemon.moves, canonicalName];
    }
    movePp[canonicalName] = skillDefinition.powerPoint;
    targetPokemon.movePp = movePp;

    // MO (HM) machines are reusable and never consumed; MT (TM) are single-use.
    const consume = itemDefinition.machineKind !== "mo";
    const nextInventory = consume
      ? this.removeInventoryQuantity(user.inventory, item.id, 1)
      : user.inventory;

    this.updateActiveBattleMoves(userId, targetPokemon, catalogs);

    const nextUser = await this.auth.saveBattleState(userId, {
      pokemonParty: user.pokemonParty,
      inventory: nextInventory
    });

    return {
      ok: true,
      user: nextUser,
      message: replaceMoveName
        ? `${getPokemonDisplayName(targetPokemon)} forgot ${replaceMoveName} and learned ${canonicalName}!`
        : `${getPokemonDisplayName(targetPokemon)} learned ${canonicalName}!`
    };
  }

  /** The localized display move name for a field skill (cut -> "Corte"), resolved
   * from the skill catalog. null when the skill/move is unknown. */
  public resolveFieldSkillMoveName(
    fieldSkill: string,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): string | null {
    const internal = FIELD_SKILL_MOVE_INTERNALS[fieldSkill.trim().toLowerCase()];
    if (!internal) {
      return null;
    }
    const skill =
      catalogs.skillsById.get(`skill-${internal}`) ??
      catalogs.skillsByName.get(internal.toLowerCase());
    return skill?.name ?? null;
  }

  /** True when any party Venomon knows the given field skill's move (Fly's
   * party-knows check, generalized and catalog-derived). */
  public async partyKnowsFieldSkill(userId: number, fieldSkill: string): Promise<boolean> {
    const user = await this.auth.getUserForBattle(userId);
    if (!user) {
      return false;
    }
    const catalogs = await this.loadCatalogs();
    const moveName = this.resolveFieldSkillMoveName(fieldSkill, catalogs);
    if (!moveName) {
      return false;
    }
    const target = moveName.trim().toLowerCase();
    // Eggs can't use field moves even if the stored summary carries moves.
    return user.pokemonParty.some(
      (pokemon) =>
        !pokemon.isEgg &&
        (pokemon.moves ?? []).some((move) => move.trim().toLowerCase() === target)
    );
  }

  public async resolveMoveLearn(
    userId: number,
    pokemonId: string,
    moveName: string,
    replaceMoveName?: string
  ) {
    const user = await this.auth.getUserForBattle(userId);
    const catalogs = await this.loadCatalogs();
    const targetPokemon = user?.pokemonParty.find((pokemon) => pokemon.id === pokemonId);

    if (!user || !targetPokemon) {
      return { ok: false, message: "That Pokemon is not in your party." };
    }

    const pending = targetPokemon.pendingMoveLearns ?? [];
    if (!pending.includes(moveName)) {
      return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} has no pending move to learn.` };
    }

    targetPokemon.pendingMoveLearns = pending.filter((name) => name !== moveName);

    if (!replaceMoveName) {
      await this.auth.saveBattleState(userId, { pokemonParty: user.pokemonParty });
      return {
        ok: true,
        user: await this.auth.getUserForBattle(userId),
        message: `${getPokemonDisplayName(targetPokemon)} did not learn ${moveName}.`
      };
    }

    const replaceIndex = targetPokemon.moves.indexOf(replaceMoveName);
    if (replaceIndex < 0) {
      return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} does not know ${replaceMoveName}.` };
    }

    const skillDefinition = catalogs.skillsByName.get(moveName.toLowerCase());
    if (!skillDefinition) {
      return { ok: false, message: `${moveName} is not a valid move.` };
    }

    targetPokemon.moves = targetPokemon.moves.map((name, index) =>
      index === replaceIndex ? moveName : name
    );
    const movePp = { ...(targetPokemon.movePp ?? {}) };
    delete movePp[replaceMoveName];
    movePp[moveName] = skillDefinition.powerPoint;
    targetPokemon.movePp = movePp;

    this.updateActiveBattleMoves(userId, targetPokemon, catalogs);
    const nextUser = await this.auth.saveBattleState(userId, { pokemonParty: user.pokemonParty });

    return {
      ok: true,
      user: nextUser,
      message: `${getPokemonDisplayName(targetPokemon)} forgot ${replaceMoveName} and learned ${moveName}!`
    };
  }

  /**
   * Stats-window move management: teaches a move the venomon is entitled to
   * at its current level — anything in its learnset up to `level`, plus any
   * pending learn left behind when a battle closed before the player
   * answered the prompt. Outside battles only.
   */
  public async learnAvailableMove(
    userId: number,
    pokemonId: string,
    moveName: string,
    replaceMoveName?: string
  ) {
    const player = this.world.getPlayerByUserId(userId);
    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false, message: "You can't manage moves during a battle." };
    }

    const user = await this.auth.getUserForBattle(userId);
    const catalogs = await this.loadCatalogs();
    const targetPokemon = user?.pokemonParty.find((pokemon) => pokemon.id === pokemonId);

    if (!user || !targetPokemon) {
      return { ok: false, message: "That Pokemon is not in your party." };
    }

    const skillDefinition = catalogs.skillsByName.get(String(moveName ?? "").toLowerCase());
    if (!skillDefinition) {
      return { ok: false, message: `${moveName} is not a valid move.` };
    }

    const canonicalName = skillDefinition.name;
    const sameMove = (name: string) => name.toLowerCase() === canonicalName.toLowerCase();

    if (targetPokemon.moves.some(sameMove)) {
      return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} already knows ${canonicalName}.` };
    }

    const pending = targetPokemon.pendingMoveLearns ?? [];
    const definition =
      (targetPokemon.sourcePokemonId
        ? catalogs.pokemonById.get(targetPokemon.sourcePokemonId)
        : undefined) ??
      this.resolvePokemonDefinition(targetPokemon.name, catalogs);
    const inLearnset = (definition?.skills ?? []).some(
      (entry) => entry.level <= targetPokemon.level && sameMove(entry.skillName)
    );

    if (!inLearnset && !pending.some(sameMove)) {
      return {
        ok: false,
        message: `${getPokemonDisplayName(targetPokemon)} can't learn ${canonicalName} at level ${targetPokemon.level}.`
      };
    }

    const movePp = { ...(targetPokemon.movePp ?? {}) };
    if (targetPokemon.moves.length >= 4) {
      if (!replaceMoveName) {
        return {
          ok: false,
          message: `${getPokemonDisplayName(targetPokemon)} already knows four moves. Choose one to replace.`
        };
      }
      const replaceIndex = targetPokemon.moves.indexOf(replaceMoveName);
      if (replaceIndex < 0) {
        return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} does not know ${replaceMoveName}.` };
      }
      targetPokemon.moves = targetPokemon.moves.map((name, index) =>
        index === replaceIndex ? canonicalName : name
      );
      delete movePp[replaceMoveName];
    } else {
      targetPokemon.moves = [...targetPokemon.moves, canonicalName];
    }
    movePp[canonicalName] = skillDefinition.powerPoint;
    targetPokemon.movePp = movePp;
    targetPokemon.pendingMoveLearns = pending.filter((name) => !sameMove(name));

    const nextUser = await this.auth.saveBattleState(userId, { pokemonParty: user.pokemonParty });

    return {
      ok: true,
      user: nextUser,
      message: replaceMoveName
        ? `${getPokemonDisplayName(targetPokemon)} forgot ${replaceMoveName} and learned ${canonicalName}!`
        : `${getPokemonDisplayName(targetPokemon)} learned ${canonicalName}!`
    };
  }

  /** Stats-window move management: forgets a known move (never the last one). */
  public async forgetMove(userId: number, pokemonId: string, moveName: string) {
    const player = this.world.getPlayerByUserId(userId);
    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false, message: "You can't manage moves during a battle." };
    }

    const user = await this.auth.getUserForBattle(userId);
    const targetPokemon = user?.pokemonParty.find((pokemon) => pokemon.id === pokemonId);

    if (!user || !targetPokemon) {
      return { ok: false, message: "That Pokemon is not in your party." };
    }

    if (!targetPokemon.moves.includes(moveName)) {
      return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} does not know ${moveName}.` };
    }

    if (targetPokemon.moves.length <= 1) {
      return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} must keep at least one move.` };
    }

    targetPokemon.moves = targetPokemon.moves.filter((name) => name !== moveName);
    const movePp = { ...(targetPokemon.movePp ?? {}) };
    delete movePp[moveName];
    targetPokemon.movePp = movePp;

    const nextUser = await this.auth.saveBattleState(userId, { pokemonParty: user.pokemonParty });

    return {
      ok: true,
      user: nextUser,
      message: `${getPokemonDisplayName(targetPokemon)} forgot ${moveName}.`
    };
  }

  private updateActiveBattleMoves(
    userId: number,
    summary: PokemonSummary,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ) {
    for (const battle of this.battles.values()) {
      if (battle.status !== "active") {
        continue;
      }

      const side = battle.sides.find((candidate) => candidate.userId === userId);
      const battlePokemon = side?.party.find((pokemon) => pokemon.id === summary.id);
      if (!side || !battlePokemon) {
        continue;
      }

      battlePokemon.moves = summary.moves
        .map((moveName) => {
          const existing = battlePokemon.moves.find((move) => move.name === moveName);
          if (existing) {
            return existing;
          }
          const skillDefinition = catalogs.skillsByName.get(moveName.toLowerCase());
          return skillDefinition
            ? this.buildBattleMove(skillDefinition, summary.movePp?.[moveName])
            : null;
        })
        .filter((move): move is BattleMove => Boolean(move))
        .slice(0, 4);
      this.emitBattleState(battle);
    }
  }

  /** Field names on PokemonSummary for each equipment slot. */
  private static readonly SLOT_FIELDS: Record<
    EquipmentSlot,
    { id: "heldItemId" | "battleItemId" | "appearanceItemId"; name: "heldItemName" | "battleItemName" | "appearanceItemName" }
  > = {
    bonus: { id: "heldItemId", name: "heldItemName" },
    battle: { id: "battleItemId", name: "battleItemName" },
    appearance: { id: "appearanceItemId", name: "appearanceItemName" }
  };

  public async setHeldItem(userId: number, pokemonId: string, itemId: string, slot?: EquipmentSlot) {
    const player = this.world.getPlayerByUserId(userId);
    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false, message: "You can't change held items during a battle." };
    }

    const user = await this.auth.getUserForBattle(userId);
    await this.loadCatalogs();
    const item = user?.inventory.find((candidate) => candidate.id === itemId);
    const itemDefinition = this.getCachedItemDefinition(itemId, item?.name ?? "");
    const targetPokemon = user?.pokemonParty.find((pokemon) => pokemon.id === pokemonId);

    if (!user || !item || !itemDefinition || item.quantity <= 0) {
      return { ok: false, message: "That item is no longer available." };
    }

    if (!targetPokemon) {
      return { ok: false, message: "Choose a Pokemon to hold the item." };
    }

    if (targetPokemon.isEgg) {
      return { ok: false, message: "An egg can't hold items." };
    }

    const naturalSlot = classifyEquipmentSlot({
      essentialsId: itemDefinition.essentialsId,
      speciesInternalId: toSpeciesInternalId(targetPokemon.sourcePokemonId, targetPokemon.name),
      heldBonus: itemDefinition.heldBonus,
      heldEffect: itemDefinition.heldEffect
    });
    if (!naturalSlot) {
      return { ok: false, message: `${itemDefinition.name} can't be equipped.` };
    }
    if (slot && slot !== naturalSlot) {
      return { ok: false, message: `${itemDefinition.name} doesn't fit in that equipment slot.` };
    }

    const fields = BattleManager.SLOT_FIELDS[naturalSlot];
    let inventory = this.removeInventoryQuantity(user.inventory, item.id, 1);
    const previousItemId = targetPokemon[fields.id];
    if (previousItemId) {
      const previousDefinition = this.getCachedItemDefinition(
        previousItemId,
        targetPokemon[fields.name] ?? ""
      );
      if (previousDefinition) {
        inventory = this.addInventoryQuantity(inventory, previousDefinition, 1);
      }
    }

    const previousAppearance =
      naturalSlot === "appearance" ? this.resolveAppearanceForSummary(targetPokemon) : null;
    targetPokemon[fields.id] = itemDefinition.id;
    targetPokemon[fields.name] = itemDefinition.name;
    if (naturalSlot === "appearance") {
      await this.applyAppearanceFormChange(targetPokemon, previousAppearance);
    }
    const nextUser = await this.auth.saveBattleState(userId, {
      pokemonParty: user.pokemonParty,
      inventory
    });

    return {
      ok: true,
      user: nextUser,
      message: `${getPokemonDisplayName(targetPokemon)} is now holding ${itemDefinition.name}.`
    };
  }

  public async reorderPokemonParty(userId: number, order: string[]) {
    const player = this.world.getPlayerByUserId(userId);
    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false, message: "You can't reorder your party during a battle." };
    }

    const user = await this.auth.getUserForBattle(userId);
    if (!user || user.pokemonParty.length === 0) {
      return { ok: false, message: "You have no Pokemon to reorder." };
    }

    const requestedIds = Array.isArray(order)
      ? order.filter((id): id is string => typeof id === "string")
      : [];
    const partyIds = new Set(user.pokemonParty.map((pokemon) => pokemon.id));
    const isFullPermutation =
      requestedIds.length === user.pokemonParty.length &&
      new Set(requestedIds).size === requestedIds.length &&
      requestedIds.every((id) => partyIds.has(id));

    if (!isFullPermutation) {
      return { ok: false, message: "That party order is not valid anymore." };
    }

    const pokemonById = new Map(user.pokemonParty.map((pokemon) => [pokemon.id, pokemon]));
    const nextParty = requestedIds.map((id) => pokemonById.get(id)!);
    const nextUser = await this.auth.savePokemonParty(userId, nextParty);

    return {
      ok: true,
      user: nextUser,
      message: `${getPokemonDisplayName(nextParty[0])} now leads your party.`
    };
  }

  public async depositPokemonToBox(userId: number, pokemonIds: string[], boxId?: string) {
    const player = this.world.getPlayerByUserId(userId);
    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false as const, message: "You can't use the storage system during a battle." };
    }

    return this.auth.depositPokemonToStorage(userId, pokemonIds, boxId);
  }

  public async withdrawPokemonFromBox(userId: number, pokemonIds: string[], boxId: string) {
    const player = this.world.getPlayerByUserId(userId);
    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false as const, message: "You can't use the storage system during a battle." };
    }

    return this.auth.withdrawPokemonFromStorage(userId, pokemonIds, boxId);
  }

  public async takeHeldItem(userId: number, pokemonId: string, slot: EquipmentSlot = "bonus") {
    const player = this.world.getPlayerByUserId(userId);
    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false, message: "You can't change held items during a battle." };
    }

    const user = await this.auth.getUserForBattle(userId);
    await this.loadCatalogs();
    const targetPokemon = user?.pokemonParty.find((pokemon) => pokemon.id === pokemonId);

    if (!user || !targetPokemon) {
      return { ok: false, message: "That Pokemon is not in your party." };
    }

    const fields = BattleManager.SLOT_FIELDS[slot] ?? BattleManager.SLOT_FIELDS.bonus;
    const equippedItemId = targetPokemon[fields.id];
    if (!equippedItemId) {
      return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} is not holding anything.` };
    }

    const itemDefinition = this.getCachedItemDefinition(
      equippedItemId,
      targetPokemon[fields.name] ?? ""
    );
    const itemName = targetPokemon[fields.name] ?? itemDefinition?.name ?? "its item";
    const inventory = itemDefinition
      ? this.addInventoryQuantity(user.inventory, itemDefinition, 1)
      : user.inventory;

    const previousAppearance =
      slot === "appearance" ? this.resolveAppearanceForSummary(targetPokemon) : null;
    targetPokemon[fields.id] = undefined;
    targetPokemon[fields.name] = undefined;
    if (slot === "appearance") {
      await this.applyAppearanceFormChange(targetPokemon, previousAppearance);
    }
    const nextUser = await this.auth.saveBattleState(userId, {
      pokemonParty: user.pokemonParty,
      inventory
    });

    return {
      ok: true,
      user: nextUser,
      message: `You took ${itemName} from ${getPokemonDisplayName(targetPokemon)}.`
    };
  }

  public async throwInventoryItem(
    userId: number,
    itemId: string,
    quantity: number,
    player: Player
  ) {
    const user = await this.auth.getUserForBattle(userId);
    await this.loadCatalogs();
    const item = user?.inventory.find((candidate) => candidate.id === itemId);
    const itemDefinition = this.getCachedItemDefinition(itemId, item?.name ?? "");
    const throwQuantity = Math.max(1, Math.round(quantity));

    if (!user || !item || !itemDefinition || item.quantity <= 0) {
      return { ok: false, message: "That item is no longer available." };
    }

    if (throwQuantity > item.quantity) {
      return { ok: false, message: "You do not have that many to throw away." };
    }

    if (itemDefinition.essentialsId === RUNNING_SHOES_DEFINITION.essentialsId) {
      // Mamá's gift only fires once (self switch A) — tossing the shoes would
      // permanently lock the player out of running. Key items can't be tossed.
      return { ok: false, message: "Es demasiado importante para tirarlo." };
    }

    const nextInventory = this.removeInventoryQuantity(user.inventory, item.id, throwQuantity);
    const nextUser = await this.auth.saveInventory(userId, nextInventory);
    const droppedItem = this.world.dropGroundItem({
      itemId: itemDefinition.id,
      itemName: itemDefinition.name,
      category: itemDefinition.category,
      description: itemDefinition.description,
      iconSrc: itemDefinition.iconSrc,
      quantity: throwQuantity,
      mapId: player.currentMapId,
      x: player.x,
      y: player.y
    });

    return {
      ok: true,
      user: nextUser,
      droppedItem,
      message: `You threw away ${itemDefinition.name} x${throwQuantity}.`
    };
  }

  public async healPartyAtNpc(userId: number, npcPlacementId?: string) {
    const interaction = this.resolveNpcInteraction(userId, npcPlacementId);

    if (!interaction.ok) {
      return interaction;
    }

    const user = await this.auth.getUserForBattle(userId);
    const catalogs = await this.loadCatalogs();
    const npc = this.cachedNpcDefinitions.get(interaction.placement.npcId);

    if (!user || !npc || npc.npcType !== "healer") {
      return { ok: false, message: "That healer is unavailable right now." };
    }

    if (user.pokemonParty.length === 0) {
      return { ok: false, message: "You do not have a Pokemon team to heal." };
    }

    if (user.money < npc.healPrice) {
      return {
        ok: false,
        message: `${npc.name} charges $${npc.healPrice} to heal your team.`
      };
    }

    if (this.isPartyFullyHealed(user.pokemonParty, catalogs.skillsByName)) {
      return { ok: false, message: "Your Pokemon team is already fully healed." };
    }

    const healedParty = user.pokemonParty.map((pokemon) => ({
      ...pokemon,
      hp: pokemon.maxHp,
      movePp: this.restorePokemonMovePp(pokemon, catalogs.skillsByName)
    }));
    const nextUser = await this.auth.saveBattleState(userId, {
      pokemonParty: healedParty,
      money: user.money - npc.healPrice
    });

    return {
      ok: true,
      user: nextUser,
      message: `${npc.name} fully healed your team for $${npc.healPrice}.`
    };
  }

  /**
   * Items a player may currently trade at this placement: a designer store
   * NPC's stock, or — for imported Essentials mart events — the live
   * pbPokemonMart session registered by the event runtime.
   */
  private resolveStoreStock(userId: number, placement: { id: string; npcId: string }) {
    const npc = this.cachedNpcDefinitions.get(placement.npcId);

    if (npc?.npcType === "store") {
      return npc.storeItems;
    }

    return this.eventMartResolver?.(userId, placement.id) ?? null;
  }

  public setEventMartResolver(
    resolver: (userId: number, placementId: string) => NpcStoreDefinition[] | null
  ) {
    this.eventMartResolver = resolver;
  }

  /** Resolve pbPokemonMart Essentials symbols (:POTION) to store stock rows. */
  public async resolveMartItems(essentialsSymbols: string[]): Promise<NpcStoreDefinition[]> {
    await this.loadCatalogs();

    const items: NpcStoreDefinition[] = [];
    for (const symbol of essentialsSymbols) {
      const lowered = symbol.trim().toLowerCase();
      if (!lowered) continue;
      const definition = this.cachedItemDefinitions.find(
        (candidate) =>
          candidate.essentialsId.toLowerCase() === lowered ||
          candidate.id === `item-${lowered}`
      );
      if (!definition || definition.price <= 0) {
        continue;
      }
      items.push({
        itemId: definition.id,
        itemName: definition.name,
        quantity: 1,
        price: definition.price
      });
    }
    return items;
  }

  public async buyFromNpcStore(
    userId: number,
    npcPlacementId?: string,
    itemId?: string,
    quantity?: number
  ) {
    const interaction = this.resolveNpcInteraction(userId, npcPlacementId);

    if (!interaction.ok) {
      return interaction;
    }

    const user = await this.auth.getUserForBattle(userId);
    await this.loadCatalogs();
    const storeStock = this.resolveStoreStock(userId, interaction.placement);
    const purchaseCount =
      typeof quantity === "number" && Number.isFinite(quantity)
        ? Math.max(1, Math.round(quantity))
        : 1;
    const storeItem = storeStock?.find((candidate) => candidate.itemId === itemId);
    const itemDefinition = storeItem
      ? this.getCachedItemDefinition(storeItem.itemId, storeItem.itemName)
      : null;

    if (!user || !storeStock) {
      return { ok: false, message: "That store is unavailable right now." };
    }

    if (!storeItem || !itemDefinition) {
      return { ok: false, message: "That item is not available in this store." };
    }

    const totalPrice = storeItem.price * purchaseCount;

    if (user.money < totalPrice) {
      return { ok: false, message: "You do not have enough money for that purchase." };
    }

    const totalQuantity = storeItem.quantity * purchaseCount;
    const nextInventory = this.addInventoryQuantity(user.inventory, itemDefinition, totalQuantity);
    const nextUser = await this.auth.saveBattleState(userId, {
      inventory: nextInventory,
      money: user.money - totalPrice
    });

    return {
      ok: true,
      user: nextUser,
      message: `You bought ${itemDefinition.name} x${totalQuantity} for $${totalPrice}.`
    };
  }

  /**
   * Per-unit prices this store pays for everything currently in the player's
   * bag. Players don't hold the item catalog client-side, so the sell list's
   * prices have to come from here.
   */
  public async getNpcStoreSellQuotes(userId: number, npcPlacementId?: string) {
    const interaction = this.resolveNpcInteraction(userId, npcPlacementId);

    if (!interaction.ok) {
      return interaction;
    }

    const user = await this.auth.getUserForBattle(userId);
    await this.loadCatalogs();
    const storeStock = this.resolveStoreStock(userId, interaction.placement);

    if (!user || !storeStock) {
      return { ok: false as const, message: "That store is unavailable right now." };
    }

    const quotes = user.inventory
      .filter((item) => item.quantity > 0)
      .map((item) => {
        const definition = this.getCachedItemDefinition(item.id, item.name);

        if (!definition || !this.isItemSellableToStores(definition)) {
          return null;
        }

        const sellPrice = this.getStoreUnitBuybackPrice(definition, storeStock);

        if (sellPrice <= 0) {
          return null;
        }

        return {
          itemId: item.id,
          itemName: item.name,
          quantity: item.quantity,
          sellPrice
        };
      })
      .filter((quote): quote is NonNullable<typeof quote> => Boolean(quote));

    return { ok: true as const, quotes };
  }

  public async sellToNpcStore(
    userId: number,
    npcPlacementId?: string,
    itemId?: string,
    quantity?: number
  ) {
    const interaction = this.resolveNpcInteraction(userId, npcPlacementId);

    if (!interaction.ok) {
      return interaction;
    }

    const user = await this.auth.getUserForBattle(userId);
    await this.loadCatalogs();
    const storeStock = this.resolveStoreStock(userId, interaction.placement);
    const sellCount =
      typeof quantity === "number" && Number.isFinite(quantity)
        ? Math.max(1, Math.round(quantity))
        : 1;
    const inventoryItem = user?.inventory.find((candidate) => candidate.id === itemId);

    if (!user || !storeStock) {
      return { ok: false, message: "That store is unavailable right now." };
    }

    if (!inventoryItem || inventoryItem.quantity < sellCount) {
      return { ok: false, message: "You do not have that many items to sell." };
    }

    const itemDefinition = this.getCachedItemDefinition(inventoryItem.id, inventoryItem.name);

    if (!itemDefinition || !this.isItemSellableToStores(itemDefinition)) {
      return { ok: false, message: "This store does not buy that item." };
    }

    const sellPricePerUnit = this.getStoreUnitBuybackPrice(itemDefinition, storeStock);

    if (sellPricePerUnit <= 0) {
      return { ok: false, message: "This store is not buying that item right now." };
    }

    const totalPrice = sellPricePerUnit * sellCount;
    const nextInventory = this.removeInventoryQuantity(user.inventory, inventoryItem.id, sellCount);
    const nextUser = await this.auth.saveBattleState(userId, {
      inventory: nextInventory,
      money: user.money + totalPrice
    });

    return {
      ok: true,
      user: nextUser,
      message: `You sold ${inventoryItem.name} x${sellCount} for $${totalPrice}.`
    };
  }

  /**
   * Grants an item from a map event script (pbItemBall / pbReceiveItem /
   * pbStoreItem). The item is referenced either by its Essentials symbol
   * (:POTION / PBItems::POTION) or by a legacy numeric id read from an event
   * variable (apricorn trees do `pbItemBall(pbGet(1))`).
   */
  /**
   * Quantity of an Essentials-referenced item (`:OLDSEAMAP` / `PBItems::X`)
   * in the player's bag. Key-item route gates ($PokemonBag.pbQuantity(...)>0
   * conditions) resolve through this; an item the catalogs don't know counts
   * as 0 so the gate fails closed instead of silently opening.
   */
  public async getEventItemQuantity(userId: number, symbol: string): Promise<number> {
    await this.loadCatalogs();

    const lowered = symbol.trim().toLowerCase();
    if (!lowered) {
      return 0;
    }

    const definition = this.cachedItemDefinitions.find(
      (candidate) =>
        candidate.essentialsId.toLowerCase() === lowered ||
        candidate.id === `item-${lowered}`
    );
    if (!definition) {
      return 0;
    }

    const user = await this.auth.getUserForBattle(userId);
    return user?.inventory.find((item) => item.id === definition.id)?.quantity ?? 0;
  }

  /**
   * Resolves an event-script item reference (Essentials symbol or legacy
   * pre-v20 numeric id) against the item catalog. Shared by grants, removals
   * and the choose-item-from-list dialog (which needs display names).
   */
  public async findEventItemDefinition(ref: {
    symbol?: string;
    legacyNumber?: number;
  }): Promise<ItemDefinition | null> {
    await this.loadCatalogs();

    const symbol =
      ref.symbol ??
      (typeof ref.legacyNumber === "number"
        ? LEGACY_ITEM_INTERNAL_BY_NUMBER[ref.legacyNumber]
        : undefined);
    const lowered = symbol?.trim().toLowerCase();
    if (!lowered) {
      return null;
    }

    return (
      this.cachedItemDefinitions.find(
        (candidate) =>
          candidate.essentialsId.toLowerCase() === lowered ||
          candidate.id === `item-${lowered}`
      ) ?? null
    );
  }

  public async grantEventItem(
    userId: number,
    ref: { symbol?: string; legacyNumber?: number },
    quantity = 1
  ): Promise<{ ok: false } | { ok: true; itemName: string }> {
    const definition = await this.findEventItemDefinition(ref);
    const user = await this.auth.getUserForBattle(userId);
    if (!definition || !user) {
      return { ok: false };
    }

    const inventory = this.addInventoryQuantity(user.inventory, definition, quantity);
    await this.auth.saveInventory(userId, inventory);
    return { ok: true, itemName: definition.name };
  }

  /**
   * Removes items handed to an NPC by an event script ($PokemonBag
   * .pbDeleteItem): Kurt taking an apricorn, the fossil reviver taking the
   * fossil, the move tutor taking a Heart Scale.
   */
  public async removeEventItem(
    userId: number,
    ref: { symbol?: string; legacyNumber?: number },
    quantity = 1
  ): Promise<{ ok: false } | { ok: true; itemName: string }> {
    const definition = await this.findEventItemDefinition(ref);
    const user = await this.auth.getUserForBattle(userId);
    if (!definition || !user) {
      return { ok: false };
    }

    const removeQuantity = Math.max(1, Math.round(quantity));
    const inventory = user.inventory
      .map((item) =>
        item.id === definition.id
          ? { ...item, quantity: item.quantity - removeQuantity }
          : item
      )
      .filter((item) => item.quantity > 0);
    await this.auth.saveInventory(userId, inventory);
    return { ok: true, itemName: definition.name };
  }

  public async pickUpGroundItem(player: Player, groundItem: GroundItem) {
    if (typeof player.userId !== "number") {
      return false;
    }

    const user = await this.auth.getUserForBattle(player.userId);
    await this.loadCatalogs();
    const itemDefinition = this.getCachedItemDefinition(groundItem.itemId, groundItem.itemName);

    if (!user || !itemDefinition) {
      return false;
    }

    const inventory = this.addInventoryQuantity(user.inventory, itemDefinition, groundItem.quantity);
    const nextUser = await this.auth.saveInventory(player.userId, inventory);

    this.emitToPlayer(player, "auth:session", {
      authenticated: true,
      user: nextUser,
      token: undefined
    });
    this.emitToPlayer(player, "auth:info", {
      message: `You have pick up ${itemDefinition.name} x${groundItem.quantity}`
    });

    return true;
  }

  public handlePlayerStep(player: Player) {
    if (player.userId === null || this.isPlayerBattling(player.socketId)) {
      return;
    }
    if (this.isPlayerTrading(player.userId)) {
      return; // a wild encounter must not touch Venomon reserved by a trade
    }
    if (this.activeFishingSocketIds.has(player.socketId)) {
      return; // a cast is in flight — no step encounters until it resolves
    }

    const step = this.getStepEncounterForPlayer(player);
    if (!step) {
      this.lastGrassCellByPlayerId.delete(player.socketId);
      return;
    }

    if (this.lastGrassCellByPlayerId.get(player.socketId) === step.key) {
      return;
    }

    this.lastGrassCellByPlayerId.set(player.socketId, step.key);

    // Repel: a charge is spent only where an encounter could have happened
    // (each NEW encounter tile the player reaches — grass, surf water,
    // underwater floors); walking anywhere else costs nothing. While it
    // lasts the encounter is suppressed.
    const repelSteps = this.repelStepsByUserId.get(player.userId) ?? 0;
    if (repelSteps > 0) {
      const remaining = repelSteps - 1;
      if (remaining > 0) {
        this.repelStepsByUserId.set(player.userId, remaining);
      } else {
        this.repelStepsByUserId.delete(player.userId);
        this.emitToPlayer(player, "auth:info", { message: "El repelente se ha agotado." });
      }
      this.emitToPlayer(player, "player:repel-state", { steps: remaining });
      void this.auth.saveRepelSteps(player.userId, remaining).catch((error) => {
        console.error("Unable to persist repel steps:", error);
      });
      return;
    }

    if (Math.random() * 100 >= step.encounterRate) {
      return;
    }

    if (this.pendingStepChecks.has(player.socketId)) {
      return;
    }

    this.pendingStepChecks.add(player.socketId);
    void this.startWildBattle(player, step.table, step.context)
      .catch((error) => {
        console.error("Unable to start wild battle:", error);
        this.emitToPlayer(player, "battle:error", { message: "Unable to start a wild battle." });
      })
      .finally(() => {
        this.pendingStepChecks.delete(player.socketId);
        // If the battle never materialized, release anything that queued
        // behind the pending flag (a trap event fired on the same step).
        if (!this.isPlayerBattling(player.socketId)) {
          this.world.notifyPlayerLeftBattle(player);
        }
      });
  }

  /**
   * Which encounter pool (if any) the player's current cell rolls against.
   * Kept strictly per traversal mode so the pools never bleed into each other:
   * - surfing        -> the map's Essentials "Water" table (water density)
   * - walking (land) -> derived tall-grass cells (Land table)
   * - cave-style map -> the map's "Cave" table on ANY walked tile, mirroring
   *   Essentials' has_cave_encounters? rule (cave maps have no grass tiles)
   * - underwater map -> the underwater map's own "Land" table, the old
   *   Essentials convention for underwater encounters (their floors have no
   *   grass terrain tag, so no grass cells were derived there)
   */
  private getStepEncounterForPlayer(player: Player): {
    key: string;
    encounterRate: number;
    context: BattleBackContext;
    table: {
      pokemonIds: string[];
      minLevel: number;
      maxLevel: number;
      encounterRows?: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }>;
    };
  } | null {
    const cellSize = this.world.getMapCellSize(player.currentMapId);
    const cellX = Math.floor((player.x + player.width / 2) / cellSize);
    const cellY = Math.floor((player.y + player.height / 2) / cellSize);

    if (player.isSurfing) {
      // world.handlePlayerStep dismounts before this runs, so a surfing
      // player is always on a surfable water tag here.
      const table = this.getEncounterTableForMap(player.currentMapId, "Water");
      if (!table) {
        return null;
      }
      return {
        key: `water:${player.currentMapId}:${cellX}:${cellY}`,
        encounterRate: table.encounterRate,
        context: "water",
        table: { pokemonIds: [], minLevel: 1, maxLevel: 100, encounterRows: table.rows }
      };
    }

    const grass = this.getGrassCellForPlayer(player);
    if (grass) {
      return {
        key: `grass:${player.currentMapId}:${grass.x}:${grass.y}`,
        encounterRate: grass.encounterRate,
        context: "grass",
        table: grass
      };
    }

    const cave = this.getEncounterTableForMap(player.currentMapId, "Cave");
    if (cave) {
      return {
        key: `cave:${player.currentMapId}:${cellX}:${cellY}`,
        encounterRate: cave.encounterRate,
        context: "cave",
        table: { pokemonIds: [], minLevel: 1, maxLevel: 100, encounterRows: cave.rows }
      };
    }

    if (resolveDivePair(player.currentMapId)?.role === "underwater") {
      const table = this.getEncounterTableForMap(player.currentMapId, "Land");
      if (table) {
        return {
          key: `underwater:${player.currentMapId}:${cellX}:${cellY}`,
          encounterRate: table.encounterRate,
          context: "underwater",
          table: { pokemonIds: [], minLevel: 1, maxLevel: 100, encounterRows: table.rows }
        };
      }
    }

    return null;
  }

  /**
   * Advances any egg in the player's party by one walked tile. Unlike wild
   * encounters this fires on EVERY tile (not just grass), so it lives in its
   * own handler with its own per-cell dedupe. Auth.tickEggSteps fast-skips
   * players with no egg, so the common case costs a single Map lookup.
   */
  public handleEggStep(player: Player) {
    if (player.userId === null || this.isPlayerBattling(player.socketId)) {
      return;
    }

    const cellSize = 32;
    const cellX = Math.floor((player.x + player.width / 2) / cellSize);
    const cellY = Math.floor((player.y + player.height / 2) / cellSize);
    const cellKey = `${player.currentMapId}:${cellX}:${cellY}`;
    if (this.lastEggStepCellByPlayerId.get(player.socketId) === cellKey) {
      return;
    }
    this.lastEggStepCellByPlayerId.set(player.socketId, cellKey);

    if (this.pendingEggTicks.has(player.socketId)) {
      return;
    }
    this.pendingEggTicks.add(player.socketId);

    const userId = player.userId;
    void this.auth
      .tickEggSteps(userId)
      .then((result) => {
        if (result.hatched.length === 0) {
          return;
        }
        if (result.user) {
          this.emitToPlayer(player, "auth:session", {
            authenticated: true,
            user: result.user,
            token: undefined
          });
        }
        for (const egg of result.hatched) {
          this.emitToPlayer(player, "auth:info", {
            message: `¡Tu Huevo ha eclosionado en ${egg.name}!`
          });
        }
      })
      .catch((error) => {
        console.error("Unable to advance egg steps:", error);
      })
      .finally(() => {
        this.pendingEggTicks.delete(player.socketId);
      });
  }

  /**
   * Restores the persisted repel charge for a (re)joining player so an active
   * repellent survives logouts, reconnects and character switches.
   */
  public async loadRepelStateForPlayer(player: Player) {
    if (player.userId === null) {
      return;
    }
    const steps = await this.auth.getRepelSteps(player.userId);
    if (steps > 0) {
      this.repelStepsByUserId.set(player.userId, steps);
    } else {
      this.repelStepsByUserId.delete(player.userId);
    }
    this.emitToPlayer(player, "player:repel-state", { steps });
  }

  public requestChallenge(socketId: string, payload: BattleChallengePayload) {
    const challenger = this.world.getPlayerBySocket(socketId);
    const target = this.world.players.get(payload?.targetPlayerId);

    if (!challenger || !target || challenger.socketId === target.socketId) {
      this.emitToSocket(socketId, "battle:error", { message: "That trainer is unavailable." });
      return;
    }

    if (challenger.userId === null || target.userId === null) {
      this.emitToSocket(socketId, "battle:error", { message: "Both trainers must be logged in to battle." });
      return;
    }

    if (challenger.currentMapId !== target.currentMapId) {
      this.emitToSocket(socketId, "battle:error", { message: "That trainer is on another map." });
      return;
    }

    if (this.isPlayerBattling(challenger.socketId) || this.isPlayerBattling(target.socketId)) {
      this.emitToSocket(socketId, "battle:error", { message: "One of the trainers is already battling." });
      return;
    }

    if (this.isPlayerTrading(challenger.userId) || this.isPlayerTrading(target.userId)) {
      this.emitToSocket(socketId, "battle:error", {
        message: "One of the trainers is in the middle of a trade."
      });
      return;
    }

    const challengeId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      this.challenges.delete(challengeId);
      this.emitToPlayer(challenger, "battle:challenge-expired", { challengeId });
    }, 30_000);

    this.challenges.set(challengeId, {
      id: challengeId,
      challengerPlayerId: challenger.socketId,
      targetPlayerId: target.socketId,
      timeout
    });

    this.emitToPlayer(target, "battle:challenge-received", {
      challengeId,
      fromPlayerId: challenger.socketId,
      fromUsername: challenger.username || challenger.name || "Trainer"
    });
    this.emitToPlayer(challenger, "battle:challenge-sent", {
      challengeId,
      targetPlayerId: target.socketId,
      targetUsername: target.username || target.name || "Trainer"
    });
  }

  public respondToChallenge(socketId: string, payload: BattleChallengeResponsePayload) {
    const request = this.challenges.get(payload?.challengeId);
    const target = request ? this.world.players.get(request.targetPlayerId) : undefined;
    const challenger = request ? this.world.players.get(request.challengerPlayerId) : undefined;
    const responder = this.world.getPlayerBySocket(socketId);

    if (!request || !target || !challenger || responder?.socketId !== target.socketId) {
      this.emitToSocket(socketId, "battle:error", { message: "That battle challenge is no longer available." });
      return;
    }

    clearTimeout(request.timeout);
    this.challenges.delete(request.id);

    if (!payload.accepted) {
      this.emitToPlayer(challenger, "battle:challenge-declined", {
        challengeId: request.id,
        targetPlayerId: target.socketId
      });
      return;
    }

    // Either side may have entered a trade while the challenge sat pending.
    if (this.isPlayerTrading(challenger.userId) || this.isPlayerTrading(target.userId)) {
      this.emitToSocket(socketId, "battle:error", {
        message: "One of the trainers is in the middle of a trade."
      });
      return;
    }

    void this.startTrainerBattle(challenger, target).catch((error) => {
      console.error("Unable to start trainer battle:", error);
      this.emitToPlayer(challenger, "battle:error", { message: "Unable to start trainer battle." });
      this.emitToPlayer(target, "battle:error", { message: "Unable to start trainer battle." });
    });
  }

  public requestTrade(socketId: string, payload: BattleTradeRequestPayload) {
    const requester = this.world.getPlayerBySocket(socketId);
    const target = this.world.players.get(payload?.targetPlayerId);

    if (!requester || !target || requester.socketId === target.socketId) {
      this.emitToSocket(socketId, "battle:error", { message: "That trainer is unavailable." });
      return;
    }

    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      this.tradeRequests.delete(requestId);
      this.emitToPlayer(requester, "battle:trade-expired", { requestId });
    }, 30_000);

    this.tradeRequests.set(requestId, {
      id: requestId,
      requesterPlayerId: requester.socketId,
      targetPlayerId: target.socketId,
      timeout
    });

    this.emitToPlayer(target, "battle:trade-request-received", {
      requestId,
      fromPlayerId: requester.socketId,
      fromUsername: requester.username || requester.name || "Trainer"
    });
    this.emitToPlayer(requester, "battle:trade-request-sent", {
      requestId,
      targetPlayerId: target.socketId,
      targetUsername: target.username || target.name || "Trainer"
    });
  }

  public respondToTrade(socketId: string, payload: BattleTradeResponsePayload) {
    const request = this.tradeRequests.get(payload?.requestId);
    const target = request ? this.world.players.get(request.targetPlayerId) : undefined;
    const requester = request ? this.world.players.get(request.requesterPlayerId) : undefined;
    const responder = this.world.getPlayerBySocket(socketId);

    if (!request || !target || !requester || responder?.socketId !== target.socketId) {
      this.emitToSocket(socketId, "battle:error", { message: "That trade request is no longer available." });
      return;
    }

    clearTimeout(request.timeout);
    this.tradeRequests.delete(request.id);

    const eventName = payload.accepted ? "battle:trade-accepted" : "battle:trade-declined";
    this.emitToPlayer(requester, eventName, {
      requestId: request.id,
      targetPlayerId: target.socketId
    });
    this.emitToPlayer(target, eventName, {
      requestId: request.id,
      targetPlayerId: target.socketId
    });
  }

  public submitAction(socketId: string, request: BattleActionRequest) {
    const player = this.world.getPlayerBySocket(socketId);
    const battle = request?.battleId ? this.battles.get(request.battleId) : undefined;

    if (!player || !battle || battle.status !== "active") {
      this.emitToSocket(socketId, "battle:error", { message: "That battle is no longer active." });
      return;
    }

    const side = this.getBattleSideForPlayer(battle, player.socketId);
    if (!side) {
      return;
    }

    if (battle.replacementRequest?.sideId === side.id) {
      this.submitReplacementChoice(battle, side, socketId, request.action);
      return;
    }

    if (side.action) {
      return;
    }

    const action = this.sanitizeAction(request.action);
    if (!action || !this.canSideAct(side)) {
      this.emitToSocket(socketId, "battle:error", { message: "That action cannot be used right now." });
      return;
    }

    const validationMessage = this.validateAction(battle, side, action);
    if (validationMessage) {
      this.emitToSocket(socketId, "battle:error", { message: validationMessage });
      return;
    }

    side.action = action;
    this.emitBattleState(battle);

    const aiSide = battle.sides.find((candidate) => candidate.isAi);
    if (aiSide) {
      aiSide.action = this.chooseAiAction(aiSide, side);
      void this.resolveTurn(battle);
      return;
    }

    if (battle.sides.every((candidate) => candidate.action !== null)) {
      this.clearBattleTimer(battle);
      void this.resolveTurn(battle);
    }
  }

  private getGrassCellForPlayer(player: Player) {
    const snapshot = this.world.getPlayableMapsState();
    const map = snapshot?.items.find((item) => item.id === templateMapIdFor(player.currentMapId));
    const editorData = snapshot?.editorDataByMapId[templateMapIdFor(player.currentMapId)];
    const cellSize = map?.playableMapConfig?.cellSize ?? 32;

    if (!editorData || editorData.grass.length === 0) {
      return null;
    }

    const cellX = Math.floor((player.x + player.width / 2) / cellSize);
    const cellY = Math.floor((player.y + player.height / 2) / cellSize);

    const cell = editorData.grass.find((grass) => grass.x === cellX && grass.y === cellY) ?? null;
    if (!cell) {
      return null;
    }

    // Imported maps store the (identical) weighted encounter table once, on
    // a single carrier cell, instead of copying it onto every cell — the
    // duplication was ~16MB of the maps payload. Fall back to that table.
    type GrassWithRows = typeof cell & {
      encounterRows?: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }>;
    };
    const cellWithRows = cell as GrassWithRows;
    if (!cellWithRows.encounterRows?.length) {
      const carrier = (editorData.grass as GrassWithRows[]).find(
        (candidate) => candidate.encounterRows?.length
      );
      if (carrier) {
        return {
          ...cell,
          encounterRows: carrier.encounterRows,
          pokemonIds: cell.pokemonIds.length > 0 ? cell.pokemonIds : carrier.pokemonIds
        };
      }
    }
    return cell;
  }

  private async startWildBattle(
    player: Player,
    grass: {
      pokemonIds: string[];
      minLevel: number;
      maxLevel: number;
      encounterRows?: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }>;
    },
    context?: BattleBackContext
  ) {
    if (player.userId === null || (grass.pokemonIds.length === 0 && !(grass.encounterRows?.length))) {
      return;
    }

    const user = await this.auth.getUserForBattle(player.userId);
    if (!user) {
      return;
    }

    const catalogs = await this.loadCatalogs();
    const playerSide = this.buildPlayerSide("a", player, user, catalogs);

    // Weighted Essentials slot rows take precedence over the flat species list.
    let sourcePokemonId: string;
    let minLevel = grass.minLevel;
    let maxLevel = grass.maxLevel;
    const rows = (grass.encounterRows ?? []).filter(
      (row) => row && typeof row.pokemonId === "string" && row.weight > 0
    );
    if (rows.length > 0) {
      const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
      let roll = Math.random() * totalWeight;
      let chosen = rows[rows.length - 1];
      for (const row of rows) {
        roll -= row.weight;
        if (roll <= 0) {
          chosen = row;
          break;
        }
      }
      sourcePokemonId = chosen.pokemonId;
      minLevel = Math.max(1, Math.round(chosen.minLevel || grass.minLevel));
      maxLevel = Math.max(minLevel, Math.round(chosen.maxLevel || chosen.minLevel || grass.maxLevel));
    } else {
      sourcePokemonId = chooseRandom(grass.pokemonIds);
    }

    const pokemonDefinition = catalogs.pokemonById.get(sourcePokemonId);

    if (!pokemonDefinition || !this.hasAvailablePokemon(playerSide)) {
      return;
    }

    const level = clamp(
      minLevel + Math.floor(Math.random() * (Math.max(minLevel, maxLevel) - minLevel + 1)),
      1,
      100
    );
    const wildPokemon = this.buildWildPokemon(pokemonDefinition, level, catalogs.skillsById);
    const wildSide: BattleSide = {
      id: "b",
      isAi: true,
      trainerName: "Wild Pokemon",
      money: 0,
      inventory: [],
      party: [wildPokemon],
      activeIndex: 0,
      action: null,
      escapeAttempts: 0
    };

    const battle = this.createBattle(
      "wild",
      playerSide,
      wildSide,
      [`A wild ${getPokemonDisplayName(wildPokemon)} appeared.`],
      this.resolveBattleBackForPlayer(player, context)
    );

    this.activateBattle(battle);
  }

  /** Starts a battle against a map-placed NPC trainer using its designer roster. */
  public async startNpcTrainerBattle(userId: number, npcPlacementId?: string) {
    const interaction = this.resolveNpcInteraction(userId, npcPlacementId);
    if (!interaction.ok) {
      return interaction;
    }

    const player = interaction.player;
    if (this.isPlayerBattling(player.socketId)) {
      return { ok: false as const, message: "You are already in a battle." };
    }

    const user = await this.auth.getUserForBattle(userId);
    const catalogs = await this.loadCatalogs();
    const npc = this.cachedNpcDefinitions.get(interaction.placement.npcId);

    if (!user || !npc || npc.npcType !== "trainer" || npc.trainerPokemons.length === 0) {
      return { ok: false as const, message: "That trainer is not ready to battle." };
    }

    const playerSide = this.buildPlayerSide("a", player, user, catalogs);
    if (!this.hasAvailablePokemon(playerSide)) {
      return { ok: false as const, message: "Your team has no Pokemon able to battle." };
    }

    const party = npc.trainerPokemons
      .map((entry) => this.buildNpcTrainerPokemon(entry, catalogs))
      .filter((pokemon): pokemon is BattlePokemon => Boolean(pokemon));

    if (party.length === 0) {
      return { ok: false as const, message: "That trainer has no valid team." };
    }

    const trainerDisplayName =
      npc.trainerTypeName &&
      !npc.name.toLowerCase().includes(npc.trainerTypeName.toLowerCase())
        ? `${npc.trainerTypeName} ${npc.name}`
        : npc.name;
    const npcSide: BattleSide = {
      id: "b",
      isAi: true,
      trainerName: trainerDisplayName,
      money: await this.computeNpcTrainerPrize(npc, party),
      inventory: [],
      party,
      activeIndex: 0,
      action: null,
      escapeAttempts: 0
    };

    const battle = this.createBattle(
      "trainer",
      playerSide,
      npcSide,
      [
        `${trainerDisplayName} wants to battle!`,
        `${trainerDisplayName} sent out ${getPokemonDisplayName(party[0])}.`
      ],
      this.resolveBattleBackForPlayer(player)
    );

    this.activateBattle(battle);
    return { ok: true as const, message: `${trainerDisplayName} wants to battle!` };
  }

  /**
   * Starts a trainer battle from an RPG Maker event script:
   * `pbTrainerBattle(PBTrainers::TYPE, "Name", ...)`. The roster comes from
   * the imported `trainers` designer section (PBS trainers.txt).
   */
  public async startScriptedTrainerBattle(
    userId: number,
    trainerTypeEssentialsId: string,
    trainerName: string
  ): Promise<
    | { ok: true; battleId: string; playerSideId: string }
    | { ok: false; message: string }
  > {
    const player = this.world.getPlayerByUserId(userId);
    if (!player) {
      return { ok: false, message: "Enter the world before battling." };
    }
    if (this.isPlayerBattling(player.socketId)) {
      return { ok: false, message: "You are already in a battle." };
    }

    const user = await this.auth.getUserForBattle(userId);
    const catalogs = await this.loadCatalogs();
    if (!user) {
      return { ok: false, message: "Account not found." };
    }

    const trainersPayload = await this.designerSectionStore.read("trainers");
    const wanted = `${trainerTypeEssentialsId}/${trainerName}`.toLowerCase();
    const record = (trainersPayload?.state.items ?? []).find((item) => {
      const profile = item.trainerProfile as
        | { trainerTypeEssentialsId?: string; name?: string }
        | undefined;
      return (
        profile &&
        `${profile.trainerTypeEssentialsId ?? ""}/${profile.name ?? ""}`.toLowerCase() === wanted
      );
    });
    const profile = record?.trainerProfile as
      | {
          trainerTypeId?: string;
          trainerTypeName?: string;
          name?: string;
          party?: Array<{
            pokemonId?: string;
            speciesEssentialsId?: string;
            level?: number;
            moves?: string[];
            itemId?: string;
          }>;
        }
      | undefined;

    if (!profile || !Array.isArray(profile.party) || profile.party.length === 0) {
      return { ok: false, message: `${trainerName} has no team ready to battle.` };
    }

    const playerSide = this.buildPlayerSide("a", player, user, catalogs);
    if (!this.hasAvailablePokemon(playerSide)) {
      return { ok: false, message: "Your team has no Pokemon able to battle." };
    }

    const party = profile.party
      .map((entry) =>
        this.buildNpcTrainerPokemon(
          {
            pokemonId: entry.pokemonId ?? "",
            pokemonName: entry.speciesEssentialsId ?? "",
            level: Math.max(1, Math.round(entry.level ?? 1)),
            moves: Array.isArray(entry.moves) ? entry.moves : [],
            itemId: entry.itemId ?? ""
          },
          catalogs
        )
      )
      .filter((pokemon): pokemon is BattlePokemon => Boolean(pokemon));

    if (party.length === 0) {
      return { ok: false, message: `${trainerName} has no valid team.` };
    }

    const trainerDisplayName = `${profile.trainerTypeName ?? ""} ${profile.name ?? trainerName}`.trim();
    const npcSide: BattleSide = {
      id: "b",
      isAi: true,
      trainerName: trainerDisplayName,
      money: await this.computeNpcTrainerPrize({ trainerTypeId: profile.trainerTypeId ?? "" }, party),
      inventory: [],
      party,
      activeIndex: 0,
      action: null,
      escapeAttempts: 0
    };

    const battle = this.createBattle(
      "trainer",
      playerSide,
      npcSide,
      [
        `${trainerDisplayName} wants to battle!`,
        `${trainerDisplayName} sent out ${getPokemonDisplayName(party[0])}.`
      ],
      this.resolveBattleBackForPlayer(player)
    );

    this.activateBattle(battle);
    return { ok: true, battleId: battle.id, playerSideId: playerSide.id };
  }

  /**
   * Starts a wild battle from an RPG Maker event script:
   * `pbWildBattle(PBSpecies::MUK, 25, ...)` — the hidden/static overworld
   * encounters (a venomon you talk to). The player can catch it like any
   * wild battle; the event runtime decides from the outcome whether the
   * overworld venomon is consumed.
   */
  public async startScriptedWildBattle(
    userId: number,
    speciesEssentialsId: string,
    level: number
  ): Promise<
    | { ok: true; battleId: string; playerSideId: string }
    | { ok: false; message: string }
  > {
    const player = this.world.getPlayerByUserId(userId);
    if (!player) {
      return { ok: false, message: "Enter the world before battling." };
    }
    if (this.isPlayerBattling(player.socketId)) {
      return { ok: false, message: "You are already in a battle." };
    }

    const user = await this.auth.getUserForBattle(userId);
    const catalogs = await this.loadCatalogs();
    if (!user) {
      return { ok: false, message: "Account not found." };
    }

    // Imported species use `pokemon-<INTERNALNAME>` ids (same convention as
    // Auth.givePokemonBySpecies).
    const pokemonDefinition = catalogs.pokemonById.get(
      `pokemon-${String(speciesEssentialsId).toUpperCase()}`
    );
    if (!pokemonDefinition) {
      return { ok: false, message: "That Pokemon is not available." };
    }

    const playerSide = this.buildPlayerSide("a", player, user, catalogs);
    if (!this.hasAvailablePokemon(playerSide)) {
      return { ok: false, message: "Your team has no Pokemon able to battle." };
    }

    const wildPokemon = this.buildWildPokemon(
      pokemonDefinition,
      clamp(Math.round(level) || 1, 1, 100),
      catalogs.skillsById
    );
    const wildSide: BattleSide = {
      id: "b",
      isAi: true,
      trainerName: "Wild Pokemon",
      money: 0,
      inventory: [],
      party: [wildPokemon],
      activeIndex: 0,
      action: null,
      escapeAttempts: 0
    };

    const battle = this.createBattle(
      "wild",
      playerSide,
      wildSide,
      [`A wild ${getPokemonDisplayName(wildPokemon)} appeared.`],
      this.resolveBattleBackForPlayer(player)
    );

    this.activateBattle(battle);
    return { ok: true, battleId: battle.id, playerSideId: playerSide.id };
  }

  /** One-shot notification when a battle finishes (used by the event runtime). */
  public onBattleEnd(battleId: string, listener: (winnerSideId: string | null) => void) {
    const listeners = this.battleEndListeners.get(battleId) ?? [];
    listeners.push(listener);
    this.battleEndListeners.set(battleId, listeners);
  }

  private battleEndListeners = new Map<string, Array<(winnerSideId: string | null) => void>>();

  private buildNpcTrainerPokemon(
    entry: NpcTrainerPokemonDefinition,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): BattlePokemon | null {
    const definition =
      this.resolvePokemonDefinition(entry.pokemonId, catalogs) ??
      (entry.pokemonName ? this.resolvePokemonDefinition(entry.pokemonName, catalogs) : null);
    if (!definition) {
      return null;
    }

    const pokemon = this.buildWildPokemon(definition, entry.level, catalogs.skillsById);
    pokemon.id = `npc:${crypto.randomUUID()}`;

    if (entry.moves.length > 0) {
      const moves = entry.moves
        .map((moveName) => {
          const normalized = moveName.trim();
          const skillDefinition =
            catalogs.skillsById.get(normalized) ??
            catalogs.skillsById.get(`skill-${normalized.toUpperCase()}`) ??
            catalogs.skillsById.get(`skill-${normalized}`) ??
            catalogs.skillsByName.get(normalized.toLowerCase());
          return skillDefinition ? this.buildBattleMove(skillDefinition) : null;
        })
        .filter((move): move is BattleMove => Boolean(move))
        .slice(0, 4);
      if (moves.length > 0) {
        pokemon.moves = moves;
      }
    }

    if (entry.itemId) {
      const itemDefinition = this.getCachedItemDefinition(entry.itemId, "");
      if (itemDefinition) {
        const species = toSpeciesInternalId(pokemon.sourcePokemonId, pokemon.name);
        const slot =
          classifyEquipmentSlot({
            essentialsId: itemDefinition.essentialsId,
            speciesInternalId: species,
            heldBonus: itemDefinition.heldBonus,
            heldEffect: itemDefinition.heldEffect
          }) ?? "bonus";
        if (slot === "battle") {
          pokemon.battleItemId = itemDefinition.id;
          pokemon.battleItemName = itemDefinition.name;
        } else if (slot === "appearance") {
          pokemon.appearanceItemId = itemDefinition.id;
          pokemon.appearanceItemName = itemDefinition.name;
          const effect = resolveAppearanceEffect(itemDefinition.essentialsId, species);
          if (effect) {
            pokemon.types = applyAppearanceToTypes(pokemon.types, effect).map(normalizeType);
            pokemon.baseStats = applyAppearanceToBaseStats(pokemon.baseStats, effect);
            const formStats = calculateStats(
              pokemon.baseStats,
              pokemon.level,
              pokemon.statBonuses,
              pokemon.ivs,
              pokemon.evs
            );
            pokemon.stats = formStats;
            pokemon.maxHp = formStats.hp;
            pokemon.hp = formStats.hp;
          }
          const sprites = this.resolveBattleSprites(
            pokemon.frontImageSrc,
            pokemon.backImageSrc,
            itemDefinition.id,
            species
          );
          pokemon.frontImageSrc = sprites.frontImageSrc;
          pokemon.backImageSrc = sprites.backImageSrc;
        } else {
          pokemon.heldItemId = itemDefinition.id;
          pokemon.heldItemName = itemDefinition.name;
        }
      }
    }

    return pokemon;
  }

  /** Prize money: trainer type base money x strongest party level (Essentials rule). */
  private async computeNpcTrainerPrize(npc: Pick<NpcDefinition, "trainerTypeId">, party: BattlePokemon[]) {
    const highestLevel = party.reduce((highest, pokemon) => Math.max(highest, pokemon.level), 1);
    let baseMoney = 40;

    if (npc.trainerTypeId) {
      const payload = await this.designerSectionStore.read("trainerTypes");
      const record = (payload?.state.items ?? []).find(
        (item) =>
          item.id === npc.trainerTypeId ||
          (item.trainerTypeProfile as { essentialsId?: string } | undefined)?.essentialsId ===
            npc.trainerTypeId
      );
      const profile = record?.trainerTypeProfile as { baseMoney?: unknown } | undefined;
      const parsed = parseNumber(profile?.baseMoney, 0);
      if (parsed > 0) {
        baseMoney = parsed;
      }
    }

    return Math.max(0, baseMoney * highestLevel);
  }

  private async startTrainerBattle(firstPlayer: Player, secondPlayer: Player) {
    if (firstPlayer.userId === null || secondPlayer.userId === null) {
      return;
    }

    const [firstUser, secondUser, catalogs] = await Promise.all([
      this.auth.getUserForBattle(firstPlayer.userId),
      this.auth.getUserForBattle(secondPlayer.userId),
      this.loadCatalogs()
    ]);

    if (!firstUser || !secondUser) {
      return;
    }

    const firstSide = this.buildPlayerSide("a", firstPlayer, firstUser, catalogs);
    const secondSide = this.buildPlayerSide("b", secondPlayer, secondUser, catalogs);

    if (!this.hasAvailablePokemon(firstSide) || !this.hasAvailablePokemon(secondSide)) {
      this.emitToPlayer(firstPlayer, "battle:error", { message: "Both trainers need at least one Pokemon with HP." });
      this.emitToPlayer(secondPlayer, "battle:error", { message: "Both trainers need at least one Pokemon with HP." });
      return;
    }

    const battle = this.createBattle(
      "trainer",
      firstSide,
      secondSide,
      [`${firstSide.trainerName} and ${secondSide.trainerName} started a battle.`],
      this.resolveBattleBackForPlayer(firstPlayer)
    );

    this.activateBattle(battle);
  }

  /**
   * Resolves the Essentials battleback for the map a player is standing on
   * (imported from PBS metadata.txt into playableMapConfig.battleBack),
   * upgraded to the terrain variant of where the battle actually started —
   * grass, open water (surfing/fishing), cave floor or an underwater map —
   * mirroring Essentials' environment-based backdrops. Wild encounters pass
   * their pool's context; every other battle kind (NPC, PvP, scripted) infers
   * it from the player's current terrain, so a surf PvP gets a water backdrop.
   * Variants are only chosen when they exist in the battleBackgrounds section.
   */
  private resolveBattleBackForPlayer(
    player: Player | null | undefined,
    context?: BattleBackContext
  ): string | null {
    if (!player) {
      return null;
    }

    const snapshot = this.world.getPlayableMapsState();
    const map = snapshot?.items.find((item) => item.id === templateMapIdFor(player.currentMapId));
    const config = map?.playableMapConfig as { battleBack?: unknown } | undefined;
    const base =
      typeof config?.battleBack === "string" && config.battleBack.trim().length > 0
        ? config.battleBack.trim()
        : null;

    const resolved = context ?? this.inferBattleBackContext(player);

    const candidates: string[] = [];
    if (resolved === "water") {
      if (base) {
        candidates.push(`${base}Water`);
      }
      candidates.push("Water");
    } else if (resolved === "underwater") {
      candidates.push("Underwater");
    } else if (resolved === "grass") {
      if (base) {
        candidates.push(`${base}Grass`);
      } else {
        candidates.push("FieldGrass");
      }
    } else if (resolved === "cave" && !base) {
      candidates.push("Cave");
    }
    if (base) {
      candidates.push(base);
    }

    const known = this.cachedBattleBackNames;
    if (known && known.size > 0) {
      const match = candidates.find((name) => known.has(name.toLowerCase()));
      if (match) {
        return match;
      }
    }
    return candidates[0] ?? null;
  }

  /** The terrain context a non-step battle starts in (null = plain ground). */
  private inferBattleBackContext(player: Player): BattleBackContext | null {
    if (player.isSurfing) {
      return "water";
    }
    if (resolveDivePair(player.currentMapId)?.role === "underwater") {
      return "underwater";
    }
    if (this.world.getPlayerTerrainTag(player) === GRASS_TERRAIN_TAG) {
      return "grass";
    }
    return null;
  }

  private createBattle(
    kind: BattleKind,
    firstSide: BattleSide,
    secondSide: BattleSide,
    log: string[],
    battleBack: string | null = null
  ): BattleSession {
    const battle: BattleSession = {
      id: crypto.randomUUID(),
      kind,
      status: "active",
      sides: [firstSide, secondSide],
      turn: 1,
      turnEndsAt: null,
      timer: null,
      log: [],
      events: [],
      eventSeq: 0,
      lastFlushedSeq: 0,
      participation: new Map(),
      leveledPokemonIds: new Set(),
      result: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      summary: null,
      battleBack,
      weather: null,
      trickRoomTurns: 0,
      gravityTurns: 0,
      magicRoomTurns: 0,
      wonderRoomTurns: 0,
      terrain: null,
      ionDeluge: false,
      lastMoveUsed: null,
      extraMoney: 0,
      moneyMultiplier: 1,
      replacementRequest: null
    };

    this.pushEvent(battle, {
      kind: "battle-start",
      battleKind: kind,
      transition: kind === "wild" ? "wild-flash" : "trainer-versus",
      bgmName: null,
      introText: log[0] ?? ""
    });
    log.forEach((entry) => this.say(battle, entry));

    return battle;
  }

  private activateBattle(battle: BattleSession) {
    this.battles.set(battle.id, battle);
    battle.sides.forEach((side) => {
      if (!side.playerId) {
        return;
      }

      this.playerBattleIds.set(side.playerId, battle.id);
      const player = this.world.players.get(side.playerId);
      if (player) {
        player.enterBattle();
      }
    });

    this.startChoiceTurn(battle);
  }

  private startChoiceTurn(battle: BattleSession) {
    battle.sides.forEach((side) => {
      side.action = null;
      // A mon mid two-turn move (Fly/Dig/Solar Beam...), rampage
      // (Thrash/Rollout/Uproar) or Bide is locked into it — no new choice.
      const active = getActivePokemon(side);
      if (active && !isFainted(active)) {
        active.volatile.turnsOnField += 1;
        if (active.volatile.charging) {
          side.action = { type: "fight", moveId: active.volatile.charging.moveId };
        } else if (active.volatile.rampage) {
          side.action = { type: "fight", moveId: active.volatile.rampage.moveId };
        } else if (active.volatile.bide) {
          side.action = { type: "fight", moveId: active.volatile.bide.moveId };
        }
      }
    });

    if (battle.kind === "trainer") {
      battle.turnEndsAt = Date.now() + PLAYER_ACTION_TIMEOUT_MS;
      battle.timer = setTimeout(() => {
        battle.sides.forEach((side) => {
          if (!side.action) {
            side.action = this.createTimeoutAction(side);
          }
        });
        void this.resolveTurn(battle);
      }, PLAYER_ACTION_TIMEOUT_MS);
    } else {
      battle.turnEndsAt = null;
    }

    this.emitBattleState(battle);
    this.flushEvents(battle);

    // Two-turn locks can cover every human side; nobody is left to submit an
    // action, so the turn must kick itself off (AI picks, then resolve).
    const humanSides = battle.sides.filter((side) => !side.isAi);
    if (humanSides.length > 0 && humanSides.every((side) => side.action !== null)) {
      const aiSide = battle.sides.find((side) => side.isAi);
      if (aiSide && !aiSide.action) {
        aiSide.action = this.chooseAiAction(aiSide, humanSides[0]);
      }
      setTimeout(() => void this.resolveTurn(battle), 600);
    }
  }

  private clearBattleTimer(battle: BattleSession) {
    if (battle.timer) {
      clearTimeout(battle.timer);
      battle.timer = null;
    }
    battle.turnEndsAt = null;
  }

  private async resolveTurn(battle: BattleSession) {
    if (battle.status !== "active") {
      return;
    }

    this.clearBattleTimer(battle);
    this.recordParticipation(battle);
    const [firstSide, secondSide] = battle.sides;

    // Per-turn tracking for Counter/Revenge/Payback/Sucker Punch.
    for (const side of battle.sides) {
      side.hasActedThisTurn = false;
      const active = getActivePokemon(side);
      if (active) {
        active.volatile.damageTakenThisTurn = { physical: 0, special: 0, any: 0 };
      }
    }

    for (const side of battle.sides) {
      if (side.action?.type === "surrender") {
        await this.finishBattle(
          battle,
          `${side.trainerName} surrendered.`,
          this.getOpponentSide(battle, side),
          side
        );
        return;
      }
    }

    const runSide = battle.sides.find((side) => side.action?.type === "run");
    if (runSide) {
      if (battle.kind === "trainer") {
        await this.finishBattle(
          battle,
          `${runSide.trainerName} surrendered.`,
          this.getOpponentSide(battle, runSide),
          runSide
        );
        return;
      }

      const runner = getActivePokemon(runSide);
      const heldInBattle =
        runner.volatile.binding !== null || runner.volatile.trappedByPokemonId !== null;
      const escaped = heldInBattle
        ? false
        : this.tryEscape(runSide, this.getOpponentSide(battle, runSide));
      this.pushEvent(
        battle,
        { kind: "escape", success: escaped },
        escaped
          ? "You got away safely."
          : heldInBattle
            ? `${getPokemonDisplayName(runner)} is trapped and can't escape!`
            : "You could not escape."
      );
      await this.emitBattleStep(battle, !escaped);
      if (escaped) {
        await this.finishBattle(battle, "You got away safely.", null, null);
        return;
      }
    }

    for (const side of battle.sides) {
      if (side.action?.type === "bag") {
        const battleEnded = await this.applyItemAction(battle, side, side.action);
        await this.emitBattleStep(battle);
        if (battleEnded || (battle.status as BattleStatus) !== "active") {
          return;
        }
      }
    }

    for (const side of battle.sides) {
      if (side.action?.type === "pokemon") {
        const current = getActivePokemon(side);
        if (current.volatile.binding !== null || current.volatile.trappedByPokemonId !== null) {
          this.say(battle, `${getPokemonDisplayName(current)} is trapped and can't be switched out!`);
          await this.emitBattleStep(battle);
          continue;
        }

        // Pursuit intercepts the fleeing target at double power.
        const opponent = this.getOpponentSide(battle, side);
        if (opponent.action?.type === "fight" && !opponent.hasActedThisTurn) {
          const queued = this.getQueuedMove(opponent);
          const queuedSpec = queued
            ? parseMoveEffect(resolveFunctionCode(queued.functionCode ?? ""))
            : null;
          const pursuer = getActivePokemon(opponent);
          if (queued && queuedSpec?.pursuit && pursuer && !isFainted(pursuer)) {
            await this.executeMoveAction(battle, opponent, side, queued.id, { powerMult: 2 });
            opponent.hasActedThisTurn = true;
            opponent.action = { type: "pass" };
            if (await this.handleFaintChecks(battle)) {
              return;
            }
            if (isFainted(getActivePokemon(side))) {
              // The departing mon fell to Pursuit; the faint flow already
              // brought in a replacement, so the chosen switch is moot.
              continue;
            }
          }
        }

        const switched = this.switchPokemon(battle, side, side.action.pokemonId);
        if (switched) {
          const sentOut = getActivePokemon(side);
          this.pushEvent(
            battle,
            { kind: "switch", sideId: side.id, pokemon: getPublicPokemon(sentOut) },
            `${side.trainerName} sent out ${getPokemonDisplayName(sentOut)}.`
          );
          this.recordParticipation(battle);
          await this.emitBattleStep(battle);
          await this.applySwitchInEffects(battle, side);
          if (await this.handleFaintChecks(battle)) {
            return;
          }
        }
      }
    }

    const sideSpeed = (side: BattleSide) => {
      let speed = this.getModifiedStat(getActivePokemon(side), "speed");
      if ((side.sideEffects?.tailwind ?? 0) > 0) {
        speed *= 2;
      }
      return speed;
    };
    // Quick Claw: one roll per holder per turn; a proc wins the speed race
    // within the same priority bracket.
    const quickClawProcs = new Map<BattleSideId, boolean>();
    for (const side of [firstSide, secondSide]) {
      const chance = this.getHeldBonus(getActivePokemon(side), battle)?.quickClawChance ?? 0;
      quickClawProcs.set(side.id, chance > 0 && Math.random() < chance);
    }

    const attackOrder = [firstSide, secondSide]
      .filter((side) => side.action?.type === "fight" && !isFainted(getActivePokemon(side)))
      .sort((left, right) => {
        const leftMove = this.getQueuedMove(left);
        const rightMove = this.getQueuedMove(right);
        const priorityDiff = (rightMove?.priority ?? 0) - (leftMove?.priority ?? 0);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }

        const leftClaw = quickClawProcs.get(left.id) ?? false;
        const rightClaw = quickClawProcs.get(right.id) ?? false;
        if (leftClaw !== rightClaw) {
          return leftClaw ? -1 : 1;
        }

        const leftSpeed = sideSpeed(left);
        const rightSpeed = sideSpeed(right);
        // Trick Room: the slower battler moves first (priority unaffected).
        const speedDiff =
          battle.trickRoomTurns > 0 ? leftSpeed - rightSpeed : rightSpeed - leftSpeed;
        return speedDiff || (Math.random() > 0.5 ? 1 : -1);
      });

    // Announce the claw only when it actually stole the lead.
    if (attackOrder.length === 2) {
      const [first, second] = attackOrder;
      const firstMove = this.getQueuedMove(first);
      const secondMove = this.getQueuedMove(second);
      const samePriority = (firstMove?.priority ?? 0) === (secondMove?.priority ?? 0);
      const wasSlower =
        battle.trickRoomTurns > 0
          ? sideSpeed(first) > sideSpeed(second)
          : sideSpeed(first) < sideSpeed(second);
      if (samePriority && wasSlower && quickClawProcs.get(first.id) && !quickClawProcs.get(second.id)) {
        this.say(
          battle,
          `${getPokemonDisplayName(getActivePokemon(first))}'s Quick Claw let it move first!`
        );
      }
    }

    for (const side of attackOrder) {
      if ((battle.status as BattleStatus) !== "active") {
        return;
      }

      const target = this.getOpponentSide(battle, side);
      const attackerPokemon = getActivePokemon(side);

      if (isFainted(attackerPokemon) || side.action?.type !== "fight") {
        continue;
      }

      await this.executeMoveAction(battle, side, target, side.action.moveId);
      side.hasActedThisTurn = true;

      if (await this.handleFaintChecks(battle)) {
        return;
      }
    }

    if (await this.applyEndOfTurn(battle)) {
      return;
    }

    battle.turn += 1;
    this.startChoiceTurn(battle);
  }

  private getQueuedMove(side: BattleSide): BattleMove | null {
    if (side.action?.type !== "fight") {
      return null;
    }

    const moveId = side.action.moveId;
    return getActivePokemon(side).moves.find((move) => move.id === moveId) ?? null;
  }

  private pushEvent(battle: BattleSession, event: BattlePublicEvent, logText?: string | null) {
    battle.eventSeq += 1;
    battle.events.push({
      ...event,
      seq: battle.eventSeq,
      text: logText ?? undefined
    } as BattleSequencedEvent);
    if (logText) {
      this.appendBattleLog(battle, logText);
    }
  }

  private say(battle: BattleSession, text: string) {
    this.pushEvent(battle, { kind: "message", text }, text);
  }

  private flushEvents(battle: BattleSession) {
    const pending = battle.events.filter((event) => event.seq > battle.lastFlushedSeq);
    if (pending.length === 0) {
      return;
    }

    battle.lastFlushedSeq = battle.eventSeq;
    battle.sides.forEach((side) => {
      if (!side.isAi) {
        this.emitToSide(side, "battle:events", {
          battleId: battle.id,
          turn: battle.turn,
          events: pending
        });
      }
    });
  }

  private async emitBattleStep(battle: BattleSession, shouldPause = true) {
    this.emitBattleState(battle);
    this.flushEvents(battle);

    if (shouldPause && battle.status === "active") {
      await delay(BATTLE_ACTION_STEP_DELAY_MS);
    }
  }

  private recordParticipation(battle: BattleSession) {
    battle.sides.forEach((side) => {
      const opponent = this.getOpponentSide(battle, side);
      const mine = getActivePokemon(side);
      const foe = getActivePokemon(opponent);

      if (!mine || !foe || isFainted(mine)) {
        return;
      }

      let participants = battle.participation.get(foe.id);
      if (!participants) {
        participants = new Set<string>();
        battle.participation.set(foe.id, participants);
      }
      participants.add(mine.id);
    });
  }

  private async handleFaintChecks(battle: BattleSession): Promise<boolean> {
    if (battle.status !== "active") {
      return true;
    }

    // Entry hazards can faint the replacement too; sweep until stable.
    let sweepAgain = true;
    while (sweepAgain && battle.status === "active") {
      sweepAgain = false;

      for (const side of battle.sides) {
        const active = getActivePokemon(side);
        if (!active || !isFainted(active)) {
          continue;
        }

        this.pushEvent(
          battle,
          { kind: "faint", sideId: side.id, pokemonId: active.id, pokemonName: getPokemonDisplayName(active) },
          `${getPokemonDisplayName(active)} fainted.`
        );
        side.faintedThisTurn = true;
        this.clearBattlerLeaveEffects(battle, side);
        await this.emitBattleStep(battle);
        await this.awardExperienceForFaint(battle, side, active);

        if ((battle.status as BattleStatus) !== "active") {
          return true;
        }

        const replaced = await this.chooseReplacement(battle, side);
        if ((battle.status as BattleStatus) !== "active") {
          return true;
        }

        if (!replaced) {
          const winner = this.getOpponentSide(battle, side);
          await this.finishBattle(battle, `${winner.trainerName} won the battle.`, winner, side);
          return true;
        }

        // The replacement enters mid-turn; it must not inherit the fainted
        // mon's queued move (skill ids are shared across species).
        if (side.action?.type === "fight") {
          side.action = { type: "pass" };
        }

        const sentOut = getActivePokemon(side);
        this.pushEvent(
          battle,
          { kind: "switch", sideId: side.id, pokemon: getPublicPokemon(sentOut) },
          `${side.trainerName} sent out ${getPokemonDisplayName(sentOut)}.`
        );
        this.recordParticipation(battle);
        await this.emitBattleStep(battle);
        await this.applySwitchInEffects(battle, side);
        if (isFainted(getActivePokemon(side))) {
          sweepAgain = true;
        }
      }
    }

    return battle.status !== "active";
  }

  private async applyEndOfTurn(battle: BattleSession): Promise<boolean> {
    if (battle.status !== "active") {
      return true;
    }

    let pushedAnyEvent = false;

    const pushResidualDamage = (
      side: BattleSide,
      pokemon: BattlePokemon,
      damage: number,
      message: string | null
    ) => {
      const dealt = Math.min(pokemon.hp, Math.max(1, damage));
      if (dealt <= 0) {
        return 0;
      }
      pokemon.hp -= dealt;
      this.pushEvent(
        battle,
        {
          kind: "damage",
          sideId: side.id,
          pokemonId: pokemon.id,
          amount: dealt,
          hpAfter: pokemon.hp,
          maxHp: pokemon.maxHp,
          effectiveness: 1,
          critical: false,
          source: "status"
        },
        message
      );
      pushedAnyEvent = true;
      return dealt;
    };

    const pushResidualHeal = (
      side: BattleSide,
      pokemon: BattlePokemon,
      amount: number,
      message: string | null
    ) => {
      const healed = Math.min(pokemon.maxHp - pokemon.hp, Math.max(1, amount));
      if (healed <= 0) {
        return;
      }
      pokemon.hp += healed;
      this.pushEvent(
        battle,
        {
          kind: "heal",
          sideId: side.id,
          pokemonId: pokemon.id,
          amount: healed,
          hpAfter: pokemon.hp,
          maxHp: pokemon.maxHp,
          source: "move"
        },
        message
      );
      pushedAnyEvent = true;
    };

    // Weather: count down, then chip the exposed battlers (original order:
    // weather first, then residual effects).
    if (battle.weather) {
      battle.weather.turns -= 1;
      if (battle.weather.turns <= 0) {
        const endText: Record<NonNullable<BattleSession["weather"]>["kind"], string> = {
          sun: "The sunlight faded.",
          rain: "The rain stopped.",
          sandstorm: "The sandstorm subsided.",
          hail: "The hail stopped.",
          shadowsky: "The shadow sky faded."
        };
        this.say(battle, endText[battle.weather.kind]);
        battle.weather = null;
        pushedAnyEvent = true;
      } else {
        const weatherKind = battle.weather.kind;
        if (weatherKind === "sandstorm" || weatherKind === "hail" || weatherKind === "shadowsky") {
          for (const side of battle.sides) {
            const pokemon = getActivePokemon(side);
            if (!pokemon || isFainted(pokemon)) {
              continue;
            }
            const types = pokemon.types.map((type) => type.trim().toUpperCase());
            const immune =
              weatherKind === "sandstorm"
                ? types.some((type) => ["ROCK", "GROUND", "STEEL"].includes(type))
                : weatherKind === "hail"
                  ? types.includes("ICE")
                  : false;
            if (!immune) {
              pushResidualDamage(
                side,
                pokemon,
                Math.floor(pokemon.maxHp / 16),
                `${getPokemonDisplayName(pokemon)} is buffeted by the ${weatherKind === "shadowsky" ? "shadow sky" : weatherKind}!`
              );
            }
          }
        }
      }
    }

    for (const side of battle.sides) {
      const pokemon = getActivePokemon(side);
      if (!pokemon || isFainted(pokemon)) {
        continue;
      }

      const displayName = getPokemonDisplayName(pokemon);

      // Ingrain / Aqua Ring: 1/16 heal.
      if ((pokemon.volatile.ingrain || pokemon.volatile.aquaRing) && pokemon.hp < pokemon.maxHp) {
        pushResidualHeal(
          side,
          pokemon,
          Math.floor(pokemon.maxHp / 16),
          pokemon.volatile.ingrain
            ? `${displayName} absorbed nutrients with its roots!`
            : `${displayName} restored HP with its veil of water!`
        );
      }

      // Leech Seed: 1/8 drained, healing the opposing active mon.
      if (pokemon.volatile.seededBySideId && !isFainted(pokemon)) {
        const drained = pushResidualDamage(
          side,
          pokemon,
          Math.floor(pokemon.maxHp / 8),
          `${displayName}'s health is sapped by Leech Seed!`
        );
        const recipientSide = battle.sides.find(
          (candidate) => candidate.id === pokemon.volatile.seededBySideId
        );
        const recipient = recipientSide ? getActivePokemon(recipientSide) : null;
        if (drained > 0 && recipientSide && recipient && !isFainted(recipient)) {
          pushResidualHeal(recipientSide, recipient, drained, null);
        }
      }

      const residual = applyStatusEndOfTurn(pokemon.status, pokemon.maxHp, displayName);
      if (residual.damage > 0 && !isFainted(pokemon)) {
        pushResidualDamage(side, pokemon, residual.damage, residual.message);
      }

      // Nightmare: 1/4 while the target stays asleep.
      if (pokemon.volatile.nightmare) {
        if (pokemon.status?.id === "sleep") {
          if (!isFainted(pokemon)) {
            pushResidualDamage(
              side,
              pokemon,
              Math.floor(pokemon.maxHp / 4),
              `${displayName} is locked in a nightmare!`
            );
          }
        } else {
          pokemon.volatile.nightmare = false;
        }
      }

      // Bind / Wrap / Fire Spin: tick down, chip 1/16, free at zero.
      const binding = pokemon.volatile.binding;
      if (binding && !isFainted(pokemon)) {
        binding.turnsLeft -= 1;
        if (binding.turnsLeft <= 0) {
          pokemon.volatile.binding = null;
          this.say(battle, `${displayName} was freed from ${binding.moveName}!`);
          pushedAnyEvent = true;
        } else {
          pushResidualDamage(
            side,
            pokemon,
            Math.floor(pokemon.maxHp / 16),
            `${displayName} is hurt by ${binding.moveName}!`
          );
        }
      }

      // Ghost-type Curse: a quarter of max HP every turn.
      if (pokemon.volatile.cursed && !isFainted(pokemon)) {
        pushResidualDamage(
          side,
          pokemon,
          Math.floor(pokemon.maxHp / 4),
          `${displayName} is afflicted by the curse!`
        );
      }

      // Grassy Terrain heals grounded battlers.
      if (
        battle.terrain?.kind === "grassy" &&
        !isFainted(pokemon) &&
        this.isGrounded(battle, pokemon) &&
        pokemon.hp < pokemon.maxHp
      ) {
        pushResidualHeal(
          side,
          pokemon,
          Math.floor(pokemon.maxHp / 16),
          `${displayName} is healed by the grassy terrain!`
        );
      }

      // Restriction & helper countdowns.
      const volatile = pokemon.volatile;
      if (volatile.disable) {
        volatile.disable.turns -= 1;
        if (volatile.disable.turns <= 0) {
          this.say(battle, `${displayName}'s ${volatile.disable.moveName} is no longer disabled!`);
          volatile.disable = null;
          pushedAnyEvent = true;
        }
      }
      if (volatile.encore) {
        volatile.encore.turns -= 1;
        const encoredMove = pokemon.moves.find((known) => known.id === volatile.encore?.moveId);
        if (volatile.encore.turns <= 0 || !encoredMove || encoredMove.currentPp <= 0) {
          volatile.encore = null;
          this.say(battle, `${displayName}'s encore ended!`);
          pushedAnyEvent = true;
        }
      }
      if (volatile.tauntTurns > 0) {
        volatile.tauntTurns -= 1;
        if (volatile.tauntTurns <= 0) {
          this.say(battle, `${displayName}'s taunt wore off!`);
          pushedAnyEvent = true;
        }
      }
      if (volatile.healBlockTurns > 0) {
        volatile.healBlockTurns -= 1;
        if (volatile.healBlockTurns <= 0) {
          this.say(battle, `${displayName}'s Heal Block wore off!`);
          pushedAnyEvent = true;
        }
      }
      if (volatile.embargoTurns > 0) {
        volatile.embargoTurns -= 1;
        if (volatile.embargoTurns <= 0) {
          this.say(battle, `${displayName} can use items again!`);
          pushedAnyEvent = true;
        }
      }
      if (volatile.magnetRiseTurns > 0) {
        volatile.magnetRiseTurns -= 1;
        if (volatile.magnetRiseTurns <= 0) {
          this.say(battle, `${displayName}'s electromagnetism wore off!`);
          pushedAnyEvent = true;
        }
      }
      if (volatile.telekinesisTurns > 0) {
        volatile.telekinesisTurns -= 1;
        if (volatile.telekinesisTurns <= 0) {
          this.say(battle, `${displayName} was freed from the telekinesis!`);
          pushedAnyEvent = true;
        }
      }
      if (volatile.lockOnTurns > 0) {
        volatile.lockOnTurns -= 1;
      }

      // Yawn: the drowsy battler drops off at the end of the next turn.
      if (volatile.yawnTurns > 0 && !isFainted(pokemon)) {
        volatile.yawnTurns -= 1;
        if (volatile.yawnTurns <= 0 && !pokemon.status && !isImmuneToStatus("sleep", pokemon.types)) {
          pokemon.status = createStatusState("sleep");
          this.pushEvent(
            battle,
            { kind: "status-applied", sideId: side.id, pokemonId: pokemon.id, status: "sleep" },
            `${displayName} fell asleep!`
          );
          pushedAnyEvent = true;
        }
      }

      // Perish Song.
      if (volatile.perishCount > 0 && !isFainted(pokemon)) {
        volatile.perishCount -= 1;
        this.say(battle, `${displayName}'s perish count fell to ${volatile.perishCount}!`);
        pushedAnyEvent = true;
        if (volatile.perishCount <= 0) {
          pushResidualDamage(side, pokemon, pokemon.hp, null);
        }
      }

      if (!isFainted(pokemon) && this.applyHeldItemTriggers(battle, side, pokemon)) {
        pushedAnyEvent = true;
      }

      pokemon.volatile.flinched = false;
      pokemon.volatile.protected = false;
      pokemon.volatile.endure = false;
    }

    // Wish and Future Sight resolve against whoever holds the slot now.
    for (const side of battle.sides) {
      const wish = side.wish;
      if (wish) {
        wish.turns -= 1;
        if (wish.turns <= 0) {
          side.wish = null;
          const beneficiary = getActivePokemon(side);
          if (beneficiary && !isFainted(beneficiary) && beneficiary.hp < beneficiary.maxHp) {
            pushResidualHeal(side, beneficiary, wish.amount, `${wish.wisherName}'s wish came true!`);
          }
        }
      }

      const pendingHit = side.futureSight;
      if (pendingHit) {
        pendingHit.turns -= 1;
        if (pendingHit.turns <= 0) {
          side.futureSight = null;
          const victim = getActivePokemon(side);
          if (victim && !isFainted(victim)) {
            this.say(battle, `${getPokemonDisplayName(victim)} took the ${pendingHit.moveName} attack!`);
            pushResidualDamage(side, victim, pendingHit.damage, null);
          }
        }
      }

      const effects = side.sideEffects;
      if (effects) {
        if (effects.tailwind > 0 && --effects.tailwind <= 0) {
          this.say(battle, `${side.trainerName}'s tailwind petered out!`);
          pushedAnyEvent = true;
        }
        if (effects.safeguard > 0 && --effects.safeguard <= 0) {
          this.say(battle, `${side.trainerName}'s team is no longer protected by Safeguard!`);
          pushedAnyEvent = true;
        }
        if (effects.mist > 0 && --effects.mist <= 0) {
          this.say(battle, `${side.trainerName}'s mist faded!`);
          pushedAnyEvent = true;
        }
        if (effects.luckyChant > 0 && --effects.luckyChant <= 0) {
          this.say(battle, `${side.trainerName}'s Lucky Chant wore off!`);
          pushedAnyEvent = true;
        }
      }

      side.allyFaintedLastTurn = Boolean(side.faintedThisTurn);
      side.faintedThisTurn = false;
    }

    // Field-wide countdowns.
    if (battle.trickRoomTurns > 0 && --battle.trickRoomTurns <= 0) {
      this.say(battle, "The twisted dimensions returned to normal!");
      pushedAnyEvent = true;
    }
    if (battle.gravityTurns > 0 && --battle.gravityTurns <= 0) {
      this.say(battle, "Gravity returned to normal!");
      pushedAnyEvent = true;
    }
    if (battle.magicRoomTurns > 0 && --battle.magicRoomTurns <= 0) {
      this.say(battle, "The area returned to normal!");
      pushedAnyEvent = true;
    }
    if (battle.wonderRoomTurns > 0 && --battle.wonderRoomTurns <= 0) {
      this.say(battle, "Wonder Room wore off!");
      pushedAnyEvent = true;
    }
    if (battle.terrain) {
      battle.terrain.turns -= 1;
      if (battle.terrain.turns <= 0) {
        battle.terrain = null;
        this.say(battle, "The terrain returned to normal.");
        pushedAnyEvent = true;
      }
    }
    battle.ionDeluge = false;

    // Screens wear off.
    for (const side of battle.sides) {
      const screens = side.screens;
      if (!screens) {
        continue;
      }
      if (screens.reflect > 0) {
        screens.reflect -= 1;
        if (screens.reflect === 0) {
          this.say(battle, `${side.trainerName}'s Reflect wore off!`);
          pushedAnyEvent = true;
        }
      }
      if (screens.lightScreen > 0) {
        screens.lightScreen -= 1;
        if (screens.lightScreen === 0) {
          this.say(battle, `${side.trainerName}'s Light Screen wore off!`);
          pushedAnyEvent = true;
        }
      }
    }

    if (pushedAnyEvent) {
      await this.emitBattleStep(battle);
    }

    return this.handleFaintChecks(battle);
  }

  /** Returns true when at least one event was pushed. */
  private applyHeldItemTriggers(battle: BattleSession, side: BattleSide, pokemon: BattlePokemon): boolean {
    // Magic Room suspends every held item; Embargo blocks this battler's.
    if (battle.magicRoomTurns > 0 || pokemon.volatile.embargoTurns > 0) {
      return false;
    }

    // Battle-use slot first (berries, herbs), then the bonus slot's
    // trigger-style holds (Leftovers, Black Sludge, Flame/Toxic Orb).
    const usedBattleSlot = this.applySlotItemTriggers(battle, side, pokemon, "battle");
    const usedBonusSlot = this.applySlotItemTriggers(battle, side, pokemon, "bonus");
    return usedBattleSlot || usedBonusSlot;
  }

  /** The item ids/names living in one of the two in-battle item slots. */
  private getSlotItem(pokemon: BattlePokemon, slot: "bonus" | "battle") {
    return slot === "bonus"
      ? { id: pokemon.heldItemId, name: pokemon.heldItemName }
      : { id: pokemon.battleItemId, name: pokemon.battleItemName };
  }

  private applySlotItemTriggers(
    battle: BattleSession,
    side: BattleSide,
    pokemon: BattlePokemon,
    slot: "bonus" | "battle"
  ): boolean {
    const slotItem = this.getSlotItem(pokemon, slot);
    if (!slotItem.id) {
      return false;
    }

    const definition = this.getCachedItemDefinition(slotItem.id, slotItem.name ?? "");
    const effect = definition?.heldEffect;
    if (!definition || !effect) {
      return false;
    }

    const displayName = getPokemonDisplayName(pokemon);
    let used = false;

    if (effect.trigger === "end-of-turn" && effect.action === "self-status" && !pokemon.status) {
      this.applyStatusCondition(battle, side, pokemon, effect.status, true, true);
      if (pokemon.status) {
        this.say(battle, `${displayName} was hurt by its ${definition.name}!`);
        used = true;
      }
    }

    if (effect.trigger === "end-of-turn" && effect.action === "poison-heal-else-damage") {
      const isPoisonType = pokemon.types.some((type) => type.trim().toUpperCase() === "POISON");
      if (isPoisonType && pokemon.hp < pokemon.maxHp && pokemon.hp > 0) {
        const amount = Math.max(1, Math.floor(pokemon.maxHp * effect.healFraction));
        pokemon.hp = Math.min(pokemon.maxHp, pokemon.hp + amount);
        this.pushEvent(
          battle,
          {
            kind: "heal",
            sideId: side.id,
            pokemonId: pokemon.id,
            amount,
            hpAfter: pokemon.hp,
            maxHp: pokemon.maxHp,
            source: "held-item"
          },
          `${displayName} absorbed nutrients from its ${definition.name}.`
        );
        used = true;
      } else if (!isPoisonType && pokemon.hp > 0) {
        const amount = Math.max(1, Math.floor(pokemon.maxHp * effect.damageFraction));
        pokemon.hp = Math.max(0, pokemon.hp - amount);
        this.pushEvent(
          battle,
          {
            kind: "damage",
            sideId: side.id,
            pokemonId: pokemon.id,
            amount,
            hpAfter: pokemon.hp,
            maxHp: pokemon.maxHp,
            effectiveness: 1,
            critical: false,
            source: "held-item"
          },
          `${displayName} was hurt by its ${definition.name}!`
        );
        used = true;
      }
    }

    if (
      effect.trigger === "pinch" &&
      pokemon.hp > 0 &&
      pokemon.hp <= Math.floor(pokemon.maxHp / 4)
    ) {
      const coreStats: Array<Exclude<BattleStageKey, "accuracy" | "evasion">> = [
        "attack",
        "defense",
        "specialAttack",
        "specialDefense",
        "speed"
      ];
      const raisable = coreStats.filter((candidate) => pokemon.stages[candidate] < 6);
      const stat =
        effect.stat === "random"
          ? raisable.length > 0
            ? raisable[Math.floor(Math.random() * raisable.length)]
            : null
          : effect.stat;
      if (stat && pokemon.stages[stat] < 6) {
        this.pushEvent(
          battle,
          { kind: "held-item-used", sideId: side.id, pokemonId: pokemon.id, itemName: definition.name },
          `${displayName} ate its ${definition.name}!`
        );
        this.applyStatStageChange(battle, side, pokemon, stat, effect.stages, false, true);
        this.consumeHeldItem(pokemon, slot);
        used = true;
      }
    }

    if (
      effect.trigger === "end-of-turn" &&
      effect.action === "heal-fraction" &&
      pokemon.hp < pokemon.maxHp
    ) {
      const amount = Math.max(1, Math.floor(pokemon.maxHp * effect.fraction));
      pokemon.hp = Math.min(pokemon.maxHp, pokemon.hp + amount);
      this.pushEvent(
        battle,
        {
          kind: "heal",
          sideId: side.id,
          pokemonId: pokemon.id,
          amount,
          hpAfter: pokemon.hp,
          maxHp: pokemon.maxHp,
          source: "held-item"
        },
        `${displayName} restored a little HP using its ${definition.name}.`
      );
      used = true;
    }

    if (effect.trigger === "hp-below-half" && pokemon.hp > 0 && pokemon.hp <= Math.floor(pokemon.maxHp / 2)) {
      const amount =
        effect.action === "heal-amount"
          ? effect.amount
          : Math.max(1, Math.floor(pokemon.maxHp * effect.fraction));
      pokemon.hp = Math.min(pokemon.maxHp, pokemon.hp + Math.max(1, amount));
      this.pushEvent(
        battle,
        { kind: "held-item-used", sideId: side.id, pokemonId: pokemon.id, itemName: definition.name },
        `${displayName} ate its ${definition.name}!`
      );
      this.pushEvent(battle, {
        kind: "heal",
        sideId: side.id,
        pokemonId: pokemon.id,
        amount: Math.max(1, amount),
        hpAfter: pokemon.hp,
        maxHp: pokemon.maxHp,
        source: "held-item"
      });
      this.consumeHeldItem(pokemon, slot);
      used = true;
    }

    if (effect.trigger === "status") {
      const cures =
        pokemon.status &&
        (effect.cures === "any" || effect.cures.includes(pokemon.status.id));
      const curesConfusion = effect.curesConfusion && pokemon.volatile.confusionTurns > 0;

      if (cures || curesConfusion) {
        this.pushEvent(
          battle,
          { kind: "held-item-used", sideId: side.id, pokemonId: pokemon.id, itemName: definition.name },
          `${displayName} ate its ${definition.name}!`
        );
        if (cures && pokemon.status) {
          this.pushEvent(
            battle,
            { kind: "status-cured", sideId: side.id, pokemonId: pokemon.id, status: pokemon.status.id },
            `${displayName} is no longer ${STATUS_DISPLAY_NAMES[pokemon.status.id]}.`
          );
          pokemon.status = null;
        }
        if (curesConfusion) {
          pokemon.volatile.confusionTurns = 0;
          this.pushEvent(
            battle,
            { kind: "confusion-end", sideId: side.id, pokemonId: pokemon.id },
            `${displayName} snapped out of its confusion.`
          );
        }
        this.consumeHeldItem(pokemon, slot);
        used = true;
      }
    }

    return used;
  }

  private consumeHeldItem(pokemon: BattlePokemon, slot: "bonus" | "battle" = "battle") {
    const slotItem = this.getSlotItem(pokemon, slot);
    // Remember what was eaten for Recycle and Belch.
    if (slotItem.id) {
      pokemon.consumedItem = { id: slotItem.id, name: slotItem.name ?? "", slot };
      if (this.itemIsBerry(slotItem.id, slotItem.name)) {
        pokemon.ateBerry = true;
      }
    }
    this.setSlotItem(pokemon, slot, null, null);
  }

  /** Writes one of the two in-battle slots through to the persisted summary. */
  private setSlotItem(
    pokemon: BattlePokemon,
    slot: "bonus" | "battle",
    itemId: string | null,
    itemName: string | null
  ) {
    if (slot === "bonus") {
      pokemon.heldItemId = itemId;
      pokemon.heldItemName = itemName;
      if (pokemon.originalSummary) {
        pokemon.originalSummary.heldItemId = itemId ?? undefined;
        pokemon.originalSummary.heldItemName = itemName ?? undefined;
      }
    } else {
      pokemon.battleItemId = itemId;
      pokemon.battleItemName = itemName;
      if (pokemon.originalSummary) {
        pokemon.originalSummary.battleItemId = itemId ?? undefined;
        pokemon.originalSummary.battleItemName = itemName ?? undefined;
      }
    }
  }

  /** The battle-slot consumable that saves from a lethal hit (Focus Sash). */
  private getLethalSaveItem(battle: BattleSession, pokemon: BattlePokemon) {
    if (battle.magicRoomTurns > 0 || pokemon.volatile.embargoTurns > 0) {
      return null;
    }
    const slotItem = this.getSlotItem(pokemon, "battle");
    if (!slotItem.id) {
      return null;
    }
    const definition = this.getCachedItemDefinition(slotItem.id, slotItem.name ?? "");
    const effect = definition?.heldEffect;
    if (!definition || !effect || effect.trigger !== "lethal-hit") {
      return null;
    }
    return { definition, effect };
  }

  /** White Herb: right after a stat drop, reset every lowered stage. */
  private applyStatDropTriggers(battle: BattleSession, side: BattleSide, pokemon: BattlePokemon) {
    if (battle.magicRoomTurns > 0 || pokemon.volatile.embargoTurns > 0) {
      return;
    }
    const slotItem = this.getSlotItem(pokemon, "battle");
    if (!slotItem.id) {
      return;
    }
    const definition = this.getCachedItemDefinition(slotItem.id, slotItem.name ?? "");
    if (!definition || definition.heldEffect?.trigger !== "stat-drop") {
      return;
    }
    const loweredStats = (Object.keys(pokemon.stages) as BattleStageKey[]).filter(
      (stat) => pokemon.stages[stat] < 0
    );
    if (loweredStats.length === 0) {
      return;
    }
    loweredStats.forEach((stat) => {
      pokemon.stages[stat] = 0;
    });
    this.pushEvent(
      battle,
      { kind: "held-item-used", sideId: side.id, pokemonId: pokemon.id, itemName: definition.name },
      `${getPokemonDisplayName(pokemon)} restored its stats with its ${definition.name}!`
    );
    this.consumeHeldItem(pokemon, "battle");
  }

  /** The slot Knock Off / Thief / Trick / Fling act on (appearance is unlosable). */
  private getRemovableSlot(pokemon: BattlePokemon): "bonus" | "battle" | null {
    if (pokemon.battleItemId) {
      return "battle";
    }
    if (pokemon.heldItemId) {
      return "bonus";
    }
    return null;
  }

  /**
   * Hands an item to a battler mid-battle (Thief / Trick / Bestow): it lands
   * in its natural slot when free, else in whichever of the two item slots is
   * empty so nothing is ever silently lost. Returns false when both are full.
   */
  private giveItemToBattler(pokemon: BattlePokemon, itemId: string, itemName: string | null): boolean {
    const definition = this.getCachedItemDefinition(itemId, itemName ?? "");
    const slot = classifyEquipmentSlot({
      essentialsId: definition?.essentialsId ?? this.internalIdFromItemId(itemId),
      speciesInternalId: toSpeciesInternalId(pokemon.sourcePokemonId, pokemon.name),
      heldBonus: definition?.heldBonus ?? null,
      heldEffect: definition?.heldEffect ?? null
    });
    const preferred: Array<"bonus" | "battle"> =
      slot === "battle" ? ["battle", "bonus"] : ["bonus", "battle"];
    for (const candidate of preferred) {
      if (!this.getSlotItem(pokemon, candidate).id) {
        this.setSlotItem(pokemon, candidate, itemId, itemName);
        return true;
      }
    }
    return false;
  }

  private syncPokemonProgression(pokemon: BattlePokemon, config: LevelingCurveConfig) {
    const summary = pokemon.originalSummary;
    if (!summary) {
      return;
    }

    summary.level = clamp(summary.level, 1, 100);
    summary.experience = Math.max(0, Math.round(summary.experience));
    summary.statBonuses = sanitizePokemonStatBonuses(summary.statBonuses);
    summary.nextLevelExperience = this.getExperienceRequirement(pokemon, summary.level, config);

    if (summary.level >= 100) {
      summary.experience = 0;
      summary.nextLevelExperience = 0;
    }

    pokemon.level = summary.level;
    pokemon.statBonuses = summary.statBonuses;
    pokemon.experience = summary.experience;
    pokemon.nextLevelExperience = summary.nextLevelExperience;
  }

  /**
   * Experience needed to go from `level` to `level + 1`: the species growth
   * curve when the species defines one, otherwise the designer-configured
   * global leveling curve.
   */
  private getExperienceRequirement(
    pokemon: Pick<BattlePokemon, "growthRate">,
    level: number,
    config: LevelingCurveConfig
  ) {
    if (level >= 100) {
      return 0;
    }

    if (pokemon.growthRate) {
      return expToNextLevel(pokemon.growthRate, level);
    }

    return getExperienceForNextLevel(level, config);
  }

  private async awardExperienceForFaint(
    battle: BattleSession,
    faintedSide: BattleSide,
    faintedPokemon: BattlePokemon
  ) {
    const winnerSide = this.getOpponentSide(battle, faintedSide);
    if (typeof winnerSide.userId !== "number") {
      return;
    }

    const catalogs = await this.loadCatalogs();
    const participantIds = battle.participation.get(faintedPokemon.id) ?? new Set<string>();
    let participants = winnerSide.party.filter(
      (pokemon) =>
        participantIds.has(pokemon.id) &&
        !isFainted(pokemon) &&
        pokemon.originalSummary &&
        pokemon.level < 100
    );

    if (participants.length === 0) {
      const active = getActivePokemon(winnerSide);
      participants =
        active && !isFainted(active) && active.originalSummary && active.level < 100 ? [active] : [];
    }

    if (participants.length === 0) {
      return;
    }

    for (const participant of participants) {
      this.applyEvYield(participant, faintedPokemon);

      let gained =
        faintedPokemon.baseExp > 0
          ? computeFoeExperience({
              baseExp: faintedPokemon.baseExp,
              foeLevel: faintedPokemon.level,
              isTrainerBattle: battle.kind === "trainer",
              participantCount: participants.length
            })
          : computeBattleExperience(catalogs.levelingCurveConfig, participant.level, faintedPokemon.level);

      // Lucky Egg: the holder earns boosted EXP.
      const expMultiplier = this.getHeldBonus(participant, battle)?.expMultiplier ?? 1;
      if (expMultiplier > 1) {
        gained = Math.floor(gained * expMultiplier);
      }

      if (gained <= 0) {
        continue;
      }

      await this.grantExperience(battle, winnerSide, participant, gained, catalogs);
    }
  }

  private applyEvYield(participant: BattlePokemon, faintedPokemon: BattlePokemon) {
    const summary = participant.originalSummary;
    if (!summary) {
      return;
    }

    (Object.entries(faintedPokemon.evYield) as Array<[BattleStatKey, number]>).forEach(
      ([stat, amount]) => {
        if (!amount || amount <= 0) {
          return;
        }
        participant.evs[stat] = clamp(participant.evs[stat] + amount, 0, MAX_EV_PER_STAT);
      }
    );
    summary.evs = { ...participant.evs };
  }

  private async grantExperience(
    battle: BattleSession,
    side: BattleSide,
    pokemon: BattlePokemon,
    gained: number,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ) {
    const summary = pokemon.originalSummary;
    if (!summary || summary.level >= 100) {
      return;
    }

    this.syncPokemonProgression(pokemon, catalogs.levelingCurveConfig);

    let remaining = gained;
    summary.experience += remaining;
    pokemon.experience = summary.experience;
    this.pushEvent(
      battle,
      {
        kind: "exp-gain",
        sideId: side.id,
        pokemonId: pokemon.id,
        amount: gained,
        experience: Math.min(summary.experience, summary.nextLevelExperience || summary.experience),
        nextLevelExperience: summary.nextLevelExperience
      },
      `${getPokemonDisplayName(pokemon)} gained ${gained} EXP.`
    );
    await this.emitBattleStep(battle);

    while (
      battle.status === "active" &&
      summary.level < 100 &&
      summary.nextLevelExperience > 0 &&
      summary.experience >= summary.nextLevelExperience
    ) {
      summary.experience -= summary.nextLevelExperience;
      await this.levelUpPokemon(battle, side, pokemon, catalogs);
    }

    pokemon.experience = summary.experience;
    pokemon.nextLevelExperience = summary.nextLevelExperience;
  }

  private async levelUpPokemon(
    battle: BattleSession,
    side: BattleSide,
    pokemon: BattlePokemon,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ) {
    const summary = pokemon.originalSummary;
    if (!summary) {
      return;
    }

    const statsBefore = calculateStats(
      pokemon.baseStats,
      summary.level,
      pokemon.statBonuses,
      pokemon.ivs,
      pokemon.evs
    );
    const nextLevel = Math.min(100, summary.level + 1);
    const statsAfter = calculateStats(
      pokemon.baseStats,
      nextLevel,
      pokemon.statBonuses,
      pokemon.ivs,
      pokemon.evs
    );

    const statGains = {} as Record<BattleStatKey, BattleStatGain>;
    (Object.keys(statsAfter) as BattleStatKey[]).forEach((stat) => {
      statGains[stat] = {
        before: statsBefore[stat],
        after: statsAfter[stat],
        gain: statsAfter[stat] - statsBefore[stat]
      };
    });

    const hpGain = Math.max(0, statsAfter.hp - statsBefore.hp);
    summary.level = nextLevel;
    summary.maxHp = statsAfter.hp;
    summary.hp = clamp(pokemon.hp + hpGain, 1, statsAfter.hp);
    summary.nextLevelExperience = this.getExperienceRequirement(pokemon, nextLevel, catalogs.levelingCurveConfig);
    if (nextLevel >= 100) {
      summary.experience = 0;
      summary.nextLevelExperience = 0;
    }

    pokemon.level = nextLevel;
    pokemon.stats = statsAfter;
    pokemon.maxHp = statsAfter.hp;
    pokemon.hp = summary.hp;
    pokemon.nextLevelExperience = summary.nextLevelExperience;
    battle.leveledPokemonIds.add(pokemon.id);

    this.pushEvent(
      battle,
      {
        kind: "level-up",
        sideId: side.id,
        pokemonId: pokemon.id,
        pokemonName: getPokemonDisplayName(pokemon),
        level: nextLevel,
        statGains
      },
      `${getPokemonDisplayName(pokemon)} grew to level ${nextLevel}!`
    );
    await this.emitBattleStep(battle);
    await this.learnMovesAtLevel(battle, side, pokemon, nextLevel, catalogs);
  }

  private async learnMovesAtLevel(
    battle: BattleSession,
    side: BattleSide,
    pokemon: BattlePokemon,
    level: number,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ) {
    const summary = pokemon.originalSummary;
    if (!summary) {
      return;
    }

    const learnable = pokemon.learnset.filter((entry) => entry.level === level);

    for (const entry of learnable) {
      if (pokemon.moves.some((move) => move.name === entry.skillName)) {
        continue;
      }

      const skillDefinition =
        catalogs.skillsById.get(entry.skillId) ??
        catalogs.skillsByName.get(entry.skillName.toLowerCase());
      if (!skillDefinition) {
        continue;
      }

      if (pokemon.moves.length < 4) {
        const move = this.buildBattleMove(skillDefinition);
        pokemon.moves = [...pokemon.moves, move];
        summary.moves = [...summary.moves, move.name];
        summary.movePp = { ...(summary.movePp ?? {}), [move.name]: move.currentPp };
        this.pushEvent(
          battle,
          { kind: "move-learned", sideId: side.id, pokemonId: pokemon.id, moveName: move.name },
          `${getPokemonDisplayName(pokemon)} learned ${move.name}!`
        );
        await this.emitBattleStep(battle);
        continue;
      }

      const pending = summary.pendingMoveLearns ?? [];
      if (!pending.includes(entry.skillName)) {
        summary.pendingMoveLearns = [...pending, entry.skillName];
      }
      this.pushEvent(
        battle,
        {
          kind: "move-learn-prompt",
          sideId: side.id,
          pokemonId: pokemon.id,
          pokemonName: getPokemonDisplayName(pokemon),
          moveName: entry.skillName,
          currentMoves: pokemon.moves.map((move) => move.name)
        },
        `${getPokemonDisplayName(pokemon)} wants to learn ${entry.skillName}.`
      );
      await this.emitBattleStep(battle);
    }
  }

  private async finishBattle(
    battle: BattleSession,
    result: string,
    winner: BattleSide | null,
    loser: BattleSide | null
  ) {
    battle.status = "ended";
    battle.result = result;
    battle.endedAt = new Date().toISOString();
    if (battle.log[battle.log.length - 1] !== result) {
      this.appendBattleLog(battle, result);
    }
    this.clearBattleTimer(battle);
    // Unblock a turn that is suspended waiting for a replacement choice.
    battle.replacementRequest?.resolve(null);
    // Transform is battle-only: revert copies before anything persists.
    battle.sides.forEach((side) => side.party.forEach((pokemon) => this.restoreTransform(pokemon)));

    if (battle.kind === "trainer" && winner?.userId && loser?.userId) {
      const transferAmount = Math.max(0, Math.min(PVP_SURRENDER_REWARD, loser.money));
      loser.money -= transferAmount;
      winner.money += transferAmount;
      battle.log = [
        ...battle.log,
        `${winner.trainerName} received $${transferAmount}.`
      ];
    } else if (battle.kind === "trainer" && winner?.userId && loser?.isAi && loser.money > 0) {
      // Happy Hour doubles the prize money; an Amulet Coin in the winning
      // party stacks on top.
      const amuletMultiplier = winner.party.reduce(
        (best, pokemon) => Math.max(best, this.getHeldBonus(pokemon, battle)?.moneyMultiplier ?? 1),
        1
      );
      const prize = Math.floor(loser.money * Math.max(1, battle.moneyMultiplier) * amuletMultiplier);
      loser.money = 0;
      winner.money += prize;
      this.pushEvent(
        battle,
        { kind: "message", text: `${winner.trainerName} got $${prize} for winning!` },
        `${winner.trainerName} got $${prize} for winning!`
      );
    }

    // Pay Day's scattered coins go to a victorious player.
    if (battle.extraMoney > 0 && winner?.userId) {
      winner.money += battle.extraMoney;
      this.pushEvent(
        battle,
        { kind: "message", text: `${winner.trainerName} picked up $${battle.extraMoney}!` },
        `${winner.trainerName} picked up $${battle.extraMoney}!`
      );
    }

    const catalogs = await this.loadCatalogs();
    battle.sides.forEach((side) => {
      side.party.forEach((pokemon) => this.syncPokemonProgression(pokemon, catalogs.levelingCurveConfig));
    });

    await this.applyEvolutions(battle, catalogs);

    this.pushEvent(battle, {
      kind: "battle-end",
      result,
      winnerSideId: winner?.id ?? null
    });

    battle.summary = this.createBattleSummary(battle, result, winner, loser);

    // A player whose whole team faints "blacks out": their party is healed and
    // they are returned to a safe spot after the battle (classic Pokemon rule),
    // so a wipe can never leave them stuck with no way to heal.
    const whiteoutSides: BattleSide[] = [];

    await Promise.all(
      battle.sides
        .filter((side) => typeof side.userId === "number")
        .map(async (side) => {
          const wipedOut = Boolean(side.playerId) && !this.hasAvailablePokemon(side);
          let partySummaries = this.toPokemonPartySummaries(side);
          if (wipedOut) {
            partySummaries = partySummaries.map((pokemon) => ({
              ...pokemon,
              hp: pokemon.maxHp,
              status: null,
              movePp: this.restorePokemonMovePp(pokemon, catalogs.skillsByName)
            }));
            whiteoutSides.push(side);
          }
          // Eggs sat out the battle (and any whiteout heal); restore them.
          partySummaries = this.reinsertHeldEggs(side, partySummaries);
          await this.auth.saveBattleState(side.userId!, {
            pokemonParty: partySummaries,
            inventory: side.inventory,
            money: side.money
          });
          const user = await this.auth.appendBattleHistory(side.userId!, {
            id: crypto.randomUUID(),
            battleId: battle.summary!.battleId,
            kind: battle.summary!.kind,
            opponentName: this.getOpponentSide(battle, side).trainerName,
            winnerName: battle.summary!.winnerName,
            loserName: battle.summary!.loserName,
            result: battle.summary!.result,
            startedAt: battle.summary!.startedAt,
            endedAt: battle.summary!.endedAt ?? new Date().toISOString(),
            log: battle.summary!.log
          });
          if (user) {
            this.emitAuthSession(side, user);
          }
        })
    );

    this.emitBattleState(battle);
    this.flushEvents(battle);
    battle.sides.forEach((side) => {
      if (!side.playerId) {
        return;
      }

      this.playerBattleIds.delete(side.playerId);
      const player = this.world.players.get(side.playerId);
      if (player) {
        player.leaveBattle();
      }
    });
    this.battles.delete(battle.id);
    battle.sides.forEach((side) => this.emitToSide(side, "battle:ended", { battleId: battle.id }));

    // Perform the blackout teleport after the battle has fully torn down.
    for (const side of whiteoutSides) {
      const player = this.world.getPlayerByUserId(side.userId!);
      if (!player) {
        continue;
      }
      const mapsState = this.world.getPlayableMapsState();
      // Classic rule: return to the last visited Pokemon Center; fall back to
      // the initial spawn when none has been visited yet.
      const respawn = await this.auth.getRespawnPoint(side.userId!);
      const spawn =
        respawn && mapsState?.editorDataByMapId[respawn.mapId]
          ? respawn
          : mapsState
            ? resolveInitialSpawnFromPlayableMapsState(mapsState)
            : null;
      if (spawn) {
        player.teleport(spawn.mapId, spawn.x, spawn.y);
        this.world.players.set(player.socketId, player);
        this.world.presentPlayerToMap(player);
        player.socketConnections.forEach((socketId) => {
          this.world.presentPlayersOnMapTo(socketId, player.currentMapId);
        });
      }
      this.emitToPlayer(player, "auth:info", {
        message: "You blacked out! Your team was healed and you were returned to a safe place."
      });
    }

    // Wake anything awaiting this battle's outcome (scripted trainer events).
    const endListeners = this.battleEndListeners.get(battle.id);
    if (endListeners) {
      this.battleEndListeners.delete(battle.id);
      endListeners.forEach((listener) => {
        try {
          listener(winner?.id ?? null);
        } catch {
          // A bad listener must not break battle teardown.
        }
      });
    }
  }

  private async applyEvolutions(
    battle: BattleSession,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ) {
    for (const side of battle.sides) {
      if (typeof side.userId !== "number") {
        continue;
      }

      for (const pokemon of side.party) {
        const summary = pokemon.originalSummary;
        if (!summary || !battle.leveledPokemonIds.has(pokemon.id) || isFainted(pokemon)) {
          continue;
        }

        const target = this.findLevelEvolutionTarget(pokemon, catalogs);
        if (!target) {
          continue;
        }

        const fromName = getPokemonDisplayName(pokemon);
        const newStats = calculateStats(
          target.baseStats,
          pokemon.level,
          pokemon.statBonuses,
          pokemon.ivs,
          pokemon.evs
        );
        const missingHp = pokemon.maxHp - pokemon.hp;

        summary.sourcePokemonId = target.id;
        summary.name = target.name;
        summary.types = target.types;
        summary.maxHp = newStats.hp;
        summary.hp = clamp(newStats.hp - missingHp, 1, newStats.hp);

        pokemon.sourcePokemonId = target.id;
        pokemon.name = target.name;
        pokemon.types = target.types;
        pokemon.baseStats = target.baseStats;
        pokemon.stats = newStats;
        pokemon.maxHp = newStats.hp;
        pokemon.hp = summary.hp;
        pokemon.frontImageSrc = target.frontImageSrc || pokemon.frontImageSrc;
        pokemon.backImageSrc = target.backImageSrc || pokemon.backImageSrc;
        pokemon.growthRate = target.growthRate ?? pokemon.growthRate;
        pokemon.baseExp = target.baseExp;
        pokemon.catchRate = target.catchRate;
        pokemon.evYield = target.evYield;
        pokemon.learnset = target.skills;
        pokemon.evolutions = target.evolutions;

        this.pushEvent(
          battle,
          {
            kind: "evolution",
            sideId: side.id,
            pokemonId: pokemon.id,
            fromName,
            toName: target.name,
            frontImageSrc: pokemon.frontImageSrc,
            backImageSrc: pokemon.backImageSrc
          },
          `${fromName} evolved into ${target.name}!`
        );
      }
    }
  }

  private findLevelEvolutionTarget(
    pokemon: BattlePokemon,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): PokemonDefinition | null {
    for (const evolution of pokemon.evolutions) {
      const method = evolution.method.trim().toLowerCase().replace(/[\s_-]/g, "");
      if (method !== "level" && method !== "levelup") {
        continue;
      }

      const requiredLevel =
        typeof evolution.parameter === "number"
          ? evolution.parameter
          : Number.parseInt(String(evolution.parameter ?? ""), 10);
      if (!Number.isFinite(requiredLevel) || requiredLevel <= 0 || pokemon.level < requiredLevel) {
        continue;
      }

      const target = this.resolvePokemonDefinition(evolution.targetId, catalogs);
      if (target && target.id !== pokemon.sourcePokemonId) {
        return target;
      }
    }

    return null;
  }

  private resolvePokemonDefinition(
    reference: string,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): PokemonDefinition | null {
    const trimmed = reference.trim();
    if (!trimmed) {
      return null;
    }

    const byId = catalogs.pokemonById.get(trimmed);
    if (byId) {
      return byId;
    }

    const lowered = trimmed.toLowerCase();
    for (const definition of catalogs.pokemonById.values()) {
      if (
        definition.essentialsId.toLowerCase() === lowered ||
        definition.name.toLowerCase() === lowered
      ) {
        return definition;
      }
    }

    return null;
  }

  private sanitizeAction(action: BattleClientAction | undefined): BattleQueuedAction | null {
    if (!action || typeof action.type !== "string") {
      return null;
    }

    if (action.type === "fight" && typeof action.moveId === "string") {
      return { type: "fight", moveId: action.moveId };
    }

    if (action.type === "bag" && typeof action.itemId === "string") {
      return {
        type: "bag",
        itemId: action.itemId,
        targetPokemonId: typeof action.targetPokemonId === "string" ? action.targetPokemonId : undefined
      };
    }

    if (action.type === "pokemon" && typeof action.pokemonId === "string") {
      return { type: "pokemon", pokemonId: action.pokemonId };
    }

    if (action.type === "run") {
      return { type: "run" };
    }

    if (action.type === "surrender") {
      return { type: "surrender" };
    }

    return null;
  }

  private validateAction(battle: BattleSession, side: BattleSide, action: BattleQueuedAction) {
    const activePokemon = getActivePokemon(side);

    if (action.type === "fight") {
      const move = activePokemon.moves.find((candidate) => candidate.id === action.moveId);
      if (!move) {
        return "That skill is not available.";
      }
      if (move.currentPp <= 0) {
        return "That skill has no PP left.";
      }

      // Choice items seal every move except the first one used while holding.
      const lockedMoveId = activePokemon.volatile.choiceLockMoveId;
      if (
        lockedMoveId &&
        lockedMoveId !== move.id &&
        this.getHeldBonus(activePokemon, battle)?.choiceLock &&
        activePokemon.moves.some((candidate) => candidate.id === lockedMoveId && candidate.currentPp > 0)
      ) {
        const lockedMove = activePokemon.moves.find((candidate) => candidate.id === lockedMoveId);
        return `${getPokemonDisplayName(activePokemon)} is locked into ${lockedMove?.name ?? "its move"} by its ${activePokemon.heldItemName ?? "held item"}!`;
      }
    }

    if (action.type === "pokemon") {
      const targetPokemon = side.party.find((pokemon) => pokemon.id === action.pokemonId);
      if (!targetPokemon || targetPokemon.id === activePokemon.id || isFainted(targetPokemon)) {
        return "That Pokemon cannot enter battle.";
      }
    }

    if (action.type === "bag") {
      const item = side.inventory.find((candidate) => candidate.id === action.itemId);
      const definition = item ? this.getCachedItemDefinition(item.id, item.name) : null;
      const isPokeball = Boolean(definition?.isPokeball);

      if (!item || item.quantity <= 0 || (!isPokeball && !["usable", "berries"].includes(item.category))) {
        return "That item cannot be used in battle.";
      }

      if (isPokeball && battle.kind !== "wild") {
        // A full party no longer blocks the throw: the catch goes to PC storage.
        return "You can't catch another trainer's Pokemon!";
      }
    }

    if (action.type === "run" && battle.kind === "trainer") {
      return "Run is not available in trainer battles.";
    }

    if (action.type === "surrender" && battle.kind !== "trainer") {
      return "Surrender is only available in trainer battles.";
    }

    return null;
  }

  private canSideAct(side: BattleSide) {
    return !side.isAi && !isFainted(getActivePokemon(side));
  }

  private createTimeoutAction(side: BattleSide): BattleQueuedAction {
    const moves = getUsableMoves(getActivePokemon(side));
    if (moves.length === 0) {
      return { type: "pass" };
    }

    return {
      type: "fight",
      moveId: chooseRandom(moves).id
    };
  }

  private chooseAiAction(side: BattleSide, opponent: BattleSide): BattleQueuedAction {
    const activePokemon = getActivePokemon(side);
    const volatile = activePokemon.volatile;
    const opponentActive = getActivePokemon(opponent);
    let moves = getUsableMoves(activePokemon).filter((move) => {
      if (volatile.disable?.moveId === move.id) {
        return false;
      }
      if (
        volatile.choiceLockMoveId &&
        move.id !== volatile.choiceLockMoveId &&
        this.getHeldBonus(activePokemon)?.choiceLock
      ) {
        return false;
      }
      if (volatile.encore && move.id !== volatile.encore.moveId) {
        return false;
      }
      if (volatile.tauntTurns > 0 && move.damageClass === "status") {
        return false;
      }
      if (volatile.torment && volatile.lastMoveId === move.id) {
        return false;
      }
      if (opponentActive?.volatile.imprison && opponentActive.moves.some((known) => known.name === move.name)) {
        return false;
      }
      return true;
    });
    if (moves.length === 0) {
      moves = getUsableMoves(activePokemon);
    }

    if (moves.length === 0) {
      return { type: "pass" };
    }

    const targetPokemon = getActivePokemon(opponent);
    const scoreMove = (move: BattleMove) => {
      const stab = activePokemon.types.some((type) => isSameType(this.typeChart, type, move.type)) ? 1.5 : 1;
      return Math.max(1, move.power) * this.getEffectiveness(move.type, targetPokemon.types) * stab;
    };
    const bestMove = [...moves].sort((left, right) => scoreMove(right) - scoreMove(left))[0];

    return {
      type: "fight",
      moveId: bestMove.id
    };
  }

  /** Applies a bag action. Returns true when the item ended the battle (capture). */
  private async applyItemAction(
    battle: BattleSession,
    side: BattleSide,
    action: Extract<BattleQueuedAction, { type: "bag" }>
  ): Promise<boolean> {
    const item = side.inventory.find((candidate) => candidate.id === action.itemId);
    const itemDefinition = this.getCachedItemDefinition(item?.id ?? "", item?.name ?? "");

    if (!item || !itemDefinition || item.quantity <= 0) {
      this.say(battle, `${side.trainerName} could not use that item.`);
      return false;
    }

    if (itemDefinition.isPokeball) {
      return this.applyPokeballAction(battle, side, item, itemDefinition);
    }

    const targetPokemon =
      side.party.find((pokemon) => pokemon.id === action.targetPokemonId) ??
      getActivePokemon(side);

    item.quantity -= 1;
    this.pushEvent(
      battle,
      {
        kind: "item-used",
        sideId: side.id,
        itemId: item.id,
        itemName: item.name,
        targetPokemonId: targetPokemon.id
      },
      `${side.trainerName} used ${item.name} on ${getPokemonDisplayName(targetPokemon)}.`
    );

    const displayName = getPokemonDisplayName(targetPokemon);
    const modifiers = itemDefinition.statModifiers;

    if (modifiers.hp > 0 && targetPokemon.hp > 0) {
      const beforeHp = targetPokemon.hp;
      targetPokemon.hp = clamp(targetPokemon.hp + modifiers.hp, 0, targetPokemon.maxHp);
      if (targetPokemon.hp > beforeHp) {
        this.pushEvent(
          battle,
          {
            kind: "heal",
            sideId: side.id,
            pokemonId: targetPokemon.id,
            amount: targetPokemon.hp - beforeHp,
            hpAfter: targetPokemon.hp,
            maxHp: targetPokemon.maxHp,
            source: "item"
          },
          `${displayName} recovered ${targetPokemon.hp - beforeHp} HP.`
        );
      }
    }

    if (itemDefinition.curesStatuses && targetPokemon.status) {
      const cures =
        itemDefinition.curesStatuses === "any" ||
        itemDefinition.curesStatuses.includes(targetPokemon.status.id);
      if (cures) {
        this.pushEvent(
          battle,
          {
            kind: "status-cured",
            sideId: side.id,
            pokemonId: targetPokemon.id,
            status: targetPokemon.status.id
          },
          `${displayName} is no longer ${STATUS_DISPLAY_NAMES[targetPokemon.status.id]}.`
        );
        targetPokemon.status = null;
      }
    }

    if (itemDefinition.curesConfusion && targetPokemon.volatile.confusionTurns > 0) {
      targetPokemon.volatile.confusionTurns = 0;
      this.pushEvent(
        battle,
        { kind: "confusion-end", sideId: side.id, pokemonId: targetPokemon.id },
        `${displayName} snapped out of its confusion.`
      );
    }

    const stageKeys: Array<Exclude<BattleStageKey, "accuracy" | "evasion">> = [
      "attack",
      "defense",
      "specialAttack",
      "specialDefense",
      "speed"
    ];
    stageKeys.forEach((stat) => {
      const delta = modifiers[stat];
      if (delta !== 0) {
        this.applyStatStageChange(battle, side, targetPokemon, stat, delta, false);
      }
    });

    return false;
  }

  private async applyPokeballAction(
    battle: BattleSession,
    side: BattleSide,
    item: InventoryItem,
    itemDefinition: ItemDefinition
  ): Promise<boolean> {
    const opponent = this.getOpponentSide(battle, side);
    const wildPokemon = getActivePokemon(opponent);

    if (battle.kind !== "wild" || !opponent.isAi || !wildPokemon || isFainted(wildPokemon)) {
      this.say(battle, `${side.trainerName} can't use ${item.name} right now.`);
      return false;
    }

    item.quantity -= 1;
    this.pushEvent(
      battle,
      { kind: "item-used", sideId: side.id, itemId: item.id, itemName: item.name, targetPokemonId: null },
      `${side.trainerName} threw a ${item.name}!`
    );

    const catchRate = wildPokemon.catchRate > 0 ? wildPokemon.catchRate : 45;
    const ballBonus = itemDefinition.pokeballBonusRatio > 0 ? itemDefinition.pokeballBonusRatio : 1;
    const statusBonus = getStatusCatchBonus(wildPokemon.status);
    const captureValue = clamp(
      Math.floor(
        ((3 * wildPokemon.maxHp - 2 * wildPokemon.hp) * catchRate * ballBonus * statusBonus) /
          (3 * wildPokemon.maxHp)
      ),
      1,
      255
    );

    let shakes = 0;
    let caught = false;
    if (captureValue >= 255) {
      shakes = 4;
      caught = true;
    } else {
      const shakeThreshold = Math.floor(
        1048560 / Math.sqrt(Math.sqrt(Math.floor(16711680 / captureValue)))
      );
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (Math.floor(Math.random() * 65536) >= shakeThreshold) {
          break;
        }
        shakes += 1;
      }
      caught = shakes === 4;
    }

    this.pushEvent(
      battle,
      {
        kind: "catch-attempt",
        pokemonId: wildPokemon.id,
        pokemonName: getPokemonDisplayName(wildPokemon),
        ballName: item.name,
        shakes,
        caught
      },
      caught
        ? `Gotcha! ${getPokemonDisplayName(wildPokemon)} was caught!`
        : shakes === 0
          ? `Oh no! ${getPokemonDisplayName(wildPokemon)} broke free immediately!`
          : `Oh no! ${getPokemonDisplayName(wildPokemon)} broke free!`
    );
    await this.emitBattleStep(battle);

    if (!caught) {
      return false;
    }

    const caughtSummary: PokemonSummary = {
      id: crypto.randomUUID(),
      sourcePokemonId: wildPokemon.sourcePokemonId,
      name: wildPokemon.name,
      level: wildPokemon.level,
      types: wildPokemon.types,
      hp: Math.max(1, wildPokemon.hp),
      maxHp: wildPokemon.maxHp,
      moves: wildPokemon.moves.map((move) => move.name),
      movePp: wildPokemon.moves.reduce<Record<string, number>>((accumulator, move) => {
        accumulator[move.name] = move.currentPp;
        return accumulator;
      }, {}),
      experience: 0,
      experienceCurve: "medium",
      nextLevelExperience: this.getExperienceRequirement(
        wildPokemon,
        wildPokemon.level,
        await this.getLevelingCurveConfig()
      ),
      statBonuses: createEmptyPokemonStatBonuses(),
      ivs: { ...wildPokemon.ivs },
      evs: { ...wildPokemon.evs },
      status: wildPokemon.status ? { ...wildPokemon.status } : undefined,
      heldItemId: undefined,
      heldItemName: undefined
    };

    if (side.party.length >= MAX_PARTY_SIZE && typeof side.userId === "number") {
      // Party full: the catch still succeeds and goes straight to PC storage
      // (unless storage itself is completely full).
      const stored = await this.auth.addPokemonToStorage(side.userId, caughtSummary);
      const storedMessage = stored.ok
        ? `${getPokemonDisplayName(wildPokemon)} was sent to storage (${stored.boxName}).`
        : `${getPokemonDisplayName(wildPokemon)} was caught, but ${stored.message}`;
      this.pushEvent(battle, { kind: "message", text: storedMessage }, storedMessage);
      await this.finishBattle(battle, `${getPokemonDisplayName(wildPokemon)} was caught!`, side, opponent);
      return true;
    }

    side.party.push({ ...wildPokemon, id: caughtSummary.id, originalSummary: caughtSummary });
    await this.finishBattle(battle, `${getPokemonDisplayName(wildPokemon)} was caught!`, side, opponent);
    return true;
  }

  private async getLevelingCurveConfig() {
    const catalogs = await this.loadCatalogs();
    return catalogs.levelingCurveConfig;
  }

  private cachedItemDefinitions: ItemDefinition[] = [];
  private cachedSkillsById = new Map<string, SkillDefinition>();
  private cachedSkillsByEssentialsId = new Map<string, SkillDefinition>();
  private eventMartResolver:
    | ((userId: number, placementId: string) => NpcStoreDefinition[] | null)
    | null = null;
  private cachedNpcDefinitions = new Map<string, NpcDefinition>();

  /** Catalog definition of an inventory item id (housing furniture checks). */
  public async findItemDefinitionById(itemId: string, itemName = ""): Promise<ItemDefinition | null> {
    await this.loadCatalogs();
    return this.getCachedItemDefinition(itemId, itemName) ?? null;
  }

  /**
   * A designer map object (designer:section:objects) by id — what furniture
   * items draw when placed in a house. Read through the section store's
   * probe cache, so it is cheap and follows designer edits.
   */
  public async findMapObjectAssetById(
    objectId: string
  ): Promise<{ id: string; name: string; imageSrc: string; width: number; height: number; objectType: string } | null> {
    if (!objectId) {
      return null;
    }
    const payload = await this.designerSectionStore.read("objects");
    const item = (payload?.state.items ?? []).find((candidate) => candidate.id === objectId);
    const asset = item?.mapObjectAsset as
      | { imageSrc?: unknown; width?: unknown; height?: unknown; objectType?: unknown }
      | undefined;
    if (!item || !asset || typeof asset.imageSrc !== "string" || !asset.imageSrc) {
      return null;
    }
    return {
      id: item.id,
      name: item.name,
      imageSrc: asset.imageSrc,
      width: Math.max(1, Math.round(parseNumber(asset.width, 32))),
      height: Math.max(1, Math.round(parseNumber(asset.height, 32))),
      objectType: normalizeText(asset.objectType) || "obstacle"
    };
  }

  private getCachedItemDefinition(itemId: string, itemName: string) {
    const normalizedName = itemName.toLowerCase();
    return this.cachedItemDefinitions.find((item) =>
      item.id === itemId || item.name.toLowerCase() === normalizedName
    ) ?? null;
  }

  private removeInventoryQuantity(inventory: InventoryItem[], itemId: string, quantity: number) {
    const removeQuantity = Math.max(1, Math.round(quantity));

    return inventory
      .map((item) =>
        item.id === itemId
          ? {
              ...item,
              quantity: item.quantity - removeQuantity
            }
          : item
      )
      .filter((item) => item.quantity > 0);
  }

  private addInventoryQuantity(
    inventory: InventoryItem[],
    itemDefinition: ItemDefinition,
    quantity: number
  ) {
    const addQuantity = Math.max(1, Math.round(quantity));
    const existingItem = inventory.find((item) => item.id === itemDefinition.id);

    if (existingItem) {
      return inventory.map((item) =>
        item.id === itemDefinition.id
          ? {
              ...item,
              quantity: item.quantity + addQuantity
            }
          : item
      );
    }

    return [
      ...inventory,
      {
        id: itemDefinition.id,
        name: itemDefinition.name,
        category: itemDefinition.category,
        quantity: addQuantity,
        description: itemDefinition.description
      }
    ];
  }

  private resolveNpcInteraction(
    userId: number,
    npcPlacementId?: string
  ): { ok: false; message: string } | ({ ok: true } & ResolvedNpcInteraction) {
    if (typeof npcPlacementId !== "string" || npcPlacementId.trim().length === 0) {
      return { ok: false, message: "Choose an NPC to interact with." };
    }

    const player = this.world.getPlayerByUserId(userId);

    if (!player) {
      return { ok: false, message: "Enter the world before talking to NPCs." };
    }

    const playableMapsState = this.world.getPlayableMapsState();

    if (!playableMapsState) {
      return { ok: false, message: "The world map is still loading." };
    }

    const mapEditorData = playableMapsState.editorDataByMapId[templateMapIdFor(player.currentMapId)];
    const placement =
      mapEditorData?.npcs.find((candidate) => candidate.id === npcPlacementId) ?? null;

    if (!placement) {
      return { ok: false, message: "That NPC is not on your current map." };
    }

    const mapDefinition =
      playableMapsState.items.find((candidate) => candidate.id === templateMapIdFor(player.currentMapId)) ?? null;
    const cellSize = mapDefinition?.playableMapConfig?.cellSize ?? 32;
    const interactionDistanceSquares =
      typeof placement.interactionDistanceSquares === "number" &&
      Number.isFinite(placement.interactionDistanceSquares) &&
      placement.interactionDistanceSquares >= 0
        ? placement.interactionDistanceSquares
        : 2;
    const playerCenterX = player.x + player.width / 2;
    const playerCenterY = player.y + player.height / 2;
    const npcCenterX = placement.x * cellSize + cellSize / 2;
    const npcCenterY = placement.y * cellSize + cellSize / 2;
    const distance = Math.hypot(
      playerCenterX - npcCenterX,
      playerCenterY - npcCenterY
    );

    if (distance > cellSize * interactionDistanceSquares) {
      return { ok: false, message: "Move closer to talk with that NPC." };
    }

    player.stopMovement();

    return {
      ok: true,
      player,
      placement: {
        id: placement.id,
        npcId: placement.npcId,
        name: placement.name,
        interactionDistanceSquares,
        x: placement.x,
        y: placement.y
      }
    };
  }

  private restorePokemonMovePp(
    pokemon: PokemonSummary,
    skillsByName: Map<string, SkillDefinition>
  ) {
    if (!Array.isArray(pokemon.moves) || pokemon.moves.length === 0) {
      return pokemon.movePp ?? {};
    }

    return pokemon.moves.reduce<Record<string, number>>((accumulator, moveName) => {
      const skillDefinition = skillsByName.get(moveName.toLowerCase());
      const currentPp = pokemon.movePp?.[moveName];
      const fallbackPp =
        typeof currentPp === "number" && Number.isFinite(currentPp)
          ? Math.max(0, Math.round(currentPp))
          : 1;

      accumulator[moveName] = Math.max(1, skillDefinition?.powerPoint ?? fallbackPp);
      return accumulator;
    }, {});
  }

  private isPartyFullyHealed(
    party: PokemonSummary[],
    skillsByName: Map<string, SkillDefinition>
  ) {
    return party.every((pokemon) => {
      if (pokemon.hp < pokemon.maxHp) {
        return false;
      }

      return pokemon.moves.every((moveName) => {
        const skillDefinition = skillsByName.get(moveName.toLowerCase());
        const maxPp = Math.max(1, skillDefinition?.powerPoint ?? pokemon.movePp?.[moveName] ?? 1);
        const currentPp =
          typeof pokemon.movePp?.[moveName] === "number" && Number.isFinite(pokemon.movePp[moveName])
            ? Math.max(0, Math.round(pokemon.movePp[moveName]!))
            : maxPp;

        return currentPp >= maxPp;
      });
    });
  }

  private getNpcStoreSellPrice(storeItem: NpcStoreDefinition) {
    const perUnitBuyPrice = Math.floor(storeItem.price / Math.max(1, storeItem.quantity));
    return Math.max(0, Math.floor(perUnitBuyPrice / 2));
  }

  /** Stores refuse to trade move machines (MO/MT), quest items and anything
   * without a catalog price. */
  private isItemSellableToStores(definition: ItemDefinition) {
    if (definition.machineKind !== null) {
      return false;
    }

    if (
      definition.type === "machines" ||
      definition.type === "skill item" ||
      definition.type === "quest item"
    ) {
      return false;
    }

    return definition.price > 0;
  }

  /** Per-unit buyback: half the store's own price when the item is in stock,
   * half the catalog price otherwise. */
  private getStoreUnitBuybackPrice(
    definition: ItemDefinition,
    storeStock: NpcStoreDefinition[]
  ) {
    const storeItem = storeStock.find((candidate) => candidate.itemId === definition.id);

    if (storeItem) {
      return this.getNpcStoreSellPrice(storeItem);
    }

    return Math.max(0, Math.floor(definition.price / 2));
  }

  private switchPokemon(battle: BattleSession, side: BattleSide, pokemonId: string) {
    const targetIndex = side.party.findIndex((pokemon) => pokemon.id === pokemonId);
    if (targetIndex < 0 || targetIndex === side.activeIndex || isFainted(side.party[targetIndex])) {
      return false;
    }

    this.clearBattlerLeaveEffects(battle, side);
    side.activeIndex = targetIndex;
    return true;
  }

  /**
   * Essentials clears a battler's effects when it leaves the field
   * (pbInitEffects): its own volatile state resets, and whatever it was
   * inflicting on the opponent — binding, trapping — ends with it. Runs on
   * switch-out and on faint.
   */
  private clearBattlerLeaveEffects(battle: BattleSession, side: BattleSide) {
    const leaving = getActivePokemon(side);
    if (!leaving) {
      return;
    }

    const opponent = getActivePokemon(this.getOpponentSide(battle, side));
    if (opponent) {
      if (opponent.volatile.binding?.byPokemonId === leaving.id) {
        opponent.volatile.binding = null;
      }
      if (opponent.volatile.trappedByPokemonId === leaving.id) {
        opponent.volatile.trappedByPokemonId = null;
      }
      if (opponent.volatile.attractedToPokemonId === leaving.id) {
        opponent.volatile.attractedToPokemonId = null;
      }
    }

    this.restoreTransform(leaving);
    leaving.volatile = createEmptyVolatile();
  }

  /** Undo a Transform copy when the battler leaves the field (or battle ends). */
  private restoreTransform(pokemon: BattlePokemon) {
    const backup = pokemon.volatile.transformBackup;
    if (!backup) {
      return;
    }
    pokemon.types = backup.types;
    pokemon.stats = backup.stats;
    pokemon.moves = backup.moves;
    pokemon.frontImageSrc = backup.frontImageSrc;
    pokemon.backImageSrc = backup.backImageSrc;
    pokemon.volatile.transformBackup = null;
  }

  /**
   * Pre-move restriction checks mirroring pbCanChooseMove: Disable, Taunt,
   * Torment, Imprison, Heal Block, Gravity, Focus Punch, Last Resort, Belch.
   * Returns the failure message, or null when the move may proceed.
   */
  private checkMoveRestrictions(
    battle: BattleSession,
    side: BattleSide,
    target: BattleSide,
    attacker: BattlePokemon,
    move: BattleMove,
    spec: MoveEffectSpec
  ): string | null {
    const name = getPokemonDisplayName(attacker);

    if (attacker.volatile.disable?.moveId === move.id) {
      return `${name}'s ${move.name} is disabled!`;
    }

    if (attacker.volatile.tauntTurns > 0 && move.damageClass === "status") {
      return `${name} can't use ${move.name} after the taunt!`;
    }

    if (
      attacker.volatile.torment &&
      attacker.volatile.lastMoveId === move.id &&
      attacker.volatile.consecutiveMoveUses > 0
    ) {
      return `${name} can't use the same move twice in a row due to the torment!`;
    }

    const opponent = getActivePokemon(target);
    if (
      opponent &&
      !isFainted(opponent) &&
      opponent.volatile.imprison &&
      opponent.moves.some((known) => known.name === move.name)
    ) {
      return `${name} can't use its sealed ${move.name}!`;
    }

    if (
      attacker.volatile.healBlockTurns > 0 &&
      (spec.healUserFraction > 0 ||
        spec.healUserByWeather ||
        spec.drainFraction > 0 ||
        spec.wishUser ||
        spec.swallow ||
        spec.aquaRing ||
        spec.ingrain ||
        spec.healTargetHalf)
    ) {
      return `${name} can't use ${move.name} because of Heal Block!`;
    }

    if (
      battle.gravityTurns > 0 &&
      (spec.twoTurn?.invulnerable === "sky" || spec.magnetRiseUser || spec.telekinesisTarget)
    ) {
      return `${name} can't use ${move.name} because of gravity!`;
    }

    if (spec.focusPunch && attacker.volatile.damageTakenThisTurn.any > 0) {
      return `${name} lost its focus and couldn't move!`;
    }

    if (
      spec.lastResort &&
      (attacker.moves.length < 2 ||
        attacker.moves.some(
          (known) => known.id !== move.id && !attacker.volatile.usedMoveIds.includes(known.id)
        ))
    ) {
      return `${name} can't use ${move.name} until its other moves have been used!`;
    }

    if (spec.belch && !attacker.ateBerry) {
      return `${name} hasn't eaten a berry, so ${move.name} failed!`;
    }

    // Fake Out: only on the user's first turn after entering the field.
    if (spec.failsIfNotFirstTurn && attacker.volatile.turnsOnField > 1) {
      return `${name} can't use ${move.name} except right after entering battle!`;
    }

    return null;
  }

  /** Resolves the move a call move (Metronome, Mirror Move...) will execute. */
  private resolveCalledMove(
    battle: BattleSession,
    side: BattleSide,
    target: BattleSide,
    attacker: BattlePokemon,
    kind: NonNullable<MoveEffectSpec["callMove"]>
  ): { move: BattleMove; powerMult?: number } | null {
    const buildFromSkill = (skill: SkillDefinition | undefined | null) =>
      skill ? this.buildBattleMove(skill) : null;

    switch (kind) {
      case "metronome": {
        const candidates = [...this.cachedSkillsById.values()].filter((skill) => {
          const calledSpec = parseMoveEffect(resolveFunctionCode(skill.functionCode ?? ""));
          return !calledSpec.callMove && !calledSpec.protectUser && !calledSpec.struggleRecoil;
        });
        if (candidates.length === 0) {
          return null;
        }
        const built = buildFromSkill(chooseRandom(candidates));
        return built ? { move: built } : null;
      }
      case "mirror-move": {
        const opponent = getActivePokemon(target);
        const lastId = opponent?.volatile.lastMoveId ?? null;
        const built = buildFromSkill(lastId ? this.cachedSkillsById.get(lastId) : null);
        return built ? { move: built } : null;
      }
      case "copycat": {
        const last = battle.lastMoveUsed;
        if (!last) {
          return null;
        }
        const skill = this.cachedSkillsById.get(last.skillId);
        const calledSpec = skill ? parseMoveEffect(resolveFunctionCode(skill.functionCode ?? "")) : null;
        if (!skill || calledSpec?.callMove === "copycat") {
          return null;
        }
        const built = buildFromSkill(skill);
        return built ? { move: built } : null;
      }
      case "sleep-talk": {
        const usable = attacker.moves.filter((known) => {
          const knownSpec = parseMoveEffect(resolveFunctionCode(known.functionCode ?? ""));
          return !knownSpec.callMove && !knownSpec.twoTurn && !knownSpec.bide;
        });
        if (usable.length === 0) {
          return null;
        }
        return { move: { ...chooseRandom(usable) } };
      }
      case "assist": {
        const pool = side.party
          .filter((member) => member.id !== attacker.id)
          .flatMap((member) => member.moves)
          .filter((known) => {
            const knownSpec = parseMoveEffect(resolveFunctionCode(known.functionCode ?? ""));
            return !knownSpec.callMove && !knownSpec.protectUser && !knownSpec.teleportUser;
          });
        if (pool.length === 0) {
          return null;
        }
        return { move: { ...chooseRandom(pool) } };
      }
      case "nature-power": {
        // Environment mapping from the battleback, as the original does from
        // the terrain tag; Tri Attack is the default.
        const back = (battle.battleBack ?? "").toLowerCase();
        const internal =
          back.includes("water") || back.includes("sea") || back.includes("underwater")
            ? "SURF"
            : back.includes("cave") || back.includes("rock") || back.includes("mountain")
              ? "ROCKSLIDE"
              : back.includes("sand")
                ? "EARTHQUAKE"
                : back.includes("grass") || back.includes("forest")
                  ? "STUNSPORE"
                  : "TRIATTACK";
        const built = buildFromSkill(
          this.cachedSkillsByEssentialsId.get(internal) ?? this.cachedSkillsByEssentialsId.get("TRIATTACK")
        );
        return built ? { move: built } : null;
      }
      case "me-first": {
        const queued = this.getQueuedMove(target);
        if (!queued || queued.damageClass === "status" || target.hasActedThisTurn) {
          return null;
        }
        return { move: { ...queued }, powerMult: 1.5 };
      }
      default:
        return null;
    }
  }

  /** Type effectiveness with Foresight/Miracle Eye/Gravity/airborne overrides. */
  private getEffectivenessAgainst(battle: BattleSession, moveType: string, defender: BattlePokemon) {
    let effectiveness = this.getEffectiveness(moveType, defender.types);
    const upperType = moveType.trim().toUpperCase();
    const defenderTypes = defender.types.map((type) => type.trim().toUpperCase());

    if (
      effectiveness === 0 &&
      defender.volatile.foresight &&
      (upperType === "NORMAL" || upperType === "FIGHTING") &&
      defenderTypes.includes("GHOST")
    ) {
      effectiveness = 1;
    }

    if (
      effectiveness === 0 &&
      defender.volatile.miracleEye &&
      upperType === "PSYCHIC" &&
      defenderTypes.includes("DARK")
    ) {
      effectiveness = 1;
    }

    if (upperType === "GROUND") {
      if (battle.gravityTurns > 0) {
        if (effectiveness === 0 && defenderTypes.includes("FLYING")) {
          effectiveness = 1;
        }
      } else if (defender.volatile.magnetRiseTurns > 0 || defender.volatile.telekinesisTurns > 0) {
        effectiveness = 0;
      }
    }

    return effectiveness;
  }

  private isGrounded(battle: BattleSession, pokemon: BattlePokemon) {
    if (battle.gravityTurns > 0) {
      return true;
    }
    if (pokemon.volatile.magnetRiseTurns > 0 || pokemon.volatile.telekinesisTurns > 0) {
      return false;
    }
    return !pokemon.types.some((type) => type.trim().toUpperCase() === "FLYING");
  }

  private itemIsBerry(itemId: string | null | undefined, itemName?: string | null) {
    if (!itemId) {
      return false;
    }
    const definition = this.getCachedItemDefinition(itemId, itemName ?? "");
    const name = (itemName ?? definition?.name ?? "").toLowerCase();
    return definition?.category === "berries" || name.includes("baya") || name.includes("berry");
  }

  /** The slot holding a berry (battle-use slot wins), or null. */
  private getBerrySlot(pokemon: BattlePokemon): "bonus" | "battle" | null {
    if (this.itemIsBerry(pokemon.battleItemId, pokemon.battleItemName)) {
      return "battle";
    }
    if (this.itemIsBerry(pokemon.heldItemId, pokemon.heldItemName)) {
      return "bonus";
    }
    return null;
  }

  private pokemonHoldsBerry(pokemon: BattlePokemon) {
    return this.getBerrySlot(pokemon) !== null;
  }

  /** Roar / Whirlwind / Dragon Tail: drag out a random replacement. */
  private async applyForcedSwitch(battle: BattleSession, side: BattleSide, target: BattleSide) {
    const defender = getActivePokemon(target);
    if (battle.kind === "wild" && target.isAi) {
      this.say(battle, `${getPokemonDisplayName(defender)} was blown away!`);
      await this.emitBattleStep(battle);
      await this.finishBattle(battle, "The wild Pokemon was blown away!", null, null);
      return;
    }

    const candidates = target.party.filter(
      (member) => member.id !== defender.id && !isFainted(member)
    );
    if (candidates.length === 0) {
      this.say(battle, "But it failed!");
      return;
    }

    const chosen = chooseRandom(candidates);
    this.switchPokemon(battle, target, chosen.id);
    const sentOut = getActivePokemon(target);
    this.pushEvent(
      battle,
      { kind: "switch", sideId: target.id, pokemon: getPublicPokemon(sentOut) },
      `${getPokemonDisplayName(sentOut)} was dragged out!`
    );
    // A dragged-out replacement loses its queued action.
    if (target.action?.type === "fight") {
      target.action = { type: "pass" };
    }
    this.recordParticipation(battle);
    await this.emitBattleStep(battle);
    await this.applySwitchInEffects(battle, target);
  }

  /** U-turn / Volt Switch / Baton Pass: the user rotates out mid-turn. */
  private async applyUserSwitch(battle: BattleSession, side: BattleSide, batonPass: boolean) {
    const active = getActivePokemon(side);
    const candidates = side.party.filter((member) => member.id !== active.id && !isFainted(member));
    if (candidates.length === 0) {
      if (batonPass) {
        this.say(battle, "But it failed!");
      }
      return;
    }

    const passState = batonPass
      ? {
          stages: { ...active.stages },
          confusionTurns: active.volatile.confusionTurns,
          substituteHp: active.volatile.substituteHp,
          perishCount: active.volatile.perishCount,
          seededBySideId: active.volatile.seededBySideId,
          focusEnergy: active.volatile.focusEnergy,
          aquaRing: active.volatile.aquaRing,
          ingrain: active.volatile.ingrain,
          trappedByPokemonId: active.volatile.trappedByPokemonId,
          embargoTurns: active.volatile.embargoTurns,
          healBlockTurns: active.volatile.healBlockTurns,
          magnetRiseTurns: active.volatile.magnetRiseTurns,
          telekinesisTurns: active.volatile.telekinesisTurns,
          lockOnTurns: active.volatile.lockOnTurns,
          cursed: active.volatile.cursed
        }
      : null;

    this.say(battle, `${getPokemonDisplayName(active)} went back to ${side.trainerName}!`);

    let chosenId = candidates[0].id;
    if (!side.isAi && side.playerId && candidates.length > 1) {
      this.say(battle, `${side.trainerName}, choose your next Pokemon.`);
      const picked = await this.waitForReplacementChoice(battle, side);
      if (battle.status !== "active") {
        return;
      }
      if (picked && candidates.some((member) => member.id === picked)) {
        chosenId = picked;
      }
    }

    this.switchPokemon(battle, side, chosenId);
    const sentOut = getActivePokemon(side);
    if (passState) {
      sentOut.stages = passState.stages;
      sentOut.volatile.confusionTurns = passState.confusionTurns;
      sentOut.volatile.substituteHp = passState.substituteHp;
      sentOut.volatile.perishCount = passState.perishCount;
      sentOut.volatile.seededBySideId = passState.seededBySideId;
      sentOut.volatile.focusEnergy = passState.focusEnergy;
      sentOut.volatile.aquaRing = passState.aquaRing;
      sentOut.volatile.ingrain = passState.ingrain;
      sentOut.volatile.trappedByPokemonId = passState.trappedByPokemonId;
      sentOut.volatile.embargoTurns = passState.embargoTurns;
      sentOut.volatile.healBlockTurns = passState.healBlockTurns;
      sentOut.volatile.magnetRiseTurns = passState.magnetRiseTurns;
      sentOut.volatile.telekinesisTurns = passState.telekinesisTurns;
      sentOut.volatile.lockOnTurns = passState.lockOnTurns;
      sentOut.volatile.cursed = passState.cursed;
    }
    this.pushEvent(
      battle,
      { kind: "switch", sideId: side.id, pokemon: getPublicPokemon(sentOut) },
      `${side.trainerName} sent out ${getPokemonDisplayName(sentOut)}.`
    );
    if (side.action?.type === "fight") {
      side.action = { type: "pass" };
    }
    this.recordParticipation(battle);
    await this.emitBattleStep(battle);
    await this.applySwitchInEffects(battle, side);
  }

  /**
   * Everything that greets a switch-in: Healing Wish/Lunar Dance blessings,
   * then entry hazards (Spikes 1/8-1/6-1/4, Stealth Rock 1/8 x type
   * effectiveness, Toxic Spikes, Sticky Web), exactly as pbOnActiveOne does.
   */
  private async applySwitchInEffects(battle: BattleSession, side: BattleSide) {
    const pokemon = getActivePokemon(side);
    if (!pokemon || isFainted(pokemon)) {
      return;
    }
    const displayName = getPokemonDisplayName(pokemon);
    let pushedAny = false;

    if (side.pendingSwitchHeal) {
      const kind = side.pendingSwitchHeal;
      side.pendingSwitchHeal = null;
      const healed = pokemon.maxHp - pokemon.hp;
      pokemon.hp = pokemon.maxHp;
      pokemon.status = null;
      if (kind === "lunar") {
        pokemon.moves.forEach((known) => {
          known.currentPp = known.maxPp;
        });
      }
      this.pushEvent(
        battle,
        {
          kind: "heal",
          sideId: side.id,
          pokemonId: pokemon.id,
          amount: Math.max(1, healed),
          hpAfter: pokemon.hp,
          maxHp: pokemon.maxHp,
          source: "move"
        },
        `The wish came true for ${displayName}!`
      );
      pushedAny = true;
    }

    const hazards = side.hazards;
    if (hazards) {
      const grounded = this.isGrounded(battle, pokemon);

      if (hazards.spikes > 0 && grounded && !isFainted(pokemon)) {
        const divisor = [8, 6, 4][Math.min(3, hazards.spikes) - 1];
        const damage = Math.max(1, Math.floor(pokemon.maxHp / divisor));
        pokemon.hp = Math.max(0, pokemon.hp - damage);
        this.pushEvent(
          battle,
          {
            kind: "damage",
            sideId: side.id,
            pokemonId: pokemon.id,
            amount: damage,
            hpAfter: pokemon.hp,
            maxHp: pokemon.maxHp,
            effectiveness: 1,
            critical: false,
            source: "status"
          },
          `${displayName} is hurt by the spikes!`
        );
        pushedAny = true;
      }

      if (hazards.stealthRock && !isFainted(pokemon)) {
        const effectiveness = this.getEffectiveness("ROCK", pokemon.types);
        if (effectiveness > 0) {
          const damage = Math.max(1, Math.floor((pokemon.maxHp * effectiveness) / 8));
          pokemon.hp = Math.max(0, pokemon.hp - damage);
          this.pushEvent(
            battle,
            {
              kind: "damage",
              sideId: side.id,
              pokemonId: pokemon.id,
              amount: damage,
              hpAfter: pokemon.hp,
              maxHp: pokemon.maxHp,
              effectiveness: 1,
              critical: false,
              source: "status"
            },
            `Pointed stones dug into ${displayName}!`
          );
          pushedAny = true;
        }
      }

      if (hazards.toxicSpikes > 0 && grounded && !isFainted(pokemon)) {
        const types = pokemon.types.map((type) => type.trim().toUpperCase());
        if (types.includes("POISON")) {
          hazards.toxicSpikes = 0;
          this.say(battle, `The toxic spikes around ${displayName} disappeared!`);
          pushedAny = true;
        } else if (!pokemon.status && !isImmuneToStatus("poison", pokemon.types)) {
          pokemon.status = createStatusState(hazards.toxicSpikes >= 2 ? "toxic" : "poison");
          this.pushEvent(
            battle,
            {
              kind: "status-applied",
              sideId: side.id,
              pokemonId: pokemon.id,
              status: pokemon.status.id
            },
            `${displayName} was poisoned by the toxic spikes!`
          );
          pushedAny = true;
        }
      }

      if (hazards.stickyWeb && grounded && !isFainted(pokemon)) {
        this.say(battle, `${displayName} was caught in a sticky web!`);
        this.applyStatStageChange(battle, side, pokemon, "speed", -1, true);
        pushedAny = true;
      }
    }

    if (pushedAny) {
      await this.emitBattleStep(battle);
    }
  }

  private async executeMoveAction(
    battle: BattleSession,
    side: BattleSide,
    target: BattleSide,
    moveId: string,
    opts: { calledMove?: BattleMove; depth?: number; powerMult?: number } = {}
  ) {
    const depth = opts.depth ?? 0;
    const attacker = getActivePokemon(side);
    const defender = getActivePokemon(target);
    let move = opts.calledMove ?? attacker.moves.find((candidate) => candidate.id === moveId);
    const attackerName = getPokemonDisplayName(attacker);
    const defenderName = getPokemonDisplayName(defender);

    if (!move || (!opts.calledMove && move.currentPp <= 0)) {
      this.say(battle, `${attackerName} had no skill to use.`);
      await this.emitBattleStep(battle);
      return;
    }

    if (depth === 0) {
      // Destiny Bond / Grudge last until the user's next action.
      attacker.volatile.destinyBond = false;
      attacker.volatile.grudge = false;

      if (attacker.volatile.flinched) {
        if (attacker.volatile.rampage) {
          attacker.volatile.rampage = null;
        }
        this.pushEvent(
          battle,
          { kind: "flinch", sideId: side.id, pokemonId: attacker.id },
          `${attackerName} flinched and couldn't move!`
        );
        await this.emitBattleStep(battle);
        return;
      }

      // Hyper Beam family: the turn after a successful hit is spent recharging.
      if (attacker.volatile.recharging) {
        attacker.volatile.recharging = false;
        this.say(battle, `${attackerName} must recharge!`);
        await this.emitBattleStep(battle);
        return;
      }

      // Bide: two storing turns, then the payback replaces the move entirely.
      const bide = attacker.volatile.bide;
      if (bide) {
        bide.turnsLeft -= 1;
        if (bide.turnsLeft > 0) {
          this.say(battle, `${attackerName} is storing energy!`);
          await this.emitBattleStep(battle);
          return;
        }
        attacker.volatile.bide = null;
        this.say(battle, `${attackerName} unleashed its energy!`);
        if (bide.storedDamage <= 0 || isFainted(defender)) {
          this.say(battle, "But it failed!");
        } else {
          this.applyDirectDamage(battle, target, defender, bide.storedDamage * 2, parseMoveEffect(""));
        }
        await this.emitBattleStep(battle);
        return;
      }

      // Encore: the target repeats its encored move no matter what it chose.
      const encore = attacker.volatile.encore;
      if (encore && move.id !== encore.moveId) {
        const encored = attacker.moves.find((candidate) => candidate.id === encore.moveId);
        if (encored && encored.currentPp > 0) {
          move = encored;
        }
      }

      const preSpec = parseMoveEffect(resolveFunctionCode(move.functionCode ?? ""));
      const isAsleep = attacker.status?.id === "sleep";
      const statusCheck = checkStatusBeforeMove(attacker.status, attackerName);
      if (statusCheck.cured && attacker.status) {
        this.pushEvent(
          battle,
          { kind: "status-cured", sideId: side.id, pokemonId: attacker.id, status: attacker.status.id },
          statusCheck.message
        );
        attacker.status = null;
      } else if (statusCheck.message) {
        this.say(battle, statusCheck.message);
      }
      if (!statusCheck.canMove) {
        // Sleep Talk and Snore work while asleep; everything else stays blocked.
        const worksAsleep =
          isAsleep && (preSpec.callMove === "sleep-talk" || preSpec.usableOnlyIfAsleep);
        if (!worksAsleep) {
          await this.emitBattleStep(battle);
          return;
        }
      } else if (preSpec.usableOnlyIfAsleep && !isAsleep) {
        this.say(battle, `${attackerName} used ${move.name}!`);
        this.say(battle, "But it failed!");
        move.currentPp = Math.max(0, move.currentPp - 1);
        await this.emitBattleStep(battle);
        return;
      } else if (preSpec.callMove === "sleep-talk" && !isAsleep) {
        this.say(battle, `${attackerName} used ${move.name}!`);
        this.say(battle, "But it failed!");
        move.currentPp = Math.max(0, move.currentPp - 1);
        await this.emitBattleStep(battle);
        return;
      }

      // Move restrictions: checked before any PP is spent.
      const restriction = this.checkMoveRestrictions(battle, side, target, attacker, move, preSpec);
      if (restriction) {
        this.say(battle, restriction);
        await this.emitBattleStep(battle);
        return;
      }
    }

    if (depth === 0 && attacker.volatile.confusionTurns > 0) {
      attacker.volatile.confusionTurns -= 1;
      if (attacker.volatile.confusionTurns <= 0) {
        this.pushEvent(
          battle,
          { kind: "confusion-end", sideId: side.id, pokemonId: attacker.id },
          `${attackerName} snapped out of its confusion!`
        );
      } else {
        this.say(battle, `${attackerName} is confused!`);
        if (Math.random() < 0.5) {
          const confusionDamage = this.calculateConfusionDamage(attacker);
          attacker.hp = Math.max(0, attacker.hp - confusionDamage);
          this.pushEvent(
            battle,
            {
              kind: "damage",
              sideId: side.id,
              pokemonId: attacker.id,
              amount: confusionDamage,
              hpAfter: attacker.hp,
              maxHp: attacker.maxHp,
              effectiveness: 1,
              critical: false,
              source: "confusion"
            },
            `${attackerName} hurt itself in its confusion!`
          );
          await this.emitBattleStep(battle);
          return;
        }
      }
    }

    // Attract: 50% chance of being immobilized while the beloved is active.
    if (depth === 0 && attacker.volatile.attractedToPokemonId === defender.id && !isFainted(defender)) {
      this.say(battle, `${attackerName} is in love with ${defenderName}!`);
      if (Math.random() < 0.5) {
        this.say(battle, `${attackerName} is immobilized by love!`);
        await this.emitBattleStep(battle);
        return;
      }
    }

    const spec = parseMoveEffect(resolveFunctionCode(move.functionCode ?? ""));

    // Two-turn moves: the charge turn locks the release (see startChoiceTurn);
    // the release turn skips the PP cost (paid when charging). Called moves
    // (Metronome/Mirror Move...) never cost their own PP.
    const isReleaseTurn = attacker.volatile.charging?.moveId === move.id;
    if (isReleaseTurn) {
      attacker.volatile.charging = null;
    } else if (!opts.calledMove) {
      move.currentPp -= 1;
    }

    // Fury Cutter-style ramping: uses of the same move in a row BEFORE this one.
    const consecutiveUses =
      attacker.volatile.lastMoveId === move.id ? attacker.volatile.consecutiveMoveUses : 0;
    attacker.volatile.lastMoveId = move.id;
    attacker.volatile.consecutiveMoveUses = consecutiveUses + 1;

    // Choice items lock the holder into its first move (cleared on switch or
    // when the item leaves).
    if (!opts.calledMove && this.getHeldBonus(attacker, battle)?.choiceLock) {
      attacker.volatile.choiceLockMoveId = move.id;
    }
    if (!attacker.volatile.usedMoveIds.includes(move.id)) {
      attacker.volatile.usedMoveIds.push(move.id);
    }
    battle.lastMoveUsed = { skillId: move.id, skillName: move.name };

    this.pushEvent(
      battle,
      {
        kind: "move-used",
        sideId: side.id,
        pokemonId: attacker.id,
        moveId: move.id,
        moveName: move.name,
        moveType: move.type,
        skillGfxId: move.skillGfxId || null,
        skillGfxName: move.skillGfxName || null,
        animationId: move.animationId || null,
        animationName: move.animationName || null
      },
      `${attackerName} used ${move.name}!`
    );

    // Gravity slams airborne moves out of the air.
    if (battle.gravityTurns > 0 && spec.twoTurn?.invulnerable === "sky") {
      this.say(battle, `${attackerName} can't use ${move.name} because of gravity!`);
      await this.emitBattleStep(battle);
      return;
    }

    // Call moves execute another move in their place.
    if (spec.callMove) {
      const called = this.resolveCalledMove(battle, side, target, attacker, spec.callMove);
      if (!called) {
        this.say(battle, "But it failed!");
        await this.emitBattleStep(battle);
        return;
      }
      await this.emitBattleStep(battle);
      if (depth < 2) {
        await this.executeMoveAction(battle, side, target, called.move.id, {
          calledMove: called.move,
          depth: depth + 1,
          powerMult: called.powerMult
        });
      }
      return;
    }

    if (spec.failsAlways) {
      this.say(battle, "But it failed!");
      await this.emitBattleStep(battle);
      return;
    }

    if (spec.twoTurn && !isReleaseTurn && !(spec.twoTurn.skipChargeInSun && battle.weather?.kind === "sun")) {
      attacker.volatile.charging = { moveId: move.id, invulnerable: spec.twoTurn.invulnerable };
      const chargeText =
        spec.twoTurn.invulnerable === "sky"
          ? `${attackerName} flew up high!`
          : spec.twoTurn.invulnerable === "underground"
            ? `${attackerName} burrowed its way under the ground!`
            : spec.twoTurn.invulnerable === "underwater"
              ? `${attackerName} hid underwater!`
              : `${attackerName} began charging power!`;
      this.say(battle, chargeText);
      await this.emitBattleStep(battle);
      return;
    }

    if (spec.protectUser) {
      attacker.volatile.protected = true;
      this.say(battle, `${attackerName} protected itself!`);
      await this.emitBattleStep(battle);
      return;
    }

    // Powder: a Fire-type move blows up in the user's face instead.
    if (attacker.volatile.powdered && move.type.trim().toUpperCase() === "FIRE") {
      attacker.volatile.powdered = false;
      const blast = Math.max(1, Math.floor(attacker.maxHp / 4));
      attacker.hp = Math.max(0, attacker.hp - blast);
      this.pushEvent(
        battle,
        {
          kind: "damage",
          sideId: side.id,
          pokemonId: attacker.id,
          amount: blast,
          hpAfter: attacker.hp,
          maxHp: attacker.maxHp,
          effectiveness: 1,
          critical: false,
          source: "move"
        },
        `The powder exploded when ${attackerName} used ${move.name}!`
      );
      await this.emitBattleStep(battle);
      return;
    }

    // Dream Eater: only works on a sleeping target.
    if (spec.failsUnlessTargetAsleep && defender.status?.id !== "sleep") {
      this.say(battle, `${defenderName} wasn't affected!`);
      await this.emitBattleStep(battle);
      return;
    }

    // Synchronoise: only hurts targets sharing a type with the user.
    if (
      spec.failsUnlessTargetSharesType &&
      !defender.types.some((theirs) =>
        attacker.types.some((ours) => isSameType(this.typeChart, ours, theirs))
      )
    ) {
      this.say(battle, `${defenderName} wasn't affected!`);
      await this.emitBattleStep(battle);
      return;
    }

    // Spit Up: needs at least one Stockpile charge.
    if (spec.spitUp && attacker.volatile.stockpile <= 0) {
      this.say(battle, "But it failed to spit up a thing!");
      await this.emitBattleStep(battle);
      return;
    }

    // Sucker Punch: fails unless the target is still preparing a damaging move.
    if (spec.failsUnlessTargetPreparingDamagingMove) {
      const targetQueuedMove = this.getQueuedMove(target);
      const targetPreparing =
        target.action?.type === "fight" &&
        targetQueuedMove !== null &&
        targetQueuedMove.damageClass !== "status" &&
        !target.hasActedThisTurn;
      if (!targetPreparing) {
        this.say(battle, "But it failed!");
        await this.emitBattleStep(battle);
        return;
      }
    }

    // Counter / Mirror Coat / Metal Burst: throw back damage taken this turn.
    if (spec.counter) {
      const taken = attacker.volatile.damageTakenThisTurn;
      const base =
        spec.counter === "physical" ? taken.physical : spec.counter === "special" ? taken.special : taken.any;
      if (base <= 0 || isFainted(defender)) {
        this.say(battle, "But it failed!");
        await this.emitBattleStep(battle);
        return;
      }

      const counterDamage =
        spec.counter === "any" ? Math.max(1, Math.floor(base * 1.5)) : base * 2;
      this.applyDirectDamage(battle, target, defender, counterDamage, spec);
      await this.emitBattleStep(battle);
      return;
    }

    const isDamaging = move.damageClass !== "status" && (move.power > 0 || spec.fixedDamage !== null || spec.ohko);
    const affectsTarget =
      isDamaging ||
      spec.statChanges.some((change) => change.target === "target") ||
      (spec.status !== null && spec.status.target === "target") ||
      spec.confuseTarget ||
      spec.resetTargetStats ||
      spec.bindTarget ||
      spec.trapTarget ||
      spec.leechSeedTarget ||
      spec.setTargetTypesToWater ||
      spec.addTypeToTarget !== null ||
      spec.nightmareTarget ||
      spec.disableTarget ||
      spec.encoreTarget ||
      spec.tauntTarget ||
      spec.tormentTarget ||
      spec.healBlockTarget ||
      spec.embargoTarget ||
      spec.spiteTarget ||
      spec.attractTarget ||
      spec.yawnTarget ||
      spec.telekinesisTarget ||
      spec.electrifyTarget ||
      spec.powderTarget ||
      spec.topsyTurvy ||
      spec.psychoShift ||
      spec.removeTargetItem ||
      spec.stealTargetItem ||
      spec.swapItems ||
      spec.forceTargetSwitch;

    if (affectsTarget && defender.volatile.protected) {
      if (spec.feint) {
        defender.volatile.protected = false;
        this.say(battle, `${defenderName} fell for the feint!`);
      } else {
        this.say(battle, `${defenderName} protected itself!`);
        await this.emitBattleStep(battle);
        return;
      }
    }

    // A Substitute blocks status moves aimed at its owner (Roar and PP
    // attacks still get through, as in the original).
    if (
      !isDamaging &&
      affectsTarget &&
      defender.volatile.substituteHp > 0 &&
      !spec.forceTargetSwitch &&
      !spec.spiteTarget
    ) {
      this.say(battle, "But it failed!");
      await this.emitBattleStep(battle);
      return;
    }

    // A semi-invulnerable target (Fly/Dig/Dive) dodges everything except the
    // moves that specifically reach it (Gust/Earthquake/Surf...).
    const defenderInvulnerable = defender.volatile.charging?.invulnerable ?? null;
    if (affectsTarget && defenderInvulnerable && spec.hitsInvulnerable !== defenderInvulnerable) {
      this.say(battle, `${defenderName} avoided the attack!`);
      await this.emitBattleStep(battle);
      return;
    }

    // Lock-On guarantees the next strike; Telekinesis makes the target
    // impossible to miss.
    const cannotMiss =
      spec.alwaysHits || attacker.volatile.lockOnTurns > 0 || defender.volatile.telekinesisTurns > 0;

    if (affectsTarget && !cannotMiss && !this.rollAccuracy(attacker, defender, move, spec)) {
      this.pushEvent(
        battle,
        { kind: "move-missed", sideId: side.id, pokemonId: attacker.id, moveName: move.name },
        `${attackerName}'s attack missed!`
      );
      // A missed rampage (Thrash/Rollout/Uproar) breaks the lock-in.
      attacker.volatile.rampage = null;
      if (spec.crashDamageOnMiss) {
        const crash = Math.max(1, Math.floor(attacker.maxHp / 2));
        attacker.hp = Math.max(0, attacker.hp - crash);
        this.pushEvent(
          battle,
          {
            kind: "damage",
            sideId: side.id,
            pokemonId: attacker.id,
            amount: crash,
            hpAfter: attacker.hp,
            maxHp: attacker.maxHp,
            effectiveness: 1,
            critical: false,
            source: "recoil"
          },
          `${attackerName} kept going and crashed!`
        );
      }
      await this.emitBattleStep(battle);
      return;
    }

    // Weather Ball: type and power follow the weather.
    let effectiveMoveType = move.type;
    let powerOverride: number | null = null;
    if (spec.weatherBall && battle.weather) {
      effectiveMoveType =
        battle.weather.kind === "rain"
          ? "WATER"
          : battle.weather.kind === "sun"
            ? "FIRE"
            : battle.weather.kind === "hail"
              ? "ICE"
              : battle.weather.kind === "sandstorm"
                ? "ROCK"
                : move.type;
      powerOverride = move.power * 2;
    }

    // Hidden Power: type and power come from the user's IVs.
    if (spec.hiddenPower) {
      const hidden = computeHiddenPower(attacker.ivs);
      effectiveMoveType = hidden.type;
      powerOverride = hidden.power;
    }

    // Electrify / Ion Deluge turn the move Electric.
    if (attacker.volatile.electrified) {
      attacker.volatile.electrified = false;
      effectiveMoveType = "ELECTRIC";
      this.say(battle, `${attackerName}'s move became electrified!`);
    } else if (battle.ionDeluge && effectiveMoveType.trim().toUpperCase() === "NORMAL") {
      effectiveMoveType = "ELECTRIC";
    }

    // Natural Gift: fueled by the held berry.
    if (spec.naturalGift) {
      const holdsBerry = this.pokemonHoldsBerry(attacker);
      if (!holdsBerry) {
        this.say(battle, "But it failed!");
        await this.emitBattleStep(battle);
        return;
      }
      powerOverride = 80;
      this.consumeHeldItem(attacker);
    }

    // Present: random power, or it heals the target instead.
    if (spec.present) {
      const roll = Math.random();
      if (roll < 0.2) {
        const healed = Math.max(1, Math.floor(defender.maxHp / 4));
        defender.hp = Math.min(defender.maxHp, defender.hp + healed);
        this.pushEvent(
          battle,
          {
            kind: "heal",
            sideId: target.id,
            pokemonId: defender.id,
            amount: healed,
            hpAfter: defender.hp,
            maxHp: defender.maxHp,
            source: "move"
          },
          `The present restored ${defenderName}'s health!`
        );
        await this.emitBattleStep(battle);
        return;
      }
      powerOverride = roll < 0.6 ? 40 : roll < 0.9 ? 80 : 120;
    }

    // Beat Up: one hit per able party member.
    if (spec.beatUp) {
      const able = side.party.filter((member) => !isFainted(member) && !member.status).length;
      if (able <= 0) {
        this.say(battle, "But it failed!");
        await this.emitBattleStep(battle);
        return;
      }
      spec.multiHit = { min: able, max: able };
      powerOverride = 10;
    }

    // Spit Up: power scales with Stockpile charges (spent afterwards).
    if (spec.spitUp) {
      powerOverride = 100 * attacker.volatile.stockpile;
    }

    // Conditional power formulas (Brine, Gyro Ball, Flail, Magnitude...).
    if (spec.powerModifier) {
      const modified = computeModifiedPower(powerOverride ?? move.power, spec.powerModifier, {
        userHp: attacker.hp,
        userMaxHp: attacker.maxHp,
        targetHp: defender.hp,
        targetMaxHp: defender.maxHp,
        userStatusId: attacker.status?.id ?? null,
        targetStatusId: defender.status?.id ?? null,
        userSpeed: this.getModifiedStat(attacker, "speed"),
        targetSpeed: this.getModifiedStat(defender, "speed"),
        userPositiveStages: countPositiveStages(attacker.stages),
        targetPositiveStages: countPositiveStages(defender.stages),
        userLostHpThisTurn: attacker.volatile.damageTakenThisTurn.any > 0,
        targetLostHpThisTurn: defender.volatile.damageTakenThisTurn.any > 0,
        targetActedThisTurn: Boolean(target.hasActedThisTurn),
        targetInvulnerable: defenderInvulnerable,
        consecutiveUses,
        movePpLeft: move.currentPp,
        userHappiness: attacker.baseHappiness,
        userWeightKg: attacker.weightKg,
        targetWeightKg: defender.weightKg,
        userHasItem: attacker.heldItemId !== null && battle.magicRoomTurns <= 0,
        allyFaintedLastTurn: Boolean(side.allyFaintedLastTurn)
      });
      powerOverride = modified.power;
      if (modified.message) {
        this.say(battle, modified.message);
      }
    }

    // Pursuit interception / Me First run the move at boosted power.
    if (opts.powerMult && opts.powerMult !== 1) {
      powerOverride = Math.floor((powerOverride ?? move.power) * opts.powerMult);
    }

    let totalDamage = 0;
    let hitSubstitute = false;
    if (isDamaging) {
      const effectiveness = spec.struggleRecoil
        ? 1
        : this.getEffectivenessAgainst(battle, effectiveMoveType, defender);
      if (effectiveness === 0) {
        this.say(battle, `It doesn't affect ${defenderName}...`);
        await this.emitBattleStep(battle);
        return;
      }

      const result = this.applyDamagePhase(
        battle,
        side,
        target,
        attacker,
        defender,
        move,
        spec,
        effectiveness,
        effectiveMoveType,
        powerOverride
      );
      totalDamage = result.totalDamage;
      hitSubstitute = result.hitSubstitute;

      if (result.hits > 1) {
        this.say(battle, `Hit ${result.hits} time(s)!`);
      }
      if (result.anyCritical) {
        this.say(battle, "A critical hit!");
      }
      if (effectiveness > 1) {
        this.say(battle, "It's super effective!");
      } else if (effectiveness < 1) {
        this.say(battle, "It's not very effective...");
      }

      if (
        spec.drainFraction > 0 &&
        totalDamage > 0 &&
        attacker.hp > 0 &&
        attacker.hp < attacker.maxHp &&
        attacker.volatile.healBlockTurns <= 0
      ) {
        const healed = Math.max(1, Math.floor(totalDamage * spec.drainFraction));
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + healed);
        this.pushEvent(
          battle,
          {
            kind: "heal",
            sideId: side.id,
            pokemonId: attacker.id,
            amount: healed,
            hpAfter: attacker.hp,
            maxHp: attacker.maxHp,
            source: "move"
          },
          `${defenderName} had its energy drained!`
        );
      }

      if (spec.recoilFraction > 0 && totalDamage > 0) {
        const recoil = Math.max(1, Math.floor(totalDamage * spec.recoilFraction));
        attacker.hp = Math.max(0, attacker.hp - recoil);
        this.pushEvent(
          battle,
          {
            kind: "damage",
            sideId: side.id,
            pokemonId: attacker.id,
            amount: recoil,
            hpAfter: attacker.hp,
            maxHp: attacker.maxHp,
            effectiveness: 1,
            critical: false,
            source: "recoil"
          },
          `${attackerName} was damaged by the recoil!`
        );
      }

      // Equip items on the attacker that ride on a landed damaging move:
      // King's Rock may flinch the target, Life Orb bites its holder.
      const attackerHitBonus = totalDamage > 0 ? this.getHeldBonus(attacker, battle) : null;
      if (attackerHitBonus) {
        if (
          attackerHitBonus.flinchChance &&
          !spec.flinchTarget &&
          !hitSubstitute &&
          !isFainted(defender) &&
          Math.random() < attackerHitBonus.flinchChance
        ) {
          defender.volatile.flinched = true;
        }

        if (attackerHitBonus.selfDamageFraction && attacker.hp > 0) {
          const selfDamage = Math.max(1, Math.floor(attacker.maxHp * attackerHitBonus.selfDamageFraction));
          attacker.hp = Math.max(0, attacker.hp - selfDamage);
          this.pushEvent(
            battle,
            {
              kind: "damage",
              sideId: side.id,
              pokemonId: attacker.id,
              amount: selfDamage,
              hpAfter: attacker.hp,
              maxHp: attacker.maxHp,
              effectiveness: 1,
              critical: false,
              source: "recoil"
            },
            `${attackerName} lost some of its HP to its ${attacker.heldItemName ?? "held item"}!`
          );
        }

        // Shell Bell: sip back a fraction of the damage dealt.
        if (
          attackerHitBonus.healDealtFraction &&
          attacker.hp > 0 &&
          attacker.hp < attacker.maxHp
        ) {
          const healed = Math.max(1, Math.floor(totalDamage * attackerHitBonus.healDealtFraction));
          attacker.hp = Math.min(attacker.maxHp, attacker.hp + healed);
          this.pushEvent(
            battle,
            {
              kind: "heal",
              sideId: side.id,
              pokemonId: attacker.id,
              amount: healed,
              hpAfter: attacker.hp,
              maxHp: attacker.maxHp,
              source: "held-item"
            },
            `${attackerName} restored a little HP using its ${attacker.heldItemName ?? "held item"}!`
          );
        }
      }

      // Smelling Salts / Wake-Up Slap: the doubled hit cures the condition.
      if (totalDamage > 0 && !isFainted(defender) && defender.status) {
        if (
          (spec.powerModifier === "double-if-target-paralyzed-cure" && defender.status.id === "paralysis") ||
          (spec.powerModifier === "double-if-target-asleep-cure" && defender.status.id === "sleep")
        ) {
          this.pushEvent(
            battle,
            { kind: "status-cured", sideId: target.id, pokemonId: defender.id, status: defender.status.id },
            `${defenderName} was cured of its ${STATUS_DISPLAY_NAMES[defender.status.id]} condition!`
          );
          defender.status = null;
        }
      }

      // Struggle: recoil is a quarter of the user's own max HP.
      if (spec.struggleRecoil && totalDamage > 0) {
        const recoil = Math.max(1, Math.floor(attacker.maxHp / 4));
        attacker.hp = Math.max(0, attacker.hp - recoil);
        this.pushEvent(
          battle,
          {
            kind: "damage",
            sideId: side.id,
            pokemonId: attacker.id,
            amount: recoil,
            hpAfter: attacker.hp,
            maxHp: attacker.maxHp,
            effectiveness: 1,
            critical: false,
            source: "recoil"
          },
          `${attackerName} was damaged by the recoil!`
        );
      }

      // Shadow End: user loses half its current HP after a successful hit.
      if (spec.halveUserCurrentHpAfter && totalDamage > 0 && !isFainted(attacker)) {
        const cost = Math.max(1, Math.round(attacker.hp / 2));
        attacker.hp = Math.max(0, attacker.hp - cost);
        this.pushEvent(
          battle,
          {
            kind: "damage",
            sideId: side.id,
            pokemonId: attacker.id,
            amount: cost,
            hpAfter: attacker.hp,
            maxHp: attacker.maxHp,
            effectiveness: 1,
            critical: false,
            source: "recoil"
          },
          `${attackerName} was hurt by the recoil!`
        );
      }

      // Hyper Beam family recharge after a successful hit.
      if (spec.rechargeNextTurn && totalDamage > 0) {
        attacker.volatile.recharging = true;
      }

      // Spit Up spends every Stockpile charge.
      if (spec.spitUp && totalDamage > 0) {
        attacker.volatile.stockpile = 0;
        this.say(battle, `${attackerName}'s stockpiled effect wore off!`);
      }

      // Destiny Bond / Grudge trigger when the direct hit KOs their user.
      if (totalDamage > 0 && isFainted(defender)) {
        if (defender.volatile.destinyBond && !isFainted(attacker)) {
          attacker.hp = 0;
          this.pushEvent(
            battle,
            {
              kind: "damage",
              sideId: side.id,
              pokemonId: attacker.id,
              amount: attacker.maxHp,
              hpAfter: 0,
              maxHp: attacker.maxHp,
              effectiveness: 1,
              critical: false,
              source: "move"
            },
            `${defenderName} took its attacker down with it!`
          );
        } else if (defender.volatile.grudge) {
          move.currentPp = 0;
          this.say(battle, `${attackerName}'s ${move.name} lost all its PP due to the grudge!`);
        }
      }

      // Rampages (Thrash/Rollout/Uproar) lock the user in for a few turns.
      if (spec.rampage && totalDamage > 0 && !isFainted(attacker)) {
        const rampage = attacker.volatile.rampage;
        if (!rampage) {
          const turns =
            spec.rampage === "thrash"
              ? 1 + Math.floor(Math.random() * 2)
              : spec.rampage === "rollout"
                ? 4
                : 2;
          attacker.volatile.rampage = { moveId: move.id, turnsLeft: turns, kind: spec.rampage };
        } else {
          rampage.turnsLeft -= 1;
          if (rampage.turnsLeft <= 0) {
            attacker.volatile.rampage = null;
            if (spec.rampage === "thrash" && attacker.volatile.confusionTurns <= 0) {
              attacker.volatile.confusionTurns = 2 + Math.floor(Math.random() * 4);
              this.pushEvent(
                battle,
                { kind: "confusion-start", sideId: side.id, pokemonId: attacker.id },
                `${attackerName} became confused due to fatigue!`
              );
            }
          }
        }
      }
    }

    // Shadow Half: every battler loses half of its current HP.
    if (spec.halveAllBattlersHp) {
      for (const anySide of battle.sides) {
        const battler = getActivePokemon(anySide);
        if (!battler || isFainted(battler)) {
          continue;
        }
        const loss = Math.floor(battler.hp / 2);
        if (loss <= 0) {
          continue;
        }
        battler.hp -= loss;
        this.pushEvent(
          battle,
          {
            kind: "damage",
            sideId: anySide.id,
            pokemonId: battler.id,
            amount: loss,
            hpAfter: battler.hp,
            maxHp: battler.maxHp,
            effectiveness: 1,
            critical: false,
            source: "move"
          },
          `${getPokemonDisplayName(battler)}'s HP was halved!`
        );
      }
      attacker.volatile.recharging = spec.rechargeNextTurn;
    }

    // Explosion / Self-Destruct / Final Gambit.
    if (spec.userFaints && !isFainted(attacker)) {
      attacker.hp = 0;
      this.pushEvent(
        battle,
        {
          kind: "damage",
          sideId: side.id,
          pokemonId: attacker.id,
          amount: attacker.maxHp,
          hpAfter: 0,
          maxHp: attacker.maxHp,
          effectiveness: 1,
          critical: false,
          source: "move"
        },
        `${attackerName} fainted from its own attack!`
      );
    }

    const isPureStatusMove = !isDamaging;
    const secondaryChance = isPureStatusMove ? 100 : move.effectChance > 0 ? move.effectChance : 100;
    const applySecondary =
      (isPureStatusMove || totalDamage > 0) && Math.random() * 100 < secondaryChance;

    if (applySecondary) {
      this.applyMoveEffects(battle, side, target, attacker, defender, move, spec, isPureStatusMove, hitSubstitute);
    }

    // Healing Wish / Lunar Dance: the user faints; its replacement is blessed.
    if ((spec.healingWish || spec.lunarDance) && !isFainted(attacker)) {
      if (side.party.filter((member) => !isFainted(member)).length <= 1) {
        this.say(battle, "But it failed!");
      } else {
        attacker.hp = 0;
        side.pendingSwitchHeal = spec.lunarDance ? "lunar" : "heal";
        this.pushEvent(
          battle,
          {
            kind: "damage",
            sideId: side.id,
            pokemonId: attacker.id,
            amount: attacker.maxHp,
            hpAfter: 0,
            maxHp: attacker.maxHp,
            effectiveness: 1,
            critical: false,
            source: "move"
          },
          `${attackerName} made a wish for its team!`
        );
      }
    }

    // Roar / Whirlwind / Dragon Tail: drag the target's replacement out.
    if (spec.forceTargetSwitch && (isPureStatusMove || totalDamage > 0) && !isFainted(defender)) {
      await this.applyForcedSwitch(battle, side, target);
    }

    // U-turn / Volt Switch / Baton Pass: the user rotates out.
    if (
      ((spec.switchOutUser && totalDamage > 0) || (spec.batonPass && isPureStatusMove)) &&
      !isFainted(attacker) &&
      battle.status === "active"
    ) {
      await this.applyUserSwitch(battle, side, spec.batonPass);
    }

    // Teleport: escapes wild battles.
    if (spec.teleportUser) {
      if (battle.kind === "wild") {
        this.say(battle, `${attackerName} fled from battle using Teleport!`);
        await this.emitBattleStep(battle);
        await this.finishBattle(battle, "Escaped using Teleport.", null, null);
        return;
      }
      this.say(battle, "But it failed!");
    }

    if (isPureStatusMove && !spec.recognized) {
      this.say(battle, "But nothing happened...");
    }

    await this.emitBattleStep(battle);
  }

  private applyDamagePhase(
    battle: BattleSession,
    side: BattleSide,
    target: BattleSide,
    attacker: BattlePokemon,
    defender: BattlePokemon,
    move: BattleMove,
    spec: MoveEffectSpec,
    effectiveness: number,
    effectiveMoveType?: string,
    powerOverride?: number | null
  ) {
    let hits = 1;
    if (spec.multiHit) {
      hits = rollMultiHitCount(spec.multiHit);
    }

    let totalDamage = 0;
    let landedHits = 0;
    let anyCritical = false;
    let hitSubstitute = false;

    for (let hit = 0; hit < hits && !isFainted(defender) && !isFainted(attacker); hit += 1) {
      let damage = 0;
      let critical = false;

      if (spec.ohko) {
        if (attacker.level < defender.level) {
          this.say(battle, `It failed to affect ${getPokemonDisplayName(defender)}!`);
          break;
        }
        damage = defender.hp;
      } else if (spec.fixedDamage) {
        if (spec.fixedDamage.kind === "endeavor") {
          if (defender.hp <= attacker.hp) {
            this.say(battle, "But it failed!");
            break;
          }
          damage = defender.hp - attacker.hp;
        } else {
          damage =
            spec.fixedDamage.kind === "amount"
              ? spec.fixedDamage.amount
              : spec.fixedDamage.kind === "user-level"
                ? attacker.level
                : spec.fixedDamage.kind === "user-hp"
                  ? Math.max(1, attacker.hp)
                  : spec.fixedDamage.kind === "psywave"
                    ? Math.max(1, Math.floor(attacker.level * (0.5 + Math.random())))
                    : Math.max(1, Math.floor(defender.hp / 2));
        }
      } else {
        critical = this.rollCritical(move, spec, attacker, target);
        // Triple Kick ramps: hit 1 = x1, hit 2 = x2, hit 3 = x3.
        const hitPower = (powerOverride ?? move.power) * (spec.multiHitPowersUp ? hit + 1 : 1);
        damage = this.calculateDamage(
          battle,
          attacker,
          defender,
          target,
          move,
          spec,
          effectiveness,
          critical,
          effectiveMoveType ?? move.type,
          hitPower
        );
      }

      damage = Math.max(1, Math.floor(damage));

      // A Substitute soaks the hit in place of its owner.
      if (defender.volatile.substituteHp > 0) {
        hitSubstitute = true;
        const soaked = Math.min(defender.volatile.substituteHp, damage);
        defender.volatile.substituteHp -= soaked;
        totalDamage += soaked;
        landedHits += 1;
        anyCritical = anyCritical || critical;
        if (defender.volatile.substituteHp <= 0) {
          this.say(battle, `${getPokemonDisplayName(defender)}'s substitute faded!`);
          break;
        }
        this.say(battle, `The substitute took the hit for ${getPokemonDisplayName(defender)}!`);
        continue;
      }

      // False Swipe never KOs; Endure keeps the battler at 1 HP; a held
      // Focus Band sometimes does the same; a Focus Sash always does (once)
      // when the hit would KO from full HP.
      let enduredHit = false;
      let focusBandSave = false;
      let focusSashSave: string | null = null;
      if (damage >= defender.hp) {
        if (spec.neverFaintTarget) {
          damage = Math.max(0, defender.hp - 1);
        } else if (defender.volatile.endure) {
          damage = Math.max(0, defender.hp - 1);
          enduredHit = true;
        } else {
          const focusBandChance = this.getHeldBonus(defender, battle)?.focusBandChance ?? 0;
          if (defender.hp > 1 && focusBandChance > 0 && Math.random() < focusBandChance) {
            damage = Math.max(0, defender.hp - 1);
            focusBandSave = true;
          } else {
            const lethalSave = this.getLethalSaveItem(battle, defender);
            if (
              lethalSave &&
              defender.hp > 1 &&
              (!lethalSave.effect.requiresFullHp || defender.hp === defender.maxHp)
            ) {
              damage = Math.max(0, defender.hp - 1);
              focusSashSave = lethalSave.definition.name;
            }
          }
        }
      }

      defender.hp = Math.max(0, defender.hp - damage);
      totalDamage += damage;
      landedHits += 1;
      anyCritical = anyCritical || critical;

      const taken = defender.volatile.damageTakenThisTurn;
      taken.any += damage;
      if (move.damageClass === "physical") {
        taken.physical += damage;
      } else if (move.damageClass === "special") {
        taken.special += damage;
      }

      // Bide keeps a tally of everything its user suffers.
      if (defender.volatile.bide) {
        defender.volatile.bide.storedDamage += damage;
      }

      this.pushEvent(
        battle,
        {
          kind: "damage",
          sideId: target.id,
          pokemonId: defender.id,
          amount: damage,
          hpAfter: defender.hp,
          maxHp: defender.maxHp,
          effectiveness,
          critical,
          source: "move"
        },
        `${getPokemonDisplayName(defender)} took ${damage} damage.`
      );

      if (enduredHit) {
        this.say(battle, `${getPokemonDisplayName(defender)} endured the hit!`);
      }
      if (focusBandSave) {
        this.say(
          battle,
          `${getPokemonDisplayName(defender)} hung on using its ${defender.heldItemName ?? "Focus Band"}!`
        );
      }
      if (focusSashSave) {
        this.say(battle, `${getPokemonDisplayName(defender)} hung on using its ${focusSashSave}!`);
        this.consumeHeldItem(defender, "battle");
      }
    }

    return { totalDamage, hits: landedHits, anyCritical, hitSubstitute };
  }

  /** Applies flat damage (Counter family) with the endure/never-faint clamps. */
  private applyDirectDamage(
    battle: BattleSession,
    targetSide: BattleSide,
    defender: BattlePokemon,
    amount: number,
    spec: MoveEffectSpec
  ) {
    let damage = Math.max(1, Math.floor(amount));

    // A Substitute soaks flat damage too (Counter, Fling, Bide).
    if (defender.volatile.substituteHp > 0) {
      const soaked = Math.min(defender.volatile.substituteHp, damage);
      defender.volatile.substituteHp -= soaked;
      if (defender.volatile.substituteHp <= 0) {
        this.say(battle, `${getPokemonDisplayName(defender)}'s substitute faded!`);
      } else {
        this.say(battle, `The substitute took the hit for ${getPokemonDisplayName(defender)}!`);
      }
      return;
    }

    let enduredHit = false;
    if (damage >= defender.hp && (spec.neverFaintTarget || defender.volatile.endure)) {
      damage = Math.max(0, defender.hp - 1);
      enduredHit = defender.volatile.endure && !spec.neverFaintTarget;
    } else if (damage >= defender.hp && defender.hp > 1) {
      // A held Focus Band (chance) or Focus Sash (from full HP, consumed)
      // can save the target from flat damage too.
      const focusBandChance = this.getHeldBonus(defender, battle)?.focusBandChance ?? 0;
      if (focusBandChance > 0 && Math.random() < focusBandChance) {
        damage = Math.max(0, defender.hp - 1);
        this.say(
          battle,
          `${getPokemonDisplayName(defender)} hung on using its ${defender.heldItemName ?? "Focus Band"}!`
        );
      } else {
        const lethalSave = this.getLethalSaveItem(battle, defender);
        if (lethalSave && (!lethalSave.effect.requiresFullHp || defender.hp === defender.maxHp)) {
          damage = Math.max(0, defender.hp - 1);
          this.say(
            battle,
            `${getPokemonDisplayName(defender)} hung on using its ${lethalSave.definition.name}!`
          );
          this.consumeHeldItem(defender, "battle");
        }
      }
    }

    defender.hp = Math.max(0, defender.hp - damage);
    defender.volatile.damageTakenThisTurn.any += damage;
    if (defender.volatile.bide) {
      defender.volatile.bide.storedDamage += damage;
    }

    this.pushEvent(
      battle,
      {
        kind: "damage",
        sideId: targetSide.id,
        pokemonId: defender.id,
        amount: damage,
        hpAfter: defender.hp,
        maxHp: defender.maxHp,
        effectiveness: 1,
        critical: false,
        source: "move"
      },
      `${getPokemonDisplayName(defender)} took ${damage} damage.`
    );

    if (enduredHit) {
      this.say(battle, `${getPokemonDisplayName(defender)} endured the hit!`);
    }
  }

  private applyMoveEffects(
    battle: BattleSession,
    side: BattleSide,
    target: BattleSide,
    attacker: BattlePokemon,
    defender: BattlePokemon,
    move: BattleMove,
    spec: MoveEffectSpec,
    isPureStatusMove: boolean,
    hitSubstitute = false
  ) {
    const viaSecondary = !isPureStatusMove;
    // A substitute soaks the hit AND the rider effects aimed at its owner.
    const canAffectTarget = !hitSubstitute;

    spec.statChanges.forEach((change) => {
      const receiverSide = change.target === "user" ? side : target;
      const receiver = change.target === "user" ? attacker : defender;
      if (change.target === "target" && !canAffectTarget) {
        return;
      }
      if (!isFainted(receiver) || change.target === "user") {
        this.applyStatStageChange(
          battle,
          receiverSide,
          receiver,
          change.stat,
          change.delta,
          viaSecondary,
          change.target === "user"
        );
      }
    });

    if (spec.healUserFraction > 0) {
      const healed = Math.max(1, Math.floor(attacker.maxHp * spec.healUserFraction));
      const beforeHp = attacker.hp;
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + healed);
      if (attacker.hp > beforeHp) {
        this.pushEvent(
          battle,
          {
            kind: "heal",
            sideId: side.id,
            pokemonId: attacker.id,
            amount: attacker.hp - beforeHp,
            hpAfter: attacker.hp,
            maxHp: attacker.maxHp,
            source: "move"
          },
          `${getPokemonDisplayName(attacker)} regained health!`
        );
      } else if (isPureStatusMove) {
        this.say(battle, `${getPokemonDisplayName(attacker)}'s HP is already full!`);
      }

      if (spec.sleepUserAfterFullHeal && attacker.hp > beforeHp) {
        attacker.status = { id: "sleep", counter: 2 };
        this.pushEvent(
          battle,
          { kind: "status-applied", sideId: side.id, pokemonId: attacker.id, status: "sleep" },
          `${getPokemonDisplayName(attacker)} slept and became healthy!`
        );
      }
    }

    if (spec.status && !spec.sleepUserAfterFullHeal) {
      const receiverSide = spec.status.target === "user" ? side : target;
      const receiver = spec.status.target === "user" ? attacker : defender;
      const statusId = spec.status.random
        ? spec.status.random[Math.floor(Math.random() * spec.status.random.length)]
        : spec.status.id;
      if (!isFainted(receiver) && (spec.status.target === "user" || canAffectTarget)) {
        this.applyStatusCondition(
          battle,
          receiverSide,
          receiver,
          statusId,
          viaSecondary,
          spec.status.target === "user"
        );
      }
    }

    if (spec.confuseTarget && !isFainted(defender) && canAffectTarget) {
      if (defender.volatile.confusionTurns > 0) {
        if (!viaSecondary) {
          this.say(battle, `${getPokemonDisplayName(defender)} is already confused!`);
        }
      } else {
        defender.volatile.confusionTurns = 2 + Math.floor(Math.random() * 4);
        this.pushEvent(
          battle,
          { kind: "confusion-start", sideId: target.id, pokemonId: defender.id },
          `${getPokemonDisplayName(defender)} became confused!`
        );
      }
    }

    if (spec.flinchTarget && !isFainted(defender) && canAffectTarget) {
      defender.volatile.flinched = true;
    }

    if (spec.resetTargetStats) {
      defender.stages = createEmptyStages();
      this.say(battle, `${getPokemonDisplayName(defender)}'s stat changes were removed!`);
    }

    if (spec.resetAllStats) {
      attacker.stages = createEmptyStages();
      defender.stages = createEmptyStages();
      this.say(battle, "All stat changes were eliminated!");
    }

    const attackerName = getPokemonDisplayName(attacker);
    const defenderName = getPokemonDisplayName(defender);

    // Bind / Wrap / Fire Spin: 4-5 end-of-turn chip ticks, blocks escape.
    // Original sets MultiTurn = 5+rand(2); the tick before reaching 0 is the
    // "freed" turn, so the target takes 4-5 damage ticks.
    if (spec.bindTarget && !isFainted(defender) && canAffectTarget && !defender.volatile.binding) {
      defender.volatile.binding = {
        turnsLeft: 5 + Math.floor(Math.random() * 2),
        moveName: move.name,
        byPokemonId: attacker.id
      };
      this.say(battle, `${defenderName} was trapped by ${move.name}!`);
    }

    if (spec.trapTarget && !isFainted(defender) && canAffectTarget) {
      if (defender.volatile.trappedByPokemonId) {
        if (!viaSecondary) {
          this.say(battle, "But it failed!");
        }
      } else {
        defender.volatile.trappedByPokemonId = attacker.id;
        this.say(battle, `${defenderName} can no longer escape!`);
      }
    }

    if (spec.leechSeedTarget && !isFainted(defender) && canAffectTarget) {
      const defenderTypes = defender.types.map((type) => type.trim().toUpperCase());
      if (defenderTypes.includes("GRASS")) {
        this.say(battle, `It doesn't affect ${defenderName}...`);
      } else if (defender.volatile.seededBySideId) {
        this.say(battle, `${defenderName} is already seeded!`);
      } else {
        defender.volatile.seededBySideId = side.id;
        this.say(battle, `${defenderName} was seeded!`);
      }
    }

    // Reflect Type (Clonatipo): the user copies the target's types.
    if (spec.copyTargetTypes) {
      const sameTypes =
        attacker.types.length === defender.types.length &&
        attacker.types.every((type) =>
          defender.types.some((other) => isSameType(this.typeChart, type, other))
        );
      if (sameTypes) {
        this.say(battle, "But it failed!");
      } else {
        attacker.types = [...defender.types];
        this.say(battle, `${attackerName} became the same type as ${defenderName}!`);
      }
    }

    // Conversion: the user takes the type of one of its own moves.
    if (spec.userTypesToMoveType) {
      const candidates = attacker.moves
        .map((known) => known.type)
        .filter((type) => type && !attacker.types.some((own) => isSameType(this.typeChart, own, type)));
      if (candidates.length === 0) {
        this.say(battle, "But it failed!");
      } else {
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        attacker.types = [chosen];
        this.say(battle, `${attackerName} transformed into the ${chosen} type!`);
      }
    }

    if (spec.setTargetTypesToWater && !isFainted(defender) && canAffectTarget) {
      defender.types = ["WATER"];
      this.say(battle, `${defenderName} became the WATER type!`);
    }

    if (spec.addTypeToTarget && !isFainted(defender) && canAffectTarget) {
      const already = defender.types.some((type) => isSameType(this.typeChart, type, spec.addTypeToTarget!));
      if (already) {
        this.say(battle, "But it failed!");
      } else {
        defender.types = [...defender.types, spec.addTypeToTarget];
        this.say(battle, `${spec.addTypeToTarget} type was added to ${defenderName}!`);
      }
    }

    if (spec.aquaRing) {
      if (attacker.volatile.aquaRing) {
        this.say(battle, "But it failed!");
      } else {
        attacker.volatile.aquaRing = true;
        this.say(battle, `${attackerName} surrounded itself with a veil of water!`);
      }
    }

    if (spec.ingrain) {
      if (attacker.volatile.ingrain) {
        this.say(battle, "But it failed!");
      } else {
        attacker.volatile.ingrain = true;
        this.say(battle, `${attackerName} planted its roots!`);
      }
    }

    if (spec.nightmareTarget && !isFainted(defender) && canAffectTarget) {
      if (defender.status?.id === "sleep" && !defender.volatile.nightmare) {
        defender.volatile.nightmare = true;
        this.say(battle, `${defenderName} began having a nightmare!`);
      } else if (isPureStatusMove) {
        this.say(battle, "But it failed!");
      }
    }

    if (spec.startWeather) {
      if (battle.weather?.kind === spec.startWeather) {
        this.say(battle, "But it failed!");
      } else {
        battle.weather = { kind: spec.startWeather, turns: 5 };
        const weatherText: Record<NonNullable<BattleSession["weather"]>["kind"], string> = {
          sun: "The sunlight turned harsh!",
          rain: "It started to rain!",
          sandstorm: "A sandstorm kicked up!",
          hail: "It started to hail!",
          shadowsky: "A shadow sky descended!"
        };
        this.say(battle, weatherText[spec.startWeather]);
      }
    }

    if (spec.healUserByWeather) {
      const fraction =
        battle.weather?.kind === "sun" ? 2 / 3 : battle.weather ? 0.25 : 0.5;
      if (attacker.hp >= attacker.maxHp) {
        this.say(battle, `${attackerName}'s HP is already full!`);
      } else {
        const healed = Math.max(1, Math.floor(attacker.maxHp * fraction));
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + healed);
        this.pushEvent(
          battle,
          {
            kind: "heal",
            sideId: side.id,
            pokemonId: attacker.id,
            amount: healed,
            hpAfter: attacker.hp,
            maxHp: attacker.maxHp,
            source: "move"
          },
          `${attackerName} regained health!`
        );
      }
    }

    if (spec.startScreen) {
      const screens = (side.screens ??= { reflect: 0, lightScreen: 0 });
      const key = spec.startScreen === "reflect" ? "reflect" : "lightScreen";
      if (screens[key] > 0) {
        this.say(battle, "But it failed!");
      } else {
        screens[key] = 5;
        this.say(
          battle,
          spec.startScreen === "reflect"
            ? `Reflect raised ${side.trainerName}'s side's physical defense!`
            : `Light Screen raised ${side.trainerName}'s side's special defense!`
        );
      }
    }

    if (spec.removeTargetScreens) {
      const screens = target.screens;
      if (screens && (screens.reflect > 0 || screens.lightScreen > 0)) {
        screens.reflect = 0;
        screens.lightScreen = 0;
        this.say(battle, "The wall shattered!");
      }
    }

    if (spec.removeAllScreens) {
      let shattered = false;
      for (const anySide of battle.sides) {
        if (anySide.screens && (anySide.screens.reflect > 0 || anySide.screens.lightScreen > 0)) {
          anySide.screens.reflect = 0;
          anySide.screens.lightScreen = 0;
          shattered = true;
        }
      }
      this.say(battle, shattered ? "Every wall shattered!" : "But it failed!");
    }

    if (spec.bellyDrum) {
      const cost = Math.floor(attacker.maxHp / 2);
      if (attacker.hp <= cost || attacker.stages.attack >= 6) {
        this.say(battle, "But it failed!");
      } else {
        attacker.hp -= cost;
        attacker.stages.attack = 6;
        this.pushEvent(
          battle,
          {
            kind: "damage",
            sideId: side.id,
            pokemonId: attacker.id,
            amount: cost,
            hpAfter: attacker.hp,
            maxHp: attacker.maxHp,
            effectiveness: 1,
            critical: false,
            source: "move"
          },
          `${attackerName} cut its own HP and maximized its Attack!`
        );
      }
    }

    if (spec.focusEnergy) {
      if (attacker.volatile.focusEnergy) {
        this.say(battle, "But it failed!");
      } else {
        attacker.volatile.focusEnergy = true;
        this.say(battle, `${attackerName} is getting pumped!`);
      }
    }

    if (spec.endureUser) {
      attacker.volatile.endure = true;
      this.say(battle, `${attackerName} braced itself!`);
    }

    if (spec.doesNothing) {
      this.say(battle, "But nothing happened!");
    }

    if (spec.painSplit && !isFainted(defender)) {
      const average = Math.max(1, Math.floor((attacker.hp + defender.hp) / 2));
      for (const [battlerSide, battler] of [
        [side, attacker],
        [target, defender]
      ] as Array<[BattleSide, BattlePokemon]>) {
        const before = battler.hp;
        battler.hp = Math.min(battler.maxHp, average);
        if (battler.hp === before) {
          continue;
        }
        const eventBase = {
          sideId: battlerSide.id,
          pokemonId: battler.id,
          amount: Math.abs(battler.hp - before),
          hpAfter: battler.hp,
          maxHp: battler.maxHp
        };
        if (battler.hp > before) {
          this.pushEvent(battle, { kind: "heal", ...eventBase, source: "move" }, null);
        } else {
          this.pushEvent(
            battle,
            { kind: "damage", ...eventBase, effectiveness: 1, critical: false, source: "move" },
            null
          );
        }
      }
      this.say(battle, "The battlers shared their pain!");
    }

    // ------------------------------------------------------------------
    // Restrictions & harassment
    // ------------------------------------------------------------------
    if (spec.disableTarget && !isFainted(defender) && canAffectTarget) {
      const lastId = defender.volatile.lastMoveId;
      const lastMove = lastId ? defender.moves.find((known) => known.id === lastId) : null;
      if (!lastMove || defender.volatile.disable) {
        this.say(battle, "But it failed!");
      } else {
        defender.volatile.disable = { moveId: lastMove.id, moveName: lastMove.name, turns: 5 };
        this.say(battle, `${defenderName}'s ${lastMove.name} was disabled!`);
      }
    }

    if (spec.encoreTarget && !isFainted(defender) && canAffectTarget) {
      const lastId = defender.volatile.lastMoveId;
      const lastMove = lastId ? defender.moves.find((known) => known.id === lastId) : null;
      if (!lastMove || lastMove.currentPp <= 0 || defender.volatile.encore) {
        this.say(battle, "But it failed!");
      } else {
        defender.volatile.encore = { moveId: lastMove.id, turns: 4 };
        this.say(battle, `${defenderName} received an encore!`);
      }
    }

    if (spec.tauntTarget && !isFainted(defender) && canAffectTarget) {
      if (defender.volatile.tauntTurns > 0) {
        this.say(battle, "But it failed!");
      } else {
        defender.volatile.tauntTurns = 4;
        this.say(battle, `${defenderName} fell for the taunt!`);
      }
    }

    if (spec.tormentTarget && !isFainted(defender) && canAffectTarget) {
      if (defender.volatile.torment) {
        this.say(battle, "But it failed!");
      } else {
        defender.volatile.torment = true;
        this.say(battle, `${defenderName} was subjected to torment!`);
      }
    }

    if (spec.healBlockTarget && !isFainted(defender) && canAffectTarget) {
      if (defender.volatile.healBlockTurns > 0) {
        this.say(battle, "But it failed!");
      } else {
        defender.volatile.healBlockTurns = 5;
        this.say(battle, `${defenderName} was prevented from healing!`);
      }
    }

    if (spec.imprisonUser) {
      if (attacker.volatile.imprison) {
        this.say(battle, "But it failed!");
      } else {
        attacker.volatile.imprison = true;
        this.say(battle, `${attackerName} sealed the opponent's moves!`);
      }
    }

    if (spec.embargoTarget && !isFainted(defender) && canAffectTarget) {
      if (defender.volatile.embargoTurns > 0) {
        this.say(battle, "But it failed!");
      } else {
        defender.volatile.embargoTurns = 5;
        this.say(battle, `${defenderName} can't use items anymore!`);
      }
    }

    if (spec.spiteTarget && !isFainted(defender)) {
      const lastId = defender.volatile.lastMoveId;
      const lastMove = lastId ? defender.moves.find((known) => known.id === lastId) : null;
      if (!lastMove || lastMove.currentPp <= 0) {
        this.say(battle, "But it failed!");
      } else {
        const reduction = Math.min(4, lastMove.currentPp);
        lastMove.currentPp -= reduction;
        this.say(battle, `It reduced the PP of ${defenderName}'s ${lastMove.name} by ${reduction}!`);
      }
    }

    if (spec.attractTarget && !isFainted(defender) && canAffectTarget) {
      const canAttract =
        attacker.gender !== "genderless" &&
        defender.gender !== "genderless" &&
        attacker.gender !== defender.gender &&
        !defender.volatile.attractedToPokemonId;
      if (canAttract) {
        defender.volatile.attractedToPokemonId = attacker.id;
        this.say(battle, `${defenderName} fell in love!`);
      } else {
        this.say(battle, "But it failed!");
      }
    }

    if (spec.yawnTarget && !isFainted(defender) && canAffectTarget) {
      if (defender.status || defender.volatile.yawnTurns > 0 || isImmuneToStatus("sleep", defender.types)) {
        this.say(battle, "But it failed!");
      } else {
        defender.volatile.yawnTurns = 2;
        this.say(battle, `${attackerName} made ${defenderName} drowsy!`);
      }
    }

    // ------------------------------------------------------------------
    // Curse (Ghost pays half HP; everyone else gets the stat trade)
    // ------------------------------------------------------------------
    if (spec.curse) {
      const isGhost = attacker.types.some((type) => type.trim().toUpperCase() === "GHOST");
      if (isGhost) {
        if (isFainted(defender) || defender.volatile.cursed || !canAffectTarget) {
          this.say(battle, "But it failed!");
        } else {
          const cost = Math.max(1, Math.floor(attacker.maxHp / 2));
          attacker.hp = Math.max(0, attacker.hp - cost);
          defender.volatile.cursed = true;
          this.pushEvent(
            battle,
            {
              kind: "damage",
              sideId: side.id,
              pokemonId: attacker.id,
              amount: cost,
              hpAfter: attacker.hp,
              maxHp: attacker.maxHp,
              effectiveness: 1,
              critical: false,
              source: "move"
            },
            `${attackerName} cut its own HP and laid a curse on ${defenderName}!`
          );
        }
      } else {
        this.applyStatStageChange(battle, side, attacker, "speed", -1, false, true);
        this.applyStatStageChange(battle, side, attacker, "attack", 1, false, true);
        this.applyStatStageChange(battle, side, attacker, "defense", 1, false, true);
      }
    }

    // ------------------------------------------------------------------
    // Held items. Item-moving moves act on the battle-use slot first, then
    // the bonus slot; the appearance slot is unlosable (Essentials
    // `unlosable?` semantics for form items).
    // ------------------------------------------------------------------
    if (spec.removeTargetItem && !isFainted(defender) && canAffectTarget) {
      const removableSlot = this.getRemovableSlot(defender);
      if (removableSlot) {
        const removed = this.getSlotItem(defender, removableSlot);
        this.setSlotItem(defender, removableSlot, null, null);
        this.say(battle, `${attackerName} knocked off ${defenderName}'s ${removed.name ?? "item"}!`);
      }
    }

    if (spec.stealTargetItem && !isFainted(defender) && canAffectTarget) {
      const removableSlot = this.getRemovableSlot(defender);
      const stolen = removableSlot ? this.getSlotItem(defender, removableSlot) : null;
      if (removableSlot && stolen?.id && this.giveItemToBattler(attacker, stolen.id, stolen.name)) {
        this.setSlotItem(defender, removableSlot, null, null);
        this.say(battle, `${attackerName} stole ${defenderName}'s ${stolen.name ?? "item"}!`);
      }
    }

    if (spec.swapItems && !isFainted(defender) && canAffectTarget) {
      const attackerSlot = this.getRemovableSlot(attacker);
      const defenderSlot = this.getRemovableSlot(defender);
      if (!attackerSlot && !defenderSlot) {
        this.say(battle, "But it failed!");
      } else {
        const ownItem = attackerSlot ? this.getSlotItem(attacker, attackerSlot) : null;
        const theirItem = defenderSlot ? this.getSlotItem(defender, defenderSlot) : null;
        if (attackerSlot) {
          this.setSlotItem(attacker, attackerSlot, null, null);
        }
        if (defenderSlot) {
          this.setSlotItem(defender, defenderSlot, null, null);
        }
        this.say(battle, `${attackerName} switched items with its opponent!`);
        if (theirItem?.id && this.giveItemToBattler(attacker, theirItem.id, theirItem.name)) {
          this.say(battle, `${attackerName} obtained one ${theirItem.name}.`);
        }
        if (ownItem?.id && this.giveItemToBattler(defender, ownItem.id, ownItem.name)) {
          this.say(battle, `${defenderName} obtained one ${ownItem.name}.`);
        }
      }
    }

    if (spec.bestowItem && !isFainted(defender) && canAffectTarget) {
      const attackerSlot = this.getRemovableSlot(attacker);
      const gift = attackerSlot ? this.getSlotItem(attacker, attackerSlot) : null;
      if (!attackerSlot || !gift?.id || !this.giveItemToBattler(defender, gift.id, gift.name)) {
        this.say(battle, "But it failed!");
      } else {
        this.setSlotItem(attacker, attackerSlot, null, null);
        this.say(battle, `${attackerName} gave ${defenderName} its ${gift.name}!`);
      }
    }

    if (spec.eatTargetBerry && !isFainted(defender) && canAffectTarget) {
      const berrySlot = this.getBerrySlot(defender);
      if (berrySlot) {
        const berry = this.getSlotItem(defender, berrySlot);
        this.setSlotItem(defender, berrySlot, null, null);
        attacker.ateBerry = true;
        this.say(battle, `${attackerName} stole and ate ${defenderName}'s ${berry.name ?? "berry"}!`);
      }
    }

    if (spec.incinerateBerry && !isFainted(defender) && canAffectTarget) {
      const berrySlot = this.getBerrySlot(defender);
      if (berrySlot) {
        const berry = this.getSlotItem(defender, berrySlot);
        this.setSlotItem(defender, berrySlot, null, null);
        this.say(battle, `${defenderName}'s ${berry.name ?? "berry"} was burned up!`);
      }
    }

    if (spec.recycleItem) {
      const consumed = attacker.consumedItem;
      if (consumed && !this.getSlotItem(attacker, consumed.slot).id) {
        this.setSlotItem(attacker, consumed.slot, consumed.id, consumed.name);
        attacker.consumedItem = null;
        this.say(battle, `${attackerName} found one ${consumed.name}!`);
      } else {
        this.say(battle, "But it failed!");
      }
    }

    if (spec.flingItem) {
      const flingSlot = this.getRemovableSlot(attacker);
      if (!flingSlot || battle.magicRoomTurns > 0) {
        this.say(battle, "But it failed!");
      } else {
        const flung = this.getSlotItem(attacker, flingSlot);
        this.setSlotItem(attacker, flingSlot, null, null);
        this.say(battle, `${attackerName} flung its ${flung.name ?? "item"}!`);
        if (!isFainted(defender) && canAffectTarget) {
          this.applyDirectDamage(battle, target, defender, 30, spec);
        }
      }
    }

    if (spec.payDay) {
      battle.extraMoney += 5 * attacker.level;
      this.say(battle, "Coins scattered everywhere!");
    }

    if (spec.doubleMoney) {
      battle.moneyMultiplier = 2;
      this.say(battle, "Everyone is caught up in the happy atmosphere!");
    }

    // ------------------------------------------------------------------
    // Entry hazards
    // ------------------------------------------------------------------
    if (spec.hazard) {
      const hazards = (target.hazards ??= {
        spikes: 0,
        toxicSpikes: 0,
        stealthRock: false,
        stickyWeb: false
      });
      if (spec.hazard === "spikes") {
        if (hazards.spikes >= 3) {
          this.say(battle, "But it failed!");
        } else {
          hazards.spikes += 1;
          this.say(battle, `Spikes were scattered around ${target.trainerName}'s team!`);
        }
      } else if (spec.hazard === "toxic-spikes") {
        if (hazards.toxicSpikes >= 2) {
          this.say(battle, "But it failed!");
        } else {
          hazards.toxicSpikes += 1;
          this.say(battle, `Poison spikes were scattered around ${target.trainerName}'s team!`);
        }
      } else if (spec.hazard === "stealth-rock") {
        if (hazards.stealthRock) {
          this.say(battle, "But it failed!");
        } else {
          hazards.stealthRock = true;
          this.say(battle, `Pointed stones float in the air around ${target.trainerName}'s team!`);
        }
      } else if (hazards.stickyWeb) {
        this.say(battle, "But it failed!");
      } else {
        hazards.stickyWeb = true;
        this.say(battle, `A sticky web spreads out beneath ${target.trainerName}'s team!`);
      }
    }

    if (spec.clearUserHazards) {
      let cleared = false;
      if (attacker.volatile.binding) {
        this.say(battle, `${attackerName} got free of ${attacker.volatile.binding.moveName}!`);
        attacker.volatile.binding = null;
        cleared = true;
      }
      if (attacker.volatile.seededBySideId) {
        attacker.volatile.seededBySideId = null;
        this.say(battle, `${attackerName} shed Leech Seed!`);
        cleared = true;
      }
      const ownHazards = side.hazards;
      if (
        ownHazards &&
        (ownHazards.spikes > 0 || ownHazards.toxicSpikes > 0 || ownHazards.stealthRock || ownHazards.stickyWeb)
      ) {
        side.hazards = { spikes: 0, toxicSpikes: 0, stealthRock: false, stickyWeb: false };
        this.say(battle, `${attackerName} blew away the hazards on its side!`);
        cleared = true;
      }
      if (!cleared && isPureStatusMove) {
        this.say(battle, "But it failed!");
      }
    }

    if (spec.defog) {
      if (target.screens) {
        target.screens.reflect = 0;
        target.screens.lightScreen = 0;
      }
      target.hazards = { spikes: 0, toxicSpikes: 0, stealthRock: false, stickyWeb: false };
      if (target.sideEffects) {
        target.sideEffects.safeguard = 0;
        target.sideEffects.mist = 0;
      }
      this.say(battle, `${target.trainerName}'s side was cleared of obstacles!`);
    }

    // ------------------------------------------------------------------
    // Delayed effects & lethal bonds
    // ------------------------------------------------------------------
    if (spec.futureSight) {
      if (target.futureSight) {
        this.say(battle, "But it failed!");
      } else {
        // Damage is computed with the user's stats now (classic behavior:
        // typeless, so no STAB and no type matchups).
        const typelessSpec = { ...spec, struggleRecoil: true };
        const damage = this.calculateDamage(
          battle,
          attacker,
          defender,
          target,
          move,
          typelessSpec,
          1,
          false,
          move.type
        );
        target.futureSight = { turns: 3, damage, moveName: move.name };
        this.say(battle, `${attackerName} foresaw an attack!`);
      }
    }

    if (spec.wishUser) {
      if (side.wish) {
        this.say(battle, "But it failed!");
      } else {
        side.wish = {
          turns: 2,
          amount: Math.max(1, Math.floor(attacker.maxHp / 2)),
          wisherName: attackerName
        };
        this.say(battle, `${attackerName} made a wish!`);
      }
    }

    if (spec.perishSong) {
      let affected = 0;
      for (const anySide of battle.sides) {
        const battler = getActivePokemon(anySide);
        if (battler && !isFainted(battler) && battler.volatile.perishCount === 0) {
          battler.volatile.perishCount = 4;
          affected += 1;
        }
      }
      this.say(
        battle,
        affected > 0 ? "All Pokemon that heard the song will faint in three turns!" : "But it failed!"
      );
    }

    if (spec.destinyBond) {
      attacker.volatile.destinyBond = true;
      this.say(battle, `${attackerName} is trying to take its foe down with it!`);
    }

    if (spec.grudgeUser) {
      attacker.volatile.grudge = true;
      this.say(battle, `${attackerName} wants its opponent to bear a grudge!`);
    }

    if (spec.bide && !attacker.volatile.bide) {
      attacker.volatile.bide = { moveId: move.id, turnsLeft: 2, storedDamage: 0 };
      this.say(battle, `${attackerName} is storing energy!`);
    }

    // ------------------------------------------------------------------
    // Transform & Substitute
    // ------------------------------------------------------------------
    if (spec.transformUser) {
      if (isFainted(defender) || attacker.volatile.transformBackup || defender.volatile.transformBackup) {
        this.say(battle, "But it failed!");
      } else {
        attacker.volatile.transformBackup = {
          types: attacker.types,
          stats: attacker.stats,
          moves: attacker.moves,
          frontImageSrc: attacker.frontImageSrc,
          backImageSrc: attacker.backImageSrc
        };
        attacker.types = [...defender.types];
        attacker.stats = { ...defender.stats, hp: attacker.stats.hp };
        attacker.stages = { ...defender.stages };
        attacker.moves = defender.moves.map((known) => ({
          ...known,
          currentPp: Math.min(5, known.maxPp),
          maxPp: Math.min(5, known.maxPp)
        }));
        attacker.frontImageSrc = defender.frontImageSrc;
        attacker.backImageSrc = defender.backImageSrc;
        this.say(battle, `${attackerName} transformed into ${defender.name}!`);
      }
    }

    if (spec.substitute) {
      if (attacker.volatile.substituteHp > 0) {
        this.say(battle, `${attackerName} already has a substitute!`);
      } else {
        const cost = Math.max(1, Math.floor(attacker.maxHp / 4));
        if (attacker.hp <= cost) {
          this.say(battle, "It was too weak to make a substitute!");
        } else {
          attacker.hp -= cost;
          attacker.volatile.substituteHp = cost;
          this.pushEvent(
            battle,
            {
              kind: "damage",
              sideId: side.id,
              pokemonId: attacker.id,
              amount: cost,
              hpAfter: attacker.hp,
              maxHp: attacker.maxHp,
              effectiveness: 1,
              critical: false,
              source: "move"
            },
            `${attackerName} created a substitute!`
          );
        }
      }
    }

    // ------------------------------------------------------------------
    // Stockpile family
    // ------------------------------------------------------------------
    if (spec.stockpileUser) {
      if (attacker.volatile.stockpile >= 3) {
        this.say(battle, `${attackerName} can't stockpile any more!`);
      } else {
        attacker.volatile.stockpile += 1;
        this.say(battle, `${attackerName} stockpiled ${attacker.volatile.stockpile}!`);
        this.applyStatStageChange(battle, side, attacker, "defense", 1, true);
        this.applyStatStageChange(battle, side, attacker, "specialDefense", 1, true);
      }
    }

    if (spec.swallow) {
      const count = attacker.volatile.stockpile;
      if (count <= 0) {
        this.say(battle, "But it failed to swallow a thing!");
      } else if (attacker.hp >= attacker.maxHp) {
        this.say(battle, `${attackerName}'s HP is already full!`);
      } else {
        const fraction = count === 1 ? 0.25 : count === 2 ? 0.5 : 1;
        const healed = Math.min(
          attacker.maxHp - attacker.hp,
          Math.max(1, Math.floor(attacker.maxHp * fraction))
        );
        attacker.hp += healed;
        attacker.volatile.stockpile = 0;
        this.pushEvent(
          battle,
          {
            kind: "heal",
            sideId: side.id,
            pokemonId: attacker.id,
            amount: healed,
            hpAfter: attacker.hp,
            maxHp: attacker.maxHp,
            source: "move"
          },
          `${attackerName} regained health! Its stockpiled effect wore off!`
        );
      }
    }

    // ------------------------------------------------------------------
    // Stat & type plays
    // ------------------------------------------------------------------
    if (spec.acupressure) {
      const stats: BattleStageKey[] = [
        "attack",
        "defense",
        "specialAttack",
        "specialDefense",
        "speed",
        "accuracy",
        "evasion"
      ];
      const raisable = stats.filter((stat) => attacker.stages[stat] < 6);
      if (raisable.length === 0) {
        this.say(battle, "But it failed!");
      } else {
        this.applyStatStageChange(battle, side, attacker, chooseRandom(raisable), 2, false);
      }
    }

    if (spec.swapStages && !isFainted(defender) && canAffectTarget) {
      const keys: BattleStageKey[] =
        spec.swapStages === "offense"
          ? ["attack", "specialAttack"]
          : spec.swapStages === "defense"
            ? ["defense", "specialDefense"]
            : ["attack", "defense", "specialAttack", "specialDefense", "speed", "accuracy", "evasion"];
      for (const key of keys) {
        const own = attacker.stages[key];
        attacker.stages[key] = defender.stages[key];
        defender.stages[key] = own;
      }
      this.say(battle, `${attackerName} switched stat changes with ${defenderName}!`);
    }

    if (spec.copyTargetStages && !isFainted(defender)) {
      attacker.stages = { ...defender.stages };
      this.say(battle, `${attackerName} copied ${defenderName}'s stat changes!`);
    }

    if (spec.powerTrick) {
      const own = attacker.stats.attack;
      attacker.stats = { ...attacker.stats, attack: attacker.stats.defense, defense: own };
      this.say(battle, `${attackerName} switched its Attack and Defense!`);
    }

    if (spec.averageStats && !isFainted(defender) && canAffectTarget) {
      const keys: Array<"attack" | "specialAttack" | "defense" | "specialDefense"> =
        spec.averageStats === "offense" ? ["attack", "specialAttack"] : ["defense", "specialDefense"];
      for (const key of keys) {
        const average = Math.max(1, Math.floor((attacker.stats[key] + defender.stats[key]) / 2));
        attacker.stats = { ...attacker.stats, [key]: average };
        defender.stats = { ...defender.stats, [key]: average };
      }
      this.say(
        battle,
        spec.averageStats === "offense"
          ? `${attackerName} shared its power with the target!`
          : `${attackerName} shared its guard with the target!`
      );
    }

    if (spec.topsyTurvy && !isFainted(defender) && canAffectTarget) {
      const stats: BattleStageKey[] = [
        "attack",
        "defense",
        "specialAttack",
        "specialDefense",
        "speed",
        "accuracy",
        "evasion"
      ];
      const hasStages = stats.some((stat) => defender.stages[stat] !== 0);
      if (!hasStages) {
        this.say(battle, "But it failed!");
      } else {
        stats.forEach((stat) => {
          defender.stages[stat] = -defender.stages[stat];
        });
        this.say(battle, `${defenderName}'s stat changes were all reversed!`);
      }
    }

    if ((spec.mimic || spec.sketch) && !isFainted(defender)) {
      const lastId = defender.volatile.lastMoveId;
      const skill = lastId ? this.cachedSkillsById.get(lastId) : null;
      if (!skill || attacker.moves.some((known) => known.id === skill.id)) {
        this.say(battle, "But it failed!");
      } else {
        const copied = this.buildBattleMove(skill);
        if (spec.mimic) {
          copied.maxPp = Math.min(5, copied.maxPp);
          copied.currentPp = copied.maxPp;
        }
        const slot = attacker.moves.findIndex((known) => known.id === move.id);
        if (slot >= 0) {
          attacker.moves[slot] = copied;
          this.say(battle, `${attackerName} learned ${copied.name}!`);
        } else {
          this.say(battle, "But it failed!");
        }
      }
    }

    if (spec.conversion2 && !isFainted(defender)) {
      const lastId = defender.volatile.lastMoveId;
      const lastSkill = lastId ? this.cachedSkillsById.get(lastId) : null;
      if (!lastSkill) {
        this.say(battle, "But it failed!");
      } else {
        const allTypes = [
          "NORMAL", "FIRE", "WATER", "ELECTRIC", "GRASS", "ICE", "FIGHTING", "POISON", "GROUND",
          "FLYING", "PSYCHIC", "BUG", "ROCK", "GHOST", "DRAGON", "DARK", "STEEL", "FAIRY"
        ];
        const resistant = allTypes.filter(
          (candidate) =>
            this.getEffectiveness(lastSkill.type, [candidate]) < 1 &&
            !attacker.types.some((own) => isSameType(this.typeChart, own, candidate))
        );
        if (resistant.length === 0) {
          this.say(battle, "But it failed!");
        } else {
          const chosen = chooseRandom(resistant);
          attacker.types = [chosen];
          this.say(battle, `${attackerName} transformed into the ${chosen} type!`);
        }
      }
    }

    if (spec.camouflage) {
      const back = (battle.battleBack ?? "").toLowerCase();
      const newType =
        back.includes("water") || back.includes("sea") || back.includes("underwater")
          ? "WATER"
          : back.includes("cave") || back.includes("rock") || back.includes("mountain")
            ? "ROCK"
            : back.includes("sand")
              ? "GROUND"
              : back.includes("grass") || back.includes("forest")
                ? "GRASS"
                : "NORMAL";
      if (attacker.types.some((own) => isSameType(this.typeChart, own, newType))) {
        this.say(battle, "But it failed!");
      } else {
        attacker.types = [newType];
        this.say(battle, `${attackerName} transformed into the ${newType} type!`);
      }
    }

    if (spec.psychoShift && !isFainted(defender) && canAffectTarget) {
      if (!attacker.status || defender.status || isImmuneToStatus(attacker.status.id, defender.types)) {
        this.say(battle, "But it failed!");
      } else {
        defender.status = { ...attacker.status };
        this.pushEvent(
          battle,
          { kind: "status-applied", sideId: target.id, pokemonId: defender.id, status: defender.status.id },
          `${attackerName} moved its status problem to ${defenderName}!`
        );
        this.pushEvent(
          battle,
          { kind: "status-cured", sideId: side.id, pokemonId: attacker.id, status: attacker.status.id },
          null
        );
        attacker.status = null;
      }
    }

    if (spec.curePartyStatus) {
      let cured = 0;
      side.party.forEach((member) => {
        if (member.status) {
          if (member.id === attacker.id) {
            this.pushEvent(
              battle,
              { kind: "status-cured", sideId: side.id, pokemonId: member.id, status: member.status.id },
              null
            );
          }
          member.status = null;
          cured += 1;
        }
      });
      this.say(
        battle,
        cured > 0 ? "A bell chimed! The team was cured of its status problems!" : "But it failed!"
      );
    }

    if (spec.healTargetHalf && !isFainted(defender) && canAffectTarget) {
      if (defender.hp >= defender.maxHp) {
        this.say(battle, `${defenderName}'s HP is already full!`);
      } else {
        const healed = Math.min(defender.maxHp - defender.hp, Math.max(1, Math.floor(defender.maxHp / 2)));
        defender.hp += healed;
        this.pushEvent(
          battle,
          {
            kind: "heal",
            sideId: target.id,
            pokemonId: defender.id,
            amount: healed,
            hpAfter: defender.hp,
            maxHp: defender.maxHp,
            source: "move"
          },
          `${defenderName} had its HP restored.`
        );
      }
    }

    if (spec.grassStatBoost) {
      let boosted = 0;
      for (const anySide of battle.sides) {
        const battler = getActivePokemon(anySide);
        if (!battler || isFainted(battler)) {
          continue;
        }
        if (!battler.types.some((type) => type.trim().toUpperCase() === "GRASS")) {
          continue;
        }
        if (spec.grassStatBoost === "defense") {
          this.applyStatStageChange(battle, anySide, battler, "defense", 1, true);
        } else {
          this.applyStatStageChange(battle, anySide, battler, "attack", 1, true);
          this.applyStatStageChange(battle, anySide, battler, "specialAttack", 1, true);
        }
        boosted += 1;
      }
      if (boosted === 0) {
        this.say(battle, "But it failed!");
      }
    }

    // ------------------------------------------------------------------
    // Field-wide effects
    // ------------------------------------------------------------------
    if (spec.startFieldEffect) {
      switch (spec.startFieldEffect) {
        case "gravity":
          if (battle.gravityTurns > 0) {
            this.say(battle, "But it failed!");
          } else {
            battle.gravityTurns = 5;
            this.say(battle, "Gravity intensified!");
            for (const anySide of battle.sides) {
              const battler = getActivePokemon(anySide);
              if (!battler || isFainted(battler)) {
                continue;
              }
              battler.volatile.magnetRiseTurns = 0;
              battler.volatile.telekinesisTurns = 0;
              if (battler.volatile.charging?.invulnerable === "sky") {
                battler.volatile.charging = null;
                this.say(battle, `${getPokemonDisplayName(battler)} fell from the sky!`);
              }
            }
          }
          break;
        case "trick-room":
          if (battle.trickRoomTurns > 0) {
            battle.trickRoomTurns = 0;
            this.say(battle, "The twisted dimensions returned to normal!");
          } else {
            battle.trickRoomTurns = 5;
            this.say(battle, `${attackerName} twisted the dimensions!`);
          }
          break;
        case "magic-room":
          if (battle.magicRoomTurns > 0) {
            battle.magicRoomTurns = 0;
            this.say(battle, "The area returned to normal!");
          } else {
            battle.magicRoomTurns = 5;
            this.say(battle, "It created a bizarre area in which held items lose their effects!");
          }
          break;
        case "wonder-room":
          if (battle.wonderRoomTurns > 0) {
            battle.wonderRoomTurns = 0;
            this.say(battle, "Wonder Room wore off!");
          } else {
            battle.wonderRoomTurns = 5;
            this.say(battle, "It created a bizarre area in which Defense and Sp. Def stats are swapped!");
          }
          break;
        case "electric-terrain":
          if (battle.terrain?.kind === "electric") {
            this.say(battle, "But it failed!");
          } else {
            battle.terrain = { kind: "electric", turns: 5 };
            this.say(battle, "An electric current runs across the battlefield!");
          }
          break;
        case "grassy-terrain":
          if (battle.terrain?.kind === "grassy") {
            this.say(battle, "But it failed!");
          } else {
            battle.terrain = { kind: "grassy", turns: 5 };
            this.say(battle, "Grass grew to cover the battlefield!");
          }
          break;
        case "ion-deluge":
          battle.ionDeluge = true;
          this.say(battle, "A deluge of ions showers the battlefield!");
          break;
      }
    }

    if (spec.startSideEffect) {
      const effects = (side.sideEffects ??= { tailwind: 0, safeguard: 0, mist: 0, luckyChant: 0 });
      const config = {
        tailwind: { turns: 4, message: "A tailwind blew from behind the team!" },
        safeguard: { turns: 5, message: `${side.trainerName}'s team became cloaked in a mystical veil!` },
        mist: { turns: 5, message: `${side.trainerName}'s team became shrouded in mist!` },
        "lucky-chant": { turns: 5, message: "The Lucky Chant shielded the team from critical hits!" }
      }[spec.startSideEffect];
      const key = spec.startSideEffect === "lucky-chant" ? "luckyChant" : spec.startSideEffect;
      if (effects[key as keyof typeof effects] > 0) {
        this.say(battle, "But it failed!");
      } else {
        effects[key as keyof typeof effects] = config.turns;
        this.say(battle, config.message);
      }
    }

    if (spec.sport) {
      if (spec.sport === "mud") {
        attacker.volatile.mudSport = true;
        this.say(battle, "Electricity's power was weakened!");
      } else {
        attacker.volatile.waterSport = true;
        this.say(battle, "Fire's power was weakened!");
      }
    }

    if (spec.magnetRiseUser) {
      if (attacker.volatile.magnetRiseTurns > 0 || battle.gravityTurns > 0) {
        this.say(battle, "But it failed!");
      } else {
        attacker.volatile.magnetRiseTurns = 5;
        this.say(battle, `${attackerName} levitated with electromagnetism!`);
      }
    }

    if (spec.telekinesisTarget && !isFainted(defender) && canAffectTarget) {
      if (defender.volatile.telekinesisTurns > 0 || battle.gravityTurns > 0) {
        this.say(battle, "But it failed!");
      } else {
        defender.volatile.telekinesisTurns = 3;
        this.say(battle, `${defenderName} was hurled into the air!`);
      }
    }

    // ------------------------------------------------------------------
    // Targeting helpers
    // ------------------------------------------------------------------
    if (spec.lockOnUser) {
      attacker.volatile.lockOnTurns = 2;
      this.say(battle, `${attackerName} took aim at ${defenderName}!`);
    }

    if (spec.foresight && !isFainted(defender) && canAffectTarget) {
      if (spec.foresight === "normal") {
        defender.volatile.foresight = true;
      } else {
        defender.volatile.miracleEye = true;
      }
      this.say(battle, `${attackerName} identified ${defenderName}!`);
    }

    if (spec.electrifyTarget && !isFainted(defender) && canAffectTarget) {
      if (target.action?.type === "fight" && !target.hasActedThisTurn) {
        defender.volatile.electrified = true;
        this.say(battle, `${defenderName}'s moves have been electrified!`);
      } else {
        this.say(battle, "But it failed!");
      }
    }

    if (spec.powderTarget && !isFainted(defender) && canAffectTarget) {
      defender.volatile.powdered = true;
      this.say(battle, `${defenderName} is covered in powder!`);
    }
  }

  private applyStatStageChange(
    battle: BattleSession,
    side: BattleSide,
    pokemon: BattlePokemon,
    stat: BattleStageKey,
    delta: number,
    viaSecondary: boolean,
    selfInflicted = false
  ) {
    const displayName = getPokemonDisplayName(pokemon);

    // Mist blocks stat drops caused by the opponent.
    if (delta < 0 && !selfInflicted && (side.sideEffects?.mist ?? 0) > 0) {
      if (!viaSecondary) {
        this.say(battle, `${displayName} is protected by the mist!`);
      }
      return;
    }

    const current = pokemon.stages[stat];
    const next = clamp(current + delta, -6, 6);
    const actual = next - current;
    const statLabel = STAGE_DISPLAY_NAMES[stat];

    if (actual === 0) {
      if (!viaSecondary) {
        this.say(
          battle,
          delta > 0
            ? `${displayName}'s ${statLabel} won't go any higher!`
            : `${displayName}'s ${statLabel} won't go any lower!`
        );
      }
      return;
    }

    pokemon.stages[stat] = next;
    const magnitudeText =
      actual >= 3 ? "rose drastically" :
      actual === 2 ? "rose sharply" :
      actual === 1 ? "rose" :
      actual === -1 ? "fell" :
      actual === -2 ? "harshly fell" : "severely fell";

    this.pushEvent(
      battle,
      {
        kind: "stat-change",
        sideId: side.id,
        pokemonId: pokemon.id,
        stat,
        delta: actual,
        stageAfter: next
      },
      `${displayName}'s ${statLabel} ${magnitudeText}!`
    );

    if (actual < 0) {
      this.applyStatDropTriggers(battle, side, pokemon);
    }
  }

  private applyStatusCondition(
    battle: BattleSession,
    side: BattleSide,
    pokemon: BattlePokemon,
    statusId: BattleStatusId,
    viaSecondary: boolean,
    selfInflicted = false
  ) {
    const displayName = getPokemonDisplayName(pokemon);

    if (pokemon.status) {
      if (!viaSecondary) {
        this.say(battle, `${displayName} is already ${STATUS_DISPLAY_NAMES[pokemon.status.id]}!`);
      }
      return;
    }

    // Safeguard shields the side from statuses inflicted by the opponent.
    if (!selfInflicted && (side.sideEffects?.safeguard ?? 0) > 0) {
      if (!viaSecondary) {
        this.say(battle, `${displayName} is protected by Safeguard!`);
      }
      return;
    }

    // Electric Terrain keeps grounded battlers awake; an Uproar wakes the field.
    if (statusId === "sleep") {
      if (battle.terrain?.kind === "electric" && this.isGrounded(battle, pokemon)) {
        if (!viaSecondary) {
          this.say(battle, `${displayName} can't sleep on the Electric Terrain!`);
        }
        return;
      }
      const uproarActive = battle.sides.some((anySide) => {
        const battler = getActivePokemon(anySide);
        return battler && !isFainted(battler) && battler.volatile.rampage?.kind === "uproar";
      });
      if (uproarActive) {
        if (!viaSecondary) {
          this.say(battle, `But the uproar kept ${displayName} awake!`);
        }
        return;
      }
    }

    const typeIds = pokemon.types.map((type) => resolveTypeId(this.typeChart, type));
    if (isImmuneToStatus(statusId, typeIds)) {
      if (!viaSecondary) {
        this.say(battle, `It doesn't affect ${displayName}...`);
      }
      return;
    }

    pokemon.status = createStatusState(statusId);
    const statusText: Record<BattleStatusId, string> = {
      poison: `${displayName} was poisoned!`,
      toxic: `${displayName} was badly poisoned!`,
      burn: `${displayName} was burned!`,
      paralysis: `${displayName} is paralyzed! It may be unable to move!`,
      sleep: `${displayName} fell asleep!`,
      freeze: `${displayName} was frozen solid!`
    };

    this.pushEvent(
      battle,
      { kind: "status-applied", sideId: side.id, pokemonId: pokemon.id, status: statusId },
      statusText[statusId]
    );

    this.applyHeldItemTriggers(battle, side, pokemon);
  }

  private rollAccuracy(
    attacker: BattlePokemon,
    defender: BattlePokemon,
    move: BattleMove,
    spec: MoveEffectSpec
  ): boolean {
    if (spec.ohko) {
      const chance = 30 + (attacker.level - defender.level);
      return Math.random() * 100 < chance;
    }

    if (move.accuracy <= 0) {
      return true;
    }

    // Foresight/Miracle Eye ignore the target's evasion boosts.
    const identified = defender.volatile.foresight || defender.volatile.miracleEye;
    const evasion = identified ? Math.min(0, defender.stages.evasion) : defender.stages.evasion;
    const stageDelta = clamp(attacker.stages.accuracy - evasion, -6, 6);
    // BrightPowder on the target throws off incoming moves; a Wide Lens on
    // the attacker sharpens its own.
    const brightPowder = this.getHeldBonus(defender)?.incomingAccuracyMultiplier ?? 1;
    const wideLens = this.getHeldBonus(attacker)?.accuracyMultiplier ?? 1;
    const chance = move.accuracy * getAccuracyStageMultiplier(stageDelta) * brightPowder * wideLens;
    return Math.random() * 100 < chance;
  }

  private rollCritical(
    move: BattleMove,
    spec: MoveEffectSpec,
    attacker?: BattlePokemon,
    defenderSide?: BattleSide
  ): boolean {
    // Lucky Chant wards off critical hits entirely.
    if ((defenderSide?.sideEffects?.luckyChant ?? 0) > 0) {
      return false;
    }

    if (spec.alwaysCrit) {
      return true;
    }

    const flags = (move.flags ?? []).map((flag) => flag.toLowerCase());
    const highCritRate = flags.includes("h") || flags.includes("highcriticalhitrate");
    const focused = attacker?.volatile.focusEnergy ?? false;
    // Stage ladder (matches the old focused/high-crit table exactly):
    // 0 -> 1/16, 1 -> 1/8, 2 -> 1/4, 3+ -> 1/2. Focus Energy counts double;
    // a held Scope Lens adds a stage.
    const scopeLens = attacker ? (this.getHeldBonus(attacker)?.critStageBonus ?? 0) : 0;
    const stage = (highCritRate ? 1 : 0) + (focused ? 2 : 0) + scopeLens;
    const chance = [1 / 16, 1 / 8, 1 / 4][stage] ?? 1 / 2;
    return Math.random() < chance;
  }

  private getEffectiveness(moveType: string, defenderTypes: string[]) {
    return getTypeEffectiveness(this.typeChart, moveType, defenderTypes);
  }

  private calculateConfusionDamage(pokemon: BattlePokemon) {
    const attackStat = this.getModifiedStat(pokemon, "attack");
    const defenseStat = this.getModifiedStat(pokemon, "defense");
    const baseDamage =
      Math.floor(
        Math.floor((Math.floor((2 * pokemon.level) / 5 + 2) * 40 * attackStat) / Math.max(1, defenseStat)) / 50
      ) + 2;
    return Math.max(1, Math.floor(baseDamage * (0.85 + Math.random() * 0.15)));
  }

  private calculateDamage(
    battle: BattleSession,
    attacker: BattlePokemon,
    defender: BattlePokemon,
    defenderSide: BattleSide,
    move: BattleMove,
    spec: MoveEffectSpec,
    effectiveness: number,
    critical: boolean,
    effectiveMoveType?: string,
    powerOverride?: number
  ) {
    const moveType = effectiveMoveType ?? move.type;
    const power = Math.max(1, powerOverride ?? move.power);

    // Foul Play swings with the TARGET's Attack.
    const attackSource = spec.foulPlay ? defender : attacker;
    const attackStat =
      move.damageClass === "physical" || spec.foulPlay
        ? this.getModifiedStat(attackSource, "attack")
        : this.getModifiedStat(attacker, "specialAttack");
    // Psyshock hits the physical Defense with a special move; Chip Away
    // ignores the target's defensive stat stages; Wonder Room swaps the
    // defensive stats of every battler.
    let defenseStatKey: "defense" | "specialDefense" =
      move.damageClass === "physical" || spec.psyshock ? "defense" : "specialDefense";
    if (battle.wonderRoomTurns > 0) {
      defenseStatKey = defenseStatKey === "defense" ? "specialDefense" : "defense";
    }
    const defenseStat = spec.ignoreDefensiveStages
      ? Math.max(1, defender.stats[defenseStatKey])
      : this.getModifiedStat(defender, defenseStatKey);

    const baseDamage = Math.floor(
      Math.floor((Math.floor((2 * attacker.level) / 5 + 2) * power * attackStat) / Math.max(1, defenseStat)) / 50
    ) + 2;
    const stab =
      !spec.struggleRecoil && attacker.types.some((type) => isSameType(this.typeChart, type, moveType))
        ? 1.5
        : 1;
    const criticalMultiplier = critical ? 1.5 : 1;
    const randomFactor = 0.85 + Math.random() * 0.15;

    // Weather: sun boosts Fire and dampens Water; rain does the reverse.
    let weatherMultiplier = 1;
    const weather = battle.weather?.kind ?? null;
    const upperType = moveType.trim().toUpperCase();
    if (weather === "sun") {
      weatherMultiplier = upperType === "FIRE" ? 1.5 : upperType === "WATER" ? 0.5 : 1;
    } else if (weather === "rain") {
      weatherMultiplier = upperType === "WATER" ? 1.5 : upperType === "FIRE" ? 0.5 : 1;
    }

    // Terrains boost their type for grounded attackers.
    let terrainMultiplier = 1;
    if (battle.terrain && this.isGrounded(battle, attacker)) {
      if (battle.terrain.kind === "electric" && upperType === "ELECTRIC") {
        terrainMultiplier = 1.5;
      } else if (battle.terrain.kind === "grassy" && upperType === "GRASS") {
        terrainMultiplier = 1.5;
      }
    }

    // Mud Sport / Water Sport dampen Electric/Fire while their user is out.
    const sportActive = (kind: "mud" | "water") =>
      battle.sides.some((anySide) => {
        const battler = getActivePokemon(anySide);
        return (
          battler &&
          !isFainted(battler) &&
          (kind === "mud" ? battler.volatile.mudSport : battler.volatile.waterSport)
        );
      });
    let sportMultiplier = 1;
    if (upperType === "ELECTRIC" && sportActive("mud")) {
      sportMultiplier = 0.5;
    } else if (upperType === "FIRE" && sportActive("water")) {
      sportMultiplier = 0.5;
    }

    // Reflect / Light Screen halve the matching damage class (crits pierce).
    const screens = defenderSide.screens;
    const screenMultiplier =
      !critical &&
      screens &&
      ((move.damageClass === "physical" && screens.reflect > 0) ||
        (move.damageClass === "special" && screens.lightScreen > 0))
        ? 0.5
        : 1;

    // Equip items on the attacker: type boosters (Charcoal...), damage-class
    // bands (Muscle Band / Wise Glasses) and Life Orb.
    let itemMultiplier = 1;
    const attackerBonus = this.getHeldBonus(attacker, battle);
    if (attackerBonus) {
      if (
        attackerBonus.boostType &&
        upperType === attackerBonus.boostType.trim().toUpperCase()
      ) {
        itemMultiplier *= attackerBonus.boostTypeMultiplier ?? 1.2;
      }
      if (move.damageClass === "physical" && attackerBonus.physicalPowerMultiplier) {
        itemMultiplier *= attackerBonus.physicalPowerMultiplier;
      }
      if (move.damageClass === "special" && attackerBonus.specialPowerMultiplier) {
        itemMultiplier *= attackerBonus.specialPowerMultiplier;
      }
      if (attackerBonus.allPowerMultiplier) {
        itemMultiplier *= attackerBonus.allPowerMultiplier;
      }
      // Expert Belt: only super-effective hits get the boost.
      if (attackerBonus.superEffectivePowerMultiplier && effectiveness > 1) {
        itemMultiplier *= attackerBonus.superEffectivePowerMultiplier;
      }
    }

    const modifier =
      stab *
      effectiveness *
      criticalMultiplier *
      randomFactor *
      weatherMultiplier *
      screenMultiplier *
      terrainMultiplier *
      sportMultiplier *
      itemMultiplier;

    if (effectiveness === 0) {
      return 0;
    }

    return Math.max(1, Math.floor(baseDamage * modifier));
  }

  /**
   * The equip bonus of the item a battler is holding, or null when it has
   * none or its items are suspended (Embargo; pass `battle` for Magic Room
   * awareness where it is in scope). Species/evolution-conditioned bonuses
   * (Thick Club, Eviolite) resolve against the holder here.
   */
  private getHeldBonus(pokemon: BattlePokemon, battle?: BattleSession | null): HeldBonusEffect | null {
    if (!pokemon.heldItemId) {
      return null;
    }
    if (battle && battle.magicRoomTurns > 0) {
      return null;
    }
    if (pokemon.volatile.embargoTurns > 0) {
      return null;
    }

    const definition = this.getCachedItemDefinition(pokemon.heldItemId, pokemon.heldItemName ?? "");
    const bonus = definition?.heldBonus ?? null;
    if (!bonus) {
      return null;
    }

    if (bonus.onlySpecies) {
      const species = (pokemon.sourcePokemonId ?? "")
        .replace(/^pokemon-/i, "")
        .trim()
        .toUpperCase() || pokemon.name.trim().toUpperCase();
      if (!bonus.onlySpecies.includes(species)) {
        return null;
      }
    }

    if (bonus.onlyIfCanEvolve && pokemon.evolutions.length === 0) {
      return null;
    }

    return bonus;
  }

  private getHeldStatMultiplier(
    pokemon: BattlePokemon,
    stat: Exclude<BattleStageKey, "accuracy" | "evasion">
  ) {
    const bonus = this.getHeldBonus(pokemon);
    if (!bonus) {
      return 1;
    }

    switch (stat) {
      case "attack":
        return bonus.attackMultiplier ?? 1;
      case "specialAttack":
        return bonus.specialAttackMultiplier ?? 1;
      case "defense":
        return bonus.defenseMultiplier ?? 1;
      case "specialDefense":
        return bonus.specialDefenseMultiplier ?? 1;
      case "speed":
        return bonus.speedMultiplier ?? 1;
      default:
        return 1;
    }
  }

  private getModifiedStat(pokemon: BattlePokemon, stat: Exclude<BattleStageKey, "accuracy" | "evasion">) {
    const stageValue = Math.floor(pokemon.stats[stat] * getStageMultiplier(pokemon.stages[stat]));
    const statusMultiplier =
      stat === "attack" || stat === "speed" ? getStatusStatMultiplier(pokemon.status, stat) : 1;
    const itemMultiplier = this.getHeldStatMultiplier(pokemon, stat);
    return Math.max(1, Math.floor(stageValue * statusMultiplier * itemMultiplier));
  }

  private tryEscape(side: BattleSide, opponent: BattleSide) {
    side.escapeAttempts += 1;
    const activePokemon = getActivePokemon(side);
    const opponentPokemon = getActivePokemon(opponent);
    const playerSpeed = this.getModifiedStat(activePokemon, "speed");
    const opponentSpeed = this.getModifiedStat(opponentPokemon, "speed");

    if (playerSpeed >= opponentSpeed) {
      return true;
    }

    const odds = Math.floor((playerSpeed * 128) / Math.max(1, opponentSpeed) + 30 * side.escapeAttempts);
    if (odds > 255) {
      return true;
    }

    return odds > Math.floor(Math.random() * 256);
  }

  private autoSwitchIfPossible(side: BattleSide) {
    const nextIndex = side.party.findIndex((pokemon) => !isFainted(pokemon));
    if (nextIndex < 0) {
      return false;
    }

    side.activeIndex = nextIndex;
    return true;
  }

  /**
   * Replaces a fainted active mon. AI sides and one-option parties switch
   * instantly; a player with a real choice is prompted and the turn pauses
   * until they answer (or the timeout falls back to the old auto-switch).
   * Returns false only when the side has nothing left to send out.
   */
  private async chooseReplacement(battle: BattleSession, side: BattleSide): Promise<boolean> {
    const available = side.party.filter((pokemon) => !isFainted(pokemon));
    if (available.length === 0) {
      return false;
    }

    if (side.isAi || !side.playerId || available.length === 1) {
      return this.autoSwitchIfPossible(side);
    }

    this.say(battle, `${side.trainerName}, choose your next Pokemon.`);
    const chosenId = await this.waitForReplacementChoice(battle, side);

    if (battle.status !== "active") {
      return true;
    }

    if (chosenId && this.switchPokemon(battle, side, chosenId)) {
      return true;
    }

    return this.autoSwitchIfPossible(side);
  }

  private waitForReplacementChoice(battle: BattleSession, side: BattleSide) {
    return new Promise<string | null>((resolve) => {
      const settle = (pokemonId: string | null) => {
        if (battle.replacementRequest?.sideId !== side.id) {
          return;
        }

        clearTimeout(battle.replacementRequest.timer);
        battle.replacementRequest = null;
        battle.turnEndsAt = null;
        resolve(pokemonId);
      };

      battle.replacementRequest = {
        sideId: side.id,
        resolve: settle,
        timer: setTimeout(() => settle(null), PLAYER_ACTION_TIMEOUT_MS)
      };
      battle.turnEndsAt = Date.now() + PLAYER_ACTION_TIMEOUT_MS;
      this.emitBattleState(battle);
      this.flushEvents(battle);
    });
  }

  private submitReplacementChoice(
    battle: BattleSession,
    side: BattleSide,
    socketId: string,
    action: BattleClientAction | undefined
  ) {
    const sanitized = this.sanitizeAction(action);
    if (sanitized?.type !== "pokemon") {
      this.emitToSocket(socketId, "battle:error", { message: "Choose a Pokemon to send out." });
      return;
    }

    const targetIndex = side.party.findIndex((pokemon) => pokemon.id === sanitized.pokemonId);
    if (targetIndex < 0 || targetIndex === side.activeIndex || isFainted(side.party[targetIndex])) {
      this.emitToSocket(socketId, "battle:error", { message: "That Pokemon cannot enter battle." });
      return;
    }

    battle.replacementRequest?.resolve(sanitized.pokemonId);
  }

  private getBattleSideForPlayer(battle: BattleSession, playerId: string) {
    return battle.sides.find((side) => side.playerId === playerId) ?? null;
  }

  private getOpponentSide(battle: BattleSession, side: BattleSide) {
    return battle.sides.find((candidate) => candidate.id !== side.id)!;
  }

  private hasAvailablePokemon(side: BattleSide) {
    // Pure check: it must NOT touch activeIndex. finishBattle calls this on
    // every side, and the old index reset snapped the display back to the
    // first party slot at battle end (e.g. right after a catch).
    return side.party.some((pokemon) => !isFainted(pokemon));
  }

  /**
   * True when any party member knows the Fly skill, matched through the
   * skills catalog by id (skill-FLY / essentialsId FLY) so display renames
   * (volar -> Vuelo) don't break the Volar field action. Move names that no
   * longer resolve in the catalog (parties saved under an old name) fall back
   * to the known historical names.
   */
  public async partyKnowsFly(party: PokemonSummary[]): Promise<boolean> {
    const catalogs = await this.loadCatalogs();
    const legacyFlyNames = new Set(["vuelo", "volar", "fly"]);

    return party.some((pokemon) =>
      (pokemon.moves ?? []).some((moveName) => {
        const normalized = String(moveName ?? "").trim().toLowerCase();
        if (!normalized) {
          return false;
        }

        const skill = catalogs.skillsByName.get(normalized);
        if (skill) {
          return skill.id === "skill-FLY" || skill.essentialsId.toUpperCase() === "FLY";
        }

        return legacyFlyNames.has(normalized);
      })
    );
  }

  private async loadCatalogs() {
    const [pokemonPayload, skillsPayload, itemsPayload, levelingCurvePayload, npcsPayload, typesPayload, encountersPayload] = await Promise.all([
      this.designerSectionStore.read("pokemons"),
      this.designerSectionStore.read("skills"),
      this.designerSectionStore.read("items"),
      this.designerSectionStore.read("levelingCurve"),
      this.designerSectionStore.read("npcs"),
      this.designerSectionStore.read("types"),
      this.designerSectionStore.read("encounters")
    ]);

    this.cachedEncounterProfiles = this.buildEncounterProfileCache(encountersPayload?.state.items ?? []);

    // Loaded once per process: the section is heavy (embedded images) but the
    // backdrop NAMES are all resolveBattleBackForPlayer needs, and new
    // backdrops are only added via re-import.
    if (!this.cachedBattleBackNames) {
      const battleBacksPayload = await this.designerSectionStore.read("battleBackgrounds");
      this.cachedBattleBackNames = new Set(
        (battleBacksPayload?.state.items ?? [])
          .map((item) => (typeof item.name === "string" ? item.name.trim().toLowerCase() : ""))
          .filter((name) => name.length > 0)
      );
    }

    this.typeChart = buildTypeChart(typesPayload?.state.items ?? []);
    const skillsById = new Map<string, SkillDefinition>();
    const skillsByName = new Map<string, SkillDefinition>();
    const pokemonById = new Map<string, PokemonDefinition>();

    (skillsPayload?.state.items ?? []).map(this.toSkillDefinition).forEach((skill) => {
      if (!skill) {
        return;
      }
      skillsById.set(skill.id, skill);
      skillsByName.set(skill.name.toLowerCase(), skill);
    });

    // Kept for mid-battle lookups: call moves (Metronome, Mirror Move...),
    // Nature Power's Tri Attack, Mimic copies.
    this.cachedSkillsById = skillsById;
    this.cachedSkillsByEssentialsId = new Map(
      [...skillsById.values()]
        .filter((skill) => skill.essentialsId)
        .map((skill) => [skill.essentialsId.toUpperCase(), skill] as const)
    );

    (pokemonPayload?.state.items ?? []).map(this.toPokemonDefinition).forEach((pokemon) => {
      if (pokemon) {
        pokemonById.set(pokemon.id, pokemon);
      }
    });

    this.cachedItemDefinitions = (itemsPayload?.state.items ?? [])
      .map(this.toItemDefinition)
      .filter((item): item is ItemDefinition => Boolean(item));
    if (
      !this.cachedItemDefinitions.some(
        (item) => item.essentialsId === RUNNING_SHOES_DEFINITION.essentialsId
      )
    ) {
      this.cachedItemDefinitions.push(RUNNING_SHOES_DEFINITION);
    }
    this.cachedNpcDefinitions = new Map(
      (npcsPayload?.state.items ?? [])
        .map(this.toNpcDefinition)
        .filter((item): item is NpcDefinition => Boolean(item))
        .map((item) => [item.id, item] as const)
    );

    return {
      pokemonById,
      skillsById,
      skillsByName,
      levelingCurveConfig: getLevelingCurveConfigFromItems(levelingCurvePayload?.state.items ?? [])
    };
  }

  private toPokemonDefinition(item: DesignerSectionItem): PokemonDefinition | null {
    const profile = item.pokemonProfile as {
      essentialsId?: unknown;
      hp?: unknown;
      attack?: unknown;
      defense?: unknown;
      specialAttack?: unknown;
      specialDefense?: unknown;
      speed?: unknown;
      elements?: unknown;
      skills?: unknown;
      growthRate?: unknown;
      baseExp?: unknown;
      catchRate?: unknown;
      evs?: unknown;
      evolutions?: unknown;
      frontImageSrc?: unknown;
      backImageSrc?: unknown;
    } | undefined;

    if (!profile) {
      return null;
    }

    const types = Array.isArray(profile.elements)
      ? profile.elements.filter((type): type is string => typeof type === "string").map(normalizeType)
      : [normalizeType(item.category)];
    const skills = Array.isArray(profile.skills)
      ? profile.skills
          .filter((skill): skill is { skillId: string; skillName: string; level: number } => {
            const candidate = skill as { skillId?: unknown; skillName?: unknown; level?: unknown };
            return typeof candidate.skillId === "string" &&
              typeof candidate.skillName === "string" &&
              typeof candidate.level === "number" &&
              Number.isFinite(candidate.level);
          })
          .map((skill) => ({
            skillId: skill.skillId,
            skillName: skill.skillName,
            level: Math.max(1, Math.round(skill.level))
          }))
      : [];

    const evYield: Partial<Record<BattleStatKey, number>> = {};
    if (Array.isArray(profile.evs)) {
      profile.evs.forEach((entry) => {
        const candidate = entry as { stat?: unknown; value?: unknown };
        if (typeof candidate.stat !== "string" || typeof candidate.value !== "number") {
          return;
        }
        const statKey = normalizeStatKey(candidate.stat);
        if (statKey && Number.isFinite(candidate.value) && candidate.value > 0) {
          evYield[statKey] = Math.round(candidate.value);
        }
      });
    }

    const evolutions: PokemonEvolutionDefinition[] = Array.isArray(profile.evolutions)
      ? profile.evolutions
          .map((entry) => {
            const candidate = entry as { targetId?: unknown; method?: unknown; parameter?: unknown };
            if (typeof candidate.targetId !== "string" || typeof candidate.method !== "string") {
              return null;
            }
            const parameter =
              typeof candidate.parameter === "number" || typeof candidate.parameter === "string"
                ? candidate.parameter
                : null;
            return { targetId: candidate.targetId, method: candidate.method, parameter };
          })
          .filter((entry): entry is PokemonEvolutionDefinition => Boolean(entry))
      : [];

    return {
      id: item.id,
      name: item.name,
      essentialsId: normalizeText(profile.essentialsId),
      types,
      baseStats: {
        hp: Math.max(1, parseNumber(profile.hp, 1)),
        attack: Math.max(1, parseNumber(profile.attack, 1)),
        defense: Math.max(1, parseNumber(profile.defense, 1)),
        specialAttack: Math.max(1, parseNumber(profile.specialAttack, 1)),
        specialDefense: Math.max(1, parseNumber(profile.specialDefense, 1)),
        speed: Math.max(1, parseNumber(profile.speed, 1))
      },
      growthRate: normalizeGrowthRate(profile.growthRate),
      baseExp: Math.max(0, parseNumber(profile.baseExp, 0)),
      catchRate: Math.max(0, parseNumber(profile.catchRate, 0)),
      evYield,
      evolutions,
      skills,
      frontImageSrc: normalizeText(profile.frontImageSrc),
      backImageSrc: normalizeText(profile.backImageSrc),
      femaleRatio: parseFemaleRatio((profile as { genderRatio?: unknown }).genderRatio),
      baseHappiness: parseNumber((profile as { happiness?: unknown }).happiness, 70),
      weightKg: parseFloatNumber((profile as { weight?: unknown }).weight, 50)
    };
  }

  private toSkillDefinition(item: DesignerSectionItem): SkillDefinition | null {
    const profile = item.pokemonSkillProfile as {
      elements?: unknown;
      power?: unknown;
      powerPoint?: unknown;
      accuracy?: unknown;
      category?: unknown;
      target?: unknown;
      functionCode?: unknown;
      flags?: unknown;
      priority?: unknown;
      effectChance?: unknown;
      description?: unknown;
      effectText?: unknown;
      skillGfxId?: unknown;
      skillGfxName?: unknown;
      animationId?: unknown;
      animationName?: unknown;
    } | undefined;

    if (!profile) {
      return null;
    }

    const type = Array.isArray(profile.elements) && typeof profile.elements[0] === "string"
      ? normalizeType(profile.elements[0])
      : normalizeType(item.category);

    return {
      id: item.id,
      name: item.name,
      essentialsId: normalizeText((profile as { essentialsId?: unknown }).essentialsId),
      type,
      power: Math.max(0, parseNumber(profile.power, 0)),
      powerPoint: Math.max(1, parseNumber(profile.powerPoint, 1)),
      accuracy: clamp(parseNumber(profile.accuracy, 100), 1, 100),
      category: normalizeText(
        typeof profile.category === "string" && profile.category.trim().length > 0
          ? profile.category
          : item.category
      ),
      target: normalizeText(typeof profile.target === "string" ? profile.target : ""),
      functionCode: normalizeText(
        typeof profile.functionCode === "string" ? profile.functionCode : ""
      ),
      flags: Array.isArray(profile.flags)
        ? profile.flags
            .filter((flag): flag is string => typeof flag === "string")
            .map((flag) => normalizeText(flag))
            .filter(Boolean)
        : [],
      priority: Math.round(parseNumber(profile.priority, 0)),
      effectChance: clamp(parseNumber(profile.effectChance, 0), 0, 100),
      description: typeof profile.description === "string" ? profile.description : "",
      effectText: typeof profile.effectText === "string" ? profile.effectText : "",
      skillGfxId: typeof profile.skillGfxId === "string" ? profile.skillGfxId : "",
      skillGfxName: typeof profile.skillGfxName === "string" ? profile.skillGfxName : "",
      animationId: typeof profile.animationId === "string" ? profile.animationId : "",
      animationName: typeof profile.animationName === "string" ? profile.animationName : ""
    };
  }

  private toItemDefinition(item: DesignerSectionItem): ItemDefinition | null {
    const profile = item.itemProfile as {
      essentialsId?: unknown;
      price?: unknown;
      type?: unknown;
      pocket?: unknown;
      description?: unknown;
      iconSrc?: unknown;
      furnitureObjectId?: unknown;
      skillId?: unknown;
      skillName?: unknown;
      effectKind?: unknown;
      useCondition?: unknown;
      pokeballBonusRatio?: unknown;
      statModifiers?: {
        hp?: unknown;
        attack?: unknown;
        defense?: unknown;
        specialAttack?: unknown;
        specialDefense?: unknown;
        speed?: unknown;
      };
    } | undefined;

    if (!profile || !profile.statModifiers) {
      return null;
    }

    const essentialsId = normalizeText(profile.essentialsId).toUpperCase();
    const effectKind = normalizeText(profile.effectKind);
    const useCondition = normalizeText(profile.useCondition);
    const pocket = normalizeText(profile.pocket).toLowerCase();
    const pokeballBonusRatio =
      typeof profile.pokeballBonusRatio === "number" && Number.isFinite(profile.pokeballBonusRatio)
        ? Math.max(0, profile.pokeballBonusRatio)
        : 0;
    const isPokeball =
      effectKind.toLowerCase() === "pokeball" ||
      pocket.includes("ball") ||
      /(?:^|[^A-Z])BALL$/.test(essentialsId) ||
      pokeballBonusRatio > 0;

    const statModifiers = {
      hp: parseNumber(profile.statModifiers.hp, 0),
      attack: parseNumber(profile.statModifiers.attack, 0),
      defense: parseNumber(profile.statModifiers.defense, 0),
      specialAttack: parseNumber(profile.statModifiers.specialAttack, 0),
      specialDefense: parseNumber(profile.statModifiers.specialDefense, 0),
      speed: parseNumber(profile.statModifiers.speed, 0)
    };

    const cures = STATUS_CURE_ITEMS[essentialsId] ?? null;

    return {
      id: item.id,
      name: item.name,
      essentialsId,
      price: Math.max(0, Math.round(parseNumber(profile.price, 0))),
      type: normalizeText(profile.type),
      category: toInventoryCategory(normalizeText(profile.type)),
      description: typeof profile.description === "string" ? profile.description : "",
      iconSrc: typeof profile.iconSrc === "string" ? profile.iconSrc : "",
      furnitureObjectId: normalizeText(profile.furnitureObjectId),
      skillId: typeof profile.skillId === "string" ? profile.skillId : "",
      skillName: typeof profile.skillName === "string" ? profile.skillName : "",
      moveInternal:
        typeof profile.skillName === "string" ? profile.skillName.trim().toUpperCase() : "",
      machineKind: /^HM\d/i.test(essentialsId)
        ? "mo"
        : /^TM\d/i.test(essentialsId)
          ? "mt"
          : null,
      effectKind,
      useCondition,
      isPokeball,
      pokeballBonusRatio,
      curesStatuses: cures ? cures.statuses : effectKind.toLowerCase() === "cure-status" ? "any" : null,
      curesConfusion: cures ? cures.confusion : effectKind.toLowerCase() === "cure-status",
      heldEffect: resolveHeldItemEffect({
        essentialsId,
        effectKind,
        useCondition,
        healAmount: statModifiers.hp
      }),
      heldBonus: resolveHeldBonus(essentialsId),
      statModifiers
    };
  }

  private toNpcDefinition(item: DesignerSectionItem): NpcDefinition | null {
    const profile = item.npcProfile as {
      npcType?: unknown;
      healPrice?: unknown;
      storeItems?: unknown;
      trainerTypeId?: unknown;
      trainerTypeName?: unknown;
      loseText?: unknown;
      trainerPokemons?: unknown;
    } | undefined;

    if (!profile) {
      return null;
    }

    const npcType = profile.npcType;

    if (
      npcType !== "healer" &&
      npcType !== "trainer" &&
      npcType !== "store" &&
      npcType !== "chest"
    ) {
      return null;
    }

    const storeItems = Array.isArray(profile.storeItems)
      ? profile.storeItems
          .filter(
            (storeItem): storeItem is {
              itemId: string;
              itemName: string;
              quantity: number;
              price: number;
            } => {
              const candidate = storeItem as {
                itemId?: unknown;
                itemName?: unknown;
                quantity?: unknown;
                price?: unknown;
              };

              return (
                typeof candidate.itemId === "string" &&
                typeof candidate.itemName === "string" &&
                typeof candidate.quantity === "number" &&
                Number.isFinite(candidate.quantity) &&
                typeof candidate.price === "number" &&
                Number.isFinite(candidate.price)
              );
            }
          )
          .map((storeItem) => ({
            itemId: storeItem.itemId,
            itemName: normalizeText(storeItem.itemName),
            quantity: Math.max(1, Math.round(storeItem.quantity)),
            price: Math.max(0, Math.round(storeItem.price)),
          }))
      : [];

    const trainerPokemons: NpcTrainerPokemonDefinition[] = Array.isArray(profile.trainerPokemons)
      ? profile.trainerPokemons
          .map((entry) => {
            const candidate = entry as {
              pokemonId?: unknown;
              pokemonName?: unknown;
              level?: unknown;
              moves?: unknown;
              itemId?: unknown;
            };
            if (typeof candidate.pokemonId !== "string" || candidate.pokemonId.length === 0) {
              return null;
            }
            return {
              pokemonId: candidate.pokemonId,
              pokemonName: normalizeText(candidate.pokemonName),
              level: clamp(parseNumber(candidate.level, 5), 1, 100),
              moves: Array.isArray(candidate.moves)
                ? candidate.moves.filter((move): move is string => typeof move === "string")
                : [],
              itemId: typeof candidate.itemId === "string" ? candidate.itemId : ""
            };
          })
          .filter((entry): entry is NpcTrainerPokemonDefinition => Boolean(entry))
      : [];

    return {
      id: item.id,
      name: item.name,
      npcType,
      healPrice: Math.max(0, parseNumber(profile.healPrice, 0)),
      storeItems,
      trainerTypeId: normalizeText(profile.trainerTypeId),
      trainerTypeName: normalizeText(profile.trainerTypeName),
      loseText: normalizeText(profile.loseText),
      trainerPokemons
    };
  }

  private buildPlayerSide(
    id: BattleSideId,
    player: Player,
    user: AuthenticatedUser,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): BattleSide {
    // Eggs can never battle. Hold them aside (with their party position) so the
    // battle logic never sees them, and re-merge them untouched when the party
    // is written back after the fight (see reinsertHeldEggs).
    const heldEggs: Array<{ index: number; summary: PokemonSummary }> = [];
    const battleReadyParty: PokemonSummary[] = [];
    user.pokemonParty.forEach((pokemon, index) => {
      if (pokemon.isEgg) {
        heldEggs.push({ index, summary: pokemon });
      } else {
        battleReadyParty.push(pokemon);
      }
    });

    const party = battleReadyParty.map((pokemon) => {
      const sourceDefinition =
        (pokemon.sourcePokemonId ? catalogs.pokemonById.get(pokemon.sourcePokemonId) : undefined) ??
        [...catalogs.pokemonById.values()].find((definition) => definition.name.toLowerCase() === pokemon.name.toLowerCase()) ??
        null;

      return this.buildBattlePokemonFromSummary(pokemon, sourceDefinition, catalogs.skillsById, catalogs.skillsByName);
    });

    return {
      id,
      isAi: false,
      playerId: player.socketId,
      userId: user.id,
      // Character name first: it's the in-world identity; the account handle
      // is a fallback for accounts whose character has no name yet.
      trainerName: user.name || user.username || "Trainer",
      money: user.money,
      inventory: user.inventory.map((item) => ({ ...item })),
      party,
      heldEggs,
      // Start with the first mon able to battle (a fainted lead can't open).
      activeIndex: Math.max(0, party.findIndex((pokemon) => !isFainted(pokemon))),
      action: null,
      escapeAttempts: 0
    };
  }

  /**
   * Re-inserts the eggs that were held out of battle back into a rebuilt party
   * summary list at (approximately) their original party positions, so writing
   * the post-battle party never drops the player's eggs.
   */
  private reinsertHeldEggs(side: BattleSide, partySummaries: PokemonSummary[]): PokemonSummary[] {
    if (!side.heldEggs?.length) {
      return partySummaries;
    }
    const merged = [...partySummaries];
    // Ascending index order keeps earlier eggs from shifting later ones.
    [...side.heldEggs]
      .sort((left, right) => left.index - right.index)
      .forEach(({ index, summary }) => {
        merged.splice(Math.min(index, merged.length), 0, summary);
      });
    return merged;
  }

  private buildBattlePokemonFromSummary(
    pokemon: PokemonSummary,
    definition: PokemonDefinition | null,
    skillsById: Map<string, SkillDefinition>,
    skillsByName: Map<string, SkillDefinition>
  ): BattlePokemon {
    const level = clamp(pokemon.level, 1, 100);
    const statBonuses = sanitizePokemonStatBonuses(pokemon.statBonuses);
    const ivs = sanitizeBattleStats(pokemon.ivs, 31);
    const evs = sanitizeBattleStats(pokemon.evs, MAX_EV_PER_STAT);
    // Venova form items (appearance slot) can override base stats and typing.
    const appearance = this.resolveAppearanceForSummary(pokemon);
    const baseStats = applyAppearanceToBaseStats(
      definition?.baseStats ?? {
        hp: pokemon.maxHp,
        attack: Math.max(1, pokemon.maxHp),
        defense: Math.max(1, pokemon.maxHp),
        specialAttack: Math.max(1, pokemon.maxHp),
        specialDefense: Math.max(1, pokemon.maxHp),
        speed: Math.max(1, pokemon.maxHp)
      },
      appearance
    );
    const stats = calculateStats(baseStats, level, statBonuses, ivs, evs);
    const learnedMoveNames = pokemon.moves.length > 0
      ? pokemon.moves
      : (definition?.skills ?? [])
          .filter((skill) => skill.level <= level)
          .slice(-4)
          .map((skill) => skill.skillName);
    const moves = learnedMoveNames
      .map((moveName) => {
        const skillFromPokemonDefinition = definition?.skills.find((skill) => skill.skillName === moveName);
        const skillDefinition =
          (skillFromPokemonDefinition ? skillsById.get(skillFromPokemonDefinition.skillId) : undefined) ??
          skillsByName.get(moveName.toLowerCase());

        return skillDefinition
          ? this.buildBattleMove(skillDefinition, pokemon.movePp?.[moveName])
          : null;
      })
      .filter((move): move is BattleMove => Boolean(move))
      .slice(0, 4);
    const growthRate = definition?.growthRate ?? null;

    return {
      id: pokemon.id,
      sourcePokemonId: pokemon.sourcePokemonId,
      name: pokemon.name,
      nickname: pokemon.nickname,
      level,
      types:
        appearance?.typesOverride && definition
          ? applyAppearanceToTypes(definition.types, appearance).map(normalizeType)
          : pokemon.types.length > 0
            ? pokemon.types.map(normalizeType)
            : definition?.types ?? [],
      hp: clamp(pokemon.hp, 0, stats.hp),
      maxHp: stats.hp,
      experience: Math.max(0, Math.round(pokemon.experience)),
      nextLevelExperience: Math.max(0, Math.round(pokemon.nextLevelExperience)),
      growthRate,
      baseExp: definition?.baseExp ?? 0,
      catchRate: definition?.catchRate ?? 0,
      evYield: definition?.evYield ?? {},
      baseStats,
      stats,
      statBonuses,
      ivs,
      evs,
      stages: createEmptyStages(),
      status: sanitizeStatusState(pokemon.status),
      volatile: createEmptyVolatile(),
      gender: deriveGender(pokemon.id, definition?.femaleRatio ?? 0.5),
      baseHappiness: definition?.baseHappiness ?? 70,
      weightKg: definition?.weightKg ?? 50,
      consumedItem: null,
      ateBerry: false,
      heldItemId: typeof pokemon.heldItemId === "string" ? pokemon.heldItemId : null,
      heldItemName: typeof pokemon.heldItemName === "string" ? pokemon.heldItemName : null,
      battleItemId: typeof pokemon.battleItemId === "string" ? pokemon.battleItemId : null,
      battleItemName: typeof pokemon.battleItemName === "string" ? pokemon.battleItemName : null,
      appearanceItemId: typeof pokemon.appearanceItemId === "string" ? pokemon.appearanceItemId : null,
      appearanceItemName:
        typeof pokemon.appearanceItemName === "string" ? pokemon.appearanceItemName : null,
      learnset: definition?.skills ?? [],
      evolutions: definition?.evolutions ?? [],
      moves,
      ...this.resolveBattleSprites(
        definition?.frontImageSrc ?? "",
        definition?.backImageSrc ?? "",
        pokemon.appearanceItemId,
        toSpeciesInternalId(pokemon.sourcePokemonId, pokemon.name)
      ),
      originalSummary: pokemon
    };
  }

  /** Battle sprites with the appearance-slot item (forms, shiny) baked in. */
  private resolveBattleSprites(
    frontImageSrc: string,
    backImageSrc: string,
    appearanceItemId: string | null | undefined,
    speciesInternalId: string
  ): { frontImageSrc: string; backImageSrc: string } {
    const appearanceDefinition = appearanceItemId
      ? this.getCachedItemDefinition(appearanceItemId, "")
      : null;
    const appearance = resolveAppearanceEffect(
      appearanceDefinition?.essentialsId ?? this.internalIdFromItemId(appearanceItemId),
      speciesInternalId
    );
    if (!appearance) {
      return { frontImageSrc, backImageSrc };
    }
    return {
      frontImageSrc: applyAppearanceToSpritePath(frontImageSrc, appearance, "front"),
      backImageSrc: applyAppearanceToSpritePath(backImageSrc, appearance, "back")
    };
  }

  /** Item ids follow "item-<essentialsid>"; recover the internal id. */
  private internalIdFromItemId(itemId?: string | null) {
    return (itemId ?? "").replace(/^item-/i, "").trim().toUpperCase();
  }

  /**
   * Applies a Venova form change after the appearance slot mutated: typing
   * and maxHp are rebuilt from the catalog base data plus the current
   * effect's overrides, and a granted move (Canamate's HACKEO) is learned or
   * forgotten. `previousEffect` is the effect of the item that just left the
   * slot. Mirrors the MultipleForms onSetForm behavior of the original game.
   */
  private async applyAppearanceFormChange(
    targetPokemon: PokemonSummary,
    previousEffect: AppearanceEffect | null
  ) {
    const catalogs = await this.loadCatalogs();
    const definition = this.resolveSummaryDefinition(targetPokemon, catalogs);
    const nextEffect = this.resolveAppearanceForSummary(targetPokemon);

    if (definition) {
      targetPokemon.types = applyAppearanceToTypes(definition.types, nextEffect).map(normalizeType);
      this.recomputeSummaryMaxHp(targetPokemon, {
        ...definition,
        baseStats: applyAppearanceToBaseStats(definition.baseStats, nextEffect)
      });
    }

    const previousMoveId = previousEffect?.grantsMoveId ?? null;
    const nextMoveId = nextEffect?.grantsMoveId ?? null;
    if (previousMoveId && previousMoveId !== nextMoveId) {
      this.removeGrantedMove(targetPokemon, previousMoveId, definition, catalogs);
    }
    if (nextMoveId && nextMoveId !== previousMoveId) {
      this.grantAppearanceMove(targetPokemon, nextMoveId, catalogs);
    }
  }

  private resolveSkillByInternalId(
    internalId: string,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): SkillDefinition | null {
    const normalized = internalId.trim().toUpperCase();
    return (
      catalogs.skillsById.get(`skill-${normalized}`) ??
      catalogs.skillsById.get(`skill-${normalized.toLowerCase()}`) ??
      catalogs.skillsByName.get(normalized.toLowerCase()) ??
      null
    );
  }

  /** Teach the form move: directly with a free slot, else as a pending learn
   * the player resolves from the Moves tab (replace prompt). */
  private grantAppearanceMove(
    targetPokemon: PokemonSummary,
    moveInternalId: string,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ) {
    const skill = this.resolveSkillByInternalId(moveInternalId, catalogs);
    if (!skill) {
      return;
    }
    const sameMove = (name: string) => name.toLowerCase() === skill.name.toLowerCase();
    if (targetPokemon.moves.some(sameMove)) {
      return;
    }
    if (targetPokemon.moves.length < 4) {
      targetPokemon.moves = [...targetPokemon.moves, skill.name];
      targetPokemon.movePp = { ...(targetPokemon.movePp ?? {}), [skill.name]: skill.powerPoint };
      return;
    }
    const pending = targetPokemon.pendingMoveLearns ?? [];
    if (!pending.some(sameMove)) {
      targetPokemon.pendingMoveLearns = [...pending, skill.name];
    }
  }

  /** Forget the form move on unequip; a venomon never ends up move-less —
   * the original script falls back to a basic move (Canamate: Impactrueno). */
  private removeGrantedMove(
    targetPokemon: PokemonSummary,
    moveInternalId: string,
    definition: PokemonDefinition | null,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ) {
    const skill = this.resolveSkillByInternalId(moveInternalId, catalogs);
    if (!skill) {
      return;
    }
    const sameMove = (name: string) => name.toLowerCase() === skill.name.toLowerCase();
    targetPokemon.moves = targetPokemon.moves.filter((name) => !sameMove(name));
    const movePp = { ...(targetPokemon.movePp ?? {}) };
    delete movePp[skill.name];
    targetPokemon.movePp = movePp;
    targetPokemon.pendingMoveLearns = (targetPokemon.pendingMoveLearns ?? []).filter(
      (name) => !sameMove(name)
    );

    if (targetPokemon.moves.length === 0) {
      const fallbackEntry = (definition?.skills ?? [])
        .filter((entry) => entry.level <= targetPokemon.level)
        .sort((a, b) => a.level - b.level)[0];
      const fallbackSkill = fallbackEntry
        ? catalogs.skillsById.get(fallbackEntry.skillId) ??
          catalogs.skillsByName.get(fallbackEntry.skillName.toLowerCase()) ??
          null
        : this.resolveSkillByInternalId("THUNDERSHOCK", catalogs);
      if (fallbackSkill) {
        targetPokemon.moves = [fallbackSkill.name];
        targetPokemon.movePp = {
          ...(targetPokemon.movePp ?? {}),
          [fallbackSkill.name]: fallbackSkill.powerPoint
        };
      }
    }
  }

  /** The appearance effect of the item in a holder's appearance slot. */
  private resolveAppearanceForSummary(pokemon: {
    appearanceItemId?: string | null;
    sourcePokemonId?: string;
    name: string;
  }): AppearanceEffect | null {
    if (!pokemon.appearanceItemId) {
      return null;
    }
    const definition = this.getCachedItemDefinition(pokemon.appearanceItemId, "");
    return resolveAppearanceEffect(
      definition?.essentialsId ?? this.internalIdFromItemId(pokemon.appearanceItemId),
      toSpeciesInternalId(pokemon.sourcePokemonId, pokemon.name)
    );
  }

  private buildWildPokemon(
    definition: PokemonDefinition,
    level: number,
    skillsById: Map<string, SkillDefinition>
  ): BattlePokemon {
    const statBonuses = createEmptyPokemonStatBonuses();
    const ivs = rollIvs();
    const evs = createEmptyBattleStats();
    const stats = calculateStats(definition.baseStats, level, statBonuses, ivs, evs);
    const moves = definition.skills
      .filter((skill) => skill.level <= level)
      .slice(-4)
      .map((skill) => {
        const skillDefinition = skillsById.get(skill.skillId);
        return skillDefinition ? this.buildBattleMove(skillDefinition) : null;
      })
      .filter((move): move is BattleMove => Boolean(move));

    return {
      id: `wild:${crypto.randomUUID()}`,
      sourcePokemonId: definition.id,
      name: definition.name,
      level,
      types: definition.types,
      hp: stats.hp,
      maxHp: stats.hp,
      experience: 0,
      nextLevelExperience: 0,
      growthRate: definition.growthRate,
      baseExp: definition.baseExp,
      catchRate: definition.catchRate,
      evYield: definition.evYield,
      baseStats: definition.baseStats,
      stats,
      statBonuses,
      ivs,
      evs,
      stages: createEmptyStages(),
      status: null,
      volatile: createEmptyVolatile(),
      gender: deriveGender(`wild:${definition.id}:${Math.floor(Math.random() * 100000)}`, definition.femaleRatio),
      baseHappiness: definition.baseHappiness,
      weightKg: definition.weightKg,
      consumedItem: null,
      ateBerry: false,
      heldItemId: null,
      heldItemName: null,
      battleItemId: null,
      battleItemName: null,
      appearanceItemId: null,
      appearanceItemName: null,
      learnset: definition.skills,
      evolutions: definition.evolutions,
      moves,
      frontImageSrc: definition.frontImageSrc,
      backImageSrc: definition.backImageSrc
    };
  }

  private buildBattleMove(skill: SkillDefinition, currentPp?: number): BattleMove {
    return {
      id: skill.id,
      name: skill.name,
      type: skill.type,
      power: skill.power,
      accuracy: skill.accuracy,
      category: skill.category,
      target: skill.target,
      functionCode: skill.functionCode,
      flags: skill.flags,
      priority: skill.priority,
      description: skill.description,
      effectText: skill.effectText,
      skillGfxId: skill.skillGfxId,
      skillGfxName: skill.skillGfxName,
      animationId: skill.animationId,
      animationName: skill.animationName,
      maxPp: skill.powerPoint,
      currentPp:
        typeof currentPp === "number" && Number.isFinite(currentPp)
          ? clamp(Math.round(currentPp), 0, skill.powerPoint)
          : skill.powerPoint,
      damageClass: skill.power <= 0 || skill.category.toLowerCase() === "status"
        ? "status"
        : skill.category.toLowerCase() === "special"
          ? "special"
          : "physical",
      effectChance: skill.effectChance
    };
  }

  private toPokemonPartySummaries(side: BattleSide): PokemonSummary[] {
    return side.party
      .filter((pokemon) => pokemon.originalSummary)
      .map((pokemon) => {
        const originalSummary = pokemon.originalSummary!;
        const moves = originalSummary.moves.length > 0
          ? originalSummary.moves
          : pokemon.moves.map((move) => move.name);

        return {
          ...originalSummary,
          hp: pokemon.hp,
          maxHp: pokemon.maxHp,
          statBonuses: pokemon.statBonuses,
          ivs: { ...pokemon.ivs },
          evs: { ...pokemon.evs },
          status: pokemon.status ? { ...pokemon.status } : undefined,
          heldItemId: pokemon.heldItemId ?? undefined,
          heldItemName: pokemon.heldItemName ?? undefined,
          battleItemId: pokemon.battleItemId ?? undefined,
          battleItemName: pokemon.battleItemName ?? undefined,
          appearanceItemId: pokemon.appearanceItemId ?? undefined,
          appearanceItemName: pokemon.appearanceItemName ?? undefined,
          moves,
          movePp: moves.reduce<Record<string, number>>((accumulator, moveName) => {
            const battleMove = pokemon.moves.find((move) => move.name === moveName);
            const originalPp = originalSummary.movePp?.[moveName];

            if (battleMove) {
              accumulator[moveName] = battleMove.currentPp;
            } else if (typeof originalPp === "number" && Number.isFinite(originalPp)) {
              accumulator[moveName] = Math.max(0, Math.round(originalPp));
            }

            return accumulator;
          }, {})
        };
      });
  }

  private emitBattleState(battle: BattleSession) {
    battle.sides.forEach((side) => {
      if (side.isAi) {
        return;
      }

      this.emitToSide(side, "battle:state", this.toPublicState(battle, side));
    });
  }

  private appendBattleLog(battle: BattleSession, message: string) {
    battle.log = [...battle.log, message];
  }

  private createBattleSummary(
    battle: BattleSession,
    result: string,
    winner: BattleSide | null,
    loser: BattleSide | null
  ): BattlePublicSummary {
    return {
      battleId: battle.id,
      kind: battle.kind,
      winnerName: winner?.trainerName ?? null,
      loserName: loser?.trainerName ?? null,
      result,
      startedAt: battle.startedAt,
      endedAt: battle.endedAt,
      log: battle.log.slice(-100)
    };
  }

  private toPublicState(battle: BattleSession, self: BattleSide): BattlePublicState {
    const opponent = this.getOpponentSide(battle, self);
    const canAct = battle.status === "active" && !self.isAi && !self.action && !isFainted(getActivePokemon(self));
    const selectedActionType = self.action?.type ?? null;

    return {
      id: battle.id,
      kind: battle.kind,
      status: battle.status,
      turn: battle.turn,
      self: this.toPublicSide(self),
      opponent: this.toPublicSide(opponent),
      availableItems: self.inventory
        .filter((item) => {
          if (item.quantity <= 0) {
            return false;
          }
          if (["usable", "berries"].includes(item.category)) {
            return true;
          }
          return Boolean(this.getCachedItemDefinition(item.id, item.name)?.isPokeball);
        })
        .map((item) => {
          const definition = this.getCachedItemDefinition(item.id, item.name);
          const canUse = definition
            ? definition.isPokeball
              ? battle.kind === "wild"
              : true
            : false;

          return {
            id: item.id,
            name: item.name,
            category: item.category,
            quantity: item.quantity,
            description: item.description,
            canUse
          };
        }),
      canAct,
      waitingForOpponent: battle.status === "active" && Boolean(self.action) && battle.sides.some((side) => !side.isAi && !side.action),
      mustSelectReplacement: battle.status === "active" && battle.replacementRequest?.sideId === self.id,
      selectedActionType,
      turnEndsAt: battle.turnEndsAt ? new Date(battle.turnEndsAt).toISOString() : null,
      log: battle.log,
      result: battle.result,
      summary: battle.summary,
      battleBack: battle.battleBack
    };
  }

  private toPublicSide(side: BattleSide): BattlePublicSide {
    return {
      id: side.id,
      trainerName: side.trainerName,
      isPlayer: !side.isAi,
      money: side.money,
      activePokemon: getPublicPokemon(getActivePokemon(side)),
      party: side.party.map(getPublicPokemon)
    };
  }

  private emitAuthSession(side: BattleSide, user: AuthenticatedUser) {
    this.emitToSide(side, "auth:session", {
      authenticated: true,
      user
    });
  }

  private emitToSide<EventName extends keyof ServerToClientEvents>(
    side: BattleSide,
    eventName: EventName,
    payload: Parameters<ServerToClientEvents[EventName]>[0]
  ) {
    if (!side.playerId) {
      return;
    }

    const player = this.world.players.get(side.playerId);
    if (!player) {
      return;
    }

    this.emitToPlayer(player, eventName, payload);
  }

  private emitToPlayer<EventName extends keyof ServerToClientEvents>(
    player: Player,
    eventName: EventName,
    payload: Parameters<ServerToClientEvents[EventName]>[0]
  ) {
    player.socketConnections.forEach((socketId) => {
      this.emitToSocket(socketId, eventName, payload);
    });
  }

  private emitToSocket<EventName extends keyof ServerToClientEvents>(
    socketId: string,
    eventName: EventName,
    payload: Parameters<ServerToClientEvents[EventName]>[0]
  ) {
    (this.io.in(socketId) as any).emit(eventName, payload);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
