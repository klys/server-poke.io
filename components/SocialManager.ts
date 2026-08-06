import crypto from "crypto";
import type { Server } from "socket.io";
import type Auth from "./Auth";
import type { BlockedAccountEntry, SocialPrefs, SocialUserSummary } from "./Auth";
import type BattleManager from "./BattleManager";
import type EventRuntime from "./EventRuntime";
import { resolveInitialSpawnFromPlayableMapsState } from "./PlayableMapsState";
import type Player from "./player";
import type World from "./world";
import type ClientToServerEvents from "../Server/ClientToServerEvents";
import type InterServerEvents from "../Server/InterServerEvents";
import type { SocketData } from "../Server/registerSocketHandlers";
import type ServerToClientEvents from "../Server/ServerToClientEvents";

type TypedSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface FriendEntry extends SocialUserSummary {
  online: boolean;
  mapId?: string;
  playerId?: string;
  /** Active character shown to friends (null when hidden by privacy prefs). */
  activeCharacterId: number | null;
  activeCharacterName: string | null;
  /** Last-seen timestamp shown while offline (null when hidden by prefs). */
  lastSeenAt: string | null;
}

export interface FriendsStatePayload {
  friends: FriendEntry[];
  incoming: Array<SocialUserSummary & { createdAt: string }>;
  outgoing: Array<SocialUserSummary & { createdAt: string }>;
  prefs: SocialPrefs;
  /** Account-level block list: every character of these accounts is blocked. */
  blocked: BlockedAccountEntry[];
}

export interface ChatMessagePayload {
  id: string;
  channel: "map" | "whisper" | "global" | "system";
  mapId?: string;
  fromUserId?: number;
  fromUsername?: string;
  fromName?: string;
  /** Account/character identity of the sender, stated explicitly. */
  fromAccountId?: number;
  fromAccountName?: string;
  fromCharacterId?: number;
  fromCharacterName?: string;
  toUsername?: string;
  text: string;
  at: string;
}

export interface PrivateChatMemberEntry extends SocialUserSummary {
  online: boolean;
}

export interface PrivateChatStatePayload {
  chatId: string;
  members: PrivateChatMemberEntry[];
  pendingUsernames: string[];
}

interface PendingTeleportRequest {
  id: string;
  requesterUserId: number;
  targetUserId: number;
  timeout: NodeJS.Timeout;
}

interface PendingChatInvite {
  id: string;
  chatId: string;
  fromUserId: number;
  targetUserId: number;
  timeout: NodeJS.Timeout;
}

interface PrivateChat {
  id: string;
  memberUserIds: Set<number>;
  pendingInviteIds: Set<string>;
}

const REQUEST_TTL_MS = 60_000;
const CHAT_INVITE_TTL_MS = 120_000;
const MAX_CHAT_MESSAGE_LENGTH = 300;
const MAX_PRIVATE_CHAT_MEMBERS = 12;
// Simple sliding-window rate limit shared by every chat channel.
const RATE_LIMIT_WINDOW_MS = 5_000;
const RATE_LIMIT_MAX_MESSAGES = 6;

/**
 * Friends lists, friend requests, map/private/whisper chat, chat invitations
 * and teleport-to-friend approval. Friendships and pending friend requests are
 * persisted through Auth (Redis); everything conversational (private chat
 * sessions, invites, teleport requests) is in-memory and expires with the
 * session, mirroring how battle challenges already work.
 */
export default class SocialManager {
  private readonly teleportRequests = new Map<string, PendingTeleportRequest>();
  private readonly chatInvites = new Map<string, PendingChatInvite>();
  private readonly privateChats = new Map<string, PrivateChat>();
  private readonly messageTimestampsByUserId = new Map<number, number[]>();

  constructor(
    private readonly io: TypedSocketServer,
    private readonly world: World,
    private readonly auth: Auth,
    private readonly battleManager: BattleManager,
    private readonly eventRuntime: EventRuntime
  ) {}

  // ---- presence hooks (called from registerSocketHandlers) ----

  /** First socket of a user entered the world: hydrate them + tell friends. */
  public async handlePlayerJoined(userId: number) {
    try {
      await this.pushFriendsState(userId);
      await this.notifyFriendsPresence(userId);
    } catch (error) {
      console.error("social: unable to run join hooks:", error);
    }
  }

