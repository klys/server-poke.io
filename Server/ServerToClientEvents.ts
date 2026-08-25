import type {
  AdminCatalogPayload,
  AdminUserDetails,
  AdminUserListPayload,
  PokemonSummary,
  RoleDefinitionWithCount,
  SocialUserSummary
} from "../components/Auth";
import type {
  ChatMessagePayload,
  FriendsStatePayload,
  PrivateChatStatePayload
} from "../components/SocialManager";
import type {
  BattlePublicState
} from "../components/BattleManager";
import type {
  TradeActionResult,
  TradeAuditRecord,
  TradeChatMessage,
  TradeErrorCode,
  TradeExchangeSummary,
  TradeHistoryEntry,
  TradeState,
  TradeStatePayload
} from "../components/trade/tradeTypes";
import type { BattleEventsPayload } from "../components/battle/events";
import type {
  DesignerSectionPatchBroadcast,
  DesignerSectionSyncPayload,
  DesignerSectionVersionPayload
} from "../components/DesignerSectionStore";
import type {
  PlayableMapsSyncPayload,
  PlayableMapsVersionPayload
} from "../components/PlayableMapsStore";
import type { ApiKeySummary } from "../components/PokecraftApiClient";
import type { MaintenanceActionStatus } from "../components/MaintenanceRunner";

export type BerryPlotSnapshotPayload = {
  id: string;
  mapId: string;
  x: number;
  y: number;
  berryId: string | null;
  itemId: string | null;
  plantedAt: number | null;
  plantedBy: string | null;
  stageMs: number | null;
  ripeAt: number | null;
  stage: number;
};

export type EventStatePayload = {
  switches: Record<string, boolean>;
  variables: Record<string, number>;
  selfSwitches: Record<string, boolean>;
  /** Essentials session temp switches (tsOn?/setTempSwitchOn), keyed like
   * self switches; reset server-side whenever the player changes map. */
  tempSwitches?: Record<string, boolean>;
  /** Server clock for script-switch page conditions (day/night, weekday), so
   * the client's page-selection mirror agrees with the server. */
  env?: { hour: number; weekday: number };
};

export type EventStepPayload =
  | { type: "text"; npcName: string; text: string; portraitSrc?: string; portraitPokemonId?: string }
  | { type: "choices"; npcName: string; text: string; choices: string[]; portraitSrc?: string; portraitPokemonId?: string }
  | { type: "info"; npcName: string; text: string; portraitSrc?: string; portraitPokemonId?: string }
  // pbPokemonMart: open the store overlay stocked with these items. Purchases
  // go through the regular npc:store-buy / npc:store-sell sockets.
  | {
      type: "store";
      npcName: string;
      placementId: string;
      x: number;
      y: number;
      interactionDistanceSquares: number;
      items: Array<{ itemId: string; itemName: string; quantity: number; price: number }>;
    }
  // pbPokeCenterPC / pbTrainerPC: open the PC box storage overlay. Deposits
  // and withdrawals go through pokemon:box-deposit / pokemon:box-withdraw.
  | {
      type: "pcBox";
      npcName: string;
      placementId: string;
      x: number;
      y: number;
      interactionDistanceSquares: number;
    }
  // Asks the player to type a name (e.g. pbTrainerName); answered via
  // event:advance with { text }.
  | { type: "nameInput"; npcName: string; text: string; defaultName: string }
  // Non-blocking presentation cues (RMXP Show/Move/Erase Picture, sounds,
  // screen fades/tones). The client applies them and does NOT reply.
  | {
      type: "picture";
      op: "show" | "move" | "erase";
      slot: number;
      name?: string;
      origin?: number;
      x?: number;
      y?: number;
      opacity?: number;
      durationMs?: number;
    }
  | { type: "sound"; kind: "SE" | "ME" | "BGM" | "BGS" | "BGMStop" | "BGSStop"; name?: string; volume?: number }
  // "shake" (RMXP Screen Shake 225) rattles the viewport: power is the RMXP
  // 1-9 strength, durationMs how long. "flash" (224) is a brief white overlay.
  | {
      type: "screen";
      effect: "fadeout" | "fadein" | "tone" | "flash" | "shake";
      durationMs?: number;
      darken?: number;
      power?: number;
    }
  // RMXP Scroll Map (203): pan the camera off the player — direction is the
  // RMXP numpad value (2 down, 4 left, 6 right, 8 up) for distanceTiles over
  // durationMs. Scrolls accumulate; "end" resets the camera to the player.
  | { type: "camera"; op: "scroll"; direction: number; distanceTiles: number; durationMs: number }
  // RMXP Show Animation (207), rendered client-side as a lightweight emote
  // (exclaim/question bubble by animation name) plus the animation's sound
  // effect. targetCell is the event's cell for non-player targets.
  | {
      type: "animation";
      animationId: number;
      name?: string;
      se?: string;
      targetCell?: { x: number; y: number } | null;
    }
  | { type: "end" };

