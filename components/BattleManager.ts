import crypto from "crypto";
import type { Server } from "socket.io";
import type { AuthenticatedUser, InventoryItem, PokemonSummary } from "./Auth";
import Auth from "./Auth";
import type DesignerSectionStore from "./DesignerSectionStore";
import type { DesignerSectionItem } from "./DesignerSectionStore";
import type { GroundItem } from "./GroundItemStore";
import {
  computeBattleExperience,
  createEmptyPokemonStatBonuses,
  getExperienceForNextLevel,
  getLevelingCurveConfigFromItems,
  sanitizePokemonStatBonuses,
  type LevelingCurveConfig,
  type PokemonStatBonuses
} from "./LevelingCurve";
import type Player from "./player";
import type World from "./world";
import type ClientToServerEvents from "../Server/ClientToServerEvents";
import type InterServerEvents from "../Server/InterServerEvents";
import type { SocketData } from "../Server/registerSocketHandlers";
import type ServerToClientEvents from "../Server/ServerToClientEvents";

const PLAYER_ACTION_TIMEOUT_MS = 60_000;
const BATTLE_ACTION_STEP_DELAY_MS = 5_000;
const PVP_SURRENDER_REWARD = 300;
const DEFAULT_IV = 0;
const DEFAULT_EV = 0;
const NEUTRAL_NATURE = 1;

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
  selectedActionType: BattleActionType | null;
  turnEndsAt: string | null;
  log: string[];
  result: string | null;
  summary: BattlePublicSummary | null;
};

type BattleStats = {
  hp: number;
  attack: number;
  defense: number;
  specialAttack: number;
  specialDefense: number;
  speed: number;
};

type BattleStatStages = Omit<BattleStats, "hp">;

type BattleMove = BattlePublicMove & {
  damageClass: BattleDamageClass;
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
  baseStats: BattleStats;
  stats: BattleStats;
  statBonuses: PokemonStatBonuses;
  stages: BattleStatStages;
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
  result: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: BattlePublicSummary | null;
};

type PokemonDefinition = {
  id: string;
  name: string;
  types: string[];
  baseStats: BattleStats;
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
};

