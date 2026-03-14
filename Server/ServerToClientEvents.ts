interface PlayerData {
  playerId: string;
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
}

export default interface ServerToClientEvents {
  addPlayer: (data: PlayerData) => void;
  removePlayer: (data: { playerId: string; id: number }) => void;

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

  // Dynamic events using template literal types
  [event: `move${string}`]: (data: { x: number; y: number; angle: number; playerId: string; id: number }) => void;
  [event: `moveProjectil${string}`]: (data: ProjectilData) => void;
  [event: `playerReborn${string}`]: (data: { playerId: string; id: number }) => void;
  [event: `playerDeath${string}`]: (data: { playerId: string; id: number }) => void;
}