interface PlayerData {
  playerId: string;
  currentMapId: string;
  x: number;
  y: number;
  angle: number;
  id: number;
  username?: string;
  name?: string;
  /**
   * Public dual identity: the permanent account handle (`accountName`, same
   * value as `username`) and the character being played (`characterName`,
   * same value as `name`). Ids are immutable; names are display-only and must
   * never be used as authorization keys.
   */
  accountId?: number | null;
  accountName?: string;
  characterId?: number | null;
  characterName?: string;
  profileImage?: string;
  description?: string;
  characterSkinId?: string;
  /** True when the player is currently surfing (drives the mount sprite for
   * every viewer, including reconnect/visibility snapshots). */
  isSurfing?: boolean;
}

interface ProjectilData {
  x: number;
  y: number;
  id: number;
  angle: number;
}

interface ObjectData {
  x: number;
  y: number;
  type: string;
  width: number;
  height: number;
}

interface GroundItemData {
  id: string;
  itemId: string;
  itemName: string;
  category: string;
  description: string;
  iconSrc: string;
  quantity: number;
  mapId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AuthUserData {
  id: number;
  name: string;
  username: string;
  email: string;
  emailVerified: boolean;
  profileImage: string;
  description: string;
  /** Account identity: immutable id + permanent handle (= id/username). */
  accountId: number;
  accountName: string;
  /** The currently selected character; gameplay fields below belong to it. */
  characterId: number;
  characterName: string;
  /** Every character the account owns (including soft-deleted ones). */
  characters: Array<{
    characterId: number;
    characterName: string;
    characterSkinId: string;
    trainerGender: string;
    badges: number[];
    money: number;
    partyCount: number;
    lastMapId: string | null;
    createdAt: string;
    lastPlayedAt: string;
    deletedAt: string | null;
  }>;
  /**
   * Account-box currency, one aggregate per owning character. `pcMoney`
   * below is the ACTIVE character's own total (legacy alias).
   */
  sharedMoneyDeposits: Array<{
    accountId: number;
    ownerCharacterId: number;
    ownerCharacterName: string;
    amount: number;
    depositedByCharacterId: number;
    depositedAt: string;
    updatedAt: string;
  }>;
  trainerGender: string;
  characterSkinId: string;
  money: number;
  /** 0-based gym badge indices earned. */
  badges: number[];
  /** Map ids of fly-able towns the player has entered (gates Volar/Fly). */
  visitedTowns: string[];
  /** Palette key for the Trainer Card background. */
  trainerCardColor: string;
  /** Whether the party leader walks behind the player on the map. */
  followerEnabled: boolean;
  /** Secret push-chain depth (bodies-in-a-row one bump can displace). */
  pushDepth: number;
  role: "admin" | "designer" | "moderator" | "user";
  permissions: Array<"game.access" | "designer.access" | "moderator.access" | "admin.access">;
  inventory: Array<{
    id: string;
    name: string;
    category: "usable" | "berries" | "moves" | "quest";
    quantity: number;
    description: string;
  }>;
  pokemonParty: Array<{
    id: string;
    sourcePokemonId?: string;
    name: string;
    nickname?: string;
    level: number;
    types: string[];
    hp: number;
    maxHp: number;
    moves: string[];
    movePp?: Record<string, number>;
    experience: number;
    experienceCurve: "fast" | "medium" | "slow";
    nextLevelExperience: number;
    statBonuses: {
      hp: number;
      attack: number;
      defense: number;
      specialAttack: number;
      specialDefense: number;
      speed: number;
    };
  }>;
  /**
   * PC venomon box storage: up to 15 boxes, each holding `capacity` Pokemon.
   * Always contains at least one box. Entries share the party Pokemon shape.
   * `bgColor`/`bgImage`/`borderColor` are optional per-box cosmetics.
   */
  pokemonStorage: Array<{
    id: string;
    name: string;
    capacity: number;
    bgColor?: string;
    bgImage?: string;
    borderColor?: string;
    pokemon: AuthUserData["pokemonParty"];
  }>;
  /**
   * PC item box storage: up to 15 boxes, each holding `capacity` item stacks.
   * Always contains at least one box. Entries share the inventory item shape.
   */
  itemStorage: Array<{
    id: string;
    name: string;
    capacity: number;
    bgColor?: string;
    bgImage?: string;
    borderColor?: string;
    items: AuthUserData["inventory"];
  }>;
  /** Money stored in the PC bank, separate from the wallet (`money`). */
  pcMoney: number;
}

/** Public trainer card for another player (never carries money/email). */
interface TrainerCardData {
  playerId: string;
  /** Account id when the trainer is logged in — used for friend actions. */
  userId: number | null;
  name: string;
  username: string;
  /** Explicit dual identity (same values as userId/username/name). */
  accountId: number | null;
  accountName: string;
  characterId: number | null;
  characterName: string;
  description: string;
  characterSkinId: string;
  trainerCardColor: string;
  badges: number[];
  party: Array<{ name: string; sourcePokemonId?: string; nickname?: string }>;
}

export default interface ServerToClientEvents {
  addPlayer: (data: PlayerData) => void;
  "trainer:card-data": (data: TrainerCardData) => void;
  removePlayer: (data: { playerId: string; id: number }) => void;
  myPlayer: (data: { playerId: string }) => void;
  // The player just traveled through a designer portal (server-triggered);
  // clients play the door/exit chime.
  "portal:used": (data: { mapId: string }) => void;
  // Volar (Fly) request rejected — the world-map window shows the message.
  "player:fly-error": (data: { message: string }) => void;
  // A field skill (Surf/Dive/Strength/Waterfall/Cut/Rock Smash) could not be
  // used — the client shows the message near the player.
  "player:field-skill-error": (data: { skill: string; message: string }) => void;
  // Surf started/ended. Sent to the surfer's own sockets AND broadcast to the
  // map (playerId identifies whose mount sprite to toggle).
  "player:surf-state": (data: { surfing: boolean; playerId?: string }) => void;
  // Remaining repellent (Baygon) steps for THIS player: sent when a repellent
  // is used, on every step it spends, when it wears off (0) and on join.
  "player:repel-state": (data: { steps: number }) => void;
  // Public overworld pose of a player on the map (fishing cast); carries no
  // private data — just what nearby clients need to render the animation.
  "player:pose": (data: { playerId: string; pose: "fishing" | null }) => void;
  // Answer to field:actions — availability (+ reasons) of the water context
  // menu entries for the queried cell. Advisory only; execution re-validates.
  "field:actions-result": (data: {
    x: number;
    y: number;
    actions: {
      fish: {
        available: boolean;
        reason?: string;
        rods: Array<{ itemId: string; name: string; tier: "old" | "good" | "super" }>;
      };
      surf: { available: boolean; reason?: string };
      dive: { available: boolean; reason?: string };
    };
  }) => void;
  // A Strength boulder moved to a new cell (all clients on the map re-render it).
  "world:boulder-moved": (data: { mapId: string; boulderId: string; x: number; y: number }) => void;