  /** Last socket of a user left the world. */
  public async handlePlayerLeft(userId: number) {
    try {
      this.cancelPendingForUser(userId);
      this.leaveAllChats(userId);
      await this.auth.touchLastSeen(userId);
      await this.notifyFriendsPresence(userId);
    } catch (error) {
      console.error("social: unable to run leave hooks:", error);
    }
  }

  /** Player changed maps (any teleport/portal/fly/blackout transfer). */
  public handlePlayerMapChanged(player: Player) {
    if (typeof player.userId !== "number") {
      return;
    }
    void this.notifyFriendsPresence(player.userId).catch((error) => {
      console.error("social: unable to broadcast map change:", error);
    });
  }

  // ---- friends ----

  public async sendFriendsState(userId: number) {
    await this.pushFriendsState(userId);
  }

  /**
   * Sends a friend request. The target may be named by account name or, when
   * initiated through a visible character (trainer card), by account id — a
   * character always resolves to its owning account, so the request and the
   * eventual friendship are account-to-account.
   */
  public async requestFriend(userId: number, rawUsername: string, targetAccountId?: number) {
    const me = await this.auth.getSocialUserSummary(userId);
    const target =
      Number.isInteger(targetAccountId) && (targetAccountId as number) > 0
        ? await this.auth.getSocialUserSummary(targetAccountId as number)
        : await this.auth.findSocialUserByUsername(rawUsername);
    if (!me) {
      return;
    }
    if (!target) {
      this.emitToUser(userId, "friends:error", { message: "No trainer goes by that name." });
      return;
    }
    if (target.userId === userId) {
      // Also covers "another character owned by the same account": characters
      // resolve to their account before this comparison.
      this.emitToUser(userId, "friends:error", { message: "You cannot befriend yourself." });
      return;
    }
    if (await this.auth.isBlockedEitherWay(userId, target.userId)) {
      // Same message as an unknown name: a block must not be discoverable.
      this.emitToUser(userId, "friends:error", { message: "No trainer goes by that name." });
      return;
    }
    if (await this.auth.areFriends(userId, target.userId)) {
      this.emitToUser(userId, "friends:error", { message: `${target.username} is already your friend.` });
      return;
    }

    // If they already asked us, treat this as accepting their request.
    const myIncoming = await this.auth.getIncomingFriendRequests(userId);
    if (myIncoming.some((request) => request.userId === target.userId)) {
      await this.respondToFriendRequest(userId, target.userId, true);
      return;
    }

    const targetPrefs = await this.auth.getSocialPrefs(target.userId);
    if (!targetPrefs.allowFriendRequests) {
      this.emitToUser(userId, "friends:error", {
        message: `${target.username} is not accepting friend requests.`
      });
      return;
    }

    const added = await this.auth.addFriendRequest(me, target);
    if (!added) {
      this.emitToUser(userId, "friends:error", {
        message: `You already sent ${target.username} a friend request.`
      });
      return;
    }

    this.emitToUser(target.userId, "friends:request-received", { from: me });
    await Promise.all([this.pushFriendsState(userId), this.pushFriendsState(target.userId)]);
  }

  public async respondToFriendRequest(userId: number, fromUserId: number, accepted: boolean) {
    const incoming = await this.auth.getIncomingFriendRequests(userId);
    const request = incoming.find((entry) => entry.userId === fromUserId);
    if (!request) {
      this.emitToUser(userId, "friends:error", { message: "That friend request is no longer pending." });
      return;
    }

    await this.auth.removeFriendRequest(fromUserId, userId);
    if (accepted) {
      if (await this.auth.isBlockedEitherWay(userId, fromUserId)) {
        this.emitToUser(userId, "friends:error", { message: "That friend request is no longer pending." });
        await this.pushFriendsState(userId);
        return;
      }
      await this.auth.addFriendPair(userId, fromUserId);
      const me = await this.auth.getSocialUserSummary(userId);
      if (me) {
        this.emitToUser(fromUserId, "friends:request-accepted", { by: me });
      }
    }
    await Promise.all([this.pushFriendsState(userId), this.pushFriendsState(fromUserId)]);
  }

  // ---- account-level blocking ----

