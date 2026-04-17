import type {
  DesignerObjectsJoinPayload,
  DesignerObjectsUpdatePayload
} from "../components/DesignerObjectsStore";

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

interface AddPlayerMapDefinition {
  mapId: string;
  width: number;
  height: number;
  obstacles: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export default interface ClientToServerEvents {
  addPlayer: (data?: {
    initialMapId?: string;
    initialX?: number;
    initialY?: number;
    mapDefinitions?: AddPlayerMapDefinition[];
    token?: string;
  }) => void;
  "player:teleport": (data: { mapId: string; x: number; y: number }) => void;
  move: (data: { x: number; y: number }) => void;
  stopMove: () => void;
  shotProjectil: (data: { mouse_x: number; mouse_y: number }) => void;

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
   * Joins the collaborative `/designer/objects` channel.
   * - `seedState`: optional client snapshot used only when Redis has no saved state yet
   */
  "designer:objects:join": (data?: DesignerObjectsJoinPayload) => void;

  /**
   * Leaves the collaborative `/designer/objects` channel for the current socket.
   */
  "designer:objects:leave": () => void;

  /**
   * Replaces the shared map object editor state with the latest client snapshot.
   * The server persists the payload in Redis and broadcasts it to everyone in the room.
   */
  "designer:objects:update": (data: DesignerObjectsUpdatePayload) => void;
}