  /**
   * NPC movement is server-authoritative (components/NpcActors.ts). Clients
   * never simulate a walk: they interpolate the steps they are told about, so
   * every player on a map sees an NPC on the same tile. All coordinates are
   * CELLS, not pixels.
   *
   * Batched: one packet per map per simulation tick, not one per NPC.
   */
  "npc:steps": (data: {
    mapId: string;
    /** Server clock at emit time, for step-spacing on the client. */
    t: number;
    steps: Array<{
      id: string;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      /** RPG Maker facing: 2 down, 4 left, 6 right, 8 up. */
      facing: number;
      /** How long the step takes; the client glides over exactly this long. */
      stepMs: number;
    }>;
  }) => void;
  /** Full actor state for a map — sent on arrival and as a periodic resync. */
  "npc:sync": (data: {
    mapId: string;
    t: number;
    npcs: Array<{
      id: string;
      x: number;
      y: number;
      toX: number;
      toY: number;
      facing: number;
      stepMs: number;
      /** Milliseconds already elapsed of the step in progress (0 when idle). */
      elapsedMs: number;
    }>;
  }) => void;
  /** An NPC turned on the spot (a move route's turn command). */
  "npc:turn": (data: { mapId: string; id: string; facing: number; t: number }) => void;

  /**
   * Follower venomons (components/FollowerActors.ts): the party leader walks
   * one tile behind its trainer, server-authoritative like NPC actors. All
   * coordinates are CELLS. `charset` is the overworld sheet basename under
   * /migration_exports/characters/ (e.g. "025" -> 025.png, a 4x4 grid).
   */
  "follower:steps": (data: {
    mapId: string;
    t: number;
    steps: Array<{
      ownerId: string;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      /** RPG Maker facing: 2 down, 4 left, 6 right, 8 up. */
      facing: number;
      stepMs: number;
    }>;
  }) => void;
  /** Full follower state for a map — sent on arrival and as a periodic resync. */
  "follower:sync": (data: {
    mapId: string;
    t: number;
    followers: Array<{
      ownerId: string;
      charset: string;
      x: number;
      y: number;
      toX: number;
      toY: number;
      facing: number;
      stepMs: number;
      elapsedMs: number;
      /** True while the owner surfs / is underwater: don't render, not solid. */
      hidden: boolean;
    }>;
  }) => void;
  /** One follower changed (appeared, species change, hide/show, snap). */
  "follower:update": (data: {
    mapId: string;
    t: number;
    follower: {
      ownerId: string;
      charset: string;
      x: number;
      y: number;
      toX: number;
      toY: number;
      facing: number;
      stepMs: number;
      elapsedMs: number;
      hidden: boolean;
    };
  }) => void;
  /** A follower left the map (owner left/teleported, or follower disabled). */
  "follower:remove": (data: { mapId: string; ownerId: string }) => void;