  public async blockAccount(userId: number, targetAccountId: number) {
    const result = await this.auth.blockAccount(userId, Number(targetAccountId));
    if (!result.ok) {
      this.emitToUser(userId, "friends:error", { message: result.message });
      return;
    }
    // The other side's friends list loses this account; both sides refresh.
    this.emitToUser(Number(targetAccountId), "friends:removed", { userId });
    await Promise.all([
      this.pushFriendsState(userId),
      this.pushFriendsState(Number(targetAccountId))
    ]);
  }

  public async unblockAccount(userId: number, targetAccountId: number) {
    const changed = await this.auth.unblockAccount(userId, Number(targetAccountId));
    if (!changed) {
      this.emitToUser(userId, "friends:error", { message: "That account is not blocked." });
      return;
    }
    await this.pushFriendsState(userId);
  }

  /** Cancels a friend request the user sent earlier. */
  public async cancelFriendRequest(userId: number, targetUserId: number) {
    await this.auth.removeFriendRequest(userId, targetUserId);
    await Promise.all([this.pushFriendsState(userId), this.pushFriendsState(targetUserId)]);
  }

  public async removeFriend(userId: number, friendUserId: number) {
    if (!(await this.auth.areFriends(userId, friendUserId))) {
      this.emitToUser(userId, "friends:error", { message: "That trainer is not on your friends list." });
      return;
    }
    await this.auth.removeFriendPair(userId, friendUserId);
    this.emitToUser(friendUserId, "friends:removed", { userId });
    await Promise.all([this.pushFriendsState(userId), this.pushFriendsState(friendUserId)]);
  }

  public async updateSocialPrefs(userId: number, updates: Partial<SocialPrefs>) {
    await this.auth.setSocialPrefs(userId, updates);
    await this.pushFriendsState(userId);
  }

  // ---- teleport to friend ----