type ItemDefinition = {
  id: string;
  name: string;
  type: string;
  category: InventoryItem["category"];
  description: string;
  iconSrc: string;
  skillId: string;
  skillName: string;
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

type NpcDefinition = {
  id: string;
  name: string;
  npcType: "healer" | "trainer" | "store" | "chest";
  healPrice: number;
  storeItems: NpcStoreDefinition[];
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

const TYPE_EFFECTIVENESS: Record<string, Record<string, number>> = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass: { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug: { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy: { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 }
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

function calculateHpStat(base: number, level: number) {
  return Math.max(
    1,
    Math.floor(((2 * base + DEFAULT_IV + Math.floor(DEFAULT_EV / 4)) * level) / 100) + level + 10
  );
}

function calculateOtherStat(base: number, level: number) {
  return Math.max(
    1,
    Math.floor(
      (Math.floor(((2 * base + DEFAULT_IV + Math.floor(DEFAULT_EV / 4)) * level) / 100) + 5) *
      NEUTRAL_NATURE
    )
  );
}

function calculateStats(
  baseStats: BattleStats,
  level: number,
  bonuses: PokemonStatBonuses = createEmptyPokemonStatBonuses()
): BattleStats {
  return {
    hp: calculateHpStat(baseStats.hp, level) + bonuses.hp,
    attack: calculateOtherStat(baseStats.attack, level) + bonuses.attack,
    defense: calculateOtherStat(baseStats.defense, level) + bonuses.defense,
    specialAttack: calculateOtherStat(baseStats.specialAttack, level) + bonuses.specialAttack,
    specialDefense: calculateOtherStat(baseStats.specialDefense, level) + bonuses.specialDefense,
    speed: calculateOtherStat(baseStats.speed, level) + bonuses.speed
  };
}

function createEmptyStages(): BattleStatStages {
  return {
    attack: 0,
    defense: 0,
    specialAttack: 0,
    specialDefense: 0,
    speed: 0
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

function getRandomStatIncrease() {
  return Math.floor(Math.random() * 6);
}

function getMoveEffectiveness(moveType: string, targetTypes: string[]) {
  return targetTypes.reduce((multiplier, targetType) => {
    const normalizedTargetType = normalizeType(targetType);
    return multiplier * (TYPE_EFFECTIVENESS[normalizeType(moveType)]?.[normalizedTargetType] ?? 1);
  }, 1);
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
    frontImageSrc: pokemon.frontImageSrc,
    backImageSrc: pokemon.backImageSrc,
    moves: pokemon.moves.map((move) => ({
      id: move.id,
      name: move.name,
      type: move.type,
      power: move.power,
      accuracy: move.accuracy,
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

export default class BattleManager {
  private readonly io: TypedSocketServer;
  private readonly world: World;
  private readonly auth: Auth;
  private readonly designerSectionStore: DesignerSectionStore;
  private readonly battles = new Map<string, BattleSession>();
  private readonly playerBattleIds = new Map<string, string>();
  private readonly lastGrassCellByPlayerId = new Map<string, string>();
  private readonly pendingStepChecks = new Set<string>();
  private readonly challenges = new Map<string, ChallengeRequest>();
  private readonly tradeRequests = new Map<string, TradeRequest>();

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

  public async useInventoryItem(
    userId: number,
    itemId: string,
    targetPokemonId?: string
  ) {
    const user = await this.auth.getUserForBattle(userId);
    await this.loadCatalogs();
    const item = user?.inventory.find((candidate) => candidate.id === itemId);
    const itemDefinition = this.getCachedItemDefinition(itemId, item?.name ?? "");

    if (!user || !item || !itemDefinition || item.quantity <= 0) {
      return { ok: false, message: "That item is no longer available." };
    }

    if (!["usable", "berries"].includes(item.category)) {
      return { ok: false, message: "That item cannot be used from the bag." };
    }

    const targetPokemon = user.pokemonParty.find((pokemon) => pokemon.id === targetPokemonId);

    if (!targetPokemon) {
      return { ok: false, message: "Choose a Pokemon for this item." };
    }

    if (itemDefinition.statModifiers.hp > 0 && targetPokemon.hp >= targetPokemon.maxHp) {
      return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} already has full HP.` };
    }

    const beforeHp = targetPokemon.hp;
    targetPokemon.hp = Math.min(
      targetPokemon.maxHp,
      Math.max(0, targetPokemon.hp + itemDefinition.statModifiers.hp)
    );
    const nextInventory = this.removeInventoryQuantity(user.inventory, item.id, 1);
    const nextUser = await this.auth.saveBattleState(userId, {
      pokemonParty: user.pokemonParty,
      inventory: nextInventory
    });

    return {
      ok: true,
      user: nextUser,
      message:
        itemDefinition.statModifiers.hp > 0
          ? `${getPokemonDisplayName(targetPokemon)} recovered ${targetPokemon.hp - beforeHp} HP.`
          : `${item.name} was used on ${getPokemonDisplayName(targetPokemon)}.`
    };
  }

  public async teachInventoryMove(
    userId: number,
    itemId: string,
    targetPokemonId?: string
  ) {
    const user = await this.auth.getUserForBattle(userId);
    await this.loadCatalogs();
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

    if (targetPokemon.moves.includes(itemDefinition.skillName)) {
      return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} already knows ${itemDefinition.skillName}.` };
    }

    if (targetPokemon.moves.length >= 4) {
      return { ok: false, message: `${getPokemonDisplayName(targetPokemon)} already knows four moves.` };
    }

    targetPokemon.moves = [...targetPokemon.moves, itemDefinition.skillName];
    const nextInventory = this.removeInventoryQuantity(user.inventory, item.id, 1);
    const nextUser = await this.auth.saveBattleState(userId, {
      pokemonParty: user.pokemonParty,
      inventory: nextInventory
    });

    return {
      ok: true,
      user: nextUser,
      message: `${getPokemonDisplayName(targetPokemon)} learned ${itemDefinition.skillName}.`
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
    const npc = this.cachedNpcDefinitions.get(interaction.placement.npcId);
    const purchaseCount =
      typeof quantity === "number" && Number.isFinite(quantity)
        ? Math.max(1, Math.round(quantity))
        : 1;
    const storeItem = npc?.storeItems.find((candidate) => candidate.itemId === itemId);
    const itemDefinition = storeItem
      ? this.getCachedItemDefinition(storeItem.itemId, storeItem.itemName)
      : null;

    if (!user || !npc || npc.npcType !== "store") {
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
    const npc = this.cachedNpcDefinitions.get(interaction.placement.npcId);
    const sellCount =
      typeof quantity === "number" && Number.isFinite(quantity)
        ? Math.max(1, Math.round(quantity))
        : 1;
    const storeItem = npc?.storeItems.find((candidate) => candidate.itemId === itemId);
    const inventoryItem = user?.inventory.find((candidate) => candidate.id === itemId);

    if (!user || !npc || npc.npcType !== "store") {
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
    if (!side || side.action) {
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

    if (battle.kind === "wild") {
      this.getOpponentSide(battle, side).action = this.chooseAiAction(this.getOpponentSide(battle, side), side);
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

    return editorData.grass.find((grass) => grass.x === cellX && grass.y === cellY) ?? null;
  }

  private async startWildBattle(
    player: Player,
    grass: { pokemonIds: string[]; minLevel: number; maxLevel: number }
  ) {
    if (player.userId === null || grass.pokemonIds.length === 0) {
      return;
    }

    const user = await this.auth.getUserForBattle(player.userId);
    if (!user) {
      return;
    }

    const catalogs = await this.loadCatalogs();
    const playerSide = this.buildPlayerSide("a", player, user, catalogs);
    const sourcePokemonId = chooseRandom(grass.pokemonIds);
    const pokemonDefinition = catalogs.pokemonById.get(sourcePokemonId);

    if (!pokemonDefinition || !this.hasAvailablePokemon(playerSide)) {
      return;
    }

    const level = clamp(
      grass.minLevel + Math.floor(Math.random() * (Math.max(grass.minLevel, grass.maxLevel) - grass.minLevel + 1)),
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

    const battle = this.createBattle("wild", playerSide, wildSide, [
      `A wild ${getPokemonDisplayName(wildPokemon)} appeared.`
    ]);

    this.activateBattle(battle);
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

    const battle = this.createBattle("trainer", firstSide, secondSide, [
      `${firstSide.trainerName} and ${secondSide.trainerName} started a battle.`
    ]);

    this.activateBattle(battle);
  }

  private createBattle(
    kind: BattleKind,
    firstSide: BattleSide,
    secondSide: BattleSide,
    log: string[]
  ): BattleSession {
    return {
      id: crypto.randomUUID(),
      kind,
      status: "active",
      sides: [firstSide, secondSide],
      turn: 1,
      turnEndsAt: null,
      timer: null,
      log,
      result: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      summary: null
    };
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
      const escapeLog = escaped ? "You got away safely." : "You could not escape.";
      await this.emitBattleStep(battle, escapeLog, !escaped);
      if (escaped) {
        await this.finishBattle(battle, escapeLog, null, null);
        return;
      }
    }

    for (const side of battle.sides) {
      if (side.action?.type === "bag") {
        await this.emitBattleStep(battle, this.applyItemAction(side, side.action));
      }
    }

    for (const side of battle.sides) {
      if (side.action?.type === "pokemon") {
        const switched = this.switchPokemon(side, side.action.pokemonId);
        if (switched) {
          await this.emitBattleStep(battle, `${side.trainerName} sent out ${getPokemonDisplayName(getActivePokemon(side))}.`);
        }
      }
    }

    const attackOrder = [firstSide, secondSide]
      .filter((side) => side.action?.type === "fight" && !isFainted(getActivePokemon(side)))
      .sort((left, right) => {
        const leftSpeed = this.getModifiedStat(getActivePokemon(left), "speed");
        const rightSpeed = this.getModifiedStat(getActivePokemon(right), "speed");
        return rightSpeed - leftSpeed || (Math.random() > 0.5 ? 1 : -1);
      });

    for (const side of attackOrder) {
      const target = this.getOpponentSide(battle, side);
      const attackerPokemon = getActivePokemon(side);
      const targetPokemon = getActivePokemon(target);

      if (isFainted(attackerPokemon) || isFainted(targetPokemon) || side.action?.type !== "fight") {
        continue;
      }

      await this.emitBattleStep(battle, this.applyMoveAction(side, target, side.action.moveId));

      if (isFainted(targetPokemon)) {
        await this.emitBattleStep(battle, `${getPokemonDisplayName(targetPokemon)} fainted.`);
        if (!this.autoSwitchIfPossible(target)) {
          await this.finishBattle(
            battle,
            `${side.trainerName} won the battle.`,
            side,
            target
          );
          return;
        }
        await this.emitBattleStep(battle, `${target.trainerName} sent out ${getPokemonDisplayName(getActivePokemon(target))}.`);
      }
    }

    battle.turn += 1;
    this.startChoiceTurn(battle);
  }

  private async emitBattleStep(battle: BattleSession, message: string, shouldPause = true) {
    if (battle.status !== "active") {
      return;
    }

    this.appendBattleLog(battle, message);
    this.emitBattleState(battle);

    if (shouldPause) {
      await delay(BATTLE_ACTION_STEP_DELAY_MS);
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
    summary.nextLevelExperience = getExperienceForNextLevel(summary.level, config);

    if (summary.level >= 100) {
      summary.experience = 0;
      summary.nextLevelExperience = 0;
    }

    pokemon.level = summary.level;
    pokemon.statBonuses = summary.statBonuses;
  }

  private formatStatBonusLog(statBonuses: PokemonStatBonuses) {
    const labels: Array<[keyof PokemonStatBonuses, string]> = [
      ["hp", "HP"],
      ["attack", "Attack"],
      ["defense", "Defense"],
      ["specialAttack", "Sp. Attack"],
      ["specialDefense", "Sp. Defense"],
      ["speed", "Speed"]
    ];

    return labels
      .map(([key, label]) => `${label} +${statBonuses[key]}`)
      .join(", ");
  }

  private awardWinnerExperience(
    winner: BattleSide,
    loser: BattleSide,
    config: LevelingCurveConfig
  ) {
    const winnerPokemon = getActivePokemon(winner);
    const loserPokemon = getActivePokemon(loser);

    this.syncPokemonProgression(winnerPokemon, config);

    const summary = winnerPokemon.originalSummary;
    if (!summary || summary.level >= 100) {
      return [];
    }

    const gainedExperience = computeBattleExperience(config, summary.level, loserPokemon.level);
    if (gainedExperience <= 0) {
      return [`${getPokemonDisplayName(winnerPokemon)} gained no EXP.`];
    }

    const nextLevelRequirement = summary.nextLevelExperience;
    const currentExperience = Math.max(0, Math.round(summary.experience));
    const nextExperience = currentExperience + gainedExperience;
    const log = [`${getPokemonDisplayName(winnerPokemon)} gained ${gainedExperience} EXP.`];

    if (nextLevelRequirement > 0 && nextExperience >= nextLevelRequirement) {
      const statIncrease: PokemonStatBonuses = {
        hp: getRandomStatIncrease(),
        attack: getRandomStatIncrease(),
        defense: getRandomStatIncrease(),
        specialAttack: getRandomStatIncrease(),
        specialDefense: getRandomStatIncrease(),
        speed: getRandomStatIncrease()
      };
      const nextLevel = Math.min(100, summary.level + 1);
      const nextBonuses: PokemonStatBonuses = {
        hp: winnerPokemon.statBonuses.hp + statIncrease.hp,
        attack: winnerPokemon.statBonuses.attack + statIncrease.attack,
        defense: winnerPokemon.statBonuses.defense + statIncrease.defense,
        specialAttack: winnerPokemon.statBonuses.specialAttack + statIncrease.specialAttack,
        specialDefense: winnerPokemon.statBonuses.specialDefense + statIncrease.specialDefense,
        speed: winnerPokemon.statBonuses.speed + statIncrease.speed
      };
      const nextStats = calculateStats(winnerPokemon.baseStats, nextLevel, nextBonuses);

      summary.level = nextLevel;
      summary.experience = 0;
      summary.statBonuses = nextBonuses;
      summary.nextLevelExperience = getExperienceForNextLevel(nextLevel, config);
      if (nextLevel >= 100) {
        summary.nextLevelExperience = 0;
      }
      summary.maxHp = nextStats.hp;
      summary.hp = nextStats.hp;
      summary.movePp = winnerPokemon.moves.reduce<Record<string, number>>((accumulator, move) => {
        accumulator[move.name] = move.maxPp;
        return accumulator;
      }, {});

      winnerPokemon.level = nextLevel;
      winnerPokemon.statBonuses = nextBonuses;
      winnerPokemon.stats = nextStats;
      winnerPokemon.maxHp = nextStats.hp;
      winnerPokemon.hp = nextStats.hp;
      winnerPokemon.moves = winnerPokemon.moves.map((move) => ({
        ...move,
        currentPp: move.maxPp
      }));

      log.push(`${getPokemonDisplayName(winnerPokemon)} grew to level ${nextLevel}.`);
      log.push(this.formatStatBonusLog(statIncrease));
      log.push(`${getPokemonDisplayName(winnerPokemon)} was fully healed and recovered all PP.`);
      return log;
    }

    summary.experience = nextExperience;
    return log;
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

    if (battle.kind === "trainer" && winner?.userId && loser?.userId) {
      const transferAmount = Math.max(0, Math.min(PVP_SURRENDER_REWARD, loser.money));
      loser.money -= transferAmount;
      winner.money += transferAmount;
      battle.log = [
        ...battle.log,
        `${winner.trainerName} received $${transferAmount}.`
      ];
    }

    const catalogs = await this.loadCatalogs();
    battle.sides.forEach((side) => {
      side.party.forEach((pokemon) => this.syncPokemonProgression(pokemon, catalogs.levelingCurveConfig));
    });
    if (winner && loser) {
      battle.log = [
        ...battle.log,
        ...this.awardWinnerExperience(winner, loser, catalogs.levelingCurveConfig)
      ];
    }

    battle.summary = this.createBattleSummary(battle, result, winner, loser);

    await Promise.all(
      battle.sides
        .filter((side) => typeof side.userId === "number")
        .map(async (side) => {
          await this.auth.saveBattleState(side.userId!, {
            pokemonParty: this.toPokemonPartySummaries(side),
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
      if (!item || item.quantity <= 0 || !["usable", "berries"].includes(item.category)) {
        return "That item cannot be used in battle.";
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
    const bestMove = [...moves].sort((left, right) => {
      const leftScore = left.power * getMoveEffectiveness(left.type, targetPokemon.types) * (activePokemon.types.includes(left.type) ? 1.5 : 1);
      const rightScore = right.power * getMoveEffectiveness(right.type, targetPokemon.types) * (activePokemon.types.includes(right.type) ? 1.5 : 1);
      return rightScore - leftScore;
    })[0];

    return {
      type: "fight",
      moveId: bestMove.id
    };
  }

  private applyItemAction(side: BattleSide, action: Extract<BattleQueuedAction, { type: "bag" }>) {
    const item = side.inventory.find((candidate) => candidate.id === action.itemId);
    const itemDefinition = this.getCachedItemDefinition(item?.id ?? "", item?.name ?? "");
    const targetPokemon =
      side.party.find((pokemon) => pokemon.id === action.targetPokemonId) ??
      getActivePokemon(side);

    if (!item || !itemDefinition || item.quantity <= 0) {
      return `${side.trainerName} could not use that item.`;
    }

    item.quantity -= 1;
    const modifiers = itemDefinition.statModifiers;
    const beforeHp = targetPokemon.hp;
    targetPokemon.hp = clamp(targetPokemon.hp + modifiers.hp, 0, targetPokemon.maxHp);
    targetPokemon.stages.attack = clamp(targetPokemon.stages.attack + modifiers.attack, -6, 6);
    targetPokemon.stages.defense = clamp(targetPokemon.stages.defense + modifiers.defense, -6, 6);
    targetPokemon.stages.specialAttack = clamp(targetPokemon.stages.specialAttack + modifiers.specialAttack, -6, 6);
    targetPokemon.stages.specialDefense = clamp(targetPokemon.stages.specialDefense + modifiers.specialDefense, -6, 6);
    targetPokemon.stages.speed = clamp(targetPokemon.stages.speed + modifiers.speed, -6, 6);

    if (targetPokemon.hp > beforeHp) {
      return `${side.trainerName} used ${item.name}. ${getPokemonDisplayName(targetPokemon)} recovered ${targetPokemon.hp - beforeHp} HP.`;
    }

    return `${side.trainerName} used ${item.name}.`;
  }

  private cachedItemDefinitions: ItemDefinition[] = [];
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

  private applyMoveAction(side: BattleSide, target: BattleSide, moveId: string) {
    const attackerPokemon = getActivePokemon(side);
    const targetPokemon = getActivePokemon(target);
    const move = attackerPokemon.moves.find((candidate) => candidate.id === moveId);

    if (!move || move.currentPp <= 0) {
      return `${getPokemonDisplayName(attackerPokemon)} had no skill to use.`;
    }

    move.currentPp -= 1;

    if (move.accuracy < 100 && Math.random() * 100 > move.accuracy) {
      return `${getPokemonDisplayName(attackerPokemon)} used ${move.name}, but it missed.`;
    }

    if (move.damageClass === "status" || move.power <= 0) {
      return `${getPokemonDisplayName(attackerPokemon)} used ${move.name}.`;
    }

    const damage = this.calculateDamage(attackerPokemon, targetPokemon, move);
    targetPokemon.hp = Math.max(0, targetPokemon.hp - damage);
    const effectiveness = getMoveEffectiveness(move.type, targetPokemon.types);
    const effectivenessText =
      effectiveness === 0
        ? " It had no effect."
        : effectiveness > 1
          ? " It was super effective."
          : effectiveness < 1
            ? " It was not very effective."
            : "";

    return `${getPokemonDisplayName(attackerPokemon)} used ${move.name} for ${damage} damage.${effectivenessText}`;
  }

  private calculateDamage(attacker: BattlePokemon, defender: BattlePokemon, move: BattleMove) {
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
    const stab = attacker.types.map(normalizeType).includes(normalizeType(move.type)) ? 1.5 : 1;
    const effectiveness = getMoveEffectiveness(move.type, defender.types);
    const critical = Math.random() < 1 / 24 ? 1.5 : 1;
    const randomFactor = 0.85 + Math.random() * 0.15;
    const modifier = stab * effectiveness * critical * randomFactor;

    if (effectiveness === 0) {
      return 0;
    }

    return Math.max(1, Math.floor(baseDamage * modifier));
  }

  private getModifiedStat(pokemon: BattlePokemon, stat: keyof BattleStatStages) {
    return Math.max(1, Math.floor(pokemon.stats[stat] * getStageMultiplier(pokemon.stages[stat])));
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

  private getBattleSideForPlayer(battle: BattleSession, playerId: string) {
    return battle.sides.find((side) => side.playerId === playerId) ?? null;
  }

  private getOpponentSide(battle: BattleSession, side: BattleSide) {
    return battle.sides.find((candidate) => candidate.id !== side.id)!;
  }

  private hasAvailablePokemon(side: BattleSide) {
    const activeIndex = side.party.findIndex((pokemon) => !isFainted(pokemon));
    if (activeIndex < 0) {
      return false;
    }

    side.activeIndex = activeIndex;
    return true;
  }

  private async loadCatalogs() {
    const [pokemonPayload, skillsPayload, itemsPayload, levelingCurvePayload, npcsPayload] = await Promise.all([
      this.designerSectionStore.read("pokemons"),
      this.designerSectionStore.read("skills"),
      this.designerSectionStore.read("items"),
      this.designerSectionStore.read("levelingCurve"),
      this.designerSectionStore.read("npcs")
    ]);
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
      hp?: unknown;
      attack?: unknown;
      defense?: unknown;
      specialAttack?: unknown;
      specialDefense?: unknown;
      speed?: unknown;
      elements?: unknown;
      skills?: unknown;
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

    return {
      id: item.id,
      name: item.name,
      types,
      baseStats: {
        hp: Math.max(1, parseNumber(profile.hp, 1)),
        attack: Math.max(1, parseNumber(profile.attack, 1)),
        defense: Math.max(1, parseNumber(profile.defense, 1)),
        specialAttack: Math.max(1, parseNumber(profile.specialAttack, 1)),
        specialDefense: Math.max(1, parseNumber(profile.specialDefense, 1)),
        speed: Math.max(1, parseNumber(profile.speed, 1))
      },
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
      category: item.category
    };
  }

  private toItemDefinition(item: DesignerSectionItem): ItemDefinition | null {
    const profile = item.itemProfile as {
      type?: unknown;
      description?: unknown;
      iconSrc?: unknown;
      skillId?: unknown;
      skillName?: unknown;
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

    return {
      id: item.id,
      name: item.name,
      type: normalizeText(profile.type),
      category: toInventoryCategory(normalizeText(profile.type)),
      description: typeof profile.description === "string" ? profile.description : "",
      iconSrc: typeof profile.iconSrc === "string" ? profile.iconSrc : "",
      skillId: typeof profile.skillId === "string" ? profile.skillId : "",
      skillName: typeof profile.skillName === "string" ? profile.skillName : "",
      statModifiers: {
        hp: parseNumber(profile.statModifiers.hp, 0),
        attack: parseNumber(profile.statModifiers.attack, 0),
        defense: parseNumber(profile.statModifiers.defense, 0),
        specialAttack: parseNumber(profile.statModifiers.specialAttack, 0),
        specialDefense: parseNumber(profile.statModifiers.specialDefense, 0),
        speed: parseNumber(profile.statModifiers.speed, 0)
      }
    };
  }

  private toNpcDefinition(item: DesignerSectionItem): NpcDefinition | null {
    const profile = item.npcProfile as {
      npcType?: unknown;
      healPrice?: unknown;
      storeItems?: unknown;
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

    return {
      id: item.id,
      name: item.name,
      npcType,
      healPrice: Math.max(0, parseNumber(profile.healPrice, 0)),
      storeItems,
    };
  }

  private buildPlayerSide(
    id: BattleSideId,
    player: Player,
    user: AuthenticatedUser,
    catalogs: Awaited<ReturnType<BattleManager["loadCatalogs"]>>
  ): BattleSide {
    const party = user.pokemonParty.map((pokemon) => {
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
      activeIndex: 0,
      action: null,
      escapeAttempts: 0
    };
  }

  private buildBattlePokemonFromSummary(
    pokemon: PokemonSummary,
    definition: PokemonDefinition | null,
    skillsById: Map<string, SkillDefinition>,
    skillsByName: Map<string, SkillDefinition>
  ): BattlePokemon {
    const level = clamp(pokemon.level, 1, 100);
    const statBonuses = sanitizePokemonStatBonuses(pokemon.statBonuses);
    const baseStats = definition?.baseStats ?? {
      hp: pokemon.maxHp,
      attack: Math.max(1, pokemon.maxHp),
      defense: Math.max(1, pokemon.maxHp),
      specialAttack: Math.max(1, pokemon.maxHp),
      specialDefense: Math.max(1, pokemon.maxHp),
      speed: Math.max(1, pokemon.maxHp)
    };
    const stats = calculateStats(baseStats, level, statBonuses);
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

    return {
      id: pokemon.id,
      sourcePokemonId: pokemon.sourcePokemonId,
      name: pokemon.name,
      nickname: pokemon.nickname,
      level,
      types: pokemon.types.length > 0 ? pokemon.types.map(normalizeType) : definition?.types ?? [],
      hp: clamp(pokemon.hp, 0, stats.hp),
      maxHp: stats.hp,
      baseStats,
      stats,
      statBonuses,
      stages: createEmptyStages(),
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
    const stats = calculateStats(definition.baseStats, level, statBonuses);
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
      baseStats: definition.baseStats,
      stats,
      statBonuses,
      stages: createEmptyStages(),
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
      maxPp: skill.powerPoint,
      currentPp:
        typeof currentPp === "number" && Number.isFinite(currentPp)
          ? clamp(Math.round(currentPp), 0, skill.powerPoint)
          : skill.powerPoint,
      damageClass: skill.power <= 0 || skill.category.toLowerCase() === "support"
        ? "status"
        : "physical"
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
        .filter((item) => item.quantity > 0 && ["usable", "berries"].includes(item.category))
        .map((item) => ({
          id: item.id,
          name: item.name,
          category: item.category,
          quantity: item.quantity,
          description: item.description,
          canUse: Boolean(this.getCachedItemDefinition(item.id, item.name))
        })),
      canAct,
      waitingForOpponent: battle.status === "active" && Boolean(self.action) && battle.sides.some((side) => !side.isAi && !side.action),
      selectedActionType,
      turnEndsAt: battle.turnEndsAt ? new Date(battle.turnEndsAt).toISOString() : null,
      log: battle.log,
      result: battle.result,
      summary: battle.summary
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