  /**
   * Beach balls (components/BeachBalls.ts): pushable /pelota map entities.
   * Coordinates are CELLS; the sprite is /objects/BeachBall.png (a 7-frame
   * 32x32 strip: 2 rolling frames + 5 deflate frames).
   */
  "ball:spawn": (data: {
    mapId: string;
    t: number;
    ball: {
      id: string;
      mapId: string;
      x: number;
      y: number;
      toX: number;
      toY: number;
      stepMs: number;
      elapsedMs: number;
      pushesLeft: number;
      deflated: boolean;
    };
  }) => void;
  /** Live balls of a map — sent on arrival. */
  "ball:sync": (data: {
    mapId: string;
    t: number;
    balls: Array<{
      id: string;
      mapId: string;
      x: number;
      y: number;
      toX: number;
      toY: number;
      stepMs: number;
      elapsedMs: number;
      pushesLeft: number;
      deflated: boolean;
    }>;
  }) => void;
  /** The ball was kicked one cell. */
  "ball:step": (data: {
    mapId: string;
    t: number;
    id: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    stepMs: number;
    pushesLeft: number;
  }) => void;
  /** The ball ran out of pushes (or a second ball spawned): play the deflate
   * animation, then remove it. */
  "ball:deflate": (data: { mapId: string; t: number; id: string }) => void;
  /**
   * Global berry plots (BerryPlots.ts). A plot is an authored soil patch;
   * `berryId` null = empty soil. Growth is wall-clock: clients compute
   * stage = min(5, 1 + floor((serverNow - plantedAt) / stageMs)) using the
   * packet's `t` as the server clock (1 planted, 2 sprouted, 3 taller,
   * 4 flowering, 5 ripe) and pick the charset row accordingly
   * (berrytreeplanted / berrytree<BERRYID> rows 0..3).
   */
  "berry:sync": (data: { mapId: string; t: number; plots: BerryPlotSnapshotPayload[] }) => void;
  /** One plot changed (planted / harvested / cleared) — broadcast to the map. */
  "berry:update": (data: { mapId: string; t: number; plot: BerryPlotSnapshotPayload }) => void;
  /** Answer to berry:actions: the plot now + the plantable berries in the bag. */
  "berry:actions-result": (data: {
    plotId: string;
    t: number;
    plot: BerryPlotSnapshotPayload | null;
    /** Berries in the requester's bag that can be planted (empty plot only). */
    berries: Array<{ itemId: string; berryId: string; name: string; quantity: number; hoursPerStage: number }>;
    canPlant: boolean;
    canHarvest: boolean;
    canClear: boolean;
    /** i18n key explaining a refusal (e.g. "berry.reason.tooFar"), if any. */
    reasonKey?: string;
  }) => void;
  /**
   * Outcome of berry:plant / berry:harvest / berry:clear for the actor. The
   * message is an i18n key + params so the client renders it in its own
   * language (`berry.msg.harvested` -> "{name} x{count}").
   */
  "berry:result": (data: {
    action: "plant" | "harvest" | "clear";
    ok: boolean;
    plotId: string;
    messageKey: string;
    params?: Record<string, string>;
  }) => void;
  // Teaching an MO/MT to a Venomon that already knows four moves: the client
  // must ask which move to replace, then re-send inventory:teach-move with it.
  "inventory:teach-replace-needed": (data: {
    itemId: string;
    targetPokemonId: string;
    moveName: string;
    moves: string[];
  }) => void;
  // A used bag key item asks the client to open a window / toggle a mode
  // (e.g. Town Map -> open the world map). No party state changed.
  "inventory:action": (data: {
    type: "town-map" | "bicycle" | "running-shoes" | "dowsing" | "fishing" | "poke-radar" | "generic";
  }) => void;
  // Outcome of a click-to-fish cast. "bite" is followed by a battle:state; the
  // client keeps the casting animation until this arrives, then shows the text.
  "fishing:result": (data: {
    status: "bite" | "no-bite" | "error";
    message: string;
  }) => void;

