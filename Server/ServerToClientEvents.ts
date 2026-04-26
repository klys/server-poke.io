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

interface AuthUserData {
  id: number;
  name: string;
  username: string;
  email: string;
  emailVerified: boolean;
  profileImage: string;
  description: string;
  inventory: Array<{
    id: string;
    name: string;
    category: "usable" | "berries" | "moves" | "quest";
    quantity: number;
    description: string;
  }>;
  pokemonParty: Array<{
    id: string;
    name: string;
    level: number;
    types: string[];
    hp: number;
    maxHp: number;
    moves: string[];
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
  test: (data: { test: string }) => void;

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
