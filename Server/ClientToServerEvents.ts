import type {
  AdminUserUpdatePayload,
  RolePermission,
  UserRoleKey
} from "../components/Auth";
import type {
  BattleActionRequest,
  BattleChallengePayload,
  BattleChallengeResponsePayload,
  BattleTradeRequestPayload,
  BattleTradeResponsePayload
} from "../components/BattleManager";
import type {
  DesignerSectionJoinPayload,
  DesignerSectionUpdatePayload
} from "../components/DesignerSectionStore";
import type { PlayableMapsStateSnapshot } from "../components/PlayableMapsState";

interface AuthRegisterPayload {
  name: string;
  username: string;
  email: string;
  password: string;
}

interface AuthLoginPayload {
  username: string;
  password: string;
}

interface AuthPasswordRecoveryPayload {
  identifier: string;
}

interface AuthUsernameRecoveryPayload {
  email: string;
}

interface AuthSessionRequestPayload {
  token?: string;
}

interface AuthVerifyEmailPayload {
  token: string;
}

interface AuthResetPasswordPayload {
  token: string;
  password: string;
}

interface AuthChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
}

interface AuthUpdateProfilePayload {
  profileImage?: string;
  description?: string;
}

interface AuthChooseStarterPayload {
  gender: string;
  pokemonId: string;
  nickname: string;
}

interface AuthNamePokemonPayload {
  pokemonId: string;
  nickname: string;
}

interface PlayableMapsSyncRequestPayload {
  version?: number | null;
}

export default interface ClientToServerEvents {
  addPlayer: (data?: {
    token?: string;
  }) => void;
  "player:teleport": (data: { mapId: string; x: number; y: number }) => void;
  move: (data: { x: number; y: number }) => void;
  stopMove: () => void;
  shotProjectil: (data: { mouse_x: number; mouse_y: number }) => void;
  "battle:challenge-player": (data: BattleChallengePayload) => void;
  "battle:challenge-response": (data: BattleChallengeResponsePayload) => void;
  "battle:trade-request": (data: BattleTradeRequestPayload) => void;
  "battle:trade-response": (data: BattleTradeResponsePayload) => void;
  "battle:action": (data: BattleActionRequest) => void;
  "inventory:use-item": (data: { itemId: string; targetPokemonId: string }) => void;
  "inventory:teach-move": (data: { itemId: string; targetPokemonId: string }) => void;
  "inventory:throw-away": (data: { itemId: string; quantity: number }) => void;
  "npc:heal-party": (data: { npcPlacementId: string }) => void;
  "npc:store-buy": (data: { npcPlacementId: string; itemId: string; quantity: number }) => void;
  "npc:store-sell": (data: { npcPlacementId: string; itemId: string; quantity: number }) => void;
  "pokemon:name": (data: AuthNamePokemonPayload) => void;

  /**
   * Registers a new player account and starts an authenticated socket session.
   * Validation rules:
   * - `name`: letters only, min 2, max 30
   * - `username`: alphanumeric only, min 4, max 30
   * - `email`: must be a valid email address
   * - `password`: min 8, max 150, at least 1 uppercase, 1 lowercase, 1 number, and 1 symbol
   */
  "auth:register": (data: AuthRegisterPayload) => void;

  /**
   * Logs an existing player into the socket auth session.
   * - `username`: account username
   * - `password`: plaintext password from the login form
   */
  "auth:login": (data: AuthLoginPayload) => void;

  /**
   * Destroys the current auth session associated with this socket.
   * No payload is required.
   */
  "auth:logout": () => void;

  /**
   * Requests the current auth session state.
   * - omit the payload when the socket already has a token in memory
   * - pass `{ token }` when restoring a saved auth token after a reconnect/page reload
   */
  "auth:session": (data?: AuthSessionRequestPayload) => void;

  /**
   * Requests a password recovery email.
   * - `identifier`: username or email
   */
  "auth:recover-password": (data: AuthPasswordRecoveryPayload) => void;

  /**
   * Requests a username recovery email.
   * - `email`: the account email address
   */
  "auth:recover-username": (data: AuthUsernameRecoveryPayload) => void;

  /**
   * Re-sends the validation email for the currently authenticated user.
   * No payload is required. The socket must already have a valid auth token.
   */
  "auth:request-email-validation": () => void;

  /**
   * Consumes an email validation token received from the inbox link.
   * - `token`: email validation token
   */
  "auth:verify-email": (data: AuthVerifyEmailPayload) => void;

  /**
   * Consumes a password reset token and updates the account password.
   * - `token`: password reset token
   * - `password`: new password using the same password rules as registration
   */
  "auth:reset-password": (data: AuthResetPasswordPayload) => void;

  /**
   * Updates the authenticated user's password from the Account window.
   */
  "auth:change-password": (data: AuthChangePasswordPayload) => void;

  /**
   * Updates lightweight trainer profile data used by account windows and trainer card.
   */
  "auth:update-profile": (data: AuthUpdateProfilePayload) => void;

  /**
   * Grants one initial level-1 Pokemon to authenticated users with an empty party.
   * Requires a one-time Pokemon name:
   * - `nickname`: letters only, max 10, no spaces, no blocked insults
   */
  "auth:choose-starter": (data: AuthChooseStarterPayload) => void;

  /**
   * Joins a collaborative designer section channel.
   * - `version`: client's cached Redis version, if any
   * - `seedState`: optional snapshot used only when Redis has no saved state yet
   */
  "designer:section:join": (data?: DesignerSectionJoinPayload) => void;

  /**
   * Leaves a collaborative designer section channel for the current socket.
   */
  "designer:section:leave": (data?: { sectionKey?: string }) => void;

  /**
   * Replaces a shared designer section state with the latest client snapshot.
   * The server persists the payload in Redis and broadcasts it to everyone in the room.
   */
  "designer:section:update": (data: DesignerSectionUpdatePayload) => void;

  /**
   * Requests the authoritative playable map state if the server version differs
   * from the client's cached version.
   */
  "playableMaps:sync": (data?: PlayableMapsSyncRequestPayload) => void;

  /**
   * Joins the authenticated map designer sync channel.
   * `seedState` is only used to bootstrap Redis when no server map state exists yet.
   */
  "designer:maps:join": (data?: {
    version?: number | null;
    seedState?: PlayableMapsStateSnapshot;
  }) => void;

  /**
   * Leaves the authenticated map designer sync channel.
   */
  "designer:maps:leave": () => void;

  /**
   * Persists the full playable maps snapshot to Redis and publishes a new version.
   */
  "designer:maps:update": (data: { state: PlayableMapsStateSnapshot }) => void;
  "admin:users:list": (data?: {
    search?: string;
    page?: number;
    pageSize?: number;
  }) => void;
  "admin:user:get": (data: { userId: number }) => void;
  "admin:user:update": (data: { userId: number; updates: AdminUserUpdatePayload }) => void;
  "admin:roles:list": () => void;
  "admin:role:update": (data: {
    roleKey: UserRoleKey;
    description?: string;
    permissions?: RolePermission[];
  }) => void;
  "moderation:maps:list": () => void;
}