  shotProjectil: (data: ProjectilData) => void;
  explodeProjectil: (data: ProjectilData) => void;

  playerHurt: (data: { playerId: string; life: number; id: number }) => void;
  playerReborn: (data: { playerId: string; id: number }) => void;
  playerDeath: (data: { playerId: string; id: number }) => void;

  addObject: (data: ObjectData) => void;
  "world:item-dropped": (data: GroundItemData) => void;
  "world:item-picked-up": (data: { groundItemId: string }) => void;
  test: (data: { test: string }) => void;
  "battle:state": (data: BattlePublicState) => void;
  "battle:events": (data: BattleEventsPayload) => void;
  "battle:ended": (data: { battleId: string }) => void;
  "battle:error": (data: { message: string }) => void;
  "event:step": (data: EventStepPayload) => void;
  "event:state": (data: EventStatePayload) => void;
  "battle:challenge-received": (data: { challengeId: string; fromPlayerId: string; fromUsername: string }) => void;
  "battle:challenge-sent": (data: { challengeId: string; targetPlayerId: string; targetUsername: string }) => void;
  "battle:challenge-declined": (data: { challengeId: string; targetPlayerId: string }) => void;
  "battle:challenge-expired": (data: { challengeId: string }) => void;
  "battle:trade-request-received": (data: { requestId: string; fromPlayerId: string; fromUsername: string }) => void;
  "battle:trade-request-sent": (data: { requestId: string; targetPlayerId: string; targetUsername: string }) => void;
  "battle:trade-accepted": (data: { requestId: string; targetPlayerId: string }) => void;
  "battle:trade-declined": (data: { requestId: string; targetPlayerId: string }) => void;
  "battle:trade-expired": (data: { requestId: string }) => void;

  /**
   * Main auth state response emitted after:
   * - `auth:register`
   * - `auth:login`
   * - `auth:logout`
   * - `auth:session`
   * - optional refresh after `auth:verify-email`
   *
   * Response shape:
   * - `authenticated`: whether the socket currently has a valid auth session
   * - `user`: the authenticated user or `null`
   * - `token`: present after register/login so the frontend can persist and reconnect
   */
  "auth:session": (data: { authenticated: boolean; user: AuthUserData | null; token?: string }) => void;

  /**
   * Non-fatal success/notice event for auth flows that do not return a session payload,
   * such as recovery requests or email validation.
   */
  "auth:info": (data: { message: string }) => void;

