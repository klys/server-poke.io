import type {
  AdminUserUpdateInput,
  RolePermission,
  SocialPrefs,
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
  DesignerSectionPatchPayload,
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

interface AuthConfirmAccountDeletionPayload {
  code: string;
}

interface AuthUpdateProfilePayload {
  profileImage?: string;
  description?: string;
  characterSkinId?: string;
  trainerCardColor?: string;
}

interface AuthChooseStarterPayload {
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
  // Latency probe for the client's HUD: the server acks immediately and the
  // client measures the round-trip time. Works pre-auth.
  "net:ping": (ack: () => void) => void;
  addPlayer: (data?: {
    token?: string;
  }) => void;
  "player:teleport": (data: { mapId: string; x: number; y: number }) => void;
  /** Hold-to-run intent (Running Shoes). Server validates shoe ownership. */
  "player:run": (data: { running: boolean }) => void;
  "player:fly": (data: { mapId: string }) => void;
  // Field skills used out of battle by facing/standing on the relevant terrain.
  // player:surf optionally carries an adjacent water cell (from the water
  // context menu) to face before mounting; the server re-validates everything.
  "player:surf": (data?: { x?: number; y?: number }) => void;
  "player:dive": () => void;
  "player:waterfall": () => void;
  "player:strength-push": () => void;
  // Action button pressed with nothing to interact with: the server resolves
  // whichever field skill (Surf/Dive/Waterfall/Strength) the terrain allows.
  "player:field-interact": () => void;
  // Water context menu: which actions (Fish/Surf/Dive) apply to this adjacent
  // cell right now? Answered with field:actions-result; purely advisory.
  "field:actions": (data: { x: number; y: number }) => void;
  // Click-to-fish: cast at an adjacent water tile (cell coords) the player
  // tapped. rodItemId (optional) picks a specific owned rod; default best.
  "fishing:cast": (data: { x: number; y: number; rodItemId?: string }) => void;
  move: (data: { x: number; y: number }) => void;
  stopMove: () => void;
  shotProjectil: (data: { mouse_x: number; mouse_y: number }) => void;
  "battle:challenge-player": (data: BattleChallengePayload) => void;
  "battle:challenge-response": (data: BattleChallengeResponsePayload) => void;
  "battle:trade-request": (data: BattleTradeRequestPayload) => void;
  "battle:trade-response": (data: BattleTradeResponsePayload) => void;
  "player:set-skin": (data: { characterSkinId: string }) => void;
  "trainer:card": (data: { targetPlayerId: string }) => void;
  "battle:action": (data: BattleActionRequest) => void;
  "battle:learn-move": (data: { pokemonId: string; moveName: string; replaceMoveName?: string }) => void;
  "inventory:use-item": (data: { itemId: string; targetPokemonId?: string; targetMoveName?: string }) => void;
  "inventory:teach-move": (data: {
    itemId: string;
    targetPokemonId: string;
    replaceMoveName?: string;
  }) => void;
  // slot: "bonus" (passive equip; default/legacy), "battle" (consumable
  // battle-use item) or "appearance" (sprite-changing form item). Omitted =
  // the server classifies the item into its natural slot.
  "inventory:hold-item": (data: {
    pokemonId: string;
    itemId: string;
    slot?: "bonus" | "battle" | "appearance";
  }) => void;
  "inventory:take-held-item": (data: {
    pokemonId: string;
    slot?: "bonus" | "battle" | "appearance";
  }) => void;
  "inventory:throw-away": (data: { itemId: string; quantity: number }) => void;
  "npc:heal-party": (data: { npcPlacementId: string }) => void;
  "npc:battle": (data: { npcPlacementId: string }) => void;
  "event:interact": (data: { npcPlacementId: string }) => void;
  "event:advance": (data?: { text?: string }) => void;
  "event:choice": (data: { index: number }) => void;
  "npc:store-buy": (data: { npcPlacementId: string; itemId: string; quantity: number }) => void;
  "npc:store-sell": (data: { npcPlacementId: string; itemId: string; quantity: number }) => void;
  "npc:store-sell-quotes": (data: { npcPlacementId: string }) => void;
  "pokemon:name": (data: AuthNamePokemonPayload) => void;

  /**
   * Reorders the player's Pokemon party. `order` must contain every party
   * member's id exactly once; the first id becomes the battle lead.
   * Not allowed while the player is in a battle.
   */
  "pokemon:reorder": (data: { order: string[] }) => void;

  /**
   * Toggles the follower venomon (the party leader walking behind the player
   * on the map). Persisted per character; echoed back via `auth:session`.
   */
  "follower:set-enabled": (data: { enabled: boolean }) => void;

  /**
   * Stats-window move management (outside battles): learn a move available at
   * the venomon's current level (learnset or a missed battle prompt),
   * optionally replacing a known move, or forget a known move.
   */
  "pokemon:learn-move": (data: { pokemonId: string; moveName: string; replaceMoveName?: string }) => void;
  "pokemon:forget-move": (data: { pokemonId: string; moveName: string }) => void;

  /**
   * Moves one or more party Pokemon into PC box storage. Omit `boxId` to use
   * the first box with free space (a new box is created when every box is
   * full, up to 15). The last party Pokemon cannot be deposited. Not allowed
   * during a battle. `pokemonId` is accepted for backward compatibility.
   */
  "pokemon:box-deposit": (data: { pokemonIds?: string[]; pokemonId?: string; boxId?: string }) => void;

  /**
   * Moves one or more Pokemon from the given PC storage box back into the
   * party. Fails when the party would exceed 6. Not allowed during a battle.
   */
  "pokemon:box-withdraw": (data: { pokemonIds?: string[]; pokemonId?: string; boxId: string }) => void;

  /** Moves one or more stored Pokemon into another box (`toBoxId`). */
  "pokemon:box-move": (data: { pokemonIds: string[]; toBoxId: string }) => void;

  /** Permanently releases ("let go") one or more stored Pokemon. */
  "pokemon:box-release": (data: { pokemonIds: string[] }) => void;

  /** Adds a new empty venomon box (up to 15). */
  "pokemon:box-create": () => void;

  /** Renames / restyles a venomon box (colors + background image asset). */
  "pokemon:box-style": (data: {
    boxId: string;
    name?: string;
    bgColor?: string;
    bgImage?: string;
    borderColor?: string;
  }) => void;

  /** Moves a quantity of a bag item into an item box (auto box when omitted). */
  "item:box-deposit": (data: { itemId: string; quantity: number; boxId?: string }) => void;

  /** Moves a quantity of an item from an item box back into the bag. */
  "item:box-withdraw": (data: { itemId: string; quantity: number; boxId: string }) => void;

  /** Moves a quantity of an item from one item box to another. */
  "item:box-move": (data: { itemId: string; quantity: number; fromBoxId: string; toBoxId: string }) => void;

  /** Permanently discards ("let go") a quantity of an item from a box. */
  "item:box-release": (data: { itemId: string; quantity: number; boxId: string }) => void;

  /** Adds a new empty item box (up to 15). */
  "item:box-create": () => void;

  /** Renames / restyles an item box (colors + background image asset). */
  "item:box-style": (data: {
    boxId: string;
    name?: string;
    bgColor?: string;
    bgImage?: string;
    borderColor?: string;
  }) => void;

  /** Deposits wallet money into the account box (owned by the active character). */
  "pc:money-deposit": (data: { amount: number }) => void;

  /**
   * Withdraws money from the account box back into the wallet.
   * `ownerCharacterId` picks whose deposit to draw from (defaults to the
   * active character's own); a sibling character's deposit requires the
   * cross-character gym-medal gate. Partial amounts are supported — only the
   * withdrawn amount changes ownership.
   */
  "pc:money-withdraw": (data: { amount: number; ownerCharacterId?: number }) => void;

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
   * Starts self-service account deletion by emailing a confirmation code to the
   * authenticated user. No payload; the socket must have a valid auth token.
   */
  "auth:request-account-deletion": () => void;

  /**
   * Confirms self-service account deletion with the emailed code. On success the
   * account and all of its data are permanently removed and the socket is
   * signed out.
   */
  "auth:confirm-account-deletion": (data: AuthConfirmAccountDeletionPayload) => void;

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

  // ---- Account characters (character:*) -----------------------------------
  // Character ids are immutable and are the only accepted keys; character
  // names are display values. Every action answers with `character:changed`
  // (or `character:error`) plus a refreshed `auth:session`.

  /** Requests the character list (`character:list-data`). */
  "character:list": () => void;
  /** Creates a new character (letters-only name, 2-30 chars) and selects it. */
  "character:create": (data: { name: string }) => void;
  /** Switches the session to another (non-deleted) character the account owns. */
  "character:select": (data: { characterId: number }) => void;
  /** Soft-deletes a character (not the active one; recoverable for a while). */
  "character:delete": (data: { characterId: number }) => void;
  /** Restores a soft-deleted character within the recovery window. */
  "character:restore": (data: { characterId: number }) => void;

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
   * Applies item-level ops (upsert/delete/setCategories) to a designer
   * section without re-uploading the whole state. The server persists the
   * patched state and rebroadcasts the ops to the section room.
   */
  "designer:section:patch": (data: DesignerSectionPatchPayload) => void;

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

  /**
   * Uploads baked map surface images (png/webp/jpeg data URLs) for one map.
   * Files are stored on disk and served at GET /map-assets/<mapId>/<file>.
   * `replace` (default true) clears the map's previous asset set first.
   */
  "designer:mapAssets:update": (data: {
    mapId: string;
    files: Array<{ name?: string; dataUrl: string }>;
    replace?: boolean;
  }) => void;
  "admin:users:list": (data?: {
    search?: string;
    page?: number;
    pageSize?: number;
  }) => void;
  "admin:user:get": (data: { userId: number }) => void;
  "admin:user:update": (data: { userId: number; updates: AdminUserUpdateInput }) => void;
  "admin:user:reset-progress": (data: { userId: number }) => void;
  "admin:user:delete": (data: { userId: number }) => void;
  "admin:user:set-password": (data: { userId: number; newPassword: string }) => void;
  "admin:user:send-recovery": (data: { userId: number }) => void;
  /** Explicitly drop every live session of a user (admin decision — gifts and relocation never disconnect). */
  "admin:user:disconnect": (data: { userId: number }) => void;
  "admin:user:event-state:get": (data: { userId: number }) => void;
  /** Replaces the user's event switches/variables (self-switches untouched). */
  "admin:user:event-state:update": (data: {
    userId: number;
    switches?: Record<string, boolean>;
    variables?: Record<string, number>;
  }) => void;
  /** Read-only PC box storage + public trainer profile for the admin panel. */
  "admin:user:storage:get": (data: { userId: number }) => void;
  "admin:catalog:get": () => void;
  "admin:presence:subscribe": () => void;
  "admin:presence:unsubscribe": () => void;
  "admin:roles:list": () => void;
  "admin:maintenance:list": () => void;
  "admin:maintenance:run": (data: { id: string; dryRun?: boolean }) => void;
  /** Requests the stored report (HTML + meta) of an action's last run. */
  "admin:maintenance:report": (data: { id: string }) => void;
  /** Emails an action's last-run report; `to` defaults to the requesting admin's address. */
  "admin:maintenance:email-report": (data: { id: string; to?: string }) => void;
  /** Drops the admin-uploaded rxdata zip so the event repair reads the bundled dump again. */
  "admin:maintenance:rxdata-clear": () => void;
  /** Broadcasts a global chat message to every online player (admin.access). */
  "admin:maintenance:broadcast": (data: { message: string }) => void;

  /** Requests the operator-tunable global game settings (admin.access). */
  "admin:settings:get": () => void;
  /**
   * Updates one or more global game settings (admin.access). Values are
   * sanitized/clamped server-side; the full effective set is echoed back via
   * `admin:settings-data`.
   */
  "admin:settings:update": (data: {
    maxCharactersPerAccount?: number;
    crossCharacterStorageMinMedals?: number;
    characterRecoveryDays?: number;
    skinChangePrice?: number;
    startingMoney?: number;
    allowMultipleBeachBalls?: boolean;
  }) => void;
  "admin:role:update": (data: {
    roleKey: UserRoleKey;
    description?: string;
    permissions?: RolePermission[];
  }) => void;
  "admin:apikeys:list": () => void;
  "admin:apikeys:create": (data: {
    name: string;
    scopes: Array<"read" | "write" | "admin">;
    expiresInDays?: number;
  }) => void;
  "admin:apikeys:revoke": (data: { id: number }) => void;
  "moderation:maps:list": () => void;

  /** Requests a fresh friends:state snapshot (list + pending requests + prefs). */
  "friends:list": () => void;

  /**
   * Sends (or auto-accepts a mutual) friend request. Target by exact account
   * name OR by account id (e.g. from a trainer card — the visible character
   * resolves to its owning account; the friendship is account-to-account).
   */
  "friends:request": (data: { username?: string; accountId?: number }) => void;

  /** Accepts/declines a pending incoming friend request from `userId`. */
  "friends:respond": (data: { userId: number; accepted: boolean }) => void;

  /** Cancels a friend request previously sent to `userId`. */
  "friends:cancel-request": (data: { userId: number }) => void;

  /** Removes an existing friend (both directions). */
  "friends:remove": (data: { userId: number }) => void;

  /**
   * Blocks an entire account: every character it owns can no longer chat,
   * whisper, friend-request, trade with, or challenge you (and vice versa).
   * Any existing friendship and pending requests are severed.
   */
  "friends:block": (data: { accountId: number }) => void;

  /** Removes an account from the block list. */
  "friends:unblock": (data: { accountId: number }) => void;

  /** Updates the social config toggles shown in the Friends window. */
  "friends:set-prefs": (data: Partial<SocialPrefs>) => void;

  /** Asks a friend for permission to teleport to their current location. */
  "friends:teleport-request": (data: { userId: number }) => void;

  /** Answers a pending teleport request received via friends:teleport-request. */
  "friends:teleport-respond": (data: { requestId: string; accepted: boolean }) => void;

  /**
   * Sends a message to the sender's current map. Messages starting with "/"
   * are commands resolved server-side:
   * - `/w <user_name> <message>` whispers an online player
   * - `/global <message>` broadcasts to everyone (moderator/admin only)
   * - `/help` or `/ayuda` returns the player to their last Venomon Center
   */
  "chat:map-message": (data: { text: string }) => void;

  /** Opens a private chat and invites the given users (they must accept). */
  "chat:private-create": (data: { userIds: number[] }) => void;

  /** Invites one more user into an existing private chat. */
  "chat:private-invite": (data: { chatId: string; userId: number }) => void;

  /** Accepts/declines a chat invitation received via chat:invite-received. */
  "chat:invite-respond": (data: { inviteId: string; accepted: boolean }) => void;

  /** Sends a message to a private chat the sender belongs to. */
  "chat:private-message": (data: { chatId: string; text: string }) => void;

  /** Leaves a private chat (empty chats are disposed). */
  "chat:private-leave": (data: { chatId: string }) => void;

  // ---- Player-to-player trading (TradeManager) ----------------------------
  //
  // Every action carries the trade id, the version the client last saw, and an
  // idempotency key. The server rejects stale versions and drops replayed
  // request ids, and answers every one of these with `trade:result`.
  // See TRADING.md for the full contract.

  /** Opens a trade request. Identify the target by socket id or user id. */
  "trade:request": (data: { targetPlayerId?: string; targetUserId?: number }) => void;
  "trade:request:accept": (data: { tradeId: string }) => void;
  "trade:request:decline": (data: { tradeId: string }) => void;
  /** The sender withdrawing their own pending request. */
  "trade:request:cancel": (data: { tradeId: string }) => void;

  /** Adds `quantity` on top of whatever this item already contributes. */
  "trade:offer:add-item": (data: TradeOfferItemAction & { quantity: number }) => void;
  /** Sets an absolute quantity; 0 removes the entry. */
  "trade:offer:update-item": (data: TradeOfferItemAction & { quantity: number }) => void;
  "trade:offer:remove-item": (data: TradeOfferItemAction) => void;

  "trade:offer:add-venomon": (data: TradeActionEnvelope & { venomonId: string }) => void;
  "trade:offer:remove-venomon": (data: TradeActionEnvelope & { venomonId: string }) => void;

  /** Absolute, non-negative integer amount of game money. */
  "trade:offer:set-currency": (data: TradeActionEnvelope & { amount: number }) => void;

  "trade:offer:lock": (data: TradeActionEnvelope) => void;
  "trade:offer:unlock": (data: TradeActionEnvelope) => void;

  /**
   * Final confirmation. Must echo the exact `snapshotHash` the server issued
   * with `trade:confirmation:started`; a mismatch means the offer moved.
   */
  "trade:confirm": (data: TradeActionEnvelope & { snapshotHash: string }) => void;

  "trade:cancel": (data: { tradeId: string; requestId?: string }) => void;

  /** Private, participants-only chat for one trade session. */
  "trade:chat:send": (data: { tradeId: string; text: string; requestId?: string }) => void;

  /** Requests the authoritative trade state (reconnect, window reopen). */
  "trade:sync": (data?: { tradeId?: string }) => void;

  /** Paginated player-facing trade history. */
  "trade:history": (data?: { page?: number; pageSize?: number }) => void;

  /** Reports a completed or failed trade for moderation review. */
  "trade:report": (data: { tradeId: string; reason: string; explanation?: string }) => void;

  // ---- Moderation (requires moderator.access) ------------------------------
  "moderation:trades:search": (data?: {
    userId?: number;
    tradeId?: string;
    page?: number;
    pageSize?: number;
  }) => void;
  "moderation:trades:detail": (data: { tradeId: string }) => void;
  "moderation:trades:note": (data: { tradeId: string; text: string }) => void;
  "moderation:trades:set-restriction": (data: {
    userId: number;
    disabled: boolean;
    reason?: string;
  }) => void;
  "moderation:trades:reports": (data?: { page?: number; pageSize?: number }) => void;
}

/** Common fields on every trade action (see TRADING.md §Concurrency). */
export interface TradeActionEnvelope {
  tradeId: string;
  /** The version the client is acting on; a mismatch is rejected. */
  expectedVersion: number;
  /** Unique per user action — replays of the same id are dropped. */
  requestId?: string;
}

export interface TradeOfferItemAction extends TradeActionEnvelope {
  itemId: string;
}
