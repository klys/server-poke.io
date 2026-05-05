import type {
  AdminUserDetails,
  AdminUserListPayload,
  RoleDefinitionWithCount
} from "../components/Auth";
import type {
  BattlePublicState
} from "../components/BattleManager";
import type {
  DesignerSectionSyncPayload,
  DesignerSectionVersionPayload
} from "../components/DesignerSectionStore";
import type {
  PlayableMapsSyncPayload,
  PlayableMapsVersionPayload
} from "../components/PlayableMapsStore";

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
}

export default interface ServerToClientEvents {
  addPlayer: (data: PlayerData) => void;
  removePlayer: (data: { playerId: string; id: number }) => void;
  myPlayer: (data: { playerId: string }) => void;

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
  "battle:ended": (data: { battleId: string }) => void;
  "battle:error": (data: { message: string }) => void;
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
  "admin:users:list": (data: AdminUserListPayload) => void;
  "admin:user:details": (data: { user: AdminUserDetails | null }) => void;
  "admin:roles:list": (data: { roles: RoleDefinitionWithCount[] }) => void;
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