  /**
   * Validation or operational auth error. The frontend should surface this as a
   * form-level error or toast message.
   */
  "auth:error": (data: { message: string }) => void;

  /**
   * Answer to npc:store-sell-quotes: per-unit prices the store pays for every
   * sellable item in the player's bag (stores buy items they don't stock too;
   * move machines, quest items and priceless items are excluded server-side).
   */
  "npc:store-sell-quotes": (data: {
    npcPlacementId: string;
    quotes: Array<{ itemId: string; itemName: string; quantity: number; sellPrice: number }>;
  }) => void;

  /**
   * Emitted right before the socket is signed out because the authenticated user
   * deleted their own account. The frontend should clear any persisted auth
   * token and return to the logged-out state.
   */
  "auth:account-deleted": (data: { message: string }) => void;

  // ---- Account characters (character:*) -----------------------------------
  // An account owns up to MAX_CHARACTERS_PER_ACCOUNT characters; gameplay
  // state (party, money, badges, progression) belongs to exactly one of them.
  // Every mutation is followed by a fresh `auth:session` so the client's
  // single source of truth stays authoritative.

  /** The account's characters (also embedded in AuthUserData.characters). */
  "character:list-data": (data: {
    characters: AuthUserData["characters"];
    activeCharacterId: number;
    maxCharacters: number;
  }) => void;
  /** A character was created/selected/deleted/restored successfully. */
  "character:changed": (data: {
    action: "created" | "selected" | "deleted" | "restored";
    characterId: number;
  }) => void;
  "character:error": (data: { message: string }) => void;

  /**
   * Full authoritative designer section snapshot loaded from Redis.
   * The same event is used for the initial hydration and for live rebroadcasts after edits.
   */
  "designer:section:state": (data: DesignerSectionSyncPayload) => void;

  /**
   * Item-level ops applied to a designer section (see designer:section:patch).
   * Clients holding version-1 apply the ops locally; anyone behind refetches
   * the full state over HTTP.
   */
  "designer:section:patched": (data: DesignerSectionPatchBroadcast) => void;

  /**
   * Lightweight designer section cache metadata.
   */
  "designer:section:version": (data: DesignerSectionVersionPayload) => void;

  /**
   * Collaborative editor error for designer sections.
   */
  "designer:section:error": (data: { message: string }) => void;

  /**
   * Latest authoritative playable map snapshot used by the multiplayer renderer.
   */
  "playableMaps:state": (data: PlayableMapsSyncPayload) => void;

  /**
   * Lightweight playable map cache metadata. Clients compare this with
   * localStorage and request `playableMaps:sync` when it differs.
   */
  "playableMaps:version": (data: PlayableMapsVersionPayload) => void;

  /**
   * Playable map sync error for both game clients and the designer.
   */
  "playableMaps:error": (data: { message: string }) => void;

