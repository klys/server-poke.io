import type {
  AdminCatalogPayload,
  AdminUserDetails,
  AdminUserListPayload,
  RoleDefinitionWithCount
} from "../components/Auth";
import type {
  BattlePublicState
} from "../components/BattleManager";
import type { BattleEventsPayload } from "../components/battle/events";
import type {
  DesignerSectionSyncPayload,
  DesignerSectionVersionPayload
} from "../components/DesignerSectionStore";
import type {
  PlayableMapsSyncPayload,
  PlayableMapsVersionPayload
} from "../components/PlayableMapsStore";
import type { ApiKeySummary } from "../components/PokecraftApiClient";

export type EventStatePayload = {
  switches: Record<string, boolean>;
  variables: Record<string, number>;
  selfSwitches: Record<string, boolean>;
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
  | { type: "screen"; effect: "fadeout" | "fadein" | "tone"; durationMs?: number; darken?: number }
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
  profileImage?: string;
  description?: string;
  characterSkinId?: string;
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
  trainerGender: string;
  characterSkinId: string;
  money: number;
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
   * PC box storage: endless boxes, each holding up to `capacity` Pokemon.
   * Always contains at least one box. Entries share the party Pokemon shape.
   */
  pokemonStorage: Array<{
    id: string;
    name: string;
    capacity: number;
    pokemon: AuthUserData["pokemonParty"];
  }>;
}

export default interface ServerToClientEvents {
  addPlayer: (data: PlayerData) => void;
  removePlayer: (data: { playerId: string; id: number }) => void;
  myPlayer: (data: { playerId: string }) => void;
  // The player just traveled through a designer portal (server-triggered);
  // clients play the door/exit chime.
  "portal:used": (data: { mapId: string }) => void;
  // Volar (Fly) request rejected — the world-map window shows the message.
  "player:fly-error": (data: { message: string }) => void;
  // A used bag key item asks the client to open a window / toggle a mode
  // (e.g. Town Map -> open the world map). No party state changed.
  "inventory:action": (data: {
    type: "town-map" | "bicycle" | "dowsing" | "fishing" | "poke-radar" | "generic";
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
   * Full authoritative designer section snapshot loaded from Redis.
   * The same event is used for the initial hydration and for live rebroadcasts after edits.
   */
  "designer:section:state": (data: DesignerSectionSyncPayload) => void;

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
  "admin:catalog": (data: AdminCatalogPayload) => void;
  /** Real-time set of user ids currently online, pushed to subscribed admins. */
  "admin:presence:state": (data: { onlineUserIds: number[] }) => void;
  "admin:roles:list": (data: { roles: RoleDefinitionWithCount[] }) => void;
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
  }) => void;
  [event: `moveProjectil${string}`]: (data: ProjectilData) => void;
  [event: `playerReborn${string}`]: (data: { playerId: string; id: number }) => void;
  [event: `playerDeath${string}`]: (data: { playerId: string; id: number }) => void;
}