  public async requestTeleport(userId: number, targetUserId: number) {
    if (!(await this.auth.areFriends(userId, targetUserId))) {
      this.emitToUser(userId, "friends:error", { message: "You can only teleport to friends." });
      return;
    }
    const requester = this.world.getPlayerByUserId(userId);
    const target = this.world.getPlayerByUserId(targetUserId);
    if (!requester) {
      return;
    }
    if (!target) {
      this.emitToUser(userId, "friends:error", { message: "That friend is not online right now." });
      return;
    }
    if (requester.inBattle || this.battleManager.isPlayerBattling(requester.socketId)) {
      this.emitToUser(userId, "friends:error", { message: "You cannot teleport during a battle." });
      return;
    }
    const targetPrefs = await this.auth.getSocialPrefs(targetUserId);
    if (!targetPrefs.allowTeleportRequests) {
      this.emitToUser(userId, "friends:error", {
        message: "That friend is not accepting teleport requests."
      });
      return;
    }
    const alreadyPending = Array.from(this.teleportRequests.values()).some(
      (entry) => entry.requesterUserId === userId && entry.targetUserId === targetUserId
    );
    if (alreadyPending) {
      this.emitToUser(userId, "friends:error", { message: "You already asked to teleport to that friend." });
      return;
    }

    const me = await this.auth.getSocialUserSummary(userId);
    if (!me) {
      return;
    }
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      if (this.teleportRequests.delete(requestId)) {
        this.emitToUser(userId, "friends:teleport-response", {
          requestId,
          accepted: false,
          byUsername: "",
          expired: true
        });
      }
    }, REQUEST_TTL_MS);
    this.teleportRequests.set(requestId, {
      id: requestId,
      requesterUserId: userId,
      targetUserId,
      timeout
    });
    this.emitToUser(targetUserId, "friends:teleport-request", { requestId, from: me });
  }

  public async respondToTeleport(userId: number, requestId: string, accepted: boolean) {
    const request = this.teleportRequests.get(requestId);
    if (!request || request.targetUserId !== userId) {
      this.emitToUser(userId, "friends:error", { message: "That teleport request is no longer pending." });
      return;
    }
    clearTimeout(request.timeout);
    this.teleportRequests.delete(requestId);

    const responder = await this.auth.getSocialUserSummary(userId);
    const byUsername = responder?.username ?? "";
    if (!accepted) {
      this.emitToUser(request.requesterUserId, "friends:teleport-response", {
        requestId,
        accepted: false,
        byUsername,
        expired: false
      });
      return;
    }

    const requester = this.world.getPlayerByUserId(request.requesterUserId);
    const target = this.world.getPlayerByUserId(request.targetUserId);
    if (!requester || !target) {
      this.emitToUser(request.requesterUserId, "friends:error", {
        message: "Teleport failed: one of you left the game."
      });
      return;
    }
    if (requester.inBattle || this.battleManager.isPlayerBattling(requester.socketId)) {
      this.emitToUser(request.requesterUserId, "friends:error", {
        message: "You cannot teleport during a battle."
      });
      return;
    }

    this.transferPlayer(requester, target.currentMapId, target.x, target.y);
    this.emitToUser(request.requesterUserId, "friends:teleport-response", {
      requestId,
      accepted: true,
      byUsername,
      expired: false
    });
  }

  // ---- map chat + commands ----

  public async handleMapMessage(socket: { data: SocketData; id: string }, rawText: string) {
    const player = this.world.getPlayerBySocket(socket.id);
    const userId = socket.data.userId;
    if (!player || typeof userId !== "number") {
      this.emitToSocket(socket.id, "chat:error", { message: "Log in to use the chat." });
      return;
    }

    const text = this.sanitizeMessage(rawText);
    if (!text) {
      return;
    }
    if (!this.checkRateLimit(userId)) {
      this.emitToSocket(socket.id, "chat:error", { message: "You are sending messages too quickly." });
      return;
    }

    if (text.startsWith("/")) {
      await this.handleChatCommand(socket, player, userId, text);
      return;
    }

    const payload: ChatMessagePayload = {
      id: crypto.randomUUID(),
      channel: "map",
      mapId: player.currentMapId,
      fromUserId: userId,
      fromUsername: player.username || "",
      fromName: player.name || player.username || "Trainer",
      fromAccountId: userId,
      fromAccountName: player.username || "",
      fromCharacterId: player.characterId ?? undefined,
      fromCharacterName: player.name || player.username || "Trainer",
      text,
      at: new Date().toISOString()
    };
    await this.emitToMapRespectingBlocks(player.currentMapId, userId, payload);
  }

  /**
   * Map-chat delivery that honors account blocks in both directions: a
   * blocked account's characters neither reach nor hear the blocker.
   */
  private async emitToMapRespectingBlocks(
    mapId: string,
    senderUserId: number,
    payload: ChatMessagePayload
  ) {
    const recipients: Player[] = [];
    for (const candidate of this.world.players.values()) {
      if (candidate.currentMapId === mapId) {
        recipients.push(candidate);
      }
    }
    await Promise.all(
      recipients.map(async (recipient) => {
        if (typeof recipient.userId === "number" && recipient.userId !== senderUserId) {
          if (await this.auth.isBlockedEitherWay(senderUserId, recipient.userId)) {
            return;
          }
        }
        this.emitToSocket(recipient.socketId, "chat:message", payload);
      })
    );
  }

  private async handleChatCommand(
    socket: { data: SocketData; id: string },
    player: Player,
    userId: number,
    text: string
  ) {
    const spaceIndex = text.indexOf(" ");
    const command = (spaceIndex === -1 ? text : text.slice(0, spaceIndex)).toLowerCase();
    const rest = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

    if (command === "/w" || command === "/whisper") {
      const targetSpace = rest.indexOf(" ");
      const targetName = targetSpace === -1 ? rest : rest.slice(0, targetSpace);
      const message = targetSpace === -1 ? "" : rest.slice(targetSpace + 1).trim();
      if (!targetName || !message) {
        this.emitToSocket(socket.id, "chat:error", { message: "Usage: /w <user_name> <message>" });
        return;
      }
      await this.sendWhisper(player, userId, targetName, message);
      return;
    }

    if (command === "/global") {
      const canBroadcast =
        socket.data.permissions?.includes("moderator.access") ||
        socket.data.permissions?.includes("admin.access");
      if (!canBroadcast) {
        this.emitToSocket(socket.id, "chat:error", {
          message: "Only moderators and admins can send global messages."
        });
        return;
      }
      if (!rest) {
        this.emitToSocket(socket.id, "chat:error", { message: "Usage: /global <message>" });
        return;
      }
      const payload: ChatMessagePayload = {
        id: crypto.randomUUID(),
        channel: "global",
        fromUserId: userId,
        fromUsername: player.username || "",
        fromName: player.name || player.username || "Moderator",
        text: rest,
        at: new Date().toISOString()
      };
      this.io.emit("chat:message", payload);
      return;
    }

    if (command === "/help" || command === "/ayuda") {
      await this.returnToSafety(socket, player, userId);
      return;
    }

    this.emitToSocket(socket.id, "chat:error", { message: `Unknown command: ${command}` });
  }

  private async sendWhisper(fromPlayer: Player, fromUserId: number, targetName: string, message: string) {
    const normalized = targetName.trim().toLowerCase();
    let target: Player | undefined;
    for (const candidate of this.world.players.values()) {
      if (
        (candidate.username || "").toLowerCase() === normalized ||
        (candidate.name || "").toLowerCase() === normalized
      ) {
        target = candidate;
        break;
      }
    }
    if (!target || typeof target.userId !== "number") {
      this.emitToUser(fromUserId, "chat:error", { message: `${targetName} is not online.` });
      return;
    }
    if (target.userId === fromUserId) {
      this.emitToUser(fromUserId, "chat:error", { message: "You cannot whisper to yourself." });
      return;
    }
    if (await this.auth.isBlockedEitherWay(fromUserId, target.userId)) {
      // Indistinguishable from the target being offline.
      this.emitToUser(fromUserId, "chat:error", { message: `${targetName} is not online.` });
      return;
    }
    const payload: ChatMessagePayload = {
      id: crypto.randomUUID(),
      channel: "whisper",
      fromUserId,
      fromUsername: fromPlayer.username || "",
      fromName: fromPlayer.name || fromPlayer.username || "Trainer",
      fromAccountId: fromUserId,
      fromAccountName: fromPlayer.username || "",
      fromCharacterId: fromPlayer.characterId ?? undefined,
      fromCharacterName: fromPlayer.name || fromPlayer.username || "Trainer",
      toUsername: target.username || target.name || "",
      text: message,
      at: new Date().toISOString()
    };
    this.emitToUser(target.userId, "chat:message", payload);
    this.emitToUser(fromUserId, "chat:message", payload);
  }

  /**
   * /help (/ayuda): returns the player to their last visited Venomon Center,
   * mirroring the blackout teleport (without healing or money loss).
   */
  private async returnToSafety(socket: { data: SocketData; id: string }, player: Player, userId: number) {
    if (player.inBattle || this.battleManager.isPlayerBattling(player.socketId)) {
      this.emitToSocket(socket.id, "chat:error", { message: "You cannot use this during a battle." });
      return;
    }
    const respawn = await this.auth.getRespawnPoint(userId);
    const mapsState = this.world.getPlayableMapsState();
    const fallback = mapsState ? resolveInitialSpawnFromPlayableMapsState(mapsState) : null;
    const destination = respawn ?? fallback;
    if (!destination) {
      this.emitToSocket(socket.id, "chat:error", { message: "No safe place to return to yet." });
      return;
    }
    this.transferPlayer(player, destination.mapId, destination.x, destination.y);
    this.emitToUser(userId, "chat:message", {
      id: crypto.randomUUID(),
      channel: "system",
      text: "You returned to the last Venomon Center you visited.",
      at: new Date().toISOString()
    });
  }

  // ---- private chats ----

  public async createPrivateChat(userId: number, targetUserIds: number[]) {
    const targets = Array.from(
      new Set(
        (Array.isArray(targetUserIds) ? targetUserIds : [])
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0 && value !== userId)
      )
    );
    if (targets.length === 0) {
      this.emitToUser(userId, "chat:error", { message: "Pick at least one trainer to chat with." });
      return;
    }
    if (targets.length + 1 > MAX_PRIVATE_CHAT_MEMBERS) {
      this.emitToUser(userId, "chat:error", { message: "That chat would have too many members." });
      return;
    }

    const chat: PrivateChat = {
      id: crypto.randomUUID(),
      memberUserIds: new Set([userId]),
      pendingInviteIds: new Set()
    };
    this.privateChats.set(chat.id, chat);
    await this.broadcastPrivateChatState(chat);
    for (const targetUserId of targets) {
      await this.inviteToPrivateChat(userId, chat.id, targetUserId);
    }
  }

  public async inviteToPrivateChat(userId: number, chatId: string, targetUserId: number) {
    const chat = this.privateChats.get(chatId);
    if (!chat || !chat.memberUserIds.has(userId)) {
      this.emitToUser(userId, "chat:error", { message: "You are not part of that chat." });
      return;
    }
    if (chat.memberUserIds.has(targetUserId)) {
      this.emitToUser(userId, "chat:error", { message: "That trainer already joined the chat." });
      return;
    }
    if (chat.memberUserIds.size + chat.pendingInviteIds.size >= MAX_PRIVATE_CHAT_MEMBERS) {
      this.emitToUser(userId, "chat:error", { message: "That chat would have too many members." });
      return;
    }
    const target = this.world.getPlayerByUserId(targetUserId);
    if (!target) {
      this.emitToUser(userId, "chat:error", { message: "That trainer is not online right now." });
      return;
    }
    const alreadyInvited = Array.from(this.chatInvites.values()).some(
      (invite) => invite.chatId === chatId && invite.targetUserId === targetUserId
    );
    if (alreadyInvited) {
      this.emitToUser(userId, "chat:error", { message: "That trainer was already invited." });
      return;
    }
    if (await this.auth.isBlockedEitherWay(userId, targetUserId)) {
      this.emitToUser(userId, "chat:error", { message: "That trainer is not online right now." });
      return;
    }
    const targetPrefs = await this.auth.getSocialPrefs(targetUserId);
    if (!targetPrefs.allowChatInvites) {
      this.emitToUser(userId, "chat:error", { message: "That trainer is not accepting chat invitations." });
      return;
    }

    const from = await this.auth.getSocialUserSummary(userId);
    if (!from) {
      return;
    }
    const inviteId = crypto.randomUUID();
    const invite: PendingChatInvite = {
      id: inviteId,
      chatId,
      fromUserId: userId,
      targetUserId,
      timeout: setTimeout(() => {
        void this.expireChatInvite(inviteId);
      }, CHAT_INVITE_TTL_MS)
    };
    this.chatInvites.set(invite.id, invite);
    chat.pendingInviteIds.add(invite.id);
    this.emitToUser(targetUserId, "chat:invite-received", {
      inviteId: invite.id,
      chatId,
      from,
      memberCount: chat.memberUserIds.size
    });
    await this.broadcastPrivateChatState(chat);
  }

  public async respondToChatInvite(userId: number, inviteId: string, accepted: boolean) {
    const invite = this.chatInvites.get(inviteId);
    if (!invite || invite.targetUserId !== userId) {
      this.emitToUser(userId, "chat:error", { message: "That chat invitation is no longer pending." });
      return;
    }
    clearTimeout(invite.timeout);
    this.chatInvites.delete(inviteId);
    const chat = this.privateChats.get(invite.chatId);
    if (!chat) {
      return;
    }
    chat.pendingInviteIds.delete(inviteId);

    const responder = await this.auth.getSocialUserSummary(userId);
    if (!accepted) {
      this.emitToUser(invite.fromUserId, "chat:invite-response", {
        inviteId,
        chatId: chat.id,
        accepted: false,
        byUsername: responder?.username ?? ""
      });
      await this.broadcastPrivateChatState(chat);
      return;
    }

    chat.memberUserIds.add(userId);
    this.emitToUser(invite.fromUserId, "chat:invite-response", {
      inviteId,
      chatId: chat.id,
      accepted: true,
      byUsername: responder?.username ?? ""
    });
    await this.broadcastPrivateChatState(chat);
  }

  public async sendPrivateChatMessage(userId: number, chatId: string, rawText: string) {
    const chat = this.privateChats.get(chatId);
    if (!chat || !chat.memberUserIds.has(userId)) {
      this.emitToUser(userId, "chat:error", { message: "You are not part of that chat." });
      return;
    }
    const text = this.sanitizeMessage(rawText);
    if (!text) {
      return;
    }
    if (!this.checkRateLimit(userId)) {
      this.emitToUser(userId, "chat:error", { message: "You are sending messages too quickly." });
      return;
    }
    const from = await this.auth.getSocialUserSummary(userId);
    if (!from) {
      return;
    }
    const payload = {
      chatId,
      id: crypto.randomUUID(),
      fromUserId: userId,
      fromUsername: from.username,
      fromName: from.name,
      fromAccountId: from.accountId,
      fromAccountName: from.accountName,
      fromCharacterId: from.characterId,
      fromCharacterName: from.characterName,
      text,
      at: new Date().toISOString()
    };
    for (const memberUserId of chat.memberUserIds) {
      // Blocks that happened after the chat formed still silence both ways.
      if (memberUserId !== userId && (await this.auth.isBlockedEitherWay(userId, memberUserId))) {
        continue;
      }
      this.emitToUser(memberUserId, "chat:private-message", payload);
    }
  }

  public async leavePrivateChat(userId: number, chatId: string) {
    const chat = this.privateChats.get(chatId);
    if (!chat || !chat.memberUserIds.has(userId)) {
      return;
    }
    chat.memberUserIds.delete(userId);
    this.emitToUser(userId, "chat:private-closed", { chatId });
    if (chat.memberUserIds.size === 0) {
      this.disposeChat(chat);
      return;
    }
    await this.broadcastPrivateChatState(chat);
  }

  // ---- internals ----

  private async pushFriendsState(userId: number) {
    const [friendIds, incoming, outgoing, prefs, blocked] = await Promise.all([
      this.auth.getFriendIds(userId),
      this.auth.getIncomingFriendRequests(userId),
      this.auth.getOutgoingFriendRequests(userId),
      this.auth.getSocialPrefs(userId),
      this.auth.getBlockedAccountEntries(userId)
    ]);
    const friends: FriendEntry[] = [];
    for (const friendId of friendIds) {
      const entry = await this.buildFriendEntry(friendId);
      if (entry) {
        friends.push(entry);
      }
    }
    this.emitToUser(userId, "friends:state", { friends, incoming, outgoing, prefs, blocked });
  }

  /**
   * One friend row, filtered through THAT friend's privacy prefs: online
   * status, active character, current map, and last-seen are each shown only
   * when the friend allows it.
   */
  private async buildFriendEntry(friendId: number): Promise<FriendEntry | null> {
    const summary = await this.auth.getSocialUserSummary(friendId);
    if (!summary) {
      return null;
    }
    const prefs = await this.auth.getSocialPrefs(friendId);
    const online = prefs.showOnlineStatus ? this.world.getPlayerByUserId(friendId) : undefined;
    const showCharacter = prefs.showActiveCharacter;
    return {
      ...summary,
      // The character-facing display fields obey the same privacy switch.
      name: showCharacter ? summary.name : summary.username,
      characterName: showCharacter ? summary.characterName : "",
      characterSkinId: showCharacter ? summary.characterSkinId : "",
      online: Boolean(online),
      mapId: prefs.showCurrentMap ? online?.currentMapId : undefined,
      playerId: online?.socketId,
      activeCharacterId: online && showCharacter ? summary.characterId : null,
      activeCharacterName: showCharacter ? summary.characterName : null,
      lastSeenAt: !online && prefs.showLastSeen ? await this.auth.getLastSeenAt(friendId) : null
    };
  }

  /** Sends a light presence update about `userId` to their online friends. */
  private async notifyFriendsPresence(userId: number) {
    const friendIds = await this.auth.getFriendIds(userId);
    if (friendIds.length === 0) {
      return;
    }
    const [summary, prefs] = await Promise.all([
      this.auth.getSocialUserSummary(userId),
      this.auth.getSocialPrefs(userId)
    ]);
    const player = prefs.showOnlineStatus ? this.world.getPlayerByUserId(userId) : undefined;
    const showCharacter = prefs.showActiveCharacter;
    const payload = {
      userId,
      accountId: userId,
      accountName: summary?.accountName ?? "",
      online: Boolean(player),
      mapId: prefs.showCurrentMap ? player?.currentMapId : undefined,
      playerId: player?.socketId,
      activeCharacterId: player && showCharacter ? summary?.characterId ?? null : null,
      activeCharacterName: showCharacter ? summary?.characterName ?? null : null,
      lastSeenAt: !player && prefs.showLastSeen ? await this.auth.getLastSeenAt(userId) : null
    };
    for (const friendId of friendIds) {
      if (this.world.getPlayerByUserId(friendId)) {
        this.emitToUser(friendId, "friends:presence", payload);
      }
    }
  }

  private cancelPendingForUser(userId: number) {
    for (const [id, request] of this.teleportRequests) {
      if (request.requesterUserId === userId || request.targetUserId === userId) {
        clearTimeout(request.timeout);
        this.teleportRequests.delete(id);
        const otherUserId =
          request.requesterUserId === userId ? request.targetUserId : request.requesterUserId;
        this.emitToUser(otherUserId, "friends:teleport-response", {
          requestId: id,
          accepted: false,
          byUsername: "",
          expired: true
        });
      }
    }
    for (const [id, invite] of this.chatInvites) {
      if (invite.targetUserId === userId) {
        void this.expireChatInvite(id);
      }
    }
    this.messageTimestampsByUserId.delete(userId);
  }

  private leaveAllChats(userId: number) {
    for (const chat of Array.from(this.privateChats.values())) {
      if (chat.memberUserIds.has(userId)) {
        chat.memberUserIds.delete(userId);
        if (chat.memberUserIds.size === 0) {
          this.disposeChat(chat);
        } else {
          void this.broadcastPrivateChatState(chat);
        }
      }
    }
  }

  private disposeChat(chat: PrivateChat) {
    for (const inviteId of chat.pendingInviteIds) {
      const invite = this.chatInvites.get(inviteId);
      if (invite) {
        clearTimeout(invite.timeout);
        this.chatInvites.delete(inviteId);
      }
    }
    this.privateChats.delete(chat.id);
  }

  private async expireChatInvite(inviteId: string) {
    const invite = this.chatInvites.get(inviteId);
    if (!invite) {
      return;
    }
    clearTimeout(invite.timeout);
    this.chatInvites.delete(inviteId);
    const chat = this.privateChats.get(invite.chatId);
    if (chat) {
      chat.pendingInviteIds.delete(inviteId);
      this.emitToUser(invite.fromUserId, "chat:invite-response", {
        inviteId,
        chatId: invite.chatId,
        accepted: false,
        byUsername: ""
      });
      await this.broadcastPrivateChatState(chat);
    }
  }

  private async broadcastPrivateChatState(chat: PrivateChat) {
    const members: PrivateChatMemberEntry[] = [];
    for (const memberUserId of chat.memberUserIds) {
      const summary = await this.auth.getSocialUserSummary(memberUserId);
      if (summary) {
        members.push({ ...summary, online: Boolean(this.world.getPlayerByUserId(memberUserId)) });
      }
    }
    const pendingUsernames: string[] = [];
    for (const inviteId of chat.pendingInviteIds) {
      const invite = this.chatInvites.get(inviteId);
      if (invite) {
        const summary = await this.auth.getSocialUserSummary(invite.targetUserId);
        if (summary) {
          pendingUsernames.push(summary.username);
        }
      }
    }
    const payload: PrivateChatStatePayload = { chatId: chat.id, members, pendingUsernames };
    for (const memberUserId of chat.memberUserIds) {
      this.emitToUser(memberUserId, "chat:private-state", payload);
    }
  }

  /** Same transfer recipe as portals / player:teleport / blackout. */
  private transferPlayer(player: Player, mapId: string, x: number, y: number) {
    player.stopMovement();
    player.teleport(mapId, x, y);
    this.world.players.set(player.socketId, player);
    this.world.presentPlayerToMap(player);
    player.socketConnections.forEach((socketId) => {
      this.world.presentPlayersOnMapTo(socketId, player.currentMapId);
    });
    if (typeof player.userId === "number") {
      void this.eventRuntime.runAutorunForMap(player.userId);
    }
  }

  private sanitizeMessage(rawText: unknown): string {
    if (typeof rawText !== "string") {
      return "";
    }
    // eslint-disable-next-line no-control-regex
    return rawText.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
  }

  private checkRateLimit(userId: number): boolean {
    const now = Date.now();
    const timestamps = (this.messageTimestampsByUserId.get(userId) ?? []).filter(
      (at) => now - at < RATE_LIMIT_WINDOW_MS
    );
    if (timestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
      this.messageTimestampsByUserId.set(userId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.messageTimestampsByUserId.set(userId, timestamps);
    return true;
  }

  private emitToUser<EventName extends keyof ServerToClientEvents>(
    userId: number,
    eventName: EventName,
    payload: Parameters<ServerToClientEvents[EventName]>[0]
  ) {
    for (const candidate of this.io.sockets.sockets.values()) {
      if (candidate.data.userId === userId) {
        (candidate as any).emit(eventName, payload);
      }
    }
  }

  private emitToSocket<EventName extends keyof ServerToClientEvents>(
    socketId: string,
    eventName: EventName,
    payload: Parameters<ServerToClientEvents[EventName]>[0]
  ) {
    (this.io.in(socketId) as any).emit(eventName, payload);
  }
}