  /**
   * Result of a designer:mapAssets:update upload. `path` values are
   * root-relative asset paths ("/map-assets/<mapId>/<file>") to store in the
   * map snapshot; clients resolve them against their configured
   * asset-storage base URL (assetStorageBaseUrl in config.json).
   */
  "designer:mapAssets:state": (data: {
    mapId: string;
    files: Array<{ name: string; path: string }>;
  }) => void;
  "admin:users:list": (data: AdminUserListPayload) => void;
  "admin:user:details": (data: { user: AdminUserDetails | null }) => void;
  "admin:user:deleted": (data: { userId: number }) => void;
  /** A user's event switches/variables snapshot for the admin Variables tab. */
  "admin:user:event-state": (data: {
    userId: number;
    switches: Record<string, boolean>;
    variables: Record<string, number>;
    selfSwitches: Record<string, boolean>;
  }) => void;
  /** Read-only PC box storage + trainer profile for the admin panel. */
  "admin:user:storage": (data: {
    userId: number;
    boxes: Array<{
      id: string;
      name: string;
      capacity: number;
      pokemon: PokemonSummary[];
    }>;
    profile: {
      name: string;
      username: string;
      description: string;
      profileImage: string;
      characterSkinId: string;
      trainerCardColor: string;
      badges: number[];
      money: number;
      createdAt: string;
    };
  }) => void;
  "admin:catalog": (data: AdminCatalogPayload) => void;
  /** Real-time set of user ids currently online, pushed to subscribed admins. */
  "admin:presence:state": (data: { onlineUserIds: number[] }) => void;
  "admin:roles:list": (data: { roles: RoleDefinitionWithCount[] }) => void;
  "admin:maintenance:list": (data: {
    actions: MaintenanceActionStatus[];
    running: string | null;
    /** SMTP is configured — report emailing is possible on this server. */
    emailEnabled: boolean;
  }) => void;
  "admin:maintenance:log": (data: { id: string; line: string }) => void;
  "admin:maintenance:done": (data: { id: string; ok: boolean; exitCode: number | null }) => void;
  /** Stored last-run report of one action, rendered as a self-contained HTML document. */
  "admin:maintenance:report": (data: {
    id: string;
    available: boolean;
    html: string | null;
    meta: {
      actionName: string;
      at: string;
      ok: boolean;
      dryRun: boolean;
      exitCode: number | null;
      by: string;
    } | null;
  }) => void;
  /** Outcome of an admin:maintenance:email-report request. */
  "admin:maintenance:email-result": (data: { id: string; ok: boolean; to: string; message: string }) => void;
  /** Outcome of an admin:maintenance:broadcast request. */
  "admin:maintenance:broadcast-result": (data: { ok: boolean; recipients: number; message: string }) => void;
  /** Effective global game settings + the env-derived defaults, admin-only. */
  "admin:settings-data": (data: {
    settings: {
      maxCharactersPerAccount: number;
      crossCharacterStorageMinMedals: number;
      characterRecoveryDays: number;
      skinChangePrice: number;
      startingMoney: number;
      allowMultipleBeachBalls: boolean;
    };
    defaults: {
      maxCharactersPerAccount: number;
      crossCharacterStorageMinMedals: number;
      characterRecoveryDays: number;
      skinChangePrice: number;
      startingMoney: number;
      allowMultipleBeachBalls: boolean;
    };
  }) => void;
  "admin:apikeys:list": (data: { keys: ApiKeySummary[] }) => void;
  /** One-time reveal of a freshly minted key's plaintext secret. */
  "admin:apikeys:created": (data: { key: string; meta: ApiKeySummary }) => void;
  "admin:error": (data: { message: string }) => void;
  "moderation:maps:list": (data: {
    maps: Array<{
      mapId: string;
      onlinePlayers: number;
      players: Array<{
        playerId: string;
        userId: number | null;
        username: string;
        name: string;
        x: number;
        y: number;
        connectedSockets: number;
      }>;
    }>;
    totalOnlinePlayers: number;
    fetchedAt: string;
  }) => void;
  "moderation:error": (data: { message: string }) => void;

  /** Full friends snapshot: list (with presence), pending requests, prefs,
   * and the account-level block list. */
  "friends:state": (data: FriendsStatePayload) => void;
  "friends:error": (data: { message: string }) => void;
  /** Presence tick about one friend (connect/disconnect/map change/character
   * switch). Character/map/last-seen fields honor the friend's privacy prefs. */
  "friends:presence": (data: {
    userId: number;
    accountId: number;
    accountName: string;
    online: boolean;
    mapId?: string;
    playerId?: string;
    activeCharacterId: number | null;
    activeCharacterName: string | null;
    lastSeenAt: string | null;
  }) => void;
  /** Someone sent you a friend request — feeds the notification center. */
  "friends:request-received": (data: { from: SocialUserSummary }) => void;
  /** A request you sent was accepted. */
  "friends:request-accepted": (data: { by: SocialUserSummary }) => void;
  /** A friend removed you from their list. */
  "friends:removed": (data: { userId: number }) => void;
  /** A friend wants to teleport to you — approve/decline via notification. */
  "friends:teleport-request": (data: { requestId: string; from: SocialUserSummary }) => void;
  /** Outcome of your teleport request (accepted/declined/expired). */
  "friends:teleport-response": (data: {
    requestId: string;
    accepted: boolean;
    byUsername: string;
    expired: boolean;
  }) => void;

