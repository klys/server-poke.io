import crypto from "crypto";
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
import { resolveHeldItemEffect, type HeldItemEffect } from "./battle/heldItems";
import {
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

type BattleVolatileState = {
  confusionTurns: number;
  flinched: boolean;
  protected: boolean;
};

type BattlePokemon = {
  id: string;
  sourcePokemonId?: string;
  name: string;
  nickname?: string;
  level: number;
  types: string[];
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
  heldItemId: string | null;
  heldItemName: string | null;
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
};

type SkillDefinition = {
  id: string;
  name: string;
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
  statModifiers: {
    hp: number;
    attack: number;
    defense: number;
    specialAttack: number;
    specialDefense: number;
    speed: number;
  };
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

function createEmptyVolatile(): BattleVolatileState {
  return { confusionTurns: 0, flinched: false, protected: false };
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
  /** Remaining Repel steps per player (in-grass encounters skipped while >0). */
  private readonly repelStepsByPlayerId = new Map<string, number>();
  private readonly challenges = new Map<string, ChallengeRequest>();
  private readonly tradeRequests = new Map<string, TradeRequest>();
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
      if (!player) {
        return { ok: false, message: "Enter the world before using Repel." };
      }
      this.repelStepsByPlayerId.set(player.socketId, effect.steps);
      return {
        ok: true,
        user: await this.consumeItem(userId, user, item),
        message: `${item.name} will keep weak Venomon away for ${effect.steps} steps.`
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
    const currentMap = mapsState.items.find((item) => item.id === player.currentMapId);
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
    await this.startWildBattle(player, grass);
    return { ok: true, message: `The ${item.name} found a rustling patch of grass!` };
  }

  /**
   * Rock Smash body script (pbRockSmashRandomEncounter): after a rock is broken,
   * roll a chance to trigger a wild encounter drawn from the map's table.
   */
  public async tryRockSmashEncounter(userId: number, player: Player): Promise<void> {
    const user = await this.auth.getUserForBattle(userId);
    if (!user || !this.partyCanBattle(user)) {
      return;
    }
    if (Math.random() > 0.25) {
      return; // ~25% like Essentials rock-smash encounters
    }
    const snapshot = this.world.getPlayableMapsState();
    const editorData = snapshot?.editorDataByMapId[player.currentMapId];
    const table = this.getMapEncounterTable(editorData);
    if (!table || (table.pokemonIds.length === 0 && !table.encounterRows?.length)) {
      return;
    }
    await this.startWildBattle(player, table);
  }

  /** The map's shared grass encounter table (fishing fallback pool). */
  private getMapEncounterTable(
    editorData:
      | { grass: Array<{ pokemonIds: string[]; minLevel: number; maxLevel: number; encounterRows?: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }> }> }
      | undefined
  ) {
    const carrier = (editorData?.grass ?? []).find(
      (cell) => (cell.encounterRows?.length ?? 0) > 0 || cell.pokemonIds.length > 0
    );
    if (!carrier) {
      return null;
    }
    return {
      pokemonIds: carrier.pokemonIds,
      minLevel: carrier.minLevel,
      maxLevel: carrier.maxLevel,
      encounterRows: carrier.encounterRows
    };
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
   * placement when one is in front (rod-tier gated), otherwise falls back to
   * the map's grass encounter table when facing a blocked/water tile.
   */
  private async useFishingRod(
    player: Player,
    user: AuthenticatedUser,
    tier: FishingRodTier,
    item: InventoryItem
  ): Promise<UseInventoryItemResult> {
    if (!this.partyCanBattle(user)) {
      return { ok: false, message: "Your Venomon are in no condition to battle." };
    }

    const snapshot = this.world.getPlayableMapsState();
    const map = snapshot?.items.find((candidate) => candidate.id === player.currentMapId);
    const editorData = snapshot?.editorDataByMapId[player.currentMapId];
    const cellSize = map?.playableMapConfig?.cellSize ?? 32;
    const facing = player.getFacingCell(cellSize);
    const rodOrder: Record<FishingRodTier, number> = { old: 0, good: 1, super: 2 };

    const spot = (editorData?.fishingSpots ?? []).find(
      (candidate) => candidate.x === facing.x && candidate.y === facing.y
    );
    if (spot) {
      if (spot.rod && rodOrder[tier] < rodOrder[spot.rod]) {
        return { ok: false, message: `The ${item.name} isn't strong enough to fish here.` };
      }
      return this.castFishing(
        player,
        { pokemonIds: spot.pokemonIds, minLevel: spot.minLevel, maxLevel: spot.maxLevel, encounterRows: spot.encounterRows },
        tier,
        item
      );
    }

    // No fishing spot: allow casting only when facing a blocked tile (water /
    // map edge), drawing from the map's grass table as a fallback pool.
    if (!this.isCellBlockedForPlayer(player, facing, cellSize)) {
      return { ok: false, message: "You can't fish here. Face the water first." };
    }
    const table = this.getMapEncounterTable(editorData);
    if (!table) {
      return { ok: true, message: "Not even a nibble..." };
    }
    return this.castFishing(player, table, tier, item);
  }

  private async castFishing(
    player: Player,
    table: { pokemonIds: string[]; minLevel: number; maxLevel: number; encounterRows?: Array<{ weight: number; pokemonId: string; minLevel: number; maxLevel: number }> },
    tier: FishingRodTier,
    item: InventoryItem
  ): Promise<UseInventoryItemResult> {
    const biteChance = tier === "super" ? 0.9 : tier === "good" ? 0.7 : 0.5;
    if (Math.random() > biteChance) {
      return { ok: true, message: "Not even a nibble..." };
    }
    const levelCap: Record<FishingRodTier, number> = { old: 15, good: 30, super: 60 };
    const gated = {
      pokemonIds: table.pokemonIds,
      minLevel: table.minLevel,
      maxLevel: Math.max(table.minLevel, Math.min(table.maxLevel, levelCap[tier])),
      encounterRows: table.encounterRows
    };
    await this.startWildBattle(player, gated);
    return { ok: true, message: `Oh! A bite! Something's on the ${item.name}!` };
  }

  /**
   * Dowsing Machine / Itemfinder: pings the nearest hidden ground item on the
   * map, revealing it once you're on top of it.
   */
  private useDowsing(player: Player, item: InventoryItem): UseInventoryItemResult {
    const snapshot = this.world.getPlayableMapsState();
    const map = snapshot?.items.find((candidate) => candidate.id === player.currentMapId);
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
    return user.pokemonParty.some((pokemon) =>
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

  public async setHeldItem(userId: number, pokemonId: string, itemId: string) {
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

    let inventory = this.removeInventoryQuantity(user.inventory, item.id, 1);
    if (targetPokemon.heldItemId) {
      const previousDefinition = this.getCachedItemDefinition(
        targetPokemon.heldItemId,
        targetPokemon.heldItemName ?? ""
      );
      if (previousDefinition) {
        inventory = this.addInventoryQuantity(inventory, previousDefinition, 1);
      }
    }

    targetPokemon.heldItemId = itemDefinition.id;
    targetPokemon.heldItemName = itemDefinition.name;
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

  public async depositPokemonToBox(userId: number, pokemonId: string, boxId?: string) {
    const player = this.world.getPlayerByUserId(userId);
    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false as const, message: "You can't use the storage system during a battle." };
    }

    return this.auth.depositPokemonToStorage(userId, pokemonId, boxId);
  }

  public async withdrawPokemonFromBox(userId: number, pokemonId: string, boxId: string) {
    const player = this.world.getPlayerByUserId(userId);
    if (player && this.isPlayerBattling(player.socketId)) {
      return { ok: false as const, message: "You can't use the storage system during a battle." };
    }

    return this.auth.withdrawPokemonFromStorage(userId, pokemonId, boxId);
  }

  public async takeHeldItem(userId: number, pokemonId: string) {
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

    if (!targetPokemon.heldItemId) {
      return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} is not holding anything.` };
    }

    const itemDefinition = this.getCachedItemDefinition(
      targetPokemon.heldItemId,
      targetPokemon.heldItemName ?? ""
    );
    const itemName = targetPokemon.heldItemName ?? itemDefinition?.name ?? "its item";
    const inventory = itemDefinition
      ? this.addInventoryQuantity(user.inventory, itemDefinition, 1)
      : user.inventory;

    targetPokemon.heldItemId = undefined;
    targetPokemon.heldItemName = undefined;
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
    const storeItem = storeStock?.find((candidate) => candidate.itemId === itemId);
    const inventoryItem = user?.inventory.find((candidate) => candidate.id === itemId);

    if (!user || !storeStock) {
      return { ok: false, message: "That store is unavailable right now." };
    }

    if (!storeItem) {
      return { ok: false, message: "This store only buys items it keeps in stock." };
    }

    if (!inventoryItem || inventoryItem.quantity < sellCount) {
      return { ok: false, message: "You do not have that many items to sell." };
    }

    const sellPricePerUnit = this.getNpcStoreSellPrice(storeItem);

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
  public async grantEventItem(
    userId: number,
    ref: { symbol?: string; legacyNumber?: number },
    quantity = 1
  ): Promise<{ ok: false } | { ok: true; itemName: string }> {
    await this.loadCatalogs();

    const symbol =
      ref.symbol ??
      (typeof ref.legacyNumber === "number"
        ? LEGACY_ITEM_INTERNAL_BY_NUMBER[ref.legacyNumber]
        : undefined);
    const lowered = symbol?.trim().toLowerCase();
    if (!lowered) {
      return { ok: false };
    }

    const definition = this.cachedItemDefinitions.find(
      (candidate) =>
        candidate.essentialsId.toLowerCase() === lowered ||
        candidate.id === `item-${lowered}`
    );
    const user = await this.auth.getUserForBattle(userId);
    if (!definition || !user) {
      return { ok: false };
    }

    const inventory = this.addInventoryQuantity(user.inventory, definition, quantity);
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

    const grass = this.getGrassCellForPlayer(player);
    if (!grass) {
      this.lastGrassCellByPlayerId.delete(player.socketId);
      return;
    }

    const grassKey = `${player.currentMapId}:${grass.x}:${grass.y}`;
    if (this.lastGrassCellByPlayerId.get(player.socketId) === grassKey) {
      return;
    }

    this.lastGrassCellByPlayerId.set(player.socketId, grassKey);

    // Repel: each new grass tile spends one step; encounters are suppressed
    // until the charge runs out.
    const repelSteps = this.repelStepsByPlayerId.get(player.socketId) ?? 0;
    if (repelSteps > 0) {
      const remaining = repelSteps - 1;
      if (remaining > 0) {
        this.repelStepsByPlayerId.set(player.socketId, remaining);
      } else {
        this.repelStepsByPlayerId.delete(player.socketId);
        this.emitToPlayer(player, "auth:info", { message: "The repellent wore off." });
      }
      return;
    }

    if (Math.random() * 100 >= grass.encounterRate) {
      return;
    }

    if (this.pendingStepChecks.has(player.socketId)) {
      return;
    }

    this.pendingStepChecks.add(player.socketId);
    void this.startWildBattle(player, grass)
      .catch((error) => {
        console.error("Unable to start wild battle:", error);
        this.emitToPlayer(player, "battle:error", { message: "Unable to start a wild battle." });
      })
      .finally(() => {
        this.pendingStepChecks.delete(player.socketId);
      });
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
    const map = snapshot?.items.find((item) => item.id === player.currentMapId);
    const editorData = snapshot?.editorDataByMapId[player.currentMapId];
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
    }
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
      this.resolveBattleBackForPlayer(player, true)
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
      this.resolveBattleBackForPlayer(player, true)
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
        pokemon.heldItemId = itemDefinition.id;
        pokemon.heldItemName = itemDefinition.name;
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
   * (imported from PBS metadata.txt into playableMapConfig.battleBack).
   * Wild battles that started in tall grass upgrade the plain Field backdrop
   * to its grass variant, mirroring Essentials' terrain-based bases.
   */
  private resolveBattleBackForPlayer(player: Player | null | undefined, fromGrass = false): string | null {
    if (!player) {
      return null;
    }

    const snapshot = this.world.getPlayableMapsState();
    const map = snapshot?.items.find((item) => item.id === player.currentMapId);
    const config = map?.playableMapConfig as { battleBack?: unknown } | undefined;
    let name =
      typeof config?.battleBack === "string" && config.battleBack.trim().length > 0
        ? config.battleBack.trim()
        : null;

    if (fromGrass && (!name || name.toLowerCase() === "field")) {
      name = "FieldGrass";
    }

    return name;
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

      const escaped = this.tryEscape(runSide, this.getOpponentSide(battle, runSide));
      this.pushEvent(
        battle,
        { kind: "escape", success: escaped },
        escaped ? "You got away safely." : "You could not escape."
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
        const switched = this.switchPokemon(side, side.action.pokemonId);
        if (switched) {
          const sentOut = getActivePokemon(side);
          this.pushEvent(
            battle,
            { kind: "switch", sideId: side.id, pokemon: getPublicPokemon(sentOut) },
            `${side.trainerName} sent out ${getPokemonDisplayName(sentOut)}.`
          );
          this.recordParticipation(battle);
          await this.emitBattleStep(battle);
        }
      }
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

        const leftSpeed = this.getModifiedStat(getActivePokemon(left), "speed");
        const rightSpeed = this.getModifiedStat(getActivePokemon(right), "speed");
        return rightSpeed - leftSpeed || (Math.random() > 0.5 ? 1 : -1);
      });

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
    }

    return battle.status !== "active";
  }

  private async applyEndOfTurn(battle: BattleSession): Promise<boolean> {
    if (battle.status !== "active") {
      return true;
    }

    let pushedAnyEvent = false;

    for (const side of battle.sides) {
      const pokemon = getActivePokemon(side);
      if (!pokemon || isFainted(pokemon)) {
        continue;
      }

      const displayName = getPokemonDisplayName(pokemon);
      const residual = applyStatusEndOfTurn(pokemon.status, pokemon.maxHp, displayName);
      if (residual.damage > 0) {
        pokemon.hp = Math.max(0, pokemon.hp - residual.damage);
        this.pushEvent(
          battle,
          {
            kind: "damage",
            sideId: side.id,
            pokemonId: pokemon.id,
            amount: residual.damage,
            hpAfter: pokemon.hp,
            maxHp: pokemon.maxHp,
            effectiveness: 1,
            critical: false,
            source: "status"
          },
          residual.message
        );
        pushedAnyEvent = true;
      }

      if (!isFainted(pokemon) && this.applyHeldItemTriggers(battle, side, pokemon)) {
        pushedAnyEvent = true;
      }

      pokemon.volatile.flinched = false;
      pokemon.volatile.protected = false;
    }

    if (pushedAnyEvent) {
      await this.emitBattleStep(battle);
    }

    return this.handleFaintChecks(battle);
  }

  /** Returns true when at least one event was pushed. */
  private applyHeldItemTriggers(battle: BattleSession, side: BattleSide, pokemon: BattlePokemon): boolean {
    if (!pokemon.heldItemId) {
      return false;
    }

    const definition = this.getCachedItemDefinition(pokemon.heldItemId, pokemon.heldItemName ?? "");
    const effect = definition?.heldEffect;
    if (!definition || !effect) {
      return false;
    }

    const displayName = getPokemonDisplayName(pokemon);
    let used = false;

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
      this.consumeHeldItem(pokemon);
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
        this.consumeHeldItem(pokemon);
        used = true;
      }
    }

    return used;
  }

  private consumeHeldItem(pokemon: BattlePokemon) {
    pokemon.heldItemId = null;
    pokemon.heldItemName = null;
    if (pokemon.originalSummary) {
      pokemon.originalSummary.heldItemId = undefined;
      pokemon.originalSummary.heldItemName = undefined;
    }
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

      const gained =
        faintedPokemon.baseExp > 0
          ? computeFoeExperience({
              baseExp: faintedPokemon.baseExp,
              foeLevel: faintedPokemon.level,
              isTrainerBattle: battle.kind === "trainer",
              participantCount: participants.length
            })
          : computeBattleExperience(catalogs.levelingCurveConfig, participant.level, faintedPokemon.level);

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

    if (battle.kind === "trainer" && winner?.userId && loser?.userId) {
      const transferAmount = Math.max(0, Math.min(PVP_SURRENDER_REWARD, loser.money));
      loser.money -= transferAmount;
      winner.money += transferAmount;
      battle.log = [
        ...battle.log,
        `${winner.trainerName} received $${transferAmount}.`
      ];
    } else if (battle.kind === "trainer" && winner?.userId && loser?.isAi && loser.money > 0) {
      const prize = loser.money;
      loser.money = 0;
      winner.money += prize;
      this.pushEvent(
        battle,
        { kind: "message", text: `${winner.trainerName} got $${prize} for winning!` },
        `${winner.trainerName} got $${prize} for winning!`
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
    const moves = getUsableMoves(activePokemon);

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
      // Party full: the catch still succeeds and goes straight to PC storage.
      const { boxName } = await this.auth.addPokemonToStorage(side.userId, caughtSummary);
      const storedMessage = `${getPokemonDisplayName(wildPokemon)} was sent to storage (${boxName}).`;
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
  private eventMartResolver:
    | ((userId: number, placementId: string) => NpcStoreDefinition[] | null)
    | null = null;
  private cachedNpcDefinitions = new Map<string, NpcDefinition>();

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

    const mapEditorData = playableMapsState.editorDataByMapId[player.currentMapId];
    const placement =
      mapEditorData?.npcs.find((candidate) => candidate.id === npcPlacementId) ?? null;

    if (!placement) {
      return { ok: false, message: "That NPC is not on your current map." };
    }

    const mapDefinition =
      playableMapsState.items.find((candidate) => candidate.id === player.currentMapId) ?? null;
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

  private switchPokemon(side: BattleSide, pokemonId: string) {
    const targetIndex = side.party.findIndex((pokemon) => pokemon.id === pokemonId);
    if (targetIndex < 0 || targetIndex === side.activeIndex || isFainted(side.party[targetIndex])) {
      return false;
    }

    side.activeIndex = targetIndex;
    return true;
  }

  private async executeMoveAction(
    battle: BattleSession,
    side: BattleSide,
    target: BattleSide,
    moveId: string
  ) {
    const attacker = getActivePokemon(side);
    const defender = getActivePokemon(target);
    const move = attacker.moves.find((candidate) => candidate.id === moveId);
    const attackerName = getPokemonDisplayName(attacker);
    const defenderName = getPokemonDisplayName(defender);

    if (!move || move.currentPp <= 0) {
      this.say(battle, `${attackerName} had no skill to use.`);
      await this.emitBattleStep(battle);
      return;
    }

    if (attacker.volatile.flinched) {
      this.pushEvent(
        battle,
        { kind: "flinch", sideId: side.id, pokemonId: attacker.id },
        `${attackerName} flinched and couldn't move!`
      );
      await this.emitBattleStep(battle);
      return;
    }

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
      await this.emitBattleStep(battle);
      return;
    }

    if (attacker.volatile.confusionTurns > 0) {
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

    move.currentPp -= 1;
    const spec = parseMoveEffect(resolveFunctionCode(move.functionCode ?? ""));
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

    if (spec.protectUser) {
      attacker.volatile.protected = true;
      this.say(battle, `${attackerName} protected itself!`);
      await this.emitBattleStep(battle);
      return;
    }

    const isDamaging = move.damageClass !== "status" && (move.power > 0 || spec.fixedDamage !== null || spec.ohko);
    const affectsTarget =
      isDamaging ||
      spec.statChanges.some((change) => change.target === "target") ||
      (spec.status !== null && spec.status.target === "target") ||
      spec.confuseTarget ||
      spec.resetTargetStats;

    if (affectsTarget && defender.volatile.protected) {
      this.say(battle, `${defenderName} protected itself!`);
      await this.emitBattleStep(battle);
      return;
    }

    if (affectsTarget && !this.rollAccuracy(attacker, defender, move, spec)) {
      this.pushEvent(
        battle,
        { kind: "move-missed", sideId: side.id, pokemonId: attacker.id, moveName: move.name },
        `${attackerName}'s attack missed!`
      );
      await this.emitBattleStep(battle);
      return;
    }

    let totalDamage = 0;
    if (isDamaging) {
      const effectiveness = this.getEffectiveness(move.type, defender.types);
      if (effectiveness === 0) {
        this.say(battle, `It doesn't affect ${defenderName}...`);
        await this.emitBattleStep(battle);
        return;
      }

      const result = this.applyDamagePhase(battle, side, target, attacker, defender, move, spec, effectiveness);
      totalDamage = result.totalDamage;

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

      if (spec.drainFraction > 0 && totalDamage > 0 && attacker.hp > 0 && attacker.hp < attacker.maxHp) {
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
    }

    const isPureStatusMove = !isDamaging;
    const secondaryChance = isPureStatusMove ? 100 : move.effectChance > 0 ? move.effectChance : 100;
    const applySecondary =
      (isPureStatusMove || totalDamage > 0) && Math.random() * 100 < secondaryChance;

    if (applySecondary) {
      this.applyMoveEffects(battle, side, target, attacker, defender, spec, isPureStatusMove);
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
    effectiveness: number
  ) {
    let hits = 1;
    if (spec.multiHit) {
      hits = rollMultiHitCount(spec.multiHit);
    }

    let totalDamage = 0;
    let landedHits = 0;
    let anyCritical = false;

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
        damage =
          spec.fixedDamage.kind === "amount"
            ? spec.fixedDamage.amount
            : spec.fixedDamage.kind === "user-level"
              ? attacker.level
              : Math.max(1, Math.floor(defender.hp / 2));
      } else {
        critical = this.rollCritical(move, spec);
        damage = this.calculateDamage(attacker, defender, move, effectiveness, critical);
      }

      damage = Math.max(1, Math.floor(damage));
      defender.hp = Math.max(0, defender.hp - damage);
      totalDamage += damage;
      landedHits += 1;
      anyCritical = anyCritical || critical;

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
    }

    return { totalDamage, hits: landedHits, anyCritical };
  }

  private applyMoveEffects(
    battle: BattleSession,
    side: BattleSide,
    target: BattleSide,
    attacker: BattlePokemon,
    defender: BattlePokemon,
    spec: MoveEffectSpec,
    isPureStatusMove: boolean
  ) {
    const viaSecondary = !isPureStatusMove;

    spec.statChanges.forEach((change) => {
      const receiverSide = change.target === "user" ? side : target;
      const receiver = change.target === "user" ? attacker : defender;
      if (!isFainted(receiver) || change.target === "user") {
        this.applyStatStageChange(battle, receiverSide, receiver, change.stat, change.delta, viaSecondary);
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
      if (!isFainted(receiver)) {
        this.applyStatusCondition(battle, receiverSide, receiver, statusId, viaSecondary);
      }
    }

    if (spec.confuseTarget && !isFainted(defender)) {
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

    if (spec.flinchTarget && !isFainted(defender)) {
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
  }

  private applyStatStageChange(
    battle: BattleSession,
    side: BattleSide,
    pokemon: BattlePokemon,
    stat: BattleStageKey,
    delta: number,
    viaSecondary: boolean
  ) {
    const current = pokemon.stages[stat];
    const next = clamp(current + delta, -6, 6);
    const actual = next - current;
    const displayName = getPokemonDisplayName(pokemon);
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
  }

  private applyStatusCondition(
    battle: BattleSession,
    side: BattleSide,
    pokemon: BattlePokemon,
    statusId: BattleStatusId,
    viaSecondary: boolean
  ) {
    const displayName = getPokemonDisplayName(pokemon);

    if (pokemon.status) {
      if (!viaSecondary) {
        this.say(battle, `${displayName} is already ${STATUS_DISPLAY_NAMES[pokemon.status.id]}!`);
      }
      return;
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

    const stageDelta = clamp(attacker.stages.accuracy - defender.stages.evasion, -6, 6);
    const chance = move.accuracy * getAccuracyStageMultiplier(stageDelta);
    return Math.random() * 100 < chance;
  }

  private rollCritical(move: BattleMove, spec: MoveEffectSpec): boolean {
    if (spec.alwaysCrit) {
      return true;
    }

    const flags = (move.flags ?? []).map((flag) => flag.toLowerCase());
    const highCritRate = flags.includes("h") || flags.includes("highcriticalhitrate");
    return Math.random() < (highCritRate ? 1 / 8 : 1 / 16);
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
    attacker: BattlePokemon,
    defender: BattlePokemon,
    move: BattleMove,
    effectiveness: number,
    critical: boolean
  ) {
    const attackStat =
      move.damageClass === "physical"
        ? this.getModifiedStat(attacker, "attack")
        : this.getModifiedStat(attacker, "specialAttack");
    const defenseStat =
      move.damageClass === "physical"
        ? this.getModifiedStat(defender, "defense")
        : this.getModifiedStat(defender, "specialDefense");
    const baseDamage = Math.floor(
      Math.floor((Math.floor((2 * attacker.level) / 5 + 2) * move.power * attackStat) / Math.max(1, defenseStat)) / 50
    ) + 2;
    const stab = attacker.types.some((type) => isSameType(this.typeChart, type, move.type)) ? 1.5 : 1;
    const criticalMultiplier = critical ? 1.5 : 1;
    const randomFactor = 0.85 + Math.random() * 0.15;
    const modifier = stab * effectiveness * criticalMultiplier * randomFactor;

    if (effectiveness === 0) {
      return 0;
    }

    return Math.max(1, Math.floor(baseDamage * modifier));
  }

  private getModifiedStat(pokemon: BattlePokemon, stat: Exclude<BattleStageKey, "accuracy" | "evasion">) {
    const stageValue = Math.floor(pokemon.stats[stat] * getStageMultiplier(pokemon.stages[stat]));
    const statusMultiplier =
      stat === "attack" || stat === "speed" ? getStatusStatMultiplier(pokemon.status, stat) : 1;
    return Math.max(1, Math.floor(stageValue * statusMultiplier));
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

    if (chosenId && this.switchPokemon(side, chosenId)) {
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

  private async loadCatalogs() {
    const [pokemonPayload, skillsPayload, itemsPayload, levelingCurvePayload, npcsPayload, typesPayload] = await Promise.all([
      this.designerSectionStore.read("pokemons"),
      this.designerSectionStore.read("skills"),
      this.designerSectionStore.read("items"),
      this.designerSectionStore.read("levelingCurve"),
      this.designerSectionStore.read("npcs"),
      this.designerSectionStore.read("types")
    ]);

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

    (pokemonPayload?.state.items ?? []).map(this.toPokemonDefinition).forEach((pokemon) => {
      if (pokemon) {
        pokemonById.set(pokemon.id, pokemon);
      }
    });

    this.cachedItemDefinitions = (itemsPayload?.state.items ?? [])
      .map(this.toItemDefinition)
      .filter((item): item is ItemDefinition => Boolean(item));
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
      backImageSrc: normalizeText(profile.backImageSrc)
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
      trainerName: user.username || user.name || "Trainer",
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
    const baseStats = definition?.baseStats ?? {
      hp: pokemon.maxHp,
      attack: Math.max(1, pokemon.maxHp),
      defense: Math.max(1, pokemon.maxHp),
      specialAttack: Math.max(1, pokemon.maxHp),
      specialDefense: Math.max(1, pokemon.maxHp),
      speed: Math.max(1, pokemon.maxHp)
    };
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
      types: pokemon.types.length > 0 ? pokemon.types.map(normalizeType) : definition?.types ?? [],
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
      heldItemId: typeof pokemon.heldItemId === "string" ? pokemon.heldItemId : null,
      heldItemName: typeof pokemon.heldItemName === "string" ? pokemon.heldItemName : null,
      learnset: definition?.skills ?? [],
      evolutions: definition?.evolutions ?? [],
      moves,
      frontImageSrc: definition?.frontImageSrc ?? "",
      backImageSrc: definition?.backImageSrc ?? "",
      originalSummary: pokemon
    };
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
      heldItemId: null,
      heldItemName: null,
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