  /** Map / whisper / global / system chat traffic for the chat bar. */
  "chat:message": (data: ChatMessagePayload) => void;
  "chat:error": (data: { message: string }) => void;
  /** You were invited to a private chat — accept/decline via notification. */
  "chat:invite-received": (data: {
    inviteId: string;
    chatId: string;
    from: SocialUserSummary;
    memberCount: number;
  }) => void;
  /** Outcome of an invitation you sent (declined/expired => accepted:false). */
  "chat:invite-response": (data: {
    inviteId: string;
    chatId: string;
    accepted: boolean;
    byUsername: string;
  }) => void;
  /** Membership snapshot of a private chat you belong to. */
  "chat:private-state": (data: PrivateChatStatePayload) => void;
  "chat:private-message": (data: {
    chatId: string;
    id: string;
    fromUserId: number;
    fromUsername: string;
    fromName: string;
    fromAccountId?: number;
    fromAccountName?: string;
    fromCharacterId?: number;
    fromCharacterName?: string;
    text: string;
    at: string;
  }) => void;
  /** You left (or the chat was disposed) — close its window. */
  "chat:private-closed": (data: { chatId: string }) => void;

  // ---- Player-to-player trading (TradeManager) ----------------------------
  //
  // `trade:state` is the authoritative view of a session and is emitted
  // per-recipient (each side gets its own `youAre`). The other state-carrying
  // events use the same payload and exist so the client can react to *why*
  // the state moved. `null` on `trade:state` means "you are in no trade".

  "trade:request:received": (data: {
    tradeId: string;
    from: {
      userId: number;
      username: string;
      displayName: string;
      characterSkinId: string;
      newAccount: boolean;
      accountId: number;
      accountName: string;
      characterId: number;
      characterName: string;
    };
    expiresAt: number;
  }) => void;
  "trade:request:expired": (data: { tradeId: string }) => void;

  "trade:opened": (data: TradeStatePayload) => void;
  "trade:state": (data: TradeStatePayload | null) => void;
  "trade:offer:changed": (data: TradeStatePayload) => void;
  "trade:offer:invalidated": (data: TradeStatePayload) => void;
  "trade:confirmation:started": (data: TradeStatePayload) => void;

  "trade:participant:disconnected": (data: {
    tradeId: string;
    userId: number;
    graceSeconds: number;
  }) => void;
  "trade:participant:reconnected": (data: { tradeId: string; userId: number }) => void;

  "trade:chat:message": (data: TradeChatMessage) => void;

  "trade:completed": (data: {
    tradeId: string;
    state: TradeState;
    version: number;
    snapshotHash: string | null;
    completedAt: string;
    given: TradeExchangeSummary;
    received: TradeExchangeSummary;
  }) => void;
  "trade:cancelled": (data: {
    tradeId: string;
    state: TradeState;
    version: number;
    reason: string;
    errorCode: TradeErrorCode | null;
  }) => void;
  "trade:failed": (data: {
    tradeId: string;
    state: TradeState;
    version: number;
    errorCode: TradeErrorCode;
    message: string;
  }) => void;

  /** Uniform acknowledgement emitted for every client trade action. */
  "trade:result": (data: TradeActionResult) => void;

  /** Player-facing trade history page (no security metadata). */
  "trade:history": (data: {
    entries: TradeHistoryEntry[];
    page: number;
    pageSize: number;
    total: number;
  }) => void;

  /** Moderation surfaces — only ever emitted to moderator.access sockets. */
  "moderation:trades:list": (data: {
    rows: TradeAuditRecord[];
    total: number;
    page: number;
    pageSize: number;
  }) => void;
  "moderation:trades:detail": (data: unknown) => void;
  "moderation:trades:reports": (data: { rows: unknown[]; total: number }) => void;

  // Dynamic events using template literal types
  [event: `move${string}`]: (data: {
    x: number;
    y: number;
    angle: number;
    playerId: string;
    id: number;
    currentMapId?: string;
    teleported?: boolean;
    stopped?: boolean;
    /** Server clock (ms) at emit time. Clients use consecutive deltas to
     * time movement interpolation, so steps stay evenly spaced even when
     * network jitter bunches packets up. */
    t: number;
  }) => void;
  [event: `moveProjectil${string}`]: (data: ProjectilData) => void;
  [event: `playerReborn${string}`]: (data: { playerId: string; id: number }) => void;
  [event: `playerDeath${string}`]: (data: { playerId: string; id: number }) => void;
}
