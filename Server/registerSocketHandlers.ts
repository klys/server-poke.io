import { berryProfile, RIPE_STAGE } from "../components/BerryPlots";
import { isHouseInstanceMapId, templateMapIdFor } from "../components/Housing";
import { registerHousingHandlers } from "./registerHousingHandlers";
import type Player from "../components/player";
import type { RedisClientType } from "redis";
import { type Server, type Socket } from "socket.io";
import Auth, {
  DEFAULT_GLOBAL_SETTINGS,
  type AuthenticatedUser,
  type RolePermission,
  type UserRoleKey
} from "../components/Auth";
import BattleManager from "../components/BattleManager";
import EventRuntime from "../components/EventRuntime";
import DesignerSectionStore, {
  isDesignerSectionKey,
  sanitizeDesignerSectionPatchOps,
  type DesignerSectionKey,
  type DesignerSectionSyncPayload,
} from "../components/DesignerSectionStore";
import type GroundItemStore from "../components/GroundItemStore";
import type MapAssetStore from "../components/MapAssetStore";
import PlayableMapsStore, {
  applyPlayableMapsStateToWorld,
  type PlayableMapsSyncPayload,
} from "../components/PlayableMapsStore";
import {
  resolveFlyDestinations,
  resolveInitialSpawnFromPlayableMapsState,
  resolvePlayableMapPortalDestination,
} from "../components/PlayableMapsState";
import SocialManager from "../components/SocialManager";
import TradeManager from "../components/TradeManager";
import { speciesCharsetName } from "../components/generated/speciesDex";
import { TradeError, type TradeMutationSource } from "../components/trade/tradeTypes";
import World from "../components/world";
import MaintenanceRunner, { MAINTENANCE_SERVER_ROOT, type MaintenanceRunRecord } from "../components/MaintenanceRunner";
import { buildMaintenanceReport, collectRunArtifacts } from "../components/MaintenanceReport";
import type MailService from "../components/MailService";
import PokecraftApiClient, {
  PokecraftApiError,
  type ApiKeyScope,
} from "../components/PokecraftApiClient";
import ClientToServerEvents from "./ClientToServerEvents";
import InterServerEvents from "./InterServerEvents";
import ServerToClientEvents from "./ServerToClientEvents";

export interface SocketData {
  authenticated: boolean;
  token?: string;
  userId?: number;
  username?: string;
  email?: string;
  /** Active character of this session (resolved at addPlayer / select). */
  characterId?: number;
  role?: UserRoleKey;
  permissions?: RolePermission[];
  /** Client platform from the handshake: "android" | "ios" | "electron" | "web". */
  platform?: string;
}

// Native app builds (Capacitor/Electron) ship the heavy shared payloads
// (playable maps, public designer sections) bundled inside the app, so the
// server must not stream full states to them — a version payload is enough
// and the client refreshes over cacheable HTTP when it really is stale.
const NATIVE_PLATFORMS = new Set(["android", "ios", "electron"]);

function isNativeClient(socket:ServerSocket) {
  return NATIVE_PLATFORMS.has(socket.data.platform ?? "");
}

type ServerSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type TypedSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

function applySocketAuth(socketData:SocketData, user:AuthenticatedUser | null) {
  socketData.authenticated = Boolean(user);

  if (!user) {
    delete socketData.token;
    delete socketData.userId;
    delete socketData.username;
    delete socketData.email;
    delete socketData.characterId;
    delete socketData.role;
    delete socketData.permissions;
    return;
  }

  socketData.userId = user.id;
  socketData.username = user.username;
  socketData.email = user.email;
  socketData.characterId = user.characterId;
  socketData.role = user.role;
  socketData.permissions = user.permissions;
}

function readSocketToken(socket:ServerSocket) {
  const handshakeToken = socket.handshake.auth?.token;
  if (typeof handshakeToken === "string" && handshakeToken.length > 0) {
    return handshakeToken;
  }

  return socket.data.token;
}

async function hydrateSocketAuth(socket:ServerSocket, auth:Auth) {
  const session = await auth.resolveSession(readSocketToken(socket));

  applySocketAuth(socket.data, session.user);

  if (session.token) {
    socket.data.token = session.token;
  }

  return session;
}

async function hydrateSocketAuthWithToken(
  socket:ServerSocket,
  auth:Auth,
  token?:string
) {
  if (typeof token === "string" && token.length > 0) {
    socket.data.token = token;
  }

  return hydrateSocketAuth(socket, auth);
}

const DESIGNER_MAPS_ROOM = "designer:maps";
const ADMIN_PRESENCE_ROOM = "admin:presence";

/**
 * Push the current set of online user ids to every admin subscribed to the
 * live presence room. Called whenever the world's authenticated population
 * changes (player joins / leaves).
 */
// ---- Visited towns (Volar/Fly gating) ----
// Fly-able town ids, memoized per maps-state snapshot (designer edits swap
// the snapshot object, invalidating the memo).
let flyTownsSnapshotRef:unknown = null;
let flyTownIdsCache = new Set<string>();

function getFlyTownIds(world:World):Set<string> {
  const snapshot = world.getPlayableMapsState();
  if (!snapshot) {
    return new Set();
  }
  if (snapshot !== flyTownsSnapshotRef) {
    flyTownsSnapshotRef = snapshot;
    flyTownIdsCache = new Set(resolveFlyDestinations(snapshot).map((destination) => destination.mapId));
  }
  return flyTownIdsCache;
}

/**
 * Records that the player entered a fly-able town. Runs on every map
 * transfer and on join; non-town maps return immediately. A NEW town pushes
 * a fresh auth:session to the player's sockets so the map window unlocks the
 * destination without a relog.
 */
function recordTownVisit(
  io:TypedSocketServer,
  world:World,
  auth:Auth,
  userId:number,
  mapId:string,
  socketIds:Iterable<string>
) {
  if (!getFlyTownIds(world).has(mapId)) {
    return;
  }

  void auth
    .markTownVisited(userId, mapId)
    .then(async (isNewTown) => {
      if (!isNewTown) {
        return;
      }
      const user = await auth.getUserForBattle(userId);
      if (!user) {
        return;
      }
      for (const socketId of socketIds) {
        io.to(socketId).emit("auth:session", { authenticated: true, user });
      }
    })
    .catch((error) => {
      console.error("Unable to record town visit:", error);
    });
}

function broadcastAdminPresence(io:TypedSocketServer, world:World) {
  io.to(ADMIN_PRESENCE_ROOM).emit("admin:presence:state", {
    onlineUserIds: world.getOnlineUserIds()
  });
}

function requireDesignerAccess(
  socket:ServerSocket,
  errorEvent: "designer:section:error" | "playableMaps:error",
  message:string
) {
  if (hasDesignerAccess(socket)) {
    return true;
  }

  socket.emit(errorEvent, { message });
  return false;
}

function hasDesignerAccess(socket:ServerSocket) {
  return Boolean(
    socket.data.authenticated &&
    socket.data.permissions?.includes("designer.access")
  );
}

function requirePermission(
  socket:ServerSocket,
  permission:RolePermission,
  errorEvent:"admin:error" | "moderation:error",
  message:string
) {
  if (
    socket.data.authenticated &&
    socket.data.permissions?.includes(permission)
  ) {
    return true;
  }

  socket.emit(errorEvent, { message });
  return false;
}

function requireDesignerSectionAccess(socket:ServerSocket) {
  return requireDesignerAccess(
    socket,
    "designer:section:error",
    "You must be authenticated to use the designer."
  );
}

function requireDesignerMapsAccess(socket:ServerSocket) {
  return requireDesignerAccess(
    socket,
    "playableMaps:error",
    "You must be authenticated to use the map designer."
  );
}

type ClientTeleportRequest = { mapId:string; x:number; y:number };

function oppositeConnectionDirection(direction:"north" | "south" | "east" | "west") {
  switch (direction) {
    case "north": return "south" as const;
    case "south": return "north" as const;
    case "east": return "west" as const;
    case "west": return "east" as const;
  }
}

/**
 * The only client-initiated teleports the server honors:
 *
 * 1. Same-map nudges (the boundary guard freeing itself from a bad spot).
 * 2. Edge crossings between maps CONNECTED in the imported world, landing
 *    inside the entry strip of the correct edge — so a "crossing" cannot be
 *    forged into a jump past mid-route blockers or into unrelated maps.
 * 3. Event-script portals the player is actually standing next to.
 *
 * Everything else (story doors, gated buildings, gyms) transfers exclusively
 * through server-side event execution and designer portals.
 */
export function isAllowedClientTeleport(
  world:World,
  player:import("../components/player").default,
  data:ClientTeleportRequest
):boolean {
  const snapshot = world.getPlayableMapsState();
  if (!snapshot) {
    return false;
  }
  if (
    !snapshot.items.some((item) => item.id === templateMapIdFor(data.mapId)) &&
    !snapshot.editorDataByMapId[templateMapIdFor(data.mapId)]
  ) {
    return false;
  }
  // House instances are only ever entered/left server-side; the one thing a
  // client may do there is the same-map correction nudge.
  if (isHouseInstanceMapId(data.mapId) || isHouseInstanceMapId(player.currentMapId)) {
    return data.mapId === player.currentMapId && Math.hypot(data.x - player.x, data.y - player.y) <= 320;
  }

  // 1) Same-map correction nudge.
  if (data.mapId === player.currentMapId) {
    return Math.hypot(data.x - player.x, data.y - player.y) <= 320;
  }

  // 2) Edge crossing along an imported map connection.
  const configOf = (mapId:string) =>
    snapshot.items.find((item) => item.id === templateMapIdFor(mapId))?.playableMapConfig;
  const fromConfig = configOf(player.currentMapId);
  const toConfig = configOf(data.mapId);
  const crossingDirections = [
    ...(fromConfig?.connections ?? [])
      .filter((connection) => connection.targetMapId === data.mapId)
      .map((connection) => connection.direction),
    ...(toConfig?.connections ?? [])
      .filter((connection) => connection.targetMapId === player.currentMapId)
      .map((connection) => oppositeConnectionDirection(connection.direction))
  ];
  if (crossingDirections.length > 0 && toConfig) {
    const cellSize = toConfig.cellSize || 32;
    const band = 3 * cellSize;
    const width = (toConfig.width || 1) * cellSize;
    const height = (toConfig.height || 1) * cellSize;
    const validCrossing = crossingDirections.some((direction) => {
      switch (direction) {
        case "north": return data.y >= height - band - cellSize; // arrive at target's south edge
        case "south": return data.y <= band;
        case "east": return data.x <= band;
        case "west": return data.x >= width - band - cellSize;
        default: return false;
      }
    });
    if (validCrossing) {
      return true;
    }
    // Not a plausible edge arrival — fall through: an event-script portal on
    // the current map may still legitimately target this connected map.
  }

  // 3) Standing next to an event-script portal on the current map.
  const portals = snapshot.editorDataByMapId[templateMapIdFor(player.currentMapId)]?.portals ?? [];
  const centerX = player.x + player.width / 2;
  const centerY = player.y + player.height / 2;
  return portals.some(
    (portal) =>
      portal.destinationType === "event-script" &&
      Math.hypot(portal.x * 32 + 16 - centerX, portal.y * 32 + 16 - centerY) <= 96
  );
}

// Maintenance actions runner (admin panel "Maintenance" tab). Created in
// registerSocketHandlers where the redis client is available; the connection
// handler only reads it.
let maintenanceRunner:MaintenanceRunner | null = null;
// SMTP delivery for emailed maintenance reports; null (or not enabled) means
// the panel shows email actions disabled.
let maintenanceMailService:MailService | null = null;

/**
 * Renders the stored last-run transcript of an action into the HTML/text
 * report shared by the panel's report modal and the emailed report. Report
 * files on disk (migration-report.md/json) only belong to the audit action.
 */
async function buildStoredMaintenanceReport(record:MaintenanceRunRecord) {
  const artifacts = record.actionId === "essentials-migration-report"
    ? await collectRunArtifacts(MAINTENANCE_SERVER_ROOT, record)
    : [];
  return buildMaintenanceReport(record, artifacts);
}

const MAINTENANCE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAINTENANCE_BROADCAST_MAX_LENGTH = 500;

function requireAdminAccess(socket:ServerSocket) {
  return requirePermission(
    socket,
    "admin.access",
    "admin:error",
    "You must be an admin to use the admin tools."
  );
}

function requireModeratorAccess(socket:ServerSocket) {
  return requirePermission(
    socket,
    "moderator.access",
    "moderation:error",
    "You must be a moderator to use the moderator tools."
  );
}

/**
 * Surface a pokecraft-api failure to the admin client. Validation/permission
 * errors from the API (4xx) carry a safe, human message we can forward; other
 * failures fall back to a generic message and are logged server-side.
 */
function emitApiKeyError(socket:ServerSocket, error:unknown, fallback:string) {
  if (error instanceof PokecraftApiError && error.status >= 400 && error.status < 500) {
    socket.emit("admin:error", { message: error.message });
    return;
  }
  console.error("pokecraft-api key operation failed:", error);
  socket.emit("admin:error", { message: fallback });
}

function emitPlayableMapsVersion(
  ioOrSocket:TypedSocketServer | ServerSocket,
  payload:PlayableMapsSyncPayload | null
) {
  ioOrSocket.emit("playableMaps:version", {
    hasState: Boolean(payload),
    version: payload?.version ?? null,
    updatedAt: payload?.updatedAt ?? null
  });
}

function getDesignerSectionRoom(sectionKey:DesignerSectionKey) {
  return `designer:section:${sectionKey}`;
}

// Media catalogs whose payloads run to tens of MB (tilesets alone is ~36MB of
// inline base64 images). Emitting them through Socket.IO stalls the event loop
// on the stringify/framing and queues enough traffic to starve heartbeats for
// every connected player, so these sections NEVER travel the websocket — even
// designers only ever receive version stubs and fetch the state over the
// cacheable /designer-sections/<key>.json HTTP endpoint.
const HEAVY_SECTION_KEYS = new Set<DesignerSectionKey>([
  "assets",
  "tilesets",
  "battleBackgrounds"
]);

// Game clients (no designer access) subscribe here instead of the state room:
// designer saves push them a tiny version stub and they refresh the section
// over the cacheable /designer-sections/<key>.json HTTP endpoint, so full
// catalogs never travel the websocket to players.
function getDesignerSectionVersionsRoom(sectionKey:DesignerSectionKey) {
  return `designer:section:${sectionKey}:versions`;
}

function emitDesignerSectionVersion(
  socket:ServerSocket,
  payload:DesignerSectionSyncPayload | null,
  sectionKey:DesignerSectionKey
) {
  socket.emit("designer:section:version", {
    sectionKey,
    hasState: Boolean(payload),
    version: payload?.version ?? null,
    updatedAt: payload?.updatedAt ?? null
  });
}

function getStarterPokemonDefinition(item: unknown) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const candidate = item as {
    id?: unknown;
    name?: unknown;
    pokemonProfile?: {
      isInitialPokemon?: unknown;
      elements?: unknown;
      hp?: unknown;
      skills?: unknown;
      iconImageSrc?: unknown;
    };
  };
  const profile = candidate.pokemonProfile;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    profile?.isInitialPokemon !== true ||
    !Array.isArray(profile.elements) ||
    typeof profile.hp !== "number" ||
    !Number.isFinite(profile.hp)
  ) {
    return null;
  }

  const skills = Array.isArray(profile.skills)
    ? profile.skills
        .filter((skill): skill is { skillId:string; skillName:string; level:number } => {
          const candidateSkill = skill as { skillId?: unknown; skillName?: unknown; level?: unknown };
          return (
            typeof candidateSkill.skillId === "string" &&
            typeof candidateSkill.skillName === "string" &&
            typeof candidateSkill.level === "number" &&
            Number.isFinite(candidateSkill.level)
          );
        })
        .map((skill) => ({
          skillId: skill.skillId,
          skillName: skill.skillName,
          level: Math.max(1, Math.round(skill.level))
        }))
    : [];

  return {
    id: candidate.id,
    name: candidate.name,
    elements: profile.elements.filter((element): element is string => typeof element === "string"),
    hp: Math.max(1, Math.round(profile.hp)),
    skills,
    iconImageSrc: typeof profile.iconImageSrc === "string" ? profile.iconImageSrc : ""
  };
}

async function emitPlayableMapsSyncIfStale(
  socket:ServerSocket,
  playableMapsStore:PlayableMapsStore,
  world:World,
  clientVersion?:number | null
) {
  const payload = await playableMapsStore.read();

  applyPlayableMapsStateToWorld(world, payload);

  if (!payload) {
    emitPlayableMapsVersion(socket, null);
    return;
  }

  // The multi-MB maps state never travels over the websocket to game clients
  // (queued frames starve the Socket.IO heartbeat into ping-timeout storms).
  // Announce the version and let the client pull the cacheable
  // /playable-maps.json HTTP endpoint; only the designer maps tooling
  // (designer:maps:join) still receives full state over the socket.
  emitPlayableMapsVersion(socket, payload);
}

async function sanitizeAuthSessionInventory(
  session: Awaited<ReturnType<Auth["resolveSession"]>>,
  auth: Auth,
  designerSectionStore: DesignerSectionStore
) {
  if (!session.authenticated || !session.user) {
    return session;
  }

  const itemsPayload = await designerSectionStore.read("items");
  const catalogItems = itemsPayload?.state.items ?? [];
  const catalogById = new Map(catalogItems.map((item) => [item.id, item]));
  const nextInventory = session.user.inventory
    .filter((inventoryItem) => catalogById.has(inventoryItem.id))
    .map((inventoryItem) => {
      const catalogItem = catalogById.get(inventoryItem.id)!;
      const profile = catalogItem.itemProfile as {
        type?: unknown;
        description?: unknown;
      } | undefined;

      return {
        ...inventoryItem,
        name: catalogItem.name,
        category: toInventoryCategory(typeof profile?.type === "string" ? profile.type : catalogItem.category),
        description: typeof profile?.description === "string" ? profile.description : inventoryItem.description
      };
    });

  if (
    nextInventory.length === session.user.inventory.length &&
    nextInventory.every((item, index) =>
      item.id === session.user!.inventory[index].id &&
      item.name === session.user!.inventory[index].name &&
      item.category === session.user!.inventory[index].category &&
      item.description === session.user!.inventory[index].description
    )
  ) {
    return session;
  }

  const user = await auth.saveInventory(session.user.id, nextInventory);

  return {
    ...session,
    user
  };
}

function applyAndEmitAuthSession(
  socket: ServerSocket,
  session: Awaited<ReturnType<Auth["resolveSession"]>>
) {
  applySocketAuth(socket.data, session.user);

  if (session.token) {
    socket.data.token = session.token;
  }

  socket.emit("auth:session", session);
}

async function emitRefreshedAuthSessionToUserSockets(
  io: TypedSocketServer,
  auth: Auth,
  designerSectionStore: DesignerSectionStore,
  userId: number
) {
  const matchingSockets = Array.from(io.sockets.sockets.values()).filter(
    (candidate) => candidate.data.userId === userId
  );

  await Promise.all(
    matchingSockets.map(async (candidateSocket) => {
      // readSocketToken, not data.token: sockets that authenticated through
      // the handshake token never get data.token populated, and resolving
      // undefined here used to push authenticated:false to a live player —
      // the client then wiped its stored token and bounced to the login page.
      const session = await sanitizeAuthSessionInventory(
        await auth.resolveSession(readSocketToken(candidateSocket)),
        auth,
        designerSectionStore
      );

      // This is a background refresh, never a logout: if the token can't be
      // resolved right now, keep the client's current session untouched.
      if (!session.authenticated) {
        return;
      }

      applyAndEmitAuthSession(candidateSocket, session);
    })
  );
}

/**
 * Toast a message on every connected client of a user. authContext listens for
 * auth:info on each socket and shows it as a toast, so this is the channel for
 * "an admin did something to your account" notices.
 */
function notifyUserSockets(io:TypedSocketServer, userId:number, message:string) {
  for (const candidate of io.sockets.sockets.values()) {
    if (candidate.data.userId === userId) {
      candidate.emit("auth:info", { message });
    }
  }
}

function toInventoryCategory(value: string) {
  switch (value.toLowerCase()) {
    case "berries":
      return "berries" as const;
    case "skill item":
    case "machines":
      return "moves" as const;
    case "furniture":
      return "furniture" as const;
    case "usable":
    case "medicine":
    case "battle item":
    case "battle items":
      return "usable" as const;
    default:
      return "quest" as const;
  }
}

function createConnectionHandler(
  io:TypedSocketServer,
  world:World,
  auth:Auth,
  designerSectionStore:DesignerSectionStore,
  playableMapsStore:PlayableMapsStore,
  battleManager:BattleManager,
  eventRuntime:EventRuntime,
  socialManager:SocialManager,
  tradeManager:TradeManager,
  mapAssetStore?:MapAssetStore,
  pokecraftApi?:PokecraftApiClient
) {
  return (socket:ServerSocket) => {
    const handshakePlatform = socket.handshake.auth?.platform;
    socket.data.platform =
      typeof handshakePlatform === "string" ? handshakePlatform.slice(0, 20) : "web";

    void hydrateSocketAuth(socket, auth).catch((error) => {
      console.error("Unable to hydrate socket auth state:", error);
    });

    // Latency probe for the client HUD: ack right away so the client can
    // measure round-trip time. Deliberately unauthenticated — the HUD shows
    // latency from the login screen onward.
    socket.on("net:ping", (ack) => {
      if (typeof ack === "function") {
        ack();
      }
    });

    /**
     * Asset-reservation gate. Anything that could change an item, a Venomon or
     * the player's money must pass through here first: if a live trade has the
     * asset reserved, the mutation is refused instead of racing the trade.
     */
    const guardTradedAssets = (
      source: TradeMutationSource,
      target: { itemIds?: string[]; venomonIds?: string[]; currency?: boolean; anyVenomon?: boolean }
    ) => {
      if (typeof socket.data.userId !== "number") {
        return true;
      }
      try {
        tradeManager.assertMutationAllowed(socket.data.userId, source, target);
        return true;
      } catch (error) {
        socket.emit("auth:error", {
          message:
            error instanceof TradeError
              ? error.message
              : "That is part of an active trade right now."
        });
        return false;
      }
    };

    socket.on("auth:register", async (data) => {
      try {
        const result = await auth.register(data);
        if (!("session" in result)) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        if (!result.session.token) {
          socket.emit("auth:error", { message: "Unable to create auth session token." });
          return;
        }

        const session = await sanitizeAuthSessionInventory(result.session, auth, designerSectionStore);
        socket.data.token = result.session.token;
        applyAndEmitAuthSession(socket, session);
      } catch (error) {
        console.error("Auth register event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to register user."
        });
      }
    });

    socket.on("auth:login", async (data) => {
      try {
        const result = await auth.login(data);
        if (!("session" in result)) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        if (!result.session.token) {
          socket.emit("auth:error", { message: "Unable to create auth session token." });
          return;
        }

        const session = await sanitizeAuthSessionInventory(result.session, auth, designerSectionStore);
        socket.data.token = result.session.token;
        applyAndEmitAuthSession(socket, session);
      } catch (error) {
        console.error("Auth login event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to login user."
        });
      }
    });

    socket.on("auth:recover-password", async (data) => {
      try {
        const result = await auth.requestPasswordRecovery(data);
        if ("error" in result) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        socket.emit("auth:info", { message: result.message });
      } catch (error) {
        console.error("Auth recover password event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to process password recovery right now."
        });
      }
    });

    socket.on("auth:recover-username", async (data) => {
      try {
        const result = await auth.requestUsernameRecovery(data);
        if ("error" in result) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        socket.emit("auth:info", { message: result.message });
      } catch (error) {
        console.error("Auth recover username event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to process username recovery right now."
        });
      }
    });

    socket.on("auth:request-email-validation", async () => {
      try {
        const result = await auth.requestEmailValidation(socket.data.token);
        if ("error" in result) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        socket.emit("auth:info", { message: result.message });
      } catch (error) {
        console.error("Auth request email validation event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to send the email validation request."
        });
      }
    });

    socket.on("auth:verify-email", async (data) => {
      try {
        const result = await auth.verifyEmail(data);
        if ("error" in result) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        socket.emit("auth:info", { message: result.message });

        if (socket.data.token) {
          const session = await sanitizeAuthSessionInventory(
            await auth.resolveSession(socket.data.token),
            auth,
            designerSectionStore
          );
          applyAndEmitAuthSession(socket, session);
        }
      } catch (error) {
        console.error("Auth verify email event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to verify the email token."
        });
      }
    });

    socket.on("auth:reset-password", async (data) => {
      try {
        const result = await auth.resetPassword(data);
        if ("error" in result) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        socket.emit("auth:info", { message: result.message });
      } catch (error) {
        console.error("Auth reset password event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to reset the password right now."
        });
      }
    });

    socket.on("auth:change-password", async (data) => {
      try {
        const result = await auth.changePassword(socket.data.token, data);
        if ("error" in result) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        socket.emit("auth:info", { message: result.message });
      } catch (error) {
        console.error("Auth change password event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to change the password right now."
        });
      }
    });

    socket.on("auth:request-account-deletion", async () => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        const result = await auth.requestAccountDeletion(readSocketToken(socket));
        if ("error" in result) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        socket.emit("auth:info", { message: result.message });
      } catch (error) {
        console.error("Auth request account deletion event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to start account deletion right now."
        });
      }
    });

    socket.on("auth:confirm-account-deletion", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        const userId = socket.data.userId;
        if (typeof userId === "number") {
          const player = world.getPlayerByUserId(userId);
          if (player && battleManager.isPlayerBattling(player.socketId)) {
            socket.emit("auth:error", {
              message: "You are in a battle right now. Finish it before deleting your account."
            });
            return;
          }
        }

        const result = await auth.confirmAccountDeletion(readSocketToken(socket), {
          code: typeof data?.code === "string" ? data.code : ""
        });
        if ("error" in result) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        // Force every live session of this account off. Clearing auth on each
        // socket first stops the disconnect handler from re-persisting a saved
        // location into the hash we just deleted.
        if (typeof userId === "number") {
          const targetSockets = Array.from(io.sockets.sockets.values()).filter(
            (candidate) => candidate.data.userId === userId
          );
          for (const targetSocket of targetSockets) {
            world.removePlayer(targetSocket.id);
            applySocketAuth(targetSocket.data, null);
            targetSocket.emit("auth:account-deleted", {
              message: "Your account and all of its data have been permanently deleted."
            });
            targetSocket.disconnect(true);
          }

          broadcastAdminPresence(io, world);
        } else {
          world.removePlayer(socket.id);
          applySocketAuth(socket.data, null);
          socket.emit("auth:account-deleted", {
            message: "Your account and all of its data have been permanently deleted."
          });
          socket.disconnect(true);
        }
      } catch (error) {
        console.error("Auth confirm account deletion event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to delete your account right now."
        });
      }
    });

    socket.on("auth:update-profile", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        const result = await auth.updateProfile(readSocketToken(socket), data);
        if (!("session" in result)) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        const session = await sanitizeAuthSessionInventory(result.session, auth, designerSectionStore);
        applyAndEmitAuthSession(socket, session);
        socket.emit("auth:info", { message: "Profile updated successfully." });
      } catch (error) {
        console.error("Auth update profile event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to update profile right now."
        });
      }
    });

    socket.on("auth:choose-starter", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (typeof data?.pokemonId !== "string" || data.pokemonId.length === 0) {
          socket.emit("auth:error", { message: "Select a starter Pokemon." });
          return;
        }

        const pokemonPayload = await designerSectionStore.read("pokemons");
        const starterPokemon = pokemonPayload?.state.items
          .map(getStarterPokemonDefinition)
          .find((pokemon) => pokemon?.id === data.pokemonId) ?? null;

        if (!starterPokemon) {
          socket.emit("auth:error", { message: "Selected starter Pokemon is unavailable." });
          return;
        }

        const result = await auth.chooseStarter(readSocketToken(socket), data, starterPokemon);
        if (!("session" in result)) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        const session = await sanitizeAuthSessionInventory(result.session, auth, designerSectionStore);
        applyAndEmitAuthSession(socket, session);
        socket.emit("auth:info", { message: `${starterPokemon.name} joined your team.` });
      } catch (error) {
        console.error("Auth choose starter event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to choose starter Pokemon right now."
        });
      }
    });

    socket.on("pokemon:name", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (typeof data?.pokemonId !== "string" || data.pokemonId.length === 0) {
          socket.emit("auth:error", { message: "Choose a Pokemon to name." });
          return;
        }

        if (!guardTradedAssets("pokemon:name", { venomonIds: [data.pokemonId] })) return;

        const result = await auth.namePokemon(readSocketToken(socket), data.pokemonId, data.nickname);
        if (!("session" in result)) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        const session = await sanitizeAuthSessionInventory(result.session, auth, designerSectionStore);
        applySocketAuth(socket.data, session.user);
        socket.emit("auth:session", session);
        socket.emit("auth:info", { message: "Pokemon name selected." });
      } catch (error) {
        console.error("Pokemon name event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to name Pokemon right now."
        });
      }
    });

    socket.on("auth:logout", async () => {
      try {
        const session = await auth.logout(socket.data.token);
        applySocketAuth(socket.data, null);
        socket.emit("auth:session", session);
      } catch (error) {
        console.error("Auth logout event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to logout user."
        });
      }
    });

    socket.on("auth:session", async (data) => {
      try {
        if (typeof data?.token === "string" && data.token.length > 0) {
          socket.data.token = data.token;
        }

        const session = await sanitizeAuthSessionInventory(
          await auth.resolveSession(readSocketToken(socket)),
          auth,
          designerSectionStore
        );
        applySocketAuth(socket.data, session.user);
        socket.emit("auth:session", session);
      } catch (error) {
        console.error("Auth session event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to read the current auth session."
        });
      }
    });

    socket.on("designer:section:join", async (data) => {
      if (!socket.data.authenticated && readSocketToken(socket)) {
        await hydrateSocketAuth(socket, auth);
      }

      if (!isDesignerSectionKey(data?.sectionKey)) {
        socket.emit("designer:section:error", {
          message: "Unknown designer section."
        });
        return;
      }

      const sectionKey = data.sectionKey;
      const canReadSharedSection =
        socket.data.authenticated &&
        (sectionKey === "pokemons" ||
          sectionKey === "npcs" ||
          sectionKey === "players" ||
          sectionKey === "skillsGfx" ||
          sectionKey === "audio" ||
          sectionKey === "types" ||
          sectionKey === "battleInterface");

      if (!canReadSharedSection && !requireDesignerSectionAccess(socket)) {
        return;
      }

      // Designers join the state room (live full-state broadcasts keep their
      // tooling in sync); game clients join the versions room and pull state
      // over HTTP instead. Heavy sections are versions-room-only for everyone.
      if (hasDesignerAccess(socket) && !HEAVY_SECTION_KEYS.has(sectionKey)) {
        socket.join(getDesignerSectionRoom(sectionKey));
      } else {
        socket.join(getDesignerSectionVersionsRoom(sectionKey));
      }

      try {
        const payload = await designerSectionStore.getOrCreate(sectionKey, data?.seedState);

        if (typeof data?.version === "number" && data.version === payload.version) {
          emitDesignerSectionVersion(socket, payload, sectionKey);
          return;
        }

        // Game clients never receive the full catalog over the socket — they
        // refresh via the cacheable /designer-sections/<key>.json endpoint.
        // Heavy sections take that HTTP path for designers too.
        if (!hasDesignerAccess(socket) || HEAVY_SECTION_KEYS.has(sectionKey)) {
          emitDesignerSectionVersion(socket, payload, sectionKey);
          return;
        }

        // Native apps ship these shared sections bundled; when they hold ANY
        // version, answer with the version payload instead of streaming the
        // full state (they keep using their bundle until an app update). The
        // designer-only sections are exempt so designer tooling on desktop
        // still receives live state.
        if (
          canReadSharedSection &&
          isNativeClient(socket) &&
          typeof data?.version === "number"
        ) {
          emitDesignerSectionVersion(socket, payload, sectionKey);
          return;
        }

        socket.emit("designer:section:state", payload);
      } catch (error) {
        console.error(`Unable to load designer ${sectionKey} state:`, error);
        socket.emit("designer:section:error", {
          message: "Unable to load the collaborative designer state."
        });
      }
    });

    socket.on("designer:section:leave", (data) => {
      if (!isDesignerSectionKey(data?.sectionKey)) {
        return;
      }

      socket.leave(getDesignerSectionRoom(data.sectionKey));
      socket.leave(getDesignerSectionVersionsRoom(data.sectionKey));
    });

    socket.on("designer:section:update", async (data) => {
      if (!requireDesignerSectionAccess(socket)) {
        return;
      }

      if (!isDesignerSectionKey(data?.sectionKey)) {
        socket.emit("designer:section:error", {
          message: "Unknown designer section."
        });
        return;
      }

      const sectionKey = data.sectionKey;
      const room = getDesignerSectionRoom(sectionKey);

      if (!HEAVY_SECTION_KEYS.has(sectionKey)) {
        socket.join(room);
      }

      try {
        const payload = await designerSectionStore.save(
          sectionKey,
          data.state,
          socket.data.userId ?? null,
          socket.data.username ?? null
        );

        // Heavy sections never travel the socket: the saver and every
        // subscriber get a version stub and refetch over HTTP.
        if (HEAVY_SECTION_KEYS.has(sectionKey)) {
          emitDesignerSectionVersion(socket, payload, sectionKey);
        } else {
          socket.emit("designer:section:state", payload);
          socket.broadcast.to(room).emit("designer:section:state", payload);
        }
        // Game clients get a version stub and refetch over HTTP.
        io.to(getDesignerSectionVersionsRoom(sectionKey)).emit("designer:section:version", {
          sectionKey,
          hasState: true,
          version: payload.version,
          updatedAt: payload.updatedAt ?? null
        });
      } catch (error) {
        console.error(`Unable to save designer ${sectionKey} state:`, error);
        socket.emit("designer:section:error", {
          message: "Unable to save the collaborative designer state."
        });
      }
    });

    socket.on("designer:section:patch", async (data) => {
      if (!requireDesignerSectionAccess(socket)) {
        return;
      }

      if (!isDesignerSectionKey(data?.sectionKey)) {
        socket.emit("designer:section:error", {
          message: "Unknown designer section."
        });
        return;
      }

      const ops = sanitizeDesignerSectionPatchOps(data?.ops);

      if (!ops) {
        socket.emit("designer:section:error", {
          message: "Invalid designer section patch."
        });
        return;
      }

      const sectionKey = data.sectionKey;
      const room = getDesignerSectionRoom(sectionKey);

      if (!HEAVY_SECTION_KEYS.has(sectionKey)) {
        socket.join(room);
      }

      try {
        const payload = await designerSectionStore.patch(
          sectionKey,
          ops,
          socket.data.userId ?? null,
          socket.data.username ?? null
        );

        if (!payload) {
          // No stored state to patch — the client must seed with a full save.
          socket.emit("designer:section:error", {
            message: "Section has no saved state yet; use a full save first."
          });
          return;
        }

        const broadcast = {
          sectionKey,
          ops,
          version: payload.version,
          updatedAt: payload.updatedAt,
          updatedByUserId: payload.updatedByUserId,
          updatedByUsername: payload.updatedByUsername
        };

        // The patch itself is small, so unlike full-state saves it is safe to
        // send even for heavy sections (their state room is empty anyway —
        // everyone sits in the versions room and refetches over HTTP).
        socket.emit("designer:section:patched", broadcast);
        socket.broadcast.to(room).emit("designer:section:patched", broadcast);
        io.to(getDesignerSectionVersionsRoom(sectionKey)).emit("designer:section:version", {
          sectionKey,
          hasState: true,
          version: payload.version,
          updatedAt: payload.updatedAt ?? null
        });
      } catch (error) {
        console.error(`Unable to patch designer ${sectionKey} state:`, error);
        socket.emit("designer:section:error", {
          message: "Unable to save the collaborative designer state."
        });
      }
    });

    socket.on("playableMaps:sync", async (data) => {
      try {
        await emitPlayableMapsSyncIfStale(socket, playableMapsStore, world, data?.version ?? null);
      } catch (error) {
        console.error("Unable to sync playable maps state:", error);
        socket.emit("playableMaps:error", {
          message: "Unable to sync playable maps state."
        });
      }
    });

    socket.on("designer:maps:join", async (data) => {
      if (!requireDesignerMapsAccess(socket)) {
        return;
      }

      socket.join(DESIGNER_MAPS_ROOM);

      try {
        const payload = await playableMapsStore.getOrCreate(data?.seedState);
        applyPlayableMapsStateToWorld(world, payload);

        if (!payload) {
          socket.emit("playableMaps:error", {
            message: "No playable map state has been saved on the server yet."
          });
          return;
        }

        if (typeof data?.version === "number" && data.version === payload.version) {
          emitPlayableMapsVersion(socket, payload);
          return;
        }

        socket.emit("playableMaps:state", payload);
      } catch (error) {
        console.error("Unable to load playable maps state:", error);
        socket.emit("playableMaps:error", {
          message: "Unable to load the playable maps state."
        });
      }
    });

    socket.on("designer:maps:leave", () => {
      socket.leave(DESIGNER_MAPS_ROOM);
    });

    socket.on("designer:maps:update", async (data) => {
      if (!requireDesignerMapsAccess(socket)) {
        return;
      }

      socket.join(DESIGNER_MAPS_ROOM);

      try {
        const payload = await playableMapsStore.save(
          data.state,
          socket.data.userId ?? null,
          socket.data.username ?? null
        );

        applyPlayableMapsStateToWorld(world, payload);
        socket.emit("playableMaps:state", payload);
        socket.broadcast.to(DESIGNER_MAPS_ROOM).emit("playableMaps:state", payload);
        emitPlayableMapsVersion(World.socketServer, payload);
      } catch (error) {
        console.error("Unable to save playable maps state:", error);
        socket.emit("playableMaps:error", {
          message: "Unable to save the playable maps state."
        });
      }
    });

    socket.on("designer:mapAssets:update", async (data) => {
      if (!requireDesignerMapsAccess(socket)) {
        return;
      }

      if (!mapAssetStore) {
        socket.emit("playableMaps:error", {
          message: "Map asset storage is not available on this server."
        });
        return;
      }

      try {
        const files = await mapAssetStore.saveFiles(data.mapId, data.files, {
          replace: data.replace !== false
        });

        socket.emit("designer:mapAssets:state", { mapId: data.mapId, files });
      } catch (error) {
        console.error("Unable to save map assets:", error);
        socket.emit("playableMaps:error", {
          message: "Unable to save the baked map assets."
        });
      }
    });

    socket.on("admin:users:list", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        socket.emit("admin:users:list", await auth.listUsers(data));
      } catch (error) {
        console.error("Unable to list admin users:", error);
        socket.emit("admin:error", {
          message: "Unable to load users right now."
        });
      }
    });

    socket.on("admin:user:get", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const userId = typeof data?.userId === "number" ? Math.round(data.userId) : Number.NaN;
        if (!Number.isFinite(userId) || userId <= 0) {
          socket.emit("admin:error", {
            message: "Choose a valid user."
          });
          return;
        }

        socket.emit("admin:user:details", {
          user: await auth.getUserAdminDetails(userId)
        });
      } catch (error) {
        console.error("Unable to load admin user details:", error);
        socket.emit("admin:error", {
          message: "Unable to load the selected user."
        });
      }
    });

    socket.on("admin:user:update", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const userId = typeof data?.userId === "number" ? Math.round(data.userId) : Number.NaN;
        if (!Number.isFinite(userId) || userId <= 0) {
          socket.emit("admin:error", {
            message: "Choose a valid user."
          });
          return;
        }

        // Snapshot before applying so gift notifications can name exactly
        // what was added (new party members, item quantity deltas).
        const before = await auth.getUserAdminDetails(userId);

        // Resolve an "automatic placement" savedLocation into concrete
        // coordinates the persistence + teleport paths understand. The world's
        // map definitions must be loaded first (they load lazily on addPlayer,
        // so an admin acting on a fresh server may not have them yet) or the
        // collision grid lookup would see an empty map and skip the safety
        // spiral entirely.
        const { savedLocation: rawSavedLocation, ...restUpdates } = data.updates ?? {};
        let resolvedSavedLocation: { mapId: string; x: number; y: number } | null = null;
        if (rawSavedLocation) {
          const mapId = typeof rawSavedLocation.mapId === "string" ? rawSavedLocation.mapId.trim() : "";
          if (!mapId) {
            socket.emit("admin:error", { message: "Saved location must include a map and valid coordinates." });
            return;
          }

          if (rawSavedLocation.automatic === true) {
            applyPlayableMapsStateToWorld(world, await playableMapsStore.read());
            const placement = world.resolveAutomaticPlacement(mapId);
            resolvedSavedLocation = { mapId, x: placement.x, y: placement.y };
          } else if (Number.isFinite(rawSavedLocation.x) && Number.isFinite(rawSavedLocation.y)) {
            resolvedSavedLocation = { mapId, x: rawSavedLocation.x, y: rawSavedLocation.y };
          } else {
            socket.emit("admin:error", { message: "Saved location must include a map and valid coordinates." });
            return;
          }
        }

        // Hand updateUserByAdmin the concrete location (never the automatic
        // form) so its validation and persistence stay coordinate-based.
        const concreteUpdates = {
          ...restUpdates,
          ...(resolvedSavedLocation ? { savedLocation: resolvedSavedLocation } : {})
        };

        const result = await auth.updateUserByAdmin(userId, concreteUpdates);
        if ("error" in result) {
          socket.emit("admin:error", {
            message: result.error
          });
          return;
        }

        if (resolvedSavedLocation) {
          const player = world.getPlayerByUserId(userId);
          if (player) {
            player.teleport(
              resolvedSavedLocation.mapId,
              resolvedSavedLocation.x,
              resolvedSavedLocation.y
            );
            world.players.set(player.socketId, player);
            world.presentPlayerToMap(player);
            player.socketConnections.forEach((socketId) => {
              world.presentPlayersOnMapTo(socketId, player.currentMapId);
            });
          }
        }

        // The (secret) push depth takes effect immediately when the player is
        // online; otherwise it loads with the next session.
        if (typeof result.user.pushDepth === "number") {
          const player = world.getPlayerByUserId(userId);
          if (player) {
            player.pushDepth = result.user.pushDepth;
          }
        }

        // Tell the player what just happened to their account. Gifts are
        // spelled out per item / per venomon; anything else gets a generic
        // "<admin> updated your ..." notice.
        const adminName = socket.data.username || "An admin";
        const updates = data.updates ?? {};

        if (rawSavedLocation) {
          notifyUserSockets(io, userId, `${adminName} is relocating you`);
        }

        if (updates.inventory && before) {
          const beforeQuantities = new Map(
            before.inventory.map((item) => [item.id, item.quantity])
          );
          for (const item of result.user.inventory) {
            const delta = item.quantity - (beforeQuantities.get(item.id) ?? 0);
            if (delta > 0) {
              notifyUserSockets(io, userId, `${adminName} give you ${item.name} x${delta}`);
            }
          }
        }

        if (updates.pokemonParty && before) {
          const beforeIds = new Set(before.pokemonParty.map((pokemon) => pokemon.id));
          for (const pokemon of result.user.pokemonParty) {
            if (!beforeIds.has(pokemon.id)) {
              notifyUserSockets(io, userId, `${adminName} give you ${pokemon.nickname || pokemon.name}`);
            }
          }
        }

        const profileFieldLabels: Array<[keyof typeof updates, string]> = [
          ["name", "name"],
          ["role", "role"],
          ["profileImage", "profile image"],
          ["description", "description"],
          ["trainerGender", "trainer gender"],
          ["money", "money"],
          ["emailVerified", "email verification"]
        ];
        const touchedLabels = profileFieldLabels
          .filter(([key]) => updates[key] !== undefined)
          .map(([, label]) => label);
        if (touchedLabels.length > 0) {
          notifyUserSockets(io, userId, `${adminName} updated your ${touchedLabels.join(", ")}`);
        }

        socket.emit("admin:user:details", {
          user: result.user
        });
        socket.emit("auth:info", {
          message: `Updated ${result.user.username}.`
        });
        await emitRefreshedAuthSessionToUserSockets(
          io,
          auth,
          designerSectionStore,
          userId
        );
      } catch (error) {
        console.error("Unable to update admin user:", error);
        socket.emit("admin:error", {
          message: "Unable to update the selected user."
        });
      }
    });

    socket.on("admin:user:reset-progress", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const userId = typeof data?.userId === "number" ? Math.round(data.userId) : Number.NaN;
        if (!Number.isFinite(userId) || userId <= 0) {
          socket.emit("admin:error", {
            message: "Choose a valid user."
          });
          return;
        }

        const player = world.getPlayerByUserId(userId);
        if (player && battleManager.isPlayerBattling(player.socketId)) {
          socket.emit("admin:error", {
            message: "That trainer is battling right now. Wait for the battle to end before resetting."
          });
          return;
        }

        const result = await auth.resetUserProgress(userId);
        if ("error" in result) {
          socket.emit("admin:error", {
            message: result.error
          });
          return;
        }

        // If the trainer is online, send them straight to the initial spawn.
        if (player) {
          const playableMapsState = world.getPlayableMapsState();
          const spawn = playableMapsState
            ? resolveInitialSpawnFromPlayableMapsState(playableMapsState)
            : null;
          if (spawn) {
            player.teleport(spawn.mapId, spawn.x, spawn.y);
            world.players.set(player.socketId, player);
            world.presentPlayerToMap(player);
            player.socketConnections.forEach((socketId) => {
              world.presentPlayersOnMapTo(socketId, player.currentMapId);
            });
          }
          // Reset cleared all event switches — refresh the client's copy so
          // conditional NPCs return to their new-game state.
          void eventRuntime.emitEventState(userId);
        }

        notifyUserSockets(
          io,
          userId,
          `${socket.data.username || "An admin"} reset your adventure to the beginning`
        );

        socket.emit("admin:user:details", {
          user: result.user
        });
        socket.emit("auth:info", {
          message: `Reset ${result.user.username}'s adventure to the beginning.`
        });
        await emitRefreshedAuthSessionToUserSockets(
          io,
          auth,
          designerSectionStore,
          userId
        );
      } catch (error) {
        console.error("Unable to reset admin user progress:", error);
        socket.emit("admin:error", {
          message: "Unable to reset the selected user."
        });
      }
    });

    socket.on("admin:user:delete", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const userId = typeof data?.userId === "number" ? Math.round(data.userId) : Number.NaN;
        if (!Number.isFinite(userId) || userId <= 0) {
          socket.emit("admin:error", { message: "Choose a valid user." });
          return;
        }

        if (socket.data.userId === userId) {
          socket.emit("admin:error", { message: "You cannot delete your own account." });
          return;
        }

        const player = world.getPlayerByUserId(userId);
        if (player && battleManager.isPlayerBattling(player.socketId)) {
          socket.emit("admin:error", {
            message: "That trainer is battling right now. Wait for the battle to end before deleting."
          });
          return;
        }

        const result = await auth.deleteUser(userId);
        if ("error" in result) {
          socket.emit("admin:error", { message: result.error });
          return;
        }

        // Force any live sessions off. Clearing auth on the socket first stops
        // the disconnect handler from re-persisting a saved location into the
        // hash we just deleted.
        const targetSockets = Array.from(io.sockets.sockets.values()).filter(
          (candidate) => candidate.data.userId === userId
        );
        for (const targetSocket of targetSockets) {
          world.removePlayer(targetSocket.id);
          applySocketAuth(targetSocket.data, null);
          targetSocket.emit("auth:error", {
            message: "Your account has been removed by an administrator."
          });
          targetSocket.disconnect(true);
        }

        broadcastAdminPresence(io, world);

        socket.emit("admin:user:deleted", { userId });
        socket.emit("auth:info", { message: `Deleted ${result.username} and all their data.` });
      } catch (error) {
        console.error("Unable to delete admin user:", error);
        socket.emit("admin:error", {
          message: "Unable to delete the selected user."
        });
      }
    });

    socket.on("admin:user:set-password", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const userId = typeof data?.userId === "number" ? Math.round(data.userId) : Number.NaN;
        if (!Number.isFinite(userId) || userId <= 0) {
          socket.emit("admin:error", { message: "Choose a valid user." });
          return;
        }

        const result = await auth.setUserPasswordByAdmin(
          userId,
          typeof data?.newPassword === "string" ? data.newPassword : ""
        );
        if ("error" in result) {
          socket.emit("admin:error", { message: result.error });
          return;
        }

        notifyUserSockets(io, userId, `${socket.data.username || "An admin"} changed your password`);
        socket.emit("auth:info", { message: result.message });
      } catch (error) {
        console.error("Unable to set user password:", error);
        socket.emit("admin:error", {
          message: "Unable to update the password right now."
        });
      }
    });

    socket.on("admin:user:send-recovery", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const userId = typeof data?.userId === "number" ? Math.round(data.userId) : Number.NaN;
        if (!Number.isFinite(userId) || userId <= 0) {
          socket.emit("admin:error", { message: "Choose a valid user." });
          return;
        }

        const result = await auth.sendPasswordRecoveryByUserId(userId);
        if ("error" in result) {
          socket.emit("admin:error", { message: result.error });
          return;
        }

        socket.emit("auth:info", { message: result.message });
      } catch (error) {
        console.error("Unable to send password recovery email:", error);
        socket.emit("admin:error", {
          message: "Unable to send the recovery email right now."
        });
      }
    });

    // Explicit admin-initiated disconnect. Gifts and relocation no longer
    // touch the player's connection; this button is the only way an admin
    // drops a player, and it never clears their stored credentials — they can
    // simply log back in.
    socket.on("admin:user:disconnect", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const userId = typeof data?.userId === "number" ? Math.round(data.userId) : Number.NaN;
        if (!Number.isFinite(userId) || userId <= 0) {
          socket.emit("admin:error", { message: "Choose a valid user." });
          return;
        }

        if (socket.data.userId === userId) {
          socket.emit("admin:error", { message: "You cannot disconnect yourself from here." });
          return;
        }

        const adminName = socket.data.username || "An admin";
        const targetSockets = Array.from(io.sockets.sockets.values()).filter(
          (candidate) => candidate.data.userId === userId
        );

        if (targetSockets.length === 0) {
          socket.emit("admin:error", { message: "That trainer is not connected right now." });
          return;
        }

        for (const targetSocket of targetSockets) {
          targetSocket.emit("auth:info", { message: `${adminName} disconnected you` });
          world.removePlayer(targetSocket.id);
          targetSocket.disconnect(true);
        }

        broadcastAdminPresence(io, world);
        socket.emit("auth:info", { message: `Disconnected ${targetSockets.length} session${targetSockets.length === 1 ? "" : "s"}.` });
      } catch (error) {
        console.error("Unable to disconnect user:", error);
        socket.emit("admin:error", {
          message: "Unable to disconnect that trainer right now."
        });
      }
    });

    socket.on("admin:user:event-state:get", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const userId = typeof data?.userId === "number" ? Math.round(data.userId) : Number.NaN;
        if (!Number.isFinite(userId) || userId <= 0) {
          socket.emit("admin:error", { message: "Choose a valid user." });
          return;
        }

        const state = await auth.getEventState(userId);
        socket.emit("admin:user:event-state", { userId, ...state });
      } catch (error) {
        console.error("Unable to load user event state:", error);
        socket.emit("admin:error", {
          message: "Unable to load that trainer's game variables."
        });
      }
    });

    socket.on("admin:user:event-state:update", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const userId = typeof data?.userId === "number" ? Math.round(data.userId) : Number.NaN;
        if (!Number.isFinite(userId) || userId <= 0) {
          socket.emit("admin:error", { message: "Choose a valid user." });
          return;
        }

        await auth.setEventStateByAdmin(userId, {
          switches: data?.switches && typeof data.switches === "object" ? data.switches : {},
          variables: data?.variables && typeof data.variables === "object" ? data.variables : {}
        });

        // Push the fresh state into the live player (conditional NPCs and
        // event pages react immediately) and tell them what happened.
        await eventRuntime.emitEventState(userId);
        notifyUserSockets(io, userId, `${socket.data.username || "An admin"} updated your game variables`);

        const state = await auth.getEventState(userId);
        socket.emit("admin:user:event-state", { userId, ...state });
        socket.emit("auth:info", { message: "Game variables updated." });
      } catch (error) {
        console.error("Unable to update user event state:", error);
        socket.emit("admin:error", {
          message: "Unable to update that trainer's game variables."
        });
      }
    });

    socket.on("admin:user:storage:get", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const userId = typeof data?.userId === "number" ? Math.round(data.userId) : Number.NaN;
        if (!Number.isFinite(userId) || userId <= 0) {
          socket.emit("admin:error", { message: "Choose a valid user." });
          return;
        }

        const storage = await auth.getUserStorageForAdmin(userId);
        if (!storage) {
          socket.emit("admin:error", { message: "User not found." });
          return;
        }

        socket.emit("admin:user:storage", { userId, ...storage });
      } catch (error) {
        console.error("Unable to load user storage:", error);
        socket.emit("admin:error", {
          message: "Unable to load that trainer's PC box."
        });
      }
    });

    socket.on("admin:catalog:get", async () => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        const [{ items, pokemons }, playableMaps] = await Promise.all([
          auth.getAdminCatalogSections(),
          playableMapsStore.read()
        ]);

        const maps = (playableMaps?.state.items ?? [])
          .map((item) => ({
            mapId: typeof item.id === "string" ? item.id : "",
            name: typeof item.name === "string" ? item.name : "",
            category: typeof item.category === "string" ? item.category : ""
          }))
          .filter((entry) => entry.mapId.length > 0)
          .sort((left, right) => left.name.localeCompare(right.name));

        socket.emit("admin:catalog", { items, pokemons, maps });
      } catch (error) {
        console.error("Unable to load admin catalog:", error);
        socket.emit("admin:error", {
          message: "Unable to load the item and map catalog."
        });
      }
    });

    socket.on("admin:presence:subscribe", async () => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        await socket.join(ADMIN_PRESENCE_ROOM);
        socket.emit("admin:presence:state", {
          onlineUserIds: world.getOnlineUserIds()
        });
      } catch (error) {
        console.error("Unable to subscribe to admin presence:", error);
        socket.emit("admin:error", {
          message: "Unable to load live online status."
        });
      }
    });

    socket.on("admin:presence:unsubscribe", async () => {
      try {
        await socket.leave(ADMIN_PRESENCE_ROOM);
      } catch (error) {
        console.error("Unable to unsubscribe from admin presence:", error);
      }
    });

    socket.on("admin:roles:list", async () => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        socket.emit("admin:roles:list", {
          roles: await auth.getRoleDefinitionsWithCounts()
        });
      } catch (error) {
        console.error("Unable to list role definitions:", error);
        socket.emit("admin:error", {
          message: "Unable to load roles right now."
        });
      }
    });

    socket.on("admin:role:update", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        if (typeof data?.roleKey !== "string") {
          socket.emit("admin:error", {
            message: "Choose a valid role."
          });
          return;
        }

        const result = await auth.updateRoleDefinition(data.roleKey as UserRoleKey, {
          description: data.description,
          permissions: data.permissions
        });
        if ("error" in result) {
          socket.emit("admin:error", {
            message: result.error
          });
          return;
        }

        socket.emit("admin:roles:list", {
          roles: await auth.getRoleDefinitionsWithCounts()
        });
        socket.emit("auth:info", {
          message: `Updated the ${result.role.name} role.`
        });
      } catch (error) {
        console.error("Unable to update role definition:", error);
        socket.emit("admin:error", {
          message: "Unable to update the selected role."
        });
      }
    });

    socket.on("admin:maintenance:list", async () => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }
        if (!requireAdminAccess(socket) || !maintenanceRunner) {
          return;
        }
        socket.emit("admin:maintenance:list", {
          actions: await maintenanceRunner.listActions(),
          running: maintenanceRunner.running,
          emailEnabled: maintenanceMailService?.isEnabled() ?? false
        });
      } catch (error) {
        console.error("Unable to list maintenance actions:", error);
        socket.emit("admin:error", { message: "Unable to load maintenance actions right now." });
      }
    });

    socket.on("admin:maintenance:run", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }
        if (!requireAdminAccess(socket) || !maintenanceRunner) {
          return;
        }
        const actionId = typeof data?.id === "string" ? data.id : "";
        const dryRun = data?.dryRun === true;
        const result = maintenanceRunner.run(
          actionId,
          { dryRun, requestedBy: `user:${socket.data.userId ?? "?"}` },
          (line) => socket.emit("admin:maintenance:log", { id: actionId, line }),
          (outcome) => {
            socket.emit("admin:maintenance:done", {
              id: actionId,
              ok: outcome.ok,
              exitCode: outcome.exitCode
            });
            // Push the refreshed list (last-run stamps) without a re-request.
            void maintenanceRunner
              ?.listActions()
              .then((actions) =>
                socket.emit("admin:maintenance:list", {
                  actions,
                  running: maintenanceRunner?.running ?? null,
                  emailEnabled: maintenanceMailService?.isEnabled() ?? false
                })
              )
              .catch(() => undefined);
          }
        );
        if (!result.started) {
          socket.emit("admin:error", { message: result.message });
        }
      } catch (error) {
        console.error("Unable to run maintenance action:", error);
        socket.emit("admin:error", { message: "Unable to run that maintenance action right now." });
      }
    });

    socket.on("admin:maintenance:report", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }
        if (!requireAdminAccess(socket) || !maintenanceRunner) {
          return;
        }
        const actionId = typeof data?.id === "string" ? data.id : "";
        const record = await maintenanceRunner.getRunRecord(actionId);
        if (!record) {
          socket.emit("admin:maintenance:report", { id: actionId, available: false, html: null, meta: null });
          return;
        }
        const report = await buildStoredMaintenanceReport(record);
        socket.emit("admin:maintenance:report", {
          id: actionId,
          available: true,
          html: report.html,
          meta: {
            actionName: record.actionName,
            at: record.at,
            ok: record.ok,
            dryRun: record.dryRun,
            exitCode: record.exitCode,
            by: record.by
          }
        });
      } catch (error) {
        console.error("Unable to build maintenance report:", error);
        socket.emit("admin:error", { message: "Unable to build that report right now." });
      }
    });

    socket.on("admin:maintenance:email-report", async (data) => {
      const actionId = typeof data?.id === "string" ? data.id : "";
      const requestedTo = typeof data?.to === "string" ? data.to.trim() : "";
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }
        if (!requireAdminAccess(socket) || !maintenanceRunner) {
          return;
        }
        // Default destination: the requesting admin's own account email.
        const to = requestedTo || socket.data.email || "";
        if (!MAINTENANCE_EMAIL_PATTERN.test(to)) {
          socket.emit("admin:maintenance:email-result", {
            id: actionId, ok: false, to,
            message: "Provide a valid destination email address."
          });
          return;
        }
        if (!maintenanceMailService?.isEnabled()) {
          socket.emit("admin:maintenance:email-result", {
            id: actionId, ok: false, to,
            message: "SMTP is not configured on this server — email delivery is disabled."
          });
          return;
        }
        const record = await maintenanceRunner.getRunRecord(actionId);
        if (!record) {
          socket.emit("admin:maintenance:email-result", {
            id: actionId, ok: false, to,
            message: "No stored report for this action yet — run it first."
          });
          return;
        }
        const report = await buildStoredMaintenanceReport(record);
        await maintenanceMailService.sendMaintenanceReport({
          to,
          subject: report.subject,
          text: report.text,
          html: report.html,
          attachments: report.attachments
        });
        socket.emit("admin:maintenance:email-result", {
          id: actionId, ok: true, to,
          message: `Report emailed to ${to}.`
        });
      } catch (error) {
        console.error("Unable to email maintenance report:", error);
        socket.emit("admin:maintenance:email-result", {
          id: actionId, ok: false, to: requestedTo,
          message: `Unable to send the email: ${(error as Error).message}`
        });
      }
    });

    socket.on("admin:maintenance:rxdata-clear", async () => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }
        if (!requireAdminAccess(socket) || !maintenanceRunner) {
          return;
        }
        if (maintenanceRunner.running) {
          socket.emit("admin:error", { message: "Wait for the running action to finish before changing the rxdata data." });
          return;
        }
        await maintenanceRunner.rxdataUploads.clearUpload();
        socket.emit("auth:info", { message: "Uploaded rxdata data removed — the event repair will use the bundled dump." });
        socket.emit("admin:maintenance:list", {
          actions: await maintenanceRunner.listActions(),
          running: maintenanceRunner.running,
          emailEnabled: maintenanceMailService?.isEnabled() ?? false
        });
      } catch (error) {
        console.error("Unable to clear uploaded rxdata data:", error);
        socket.emit("admin:error", { message: "Unable to remove the uploaded rxdata data right now." });
      }
    });

    socket.on("admin:maintenance:broadcast", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }
        if (!requireAdminAccess(socket)) {
          return;
        }
        const message = typeof data?.message === "string" ? data.message.trim() : "";
        if (!message) {
          socket.emit("admin:maintenance:broadcast-result", { ok: false, recipients: 0, message: "The message is empty." });
          return;
        }
        if (message.length > MAINTENANCE_BROADCAST_MAX_LENGTH) {
          socket.emit("admin:maintenance:broadcast-result", {
            ok: false, recipients: 0,
            message: `The message is too long (max ${MAINTENANCE_BROADCAST_MAX_LENGTH} characters).`
          });
          return;
        }
        // Same payload shape the moderator /global chat command emits.
        io.emit("chat:message", {
          id: crypto.randomUUID(),
          channel: "global",
          fromUserId: socket.data.userId,
          fromUsername: socket.data.username ?? "",
          fromName: socket.data.username || "Admin",
          text: message,
          at: new Date().toISOString()
        });
        const recipients = world.players.size;
        socket.emit("admin:maintenance:broadcast-result", {
          ok: true,
          recipients,
          message: `Global message delivered to ${recipients} online player(s).`
        });
      } catch (error) {
        console.error("Unable to broadcast global message:", error);
        socket.emit("admin:maintenance:broadcast-result", { ok: false, recipients: 0, message: "Unable to send the global message right now." });
      }
    });

    socket.on("admin:settings:get", async () => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }
        if (!requireAdminAccess(socket)) {
          return;
        }
        socket.emit("admin:settings-data", {
          settings: await auth.getGlobalSettings(),
          defaults: DEFAULT_GLOBAL_SETTINGS
        });
      } catch (error) {
        console.error("Unable to load global settings:", error);
        socket.emit("admin:error", { message: "Unable to load global settings right now." });
      }
    });

    socket.on("admin:settings:update", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }
        if (!requireAdminAccess(socket)) {
          return;
        }
        const settings = await auth.updateGlobalSettings(data ?? {});
        socket.emit("admin:settings-data", { settings, defaults: DEFAULT_GLOBAL_SETTINGS });
        socket.emit("auth:info", { message: "Global settings updated." });
      } catch (error) {
        console.error("Unable to update global settings:", error);
        socket.emit("admin:error", { message: "Unable to update global settings right now." });
      }
    });

    socket.on("admin:apikeys:list", async () => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        if (!pokecraftApi?.isConfigured()) {
          socket.emit("admin:error", {
            message: "pokecraft-api is not configured on the server (set POKECRAFT_API_ADMIN_KEY)."
          });
          return;
        }

        socket.emit("admin:apikeys:list", {
          keys: await pokecraftApi.listApiKeys()
        });
      } catch (error) {
        emitApiKeyError(socket, error, "Unable to load API keys right now.");
      }
    });

    socket.on("admin:apikeys:create", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        if (!pokecraftApi?.isConfigured()) {
          socket.emit("admin:error", {
            message: "pokecraft-api is not configured on the server (set POKECRAFT_API_ADMIN_KEY)."
          });
          return;
        }

        const name = typeof data?.name === "string" ? data.name.trim() : "";
        if (!name) {
          socket.emit("admin:error", { message: "Give the API key a name." });
          return;
        }

        const allowedScopes:ApiKeyScope[] = ["read", "write", "admin"];
        const scopes = Array.isArray(data?.scopes)
          ? data.scopes.filter((scope):scope is ApiKeyScope => allowedScopes.includes(scope as ApiKeyScope))
          : [];
        if (scopes.length === 0) {
          socket.emit("admin:error", { message: "Pick at least one scope (read, write, admin)." });
          return;
        }

        let expiresInDays:number | undefined;
        if (data?.expiresInDays !== undefined && data.expiresInDays !== null) {
          const parsed = Number(data.expiresInDays);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            socket.emit("admin:error", { message: "Expiry (days) must be a positive number." });
            return;
          }
          expiresInDays = Math.floor(parsed);
        }

        const created = await pokecraftApi.createApiKey({
          name,
          scopes,
          createdBy: socket.data.username ?? socket.data.email ?? `user#${socket.data.userId ?? "?"}`,
          expiresInDays
        });

        socket.emit("admin:apikeys:created", created);
        socket.emit("admin:apikeys:list", { keys: await pokecraftApi.listApiKeys() });
        socket.emit("auth:info", { message: `Created API key "${created.meta.name}".` });
      } catch (error) {
        emitApiKeyError(socket, error, "Unable to create the API key.");
      }
    });

    socket.on("admin:apikeys:revoke", async (data) => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireAdminAccess(socket)) {
          return;
        }

        if (!pokecraftApi?.isConfigured()) {
          socket.emit("admin:error", {
            message: "pokecraft-api is not configured on the server (set POKECRAFT_API_ADMIN_KEY)."
          });
          return;
        }

        const id = Number(data?.id);
        if (!Number.isInteger(id) || id <= 0) {
          socket.emit("admin:error", { message: "Choose a valid API key to revoke." });
          return;
        }

        await pokecraftApi.revokeApiKey(id);
        socket.emit("admin:apikeys:list", { keys: await pokecraftApi.listApiKeys() });
        socket.emit("auth:info", { message: "Revoked the API key." });
      } catch (error) {
        emitApiKeyError(socket, error, "Unable to revoke the API key.");
      }
    });

    socket.on("moderation:maps:list", async () => {
      try {
        if (!socket.data.authenticated && readSocketToken(socket)) {
          await hydrateSocketAuth(socket, auth);
        }

        if (!requireModeratorAccess(socket)) {
          return;
        }

        const maps = world.getOnlineMapsOverview();
        socket.emit("moderation:maps:list", {
          maps,
          totalOnlinePlayers: maps.reduce((total, map) => total + map.onlinePlayers, 0),
          fetchedAt: new Date().toISOString()
        });
      } catch (error) {
        console.error("Unable to load moderation map overview:", error);
        socket.emit("moderation:error", {
          message: "Unable to load online map activity."
        });
      }
    });

    socket.on("addPlayer", async (data) => {
      try {
        const playableMapsPayload = await playableMapsStore.read();
        applyPlayableMapsStateToWorld(world, playableMapsPayload);

        if (!socket.data.authenticated && (readSocketToken(socket) || data?.token)) {
          await hydrateSocketAuthWithToken(socket, auth, data?.token);
        }

        const session = await sanitizeAuthSessionInventory(
          await auth.resolveSession(socket.data.token),
          auth,
          designerSectionStore
        );
        if (
          session.authenticated &&
          session.user &&
          !session.user.characterSkinId
        ) {
          // New adventurers start with the default protagonist skin; the intro
          // event's gender question (pbChangePlayer) lets them switch to the
          // female protagonist, and the profile page allows changes any time.
          await auth.setCharacterSkin(session.user.id, "player-player-a-pokemontrainer-red");
          const refreshed = await sanitizeAuthSessionInventory(
            await auth.resolveSession(socket.data.token),
            auth,
            designerSectionStore
          );
          if (refreshed.authenticated && refreshed.user) {
            applySocketAuth(socket.data, refreshed.user);
            socket.emit("auth:session", refreshed);
            Object.assign(session, refreshed);
          }
        }
      } catch (error) {
        console.error("Unable to hydrate auth before addPlayer:", error);
      }

      const session = await sanitizeAuthSessionInventory(
        await auth.resolveSession(socket.data.token),
        auth,
        designerSectionStore
      );
      let savedLocation =
        typeof socket.data.userId === "number"
          ? await auth.getSavedPlayerLocation(socket.data.userId)
          : null;
      if (savedLocation && isHouseInstanceMapId(savedLocation.mapId) && !world.housing.isValidInstance(savedLocation.mapId)) {
        // Logged out inside a house whose apartment/door no longer exists:
        // land on its door if the door survived, else on the shared spawn.
        const exit = world.housing.exitDestination(savedLocation.mapId);
        savedLocation = exit ? { mapId: exit.mapId, x: exit.x, y: exit.y, surfing: false } : null;
      }
      const authoritativePlayableMapsState = world.getPlayableMapsState();
      const sharedSpawnState = authoritativePlayableMapsState
        ? resolveInitialSpawnFromPlayableMapsState(authoritativePlayableMapsState)
        : null;
      const spawnState = savedLocation ?? sharedSpawnState ?? undefined;

      const playerRegistration = world.addPlayer(
        socket.id,
        spawnState,
        socket.data.userId ?? null,
        session.user
          ? {
              username: session.user.username,
              name: session.user.name,
              characterId: session.user.characterId,
              profileImage: session.user.profileImage,
              description: session.user.description,
              characterSkinId: session.user.characterSkinId
            }
          : undefined
      );
      if (session.user) {
        socket.data.characterId = session.user.characterId;
      }

      if (playerRegistration.player && session.user) {
        // Per-character gameplay knobs that live on the world entity.
        playerRegistration.player.followerEnabled = session.user.followerEnabled;
        playerRegistration.player.pushDepth = session.user.pushDepth;
        // Restore a still-running repellent charge (persisted per character).
        void battleManager.loadRepelStateForPlayer(playerRegistration.player).catch((error) => {
          console.error("Unable to restore repel state:", error);
        });
        // Materialize (or refresh) the follower venomon for this player.
        world.followerSimulation?.refreshFor(playerRegistration.player);
      }

      if (playerRegistration.player) {
        socket.emit("myPlayer", { playerId: playerRegistration.player.socketId });
        world.presentPlayersTo(socket.id);
        battleManager.resumeBattleForPlayer(playerRegistration.player);
        if (typeof socket.data.userId === "number") {
          // Emits event state, runs map autoruns with retry, and un-bricks
          // players stranded mid-intro — see EventRuntime.resumeEventsOnJoin.
          void eventRuntime.resumeEventsOnJoin(socket.data.userId);
          // A newly-authenticated player changed the online population.
          broadcastAdminPresence(io, world);
          // Push their friends snapshot and tell online friends they arrived.
          void socialManager.handlePlayerJoined(socket.data.userId);
          // Re-entering the world resumes a trade paused by a disconnect.
          tradeManager.handleUserReconnected(socket.data.userId);
          // Spawning inside a town counts as visiting it (initial spawn and
          // players created before visited-town tracking existed).
          recordTownVisit(
            io,
            world,
            auth,
            socket.data.userId,
            playerRegistration.player.currentMapId,
            playerRegistration.player.socketConnections
          );
        }
      }
    });

    socket.on("move", (data) => {
      const { x, y } = data;
      const player = world.getPlayerBySocket(socket.id);
      if (!player) return;
      if (player.inBattle) return;
      player.findPath(world, x,y);
      world.players.set(player.socketId, player);
    });

    socket.on("stopMove", () => {
      const player = world.getPlayerBySocket(socket.id);
      if (!player) return;

      player.stopMovement();
      world.players.set(player.socketId, player);
    });

    // Hold-to-run (Running Shoes). Speed stays fully server-authoritative:
    // this only flips the multiplier the movement tick consumes, and only
    // when the shoes are actually in the bag — a client emitting this
    // without them keeps walking, like holding the run key in Essentials
    // before Mamá's gift.
    socket.on("player:run", async (data) => {
      const player = world.getPlayerBySocket(socket.id);
      if (!player) return;

      if (!data?.running) {
        player.setRunning(false);
        return;
      }
      // Essentials pbCanRun?: no running while surfing (surf speed already
      // matches run speed) or on the Bicycle.
      if (player.isSurfing || player.cycling) return;
      if (typeof socket.data.userId !== "number") return;

      const shoes = await battleManager.getEventItemQuantity(socket.data.userId, "RUNNINGSHOES");
      if (shoes <= 0) return;

      // Re-check: the async inventory read may resolve after a surf mount
      // or after the key was already released.
      const current = world.getPlayerBySocket(socket.id);
      if (!current || current.isSurfing || current.cycling) return;
      current.setRunning(true);
    });

    socket.on("player:teleport", (data) => {
      const player = world.getPlayerBySocket(socket.id);

      if (
        !player ||
        typeof data?.mapId !== "string" ||
        data.mapId.length === 0 ||
        typeof data?.x !== "number" ||
        !Number.isFinite(data.x) ||
        typeof data?.y !== "number" ||
        !Number.isFinite(data.y)
      ) {
        return;
      }

      // player:teleport is a client REQUEST (edge crossings, out-of-bounds
      // self-correction, event-script portals) — not an entitlement. Without
      // validation it is an arbitrary-teleport primitive that skips every
      // story gate, so only the legitimate shapes are honored; anything else
      // is answered with the authoritative current position.
      const privileged =
        socket.data.authenticated === true &&
        (socket.data.permissions?.includes("admin.access") === true ||
          socket.data.permissions?.includes("designer.access") === true);

      if (!privileged && !isAllowedClientTeleport(world, player, data)) {
        console.warn(
          `Rejected player:teleport for user:${socket.data.userId ?? "?"} ` +
            `${player.currentMapId}(${Math.round(player.x)},${Math.round(player.y)}) -> ` +
            `${data.mapId}(${Math.round(data.x)},${Math.round(data.y)})`
        );
        // Snap the requesting client back to the server's truth (same
        // dynamic move channel the relocation path uses).
        world.emitToMap(player.currentMapId, "move" + player.socketId, player.movePayload({ teleported: true }));
        return;
      }

      player.teleport(data.mapId, data.x, data.y);
      world.players.set(player.socketId, player);
      world.presentPlayerToMap(player);
      player.socketConnections.forEach((socketId) => {
        world.presentPlayersOnMapTo(socketId, player.currentMapId);
      });
      // Play any autorun events on the destination map (e.g. the lab intro).
      if (typeof socket.data.userId === "number") {
        void eventRuntime.runAutorunForMap(socket.data.userId);
      }
    });

    socket.on("player:fly", async (data) => {
      const player = world.getPlayerBySocket(socket.id);

      if (!player || player.inBattle) {
        return;
      }

      if (typeof socket.data.userId !== "number") {
        socket.emit("player:fly-error", { message: "Log in to use Volar." });
        return;
      }

      const mapsState = world.getPlayableMapsState();
      const destination = mapsState
        ? resolveFlyDestinations(mapsState).find(
            (candidate) => candidate.mapId === data?.mapId
          )
        : undefined;

      if (!destination) {
        socket.emit("player:fly-error", { message: "You cannot fly to that place." });
        return;
      }

      const user = await auth.getUserForBattle(socket.data.userId);
      const knowsFly = await battleManager.partyKnowsFly(user?.pokemonParty ?? []);

      if (!knowsFly) {
        socket.emit("player:fly-error", { message: "No venomon in your party knows Vuelo." });
        return;
      }

      // Classic Fly: only towns the player has physically entered are
      // reachable — flying ahead would skip story progression.
      const visitedTowns = user?.visitedTowns ?? [];
      if (!visitedTowns.includes(destination.mapId)) {
        socket.emit("player:fly-error", { message: "You have not visited that town yet." });
        return;
      }

      player.stopMovement();
      player.teleport(destination.mapId, destination.x, destination.y);
      world.players.set(player.socketId, player);
      world.presentPlayerToMap(player);
      player.socketConnections.forEach((socketId) => {
        world.presentPlayersOnMapTo(socketId, player.currentMapId);
      });
      void eventRuntime.runAutorunForMap(socket.data.userId);
    });

    socket.on("player:surf", async (data) => {
      const player = world.getPlayerBySocket(socket.id);
      if (!player || player.inBattle || typeof socket.data.userId !== "number") {
        return;
      }
      if (eventRuntime.isRunning(socket.data.userId)) {
        return; // no field skills mid-dialogue/cutscene
      }
      const target =
        data &&
        typeof data.x === "number" &&
        typeof data.y === "number" &&
        Number.isFinite(data.x) &&
        Number.isFinite(data.y)
          ? { x: Math.floor(data.x), y: Math.floor(data.y) }
          : undefined;
      const result = await world.beginSurf(player, socket.data.userId, target);
      if (!result.ok) {
        socket.emit("player:field-skill-error", { skill: "surf", message: result.message ?? "" });
      }
    });

    socket.on("player:dive", async () => {
      const player = world.getPlayerBySocket(socket.id);
      if (!player || player.inBattle || typeof socket.data.userId !== "number") {
        return;
      }
      const result = await world.tryDive(player, socket.data.userId);
      if (!result.ok) {
        socket.emit("player:field-skill-error", { skill: "dive", message: result.message ?? "" });
        return;
      }
      if (result.mapChanged) {
        world.players.set(player.socketId, player);
        world.presentPlayerToMap(player);
        player.socketConnections.forEach((socketId) => {
          world.presentPlayersOnMapTo(socketId, player.currentMapId);
        });
        void eventRuntime.runAutorunForMap(socket.data.userId);
      }
    });

    socket.on("player:waterfall", async () => {
      const player = world.getPlayerBySocket(socket.id);
      if (!player || player.inBattle || typeof socket.data.userId !== "number") {
        return;
      }
      const result = await world.tryWaterfall(player, socket.data.userId);
      if (!result.ok) {
        socket.emit("player:field-skill-error", { skill: "waterfall", message: result.message ?? "" });
      }
    });

    socket.on("player:strength-push", async () => {
      const player = world.getPlayerBySocket(socket.id);
      if (!player || player.inBattle || typeof socket.data.userId !== "number") {
        return;
      }
      const result = await world.tryStrengthPush(player, socket.data.userId);
      if (!result.ok) {
        socket.emit("player:field-skill-error", { skill: "strength", message: result.message ?? "" });
      }
    });

    socket.on("player:field-interact", async () => {
      const player = world.getPlayerBySocket(socket.id);
      if (!player || player.inBattle || typeof socket.data.userId !== "number") {
        return;
      }
      const userId = socket.data.userId;
      // Resolve by state + terrain; stay silent when nothing applies (this fires
      // on every action-button press that hit no NPC/event).
      if (player.isSurfing) {
        if ((await world.tryDive(player, userId)).ok) {
          world.players.set(player.socketId, player);
          world.presentPlayerToMap(player);
          player.socketConnections.forEach((socketId) => {
            world.presentPlayersOnMapTo(socketId, player.currentMapId);
          });
          void eventRuntime.runAutorunForMap(userId);
          return;
        }
        await world.tryWaterfall(player, userId);
        return;
      }
      if ((await world.beginSurf(player, userId)).ok) {
        return;
      }
      await world.tryStrengthPush(player, userId);
    });

    // Click-to-fish: the player tapped an adjacent water tile and chose "Fish".
    // The server validates rod/adjacency/water, turns the player to face it, and
    // casts; a bite opens a wild battle via battle:state.
    socket.on("fishing:cast", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("fishing:result", { status: "error", message: "Log in to fish." });
        return;
      }
      const player = world.getPlayerBySocket(socket.id);
      if (!player) {
        socket.emit("fishing:result", { status: "error", message: "Enter the world to fish." });
        return;
      }
      if (
        !data ||
        typeof data.x !== "number" ||
        typeof data.y !== "number" ||
        !Number.isFinite(data.x) ||
        !Number.isFinite(data.y)
      ) {
        return;
      }
      if (player.inBattle || eventRuntime.isRunning(socket.data.userId)) {
        socket.emit("fishing:result", { status: "error", message: "No puedes pescar ahora." });
        return;
      }
      const rodItemId = typeof data.rodItemId === "string" ? data.rodItemId : undefined;
      const result = await battleManager.fishAtCell(
        socket.data.userId,
        player,
        {
          x: Math.floor(data.x),
          y: Math.floor(data.y)
        },
        rodItemId
      );
      const status = !result.ok ? "error" : result.battleStarted ? "bite" : "no-bite";
      socket.emit("fishing:result", { status, message: result.message });
    });

    // Water context menu: report which actions apply to the tapped cell.
    socket.on("field:actions", async (data) => {
      const player = world.getPlayerBySocket(socket.id);
      if (
        !player ||
        typeof socket.data.userId !== "number" ||
        !data ||
        typeof data.x !== "number" ||
        typeof data.y !== "number" ||
        !Number.isFinite(data.x) ||
        !Number.isFinite(data.y)
      ) {
        return;
      }
      if (player.inBattle || eventRuntime.isRunning(socket.data.userId)) {
        return;
      }
      const target = { x: Math.floor(data.x), y: Math.floor(data.y) };
      try {
        const actions = await battleManager.getWaterActionsForCell(
          socket.data.userId,
          player,
          target
        );
        socket.emit("field:actions-result", { x: target.x, y: target.y, actions });
      } catch (error) {
        console.error("Unable to resolve field actions:", error);
      }
    });

    // ── Housing (apartments, house instances, furniture) ─────────────────
    registerHousingHandlers({ io, socket, world, auth, battleManager, eventRuntime, guardTradedAssets });

    // ── Global berry plots ────────────────────────────────────────────────
    // Shared soil patches anybody may plant / harvest / clear; growth runs on
    // the server clock (components/BerryPlots.ts). Every action re-validates
    // adjacency and plot state here — the client menu is advisory only.
    type BerryCheck =
      | { ok: false; error: string }
      | { ok: true; player: Player; site: { id: string; mapId: string; x: number; y: number }; userId: number };
    const berryPlotForAction = (plotId: unknown): BerryCheck => {
      const player = world.getPlayerBySocket(socket.id);
      if (!player || typeof socket.data.userId !== "number") {
        return { ok: false, error: "berry.reason.notInWorld" };
      }
      if (player.inBattle || eventRuntime.isRunning(socket.data.userId)) {
        return { ok: false, error: "berry.reason.busy" };
      }
      if (typeof plotId !== "string" || !world.berryPlots.isPlot(plotId)) {
        return { ok: false, error: "berry.reason.noPlot" };
      }
      const site = world.berryPlots.getSite(plotId)!;
      if (site.mapId !== player.currentMapId) {
        return { ok: false, error: "berry.reason.tooFar" };
      }
      const cellSize = world.getMapCellSize(player.currentMapId);
      const current = player.getCurrentCell(cellSize);
      const distance = Math.abs(current.x - site.x) + Math.abs(current.y - site.y);
      if (distance > 1) {
        return { ok: false, error: "berry.reason.tooFar" };
      }
      // Look at the soil you're working on (broadcasts the new facing).
      player.faceCell(site, cellSize);
      return { ok: true, player, site, userId: socket.data.userId };
    };

    const listPlantableBerries = async (userId: number) => {
      const user = await auth.getUserForBattle(userId);
      const berries: Array<{ itemId: string; berryId: string; name: string; quantity: number; hoursPerStage: number }> = [];
      for (const item of user?.inventory ?? []) {
        if (item.quantity <= 0) continue;
        const definition = await battleManager.findEventItemDefinition({ symbol: item.id.replace(/^item-/, "") });
        const profile = definition ? berryProfile(definition.essentialsId) : null;
        if (!definition || !profile) continue;
        berries.push({
          itemId: item.id,
          berryId: definition.essentialsId.toUpperCase(),
          name: definition.name,
          quantity: item.quantity,
          hoursPerStage: profile.hoursPerStage
        });
      }
      return berries;
    };

    const refreshBag = async (userId: number) => {
      const user = await auth.getUserForBattle(userId);
      if (user) {
        socket.emit("auth:session", { authenticated: true, user });
      }
    };

    socket.on("berry:actions", async (data) => {
      const plotId = typeof data?.plotId === "string" ? data.plotId : "";
      const check = berryPlotForAction(plotId);
      const plot = plotId ? world.berryPlots.snapshot(plotId) : null;
      if (!check.ok) {
        socket.emit("berry:actions-result", {
          plotId,
          t: Date.now(),
          plot,
          berries: [],
          canPlant: false,
          canHarvest: false,
          canClear: false,
          reasonKey: check.error
        });
        return;
      }
      try {
        const empty = !plot?.berryId;
        const berries = empty ? await listPlantableBerries(check.userId) : [];
        socket.emit("berry:actions-result", {
          plotId,
          t: Date.now(),
          plot,
          berries,
          canPlant: empty && berries.length > 0,
          canHarvest: Boolean(plot?.berryId) && (plot?.stage ?? 0) >= RIPE_STAGE,
          canClear: Boolean(plot?.berryId),
          reasonKey: empty && berries.length === 0 ? "berry.reason.noBerries" : undefined
        });
      } catch (error) {
        console.error("Unable to resolve berry actions:", error);
      }
    });

    socket.on("berry:plant", async (data) => {
      const plotId = typeof data?.plotId === "string" ? data.plotId : "";
      const check = berryPlotForAction(plotId);
      if (!check.ok) {
        socket.emit("berry:result", { action: "plant", ok: false, plotId, messageKey: check.error });
        return;
      }
      if (world.berryPlots.snapshot(plotId)?.berryId) {
        socket.emit("berry:result", { action: "plant", ok: false, plotId, messageKey: "berry.reason.occupied" });
        return;
      }
      const itemId = typeof data?.itemId === "string" ? data.itemId : "";
      const definition = itemId
        ? await battleManager.findEventItemDefinition({ symbol: itemId.replace(/^item-/, "") })
        : null;
      const profile = definition ? berryProfile(definition.essentialsId) : null;
      if (!definition || !profile) {
        socket.emit("berry:result", { action: "plant", ok: false, plotId, messageKey: "berry.reason.notABerry" });
        return;
      }
      const owned = (await auth.getUserForBattle(check.userId))?.inventory.find((item) => item.id === definition.id);
      if (!owned || owned.quantity <= 0) {
        socket.emit("berry:result", { action: "plant", ok: false, plotId, messageKey: "berry.reason.noBerries" });
        return;
      }
      // Take the berry first: if a concurrent planter wins the plot the seed
      // goes back to the bag.
      const removed = await battleManager.removeEventItem(check.userId, { symbol: definition.essentialsId }, 1);
      if (!removed.ok) {
        socket.emit("berry:result", { action: "plant", ok: false, plotId, messageKey: "berry.reason.noBerries" });
        return;
      }
      const planted = world.berryPlots.plant(plotId, definition.essentialsId, check.player.name || null);
      if (!planted) {
        await battleManager.grantEventItem(check.userId, { symbol: definition.essentialsId }, 1);
        await refreshBag(check.userId);
        socket.emit("berry:result", { action: "plant", ok: false, plotId, messageKey: "berry.reason.occupied" });
        return;
      }
      await refreshBag(check.userId);
      socket.emit("berry:result", {
        action: "plant",
        ok: true,
        plotId,
        messageKey: "berry.msg.planted",
        params: { name: definition.name, hours: String(profile.hoursPerStage * 4) }
      });
    });

    socket.on("berry:harvest", async (data) => {
      const plotId = typeof data?.plotId === "string" ? data.plotId : "";
      const check = berryPlotForAction(plotId);
      if (!check.ok) {
        socket.emit("berry:result", { action: "harvest", ok: false, plotId, messageKey: check.error });
        return;
      }
      const plot = world.berryPlots.snapshot(plotId);
      if (!plot?.berryId) {
        socket.emit("berry:result", { action: "harvest", ok: false, plotId, messageKey: "berry.reason.empty" });
        return;
      }
      if (plot.stage < RIPE_STAGE) {
        socket.emit("berry:result", { action: "harvest", ok: false, plotId, messageKey: "berry.reason.notRipe" });
        return;
      }
      const harvested = world.berryPlots.harvest(plotId);
      if (!harvested) {
        socket.emit("berry:result", { action: "harvest", ok: false, plotId, messageKey: "berry.reason.notRipe" });
        return;
      }
      const granted = await battleManager.grantEventItem(check.userId, { symbol: harvested.berryId }, harvested.quantity);
      await refreshBag(check.userId);
      socket.emit("berry:result", {
        action: "harvest",
        ok: true,
        plotId,
        messageKey: "berry.msg.harvested",
        params: {
          name: granted.ok ? granted.itemName : harvested.berryId,
          count: String(harvested.quantity)
        }
      });
    });

    socket.on("berry:clear", async (data) => {
      const plotId = typeof data?.plotId === "string" ? data.plotId : "";
      const check = berryPlotForAction(plotId);
      if (!check.ok) {
        socket.emit("berry:result", { action: "clear", ok: false, plotId, messageKey: check.error });
        return;
      }
      if (!world.berryPlots.clear(plotId)) {
        socket.emit("berry:result", { action: "clear", ok: false, plotId, messageKey: "berry.reason.empty" });
        return;
      }
      socket.emit("berry:result", { action: "clear", ok: true, plotId, messageKey: "berry.msg.cleared" });
    });

    socket.on("shotProjectil", (data) => {
      world.shotProjectil(data.mouse_x,data.mouse_y, socket.id);
    });

    socket.on("battle:challenge-player", async (data) => {
      // Account-level blocks: no character of a blocked account can be
      // challenged, and selecting another character cannot bypass it.
      const challenger = world.getPlayerBySocket(socket.id);
      const targetPlayer = data?.targetPlayerId
        ? world.players.get(String(data.targetPlayerId))
        : undefined;
      if (
        challenger &&
        targetPlayer &&
        typeof challenger.userId === "number" &&
        typeof targetPlayer.userId === "number" &&
        (await auth.isBlockedEitherWay(challenger.userId, targetPlayer.userId))
      ) {
        socket.emit("battle:error", { message: "That trainer is not available." });
        return;
      }
      battleManager.requestChallenge(socket.id, data);
    });

    socket.on("battle:challenge-response", (data) => {
      battleManager.respondToChallenge(socket.id, data);
    });

    // Legacy trade entry points (nearby-trainer menu, friends list) from
    // clients built before the `trade:*` contract existed. They now open a
    // real trade session instead of the old no-op handshake.
    socket.on("battle:trade-request", async (data) => {
      await tradeManager.requestTrade(socket, { targetPlayerId: data?.targetPlayerId });
    });

    socket.on("battle:trade-response", async (data) => {
      const tradeId = String((data as { requestId?: string })?.requestId ?? "");
      if (data?.accepted) {
        await tradeManager.acceptRequest(socket, { tradeId });
        return;
      }
      await tradeManager.declineRequest(socket, { tradeId });
    });

    // Paid skin change ($300). The free `auth:update-profile` path only sets a
    // skin on the very first (onboarding) pick; every later change is bought
    // here so the money is actually deducted and validated server-side.
    socket.on("player:set-skin", async (data) => {
      const SKIN_PRICE = (await auth.getGlobalSettings()).skinChangePrice;
      try {
        if (typeof socket.data.userId !== "number") {
          socket.emit("auth:error", { message: "Log in to change your skin." });
          return;
        }
        const userId = socket.data.userId;
        const characterSkinId =
          typeof data?.characterSkinId === "string" ? data.characterSkinId.trim().slice(0, 120) : "";
        if (!characterSkinId) {
          socket.emit("auth:error", { message: "Select a skin to wear." });
          return;
        }

        const playersPayload = await designerSectionStore.read("players");
        const skinExists = (playersPayload?.state.items ?? []).some(
          (item) => item.id === characterSkinId && Boolean(item.characterSkinProfile)
        );
        if (!skinExists) {
          socket.emit("auth:error", { message: "That skin is not available." });
          return;
        }

        const user = await auth.getPublicUserData(userId);
        if (!user) {
          socket.emit("auth:error", { message: "Unable to load your account right now." });
          return;
        }
        if (user.characterSkinId === characterSkinId) {
          socket.emit("auth:info", { message: "You are already wearing that skin." });
          return;
        }
        if (user.money < SKIN_PRICE) {
          socket.emit("auth:error", { message: `You need $${SKIN_PRICE} to change your skin.` });
          return;
        }

        await auth.setCharacterSkin(userId, characterSkinId);
        const updated = await auth.saveBattleState(userId, { money: user.money - SKIN_PRICE });

        // Reflect the new skin on the live world player so everyone (including
        // the buyer) sees the sprite swap without a reload.
        const player = world.getPlayerByUserId(userId);
        if (player) {
          player.characterSkinId = characterSkinId;
          world.presentPlayerToMap(player);
          player.socketConnections.forEach((connectionId) => {
            socket.nsp.to(connectionId).emit("addPlayer", player.data());
          });
        }

        socket.emit("auth:session", { authenticated: true, user: updated ?? null });
        socket.emit("auth:info", { message: `You changed your skin for $${SKIN_PRICE}.` });
      } catch (error) {
        console.error("player:set-skin failed:", error);
        socket.emit("auth:error", { message: "Unable to change your skin right now." });
      }
    });

    // Public trainer card for another player (clicking them on the map). Only
    // the presentable fields are sent — never money/email/credentials.
    socket.on("trainer:card", async (data) => {
      try {
        const targetPlayerId = typeof data?.targetPlayerId === "string" ? data.targetPlayerId : "";
        const player = targetPlayerId ? world.players.get(targetPlayerId) : undefined;
        if (!player) {
          socket.emit("auth:error", { message: "That trainer is no longer nearby." });
          return;
        }

        let badges: number[] = [];
        let trainerCardColor = "";
        let party: Array<{ name: string; sourcePokemonId?: string; nickname?: string }> = [];

        if (typeof player.userId === "number") {
          const user = await auth.getPublicUserData(player.userId);
          if (user) {
            badges = user.badges;
            trainerCardColor = user.trainerCardColor;
            party = user.pokemonParty.slice(0, 6).map((pokemon) => ({
              name: pokemon.name,
              sourcePokemonId: pokemon.sourcePokemonId,
              nickname: pokemon.nickname
            }));
          }
        }

        socket.emit("trainer:card-data", {
          playerId: targetPlayerId,
          userId: typeof player.userId === "number" ? player.userId : null,
          name: player.name,
          username: player.username,
          accountId: typeof player.userId === "number" ? player.userId : null,
          accountName: player.username,
          characterId: player.characterId,
          characterName: player.name,
          description: player.description,
          characterSkinId: player.characterSkinId,
          trainerCardColor,
          badges,
          party
        });
      } catch (error) {
        console.error("trainer:card failed:", error);
        socket.emit("auth:error", { message: "Unable to load that trainer card." });
      }
    });

    socket.on("battle:action", (data) => {
      battleManager.submitAction(socket.id, data);
    });

    socket.on("battle:learn-move", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to manage moves." });
        return;
      }

      if (!guardTradedAssets("battle:start", { venomonIds: [data?.pokemonId] })) return;

      const result = await battleManager.resolveMoveLearn(
        socket.data.userId,
        data.pokemonId,
        data.moveName,
        data.replaceMoveName
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("inventory:hold-item", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to manage held items." });
        return;
      }

      if (!guardTradedAssets("inventory:hold-item", {
        itemIds: [data?.itemId],
        venomonIds: [data?.pokemonId]
      })) return;

      const result = await battleManager.setHeldItem(
        socket.data.userId,
        data.pokemonId,
        data.itemId,
        data?.slot === "bonus" || data?.slot === "battle" || data?.slot === "appearance"
          ? data.slot
          : undefined
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("pokemon:learn-move", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to manage moves." });
        return;
      }

      if (!guardTradedAssets("pokemon:learn-move", { venomonIds: [data?.pokemonId] })) return;

      const result = await battleManager.learnAvailableMove(
        socket.data.userId,
        data.pokemonId,
        data.moveName,
        data.replaceMoveName
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("pokemon:forget-move", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to manage moves." });
        return;
      }

      if (!guardTradedAssets("pokemon:forget-move", { venomonIds: [data?.pokemonId] })) return;

      const result = await battleManager.forgetMove(
        socket.data.userId,
        data.pokemonId,
        data.moveName
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("pokemon:reorder", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to reorder your party." });
        return;
      }

      if (!guardTradedAssets("pokemon:reorder", {
        venomonIds: Array.isArray(data?.order) ? data.order : []
      })) return;

      const result = await battleManager.reorderPokemonParty(
        socket.data.userId,
        Array.isArray(data?.order) ? data.order : []
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("follower:set-enabled", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to change your follower." });
        return;
      }

      const enabled = data?.enabled === true;
      await auth.saveFollowerEnabled(socket.data.userId, enabled);

      const player = world.getPlayerByUserId(socket.data.userId);
      if (player) {
        player.followerEnabled = enabled;
        world.followerSimulation?.refreshFor(player);
      }

      const session = await auth.resolveSession(socket.data.token);
      socket.emit("auth:session", session);
      socket.emit("auth:info", {
        message: enabled ? "Tu venomon ahora te sigue." : "Tu venomon volvió a su Venoball."
      });
    });

    // Normalizes the batch/legacy id shape ({pokemonIds} or {pokemonId}).
    const normalizeVenomonIds = (data: { pokemonIds?: unknown; pokemonId?: unknown }) => {
      if (Array.isArray(data?.pokemonIds)) {
        return data.pokemonIds.filter((id): id is string => typeof id === "string" && id.length > 0);
      }
      return typeof data?.pokemonId === "string" && data.pokemonId.length > 0 ? [data.pokemonId] : [];
    };

    const emitStorageResult = (
      result: { ok: true; user: unknown; message: string } | { ok: false; message: string }
    ) => {
      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }
      socket.emit("auth:session", { authenticated: true, user: (result.user as never) ?? null });
      socket.emit("auth:info", { message: result.message });
    };

    socket.on("pokemon:box-deposit", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      const ids = normalizeVenomonIds(data ?? {});
      if (ids.length === 0) {
        socket.emit("auth:error", { message: "Select a Pokemon to deposit." });
        return;
      }
      if (!guardTradedAssets("pokemon:box-deposit", { venomonIds: ids })) return;

      emitStorageResult(await battleManager.depositPokemonToBox(
        socket.data.userId,
        ids,
        typeof data?.boxId === "string" && data.boxId.length > 0 ? data.boxId : undefined
      ));
    });

    socket.on("pokemon:box-withdraw", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      const ids = normalizeVenomonIds(data ?? {});
      if (ids.length === 0 || typeof data?.boxId !== "string" || data.boxId.length === 0) {
        socket.emit("auth:error", { message: "Select a Pokemon to withdraw." });
        return;
      }
      if (!guardTradedAssets("pokemon:box-withdraw", { venomonIds: ids })) return;

      emitStorageResult(await battleManager.withdrawPokemonFromBox(socket.data.userId, ids, data.boxId));
    });

    socket.on("pokemon:box-move", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      const ids = normalizeVenomonIds(data ?? {});
      if (ids.length === 0 || typeof data?.toBoxId !== "string" || data.toBoxId.length === 0) {
        socket.emit("auth:error", { message: "Select a Pokemon to move." });
        return;
      }
      if (!guardTradedAssets("pokemon:box-move", { venomonIds: ids })) return;

      emitStorageResult(await auth.movePokemonBetweenBoxes(socket.data.userId, ids, data.toBoxId));
    });

    socket.on("pokemon:box-release", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      const ids = normalizeVenomonIds(data ?? {});
      if (ids.length === 0) {
        socket.emit("auth:error", { message: "Select a Pokemon to let go." });
        return;
      }
      if (!guardTradedAssets("pokemon:box-release", { venomonIds: ids })) return;

      emitStorageResult(await auth.releasePokemonFromStorage(socket.data.userId, ids));
    });

    socket.on("pokemon:box-create", async () => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      emitStorageResult(await auth.createPokemonBox(socket.data.userId));
    });

    socket.on("pokemon:box-style", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      if (typeof data?.boxId !== "string" || data.boxId.length === 0) {
        socket.emit("auth:error", { message: "That storage box does not exist." });
        return;
      }
      emitStorageResult(await auth.setPokemonBoxStyle(socket.data.userId, data.boxId, {
        name: data.name,
        bgColor: data.bgColor,
        bgImage: data.bgImage,
        borderColor: data.borderColor
      }));
    });

    socket.on("item:box-deposit", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      if (typeof data?.itemId !== "string" || data.itemId.length === 0) {
        socket.emit("auth:error", { message: "Select an item to store." });
        return;
      }
      emitStorageResult(await auth.depositItemToStorage(
        socket.data.userId,
        data.itemId,
        Number(data.quantity) || 1,
        typeof data.boxId === "string" && data.boxId.length > 0 ? data.boxId : undefined
      ));
    });

    socket.on("item:box-withdraw", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      if (typeof data?.itemId !== "string" || typeof data?.boxId !== "string" || data.boxId.length === 0) {
        socket.emit("auth:error", { message: "Select an item to withdraw." });
        return;
      }
      emitStorageResult(await auth.withdrawItemFromStorage(
        socket.data.userId,
        data.itemId,
        Number(data.quantity) || 1,
        data.boxId
      ));
    });

    socket.on("item:box-move", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      if (
        typeof data?.itemId !== "string" ||
        typeof data?.fromBoxId !== "string" ||
        typeof data?.toBoxId !== "string"
      ) {
        socket.emit("auth:error", { message: "Select an item to move." });
        return;
      }
      emitStorageResult(await auth.moveItemBetweenBoxes(
        socket.data.userId,
        data.itemId,
        Number(data.quantity) || 1,
        data.fromBoxId,
        data.toBoxId
      ));
    });

    socket.on("item:box-release", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      if (typeof data?.itemId !== "string" || typeof data?.boxId !== "string" || data.boxId.length === 0) {
        socket.emit("auth:error", { message: "Select an item to throw away." });
        return;
      }
      emitStorageResult(await auth.releaseItemFromStorage(
        socket.data.userId,
        data.itemId,
        Number(data.quantity) || 1,
        data.boxId
      ));
    });

    socket.on("item:box-create", async () => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      emitStorageResult(await auth.createItemBox(socket.data.userId));
    });

    socket.on("item:box-style", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the storage system." });
        return;
      }
      if (typeof data?.boxId !== "string" || data.boxId.length === 0) {
        socket.emit("auth:error", { message: "That item box does not exist." });
        return;
      }
      emitStorageResult(await auth.setItemBoxStyle(socket.data.userId, data.boxId, {
        name: data.name,
        bgColor: data.bgColor,
        bgImage: data.bgImage,
        borderColor: data.borderColor
      }));
    });

    socket.on("pc:money-deposit", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the PC bank." });
        return;
      }
      emitStorageResult(await auth.depositMoneyToPc(socket.data.userId, Number(data?.amount) || 0));
    });

    socket.on("pc:money-withdraw", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use the PC bank." });
        return;
      }
      const ownerCharacterId =
        Number.isInteger(Number(data?.ownerCharacterId)) && Number(data?.ownerCharacterId) > 0
          ? Number(data?.ownerCharacterId)
          : undefined;
      emitStorageResult(
        await auth.withdrawMoneyFromPc(socket.data.userId, Number(data?.amount) || 0, ownerCharacterId)
      );
    });

    socket.on("inventory:take-held-item", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to manage held items." });
        return;
      }

      if (!guardTradedAssets("inventory:take-held-item", { venomonIds: [data?.pokemonId] })) return;

      const result = await battleManager.takeHeldItem(
        socket.data.userId,
        data.pokemonId,
        data?.slot === "bonus" || data?.slot === "battle" || data?.slot === "appearance"
          ? data.slot
          : "bonus"
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("inventory:use-item", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use items." });
        return;
      }

      if (!guardTradedAssets("inventory:use-item", {
        itemIds: [data?.itemId],
        venomonIds: data?.targetPokemonId ? [data.targetPokemonId] : []
      })) return;

      const result = await battleManager.useInventoryItem(socket.data.userId, data.itemId, {
        targetPokemonId: data.targetPokemonId,
        targetMoveName: data.targetMoveName,
        player: world.getPlayerBySocket(socket.id) ?? undefined
      });

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      if (result.user) {
        socket.emit("auth:session", { authenticated: true, user: result.user });
      }
      if (result.clientAction) {
        socket.emit("inventory:action", result.clientAction);
      }
      if (typeof result.repelSteps === "number") {
        socket.emit("player:repel-state", { steps: result.repelSteps });
      }
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("inventory:teach-move", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to teach moves." });
        return;
      }

      if (!guardTradedAssets("inventory:teach-move", {
        itemIds: [data?.itemId],
        venomonIds: [data?.targetPokemonId]
      })) return;

      const result = await battleManager.teachInventoryMove(
        socket.data.userId,
        data.itemId,
        data.targetPokemonId,
        data.replaceMoveName
      );

      if (!result.ok) {
        if ("needsReplace" in result && result.needsReplace) {
          socket.emit("inventory:teach-replace-needed", {
            itemId: data.itemId,
            targetPokemonId: data.targetPokemonId,
            moveName: result.moveName ?? "",
            moves: result.moves ?? []
          });
          return;
        }
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("inventory:throw-away", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to throw away items." });
        return;
      }

      if (!guardTradedAssets("inventory:throw-away", { itemIds: [data?.itemId] })) return;

      const player = world.getPlayerBySocket(socket.id);
      if (!player) {
        socket.emit("auth:error", { message: "Enter the world before throwing away items." });
        return;
      }

      const result = await battleManager.throwInventoryItem(
        socket.data.userId,
        data.itemId,
        data.quantity,
        player
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("npc:heal-party", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to talk with NPCs." });
        return;
      }

      if (!guardTradedAssets("event:script", { anyVenomon: true })) return;

      const result = await battleManager.healPartyAtNpc(
        socket.data.userId,
        data?.npcPlacementId
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("npc:battle", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to battle NPCs." });
        return;
      }

      if (!guardTradedAssets("battle:start", {})) return;

      const result = await battleManager.startNpcTrainerBattle(
        socket.data.userId,
        data?.npcPlacementId
      );

      if (!result.ok) {
        socket.emit("battle:error", { message: result.message });
        return;
      }
    });

    socket.on("event:interact", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to talk with NPCs." });
        return;
      }

      // Berry plots are global state, not event pages: never run the imported
      // pbPickBerry/pbBerryPlant script (it would hand out per-player berries
      // via self switches). Re-sync the plot so the client opens its menu.
      if (typeof data?.npcPlacementId === "string" && world.berryPlots.isPlot(data.npcPlacementId)) {
        const player = world.getPlayerBySocket(socket.id);
        if (player) {
          world.berryPlots.presentTo(socket.id, player.currentMapId);
        }
        return;
      }

      const result = await eventRuntime.startEvent(socket.data.userId, data?.npcPlacementId);
      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
      }
    });

    socket.on("event:advance", (data) => {
      if (typeof socket.data.userId === "number") {
        eventRuntime.submitAdvance(socket.data.userId, data?.text);
      }
    });

    socket.on("event:choice", (data) => {
      if (typeof socket.data.userId === "number" && typeof data?.index === "number") {
        eventRuntime.submitChoice(socket.data.userId, Math.round(data.index));
      }
    });

    socket.on("npc:store-buy", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to shop with NPCs." });
        return;
      }

      if (!guardTradedAssets("npc:store-buy", { currency: true })) return;

      const result = await battleManager.buyFromNpcStore(
        socket.data.userId,
        data?.npcPlacementId,
        data?.itemId,
        data?.quantity
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("npc:store-sell-quotes", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to sell items." });
        return;
      }

      const result = await battleManager.getNpcStoreSellQuotes(
        socket.data.userId,
        data?.npcPlacementId
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("npc:store-sell-quotes", {
        npcPlacementId: data?.npcPlacementId ?? "",
        quotes: result.quotes
      });
    });

    socket.on("npc:store-sell", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to sell items." });
        return;
      }

      if (!guardTradedAssets("npc:store-sell", {
        itemIds: [data?.itemId],
        currency: true
      })) return;

      const result = await battleManager.sellToNpcStore(
        socket.data.userId,
        data?.npcPlacementId,
        data?.itemId,
        data?.quantity
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    // ---- Friends & chat (SocialManager) ----
    // Every handler resolves the acting user from socket.data.userId; guests
    // get a friendly error instead of silent drops.

    const requireSocialUserId = (errorEvent: "friends:error" | "chat:error") => {
      if (typeof socket.data.userId === "number") {
        return socket.data.userId;
      }
      socket.emit(errorEvent, { message: "Log in to use this feature." });
      return null;
    };

    socket.on("friends:list", async () => {
      const userId = requireSocialUserId("friends:error");
      if (userId === null) return;
      await socialManager.sendFriendsState(userId);
    });

    socket.on("friends:request", async (data) => {
      const userId = requireSocialUserId("friends:error");
      if (userId === null) return;
      const accountId =
        Number.isInteger(Number(data?.accountId)) && Number(data?.accountId) > 0
          ? Number(data?.accountId)
          : undefined;
      await socialManager.requestFriend(userId, String(data?.username ?? ""), accountId);
    });

    socket.on("friends:block", async (data) => {
      const userId = requireSocialUserId("friends:error");
      if (userId === null) return;
      await socialManager.blockAccount(userId, Number(data?.accountId));
    });

    socket.on("friends:unblock", async (data) => {
      const userId = requireSocialUserId("friends:error");
      if (userId === null) return;
      await socialManager.unblockAccount(userId, Number(data?.accountId));
    });

    // ---- Account characters (character:*) ----
    // Character ids are the only accepted keys; every successful mutation is
    // followed by a fresh auth:session so the client state stays authoritative.

    const requireCharacterUserId = () => {
      if (typeof socket.data.userId === "number") {
        return socket.data.userId;
      }
      socket.emit("character:error", { message: "Log in to manage characters." });
      return null;
    };

    const refreshCharacterSession = async () => {
      // Sockets authenticated through the handshake may never have
      // socket.data.token set — readSocketToken covers both sources. An
      // unauthenticated refresh here would bounce the client to the login
      // screen, so bail out instead of emitting a logged-out session.
      const session = await sanitizeAuthSessionInventory(
        await auth.resolveSession(readSocketToken(socket)),
        auth,
        designerSectionStore
      );
      if (!session.authenticated || !session.user) {
        return;
      }
      applySocketAuth(socket.data, session.user);
      socket.emit("auth:session", session);
    };

    socket.on("character:list", async () => {
      const userId = requireCharacterUserId();
      if (userId === null) return;
      socket.emit("character:list-data", {
        characters: await auth.listCharacters(userId),
        activeCharacterId: await auth.getActiveCharacterId(userId),
        maxCharacters: (await auth.getGlobalSettings()).maxCharactersPerAccount
      });
    });

    socket.on("character:create", async (data) => {
      const userId = requireCharacterUserId();
      if (userId === null) return;
      const result = await auth.createCharacter(userId, String(data?.name ?? ""));
      if (!result.ok) {
        socket.emit("character:error", { message: result.message });
        return;
      }
      socket.emit("character:changed", {
        action: "created",
        characterId: result.character.characterId
      });
      await refreshCharacterSession();
    });

    socket.on("character:select", async (data) => {
      const userId = requireCharacterUserId();
      if (userId === null) return;
      const characterId = Number(data?.characterId);
      const player = world.getPlayerByUserId(userId);
      if (player && (player.inBattle || battleManager.isPlayerBattling(player.socketId))) {
        socket.emit("character:error", { message: "You cannot switch characters during a battle." });
        return;
      }
      if (tradeManager.isTrading(userId)) {
        socket.emit("character:error", { message: "You cannot switch characters during a trade." });
        return;
      }
      // Persist the outgoing character's position before the active pointer
      // moves (savePlayerLocation resolves the still-active character).
      if (player) {
        await auth.savePlayerLocation(userId, {
          mapId: player.currentMapId,
          x: player.x,
          y: player.y,
          surfing: player.isSurfing
        });
      }
      const result = await auth.selectCharacter(userId, characterId);
      if (!result.ok) {
        socket.emit("character:error", { message: result.message });
        return;
      }
      // Drop the world entity so the next addPlayer joins as the new
      // character (position, name, skin) — the client re-joins after this.
      world.removePlayerByUserId(userId);
      socket.data.characterId = characterId;
      void socialManager.handlePlayerLeft(userId);
      socket.emit("character:changed", { action: "selected", characterId });
      await refreshCharacterSession();
    });

    socket.on("character:delete", async (data) => {
      const userId = requireCharacterUserId();
      if (userId === null) return;
      const characterId = Number(data?.characterId);
      const result = await auth.softDeleteCharacter(userId, characterId);
      if (!result.ok) {
        socket.emit("character:error", { message: result.message });
        return;
      }
      socket.emit("character:changed", { action: "deleted", characterId });
      await refreshCharacterSession();
    });

    socket.on("character:restore", async (data) => {
      const userId = requireCharacterUserId();
      if (userId === null) return;
      const characterId = Number(data?.characterId);
      const result = await auth.restoreCharacter(userId, characterId);
      if (!result.ok) {
        socket.emit("character:error", { message: result.message });
        return;
      }
      socket.emit("character:changed", { action: "restored", characterId });
      await refreshCharacterSession();
    });

    socket.on("friends:respond", async (data) => {
      const userId = requireSocialUserId("friends:error");
      if (userId === null) return;
      await socialManager.respondToFriendRequest(
        userId,
        Number(data?.userId),
        data?.accepted === true
      );
    });

    socket.on("friends:cancel-request", async (data) => {
      const userId = requireSocialUserId("friends:error");
      if (userId === null) return;
      await socialManager.cancelFriendRequest(userId, Number(data?.userId));
    });

    socket.on("friends:remove", async (data) => {
      const userId = requireSocialUserId("friends:error");
      if (userId === null) return;
      await socialManager.removeFriend(userId, Number(data?.userId));
    });

    socket.on("friends:set-prefs", async (data) => {
      const userId = requireSocialUserId("friends:error");
      if (userId === null) return;
      await socialManager.updateSocialPrefs(userId, data ?? {});
    });

    socket.on("friends:teleport-request", async (data) => {
      const userId = requireSocialUserId("friends:error");
      if (userId === null) return;
      await socialManager.requestTeleport(userId, Number(data?.userId));
    });

    socket.on("friends:teleport-respond", async (data) => {
      const userId = requireSocialUserId("friends:error");
      if (userId === null) return;
      await socialManager.respondToTeleport(
        userId,
        String(data?.requestId ?? ""),
        data?.accepted === true
      );
    });

    socket.on("chat:map-message", async (data) => {
      await socialManager.handleMapMessage(socket, String(data?.text ?? ""));
    });

    socket.on("chat:private-create", async (data) => {
      const userId = requireSocialUserId("chat:error");
      if (userId === null) return;
      await socialManager.createPrivateChat(userId, Array.isArray(data?.userIds) ? data.userIds : []);
    });

    socket.on("chat:private-invite", async (data) => {
      const userId = requireSocialUserId("chat:error");
      if (userId === null) return;
      await socialManager.inviteToPrivateChat(userId, String(data?.chatId ?? ""), Number(data?.userId));
    });

    socket.on("chat:invite-respond", async (data) => {
      const userId = requireSocialUserId("chat:error");
      if (userId === null) return;
      await socialManager.respondToChatInvite(
        userId,
        String(data?.inviteId ?? ""),
        data?.accepted === true
      );
    });

    socket.on("chat:private-message", async (data) => {
      const userId = requireSocialUserId("chat:error");
      if (userId === null) return;
      await socialManager.sendPrivateChatMessage(
        userId,
        String(data?.chatId ?? ""),
        String(data?.text ?? "")
      );
    });

    socket.on("chat:private-leave", async (data) => {
      const userId = requireSocialUserId("chat:error");
      if (userId === null) return;
      await socialManager.leavePrivateChat(userId, String(data?.chatId ?? ""));
    });

    // ---- Player-to-player trading (TradeManager) --------------------------
    // Handlers are intentionally thin: every rule, every validation and every
    // authorization check lives in TradeManager, which answers each action
    // with a uniform `trade:result` envelope (see TRADING.md).

    socket.on("trade:request", async (data) => {
      await tradeManager.requestTrade(socket, data ?? {});
    });

    socket.on("trade:request:accept", async (data) => {
      await tradeManager.acceptRequest(socket, data ?? {});
    });

    socket.on("trade:request:decline", async (data) => {
      await tradeManager.declineRequest(socket, data ?? {});
    });

    socket.on("trade:request:cancel", async (data) => {
      await tradeManager.cancelRequest(socket, data ?? {});
    });

    socket.on("trade:offer:add-item", async (data) => {
      await tradeManager.addItem(socket, data ?? {});
    });

    socket.on("trade:offer:update-item", async (data) => {
      await tradeManager.updateItem(socket, data ?? {});
    });

    socket.on("trade:offer:remove-item", async (data) => {
      await tradeManager.removeItem(socket, data ?? {});
    });

    socket.on("trade:offer:add-venomon", async (data) => {
      await tradeManager.addVenomon(socket, data ?? {});
    });

    socket.on("trade:offer:remove-venomon", async (data) => {
      await tradeManager.removeVenomon(socket, data ?? {});
    });

    socket.on("trade:offer:set-currency", async (data) => {
      await tradeManager.setCurrency(socket, data ?? {});
    });

    socket.on("trade:offer:lock", async (data) => {
      await tradeManager.lockOffer(socket, data ?? {});
    });

    socket.on("trade:offer:unlock", async (data) => {
      await tradeManager.unlockOffer(socket, data ?? {});
    });

    socket.on("trade:confirm", async (data) => {
      await tradeManager.confirm(socket, data ?? {});
    });

    socket.on("trade:cancel", async (data) => {
      await tradeManager.cancel(socket, data ?? {});
    });

    socket.on("trade:chat:send", async (data) => {
      await tradeManager.sendChat(socket, data ?? {});
    });

    socket.on("trade:sync", async (data) => {
      await tradeManager.sync(socket, data);
    });

    socket.on("trade:history", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("trade:result", {
          success: false,
          tradeId: null,
          state: null,
          version: null,
          errorCode: "NOT_AUTHENTICATED",
          message: "Log in to view your trade history."
        });
        return;
      }
      try {
        socket.emit("trade:history", await tradeManager.listHistory(socket, data));
      } catch (error) {
        console.error("Unable to list trade history:", error);
      }
    });

    socket.on("trade:report", async (data) => {
      await tradeManager.reportTrade(socket, data ?? {});
    });

    // ---- Trade moderation (moderator.access) -------------------------------

    socket.on("moderation:trades:search", async (data) => {
      if (!requireModeratorAccess(socket)) return;
      try {
        const page = Math.max(Number(data?.page) || 1, 1);
        const pageSize = Math.min(Math.max(Number(data?.pageSize) || 20, 1), 100);
        const result = await tradeManager.moderationSearch({
          userId: typeof data?.userId === "number" ? data.userId : undefined,
          tradeId: typeof data?.tradeId === "string" ? data.tradeId : undefined,
          page,
          pageSize
        });
        socket.emit("moderation:trades:list", { ...result, page, pageSize });
      } catch (error) {
        console.error("Unable to search trades:", error);
        socket.emit("moderation:error", { message: "Unable to search trades." });
      }
    });

    socket.on("moderation:trades:detail", async (data) => {
      if (!requireModeratorAccess(socket)) return;
      try {
        socket.emit("moderation:trades:detail", await tradeManager.moderationDetail(String(data?.tradeId ?? "")));
      } catch (error) {
        console.error("Unable to load trade detail:", error);
        socket.emit("moderation:error", { message: "Unable to load that trade." });
      }
    });

    socket.on("moderation:trades:note", async (data) => {
      if (!requireModeratorAccess(socket) || typeof socket.data.userId !== "number") return;
      try {
        await tradeManager.moderationAddNote(
          String(data?.tradeId ?? ""),
          socket.data.userId,
          String(data?.text ?? "")
        );
        socket.emit("moderation:trades:detail", await tradeManager.moderationDetail(String(data?.tradeId ?? "")));
      } catch (error) {
        console.error("Unable to add trade note:", error);
        socket.emit("moderation:error", { message: "Unable to save that note." });
      }
    });

    socket.on("moderation:trades:set-restriction", async (data) => {
      if (!requireModeratorAccess(socket)) return;
      try {
        await tradeManager.moderationSetTradingDisabled(
          Number(data?.userId),
          data?.disabled === true,
          typeof data?.reason === "string" ? data.reason : undefined
        );
      } catch (error) {
        console.error("Unable to change trade restriction:", error);
        socket.emit("moderation:error", { message: "Unable to change that restriction." });
      }
    });

    socket.on("moderation:trades:reports", async (data) => {
      if (!requireModeratorAccess(socket)) return;
      try {
        const page = Math.max(Number(data?.page) || 1, 1);
        const pageSize = Math.min(Math.max(Number(data?.pageSize) || 20, 1), 100);
        socket.emit("moderation:trades:reports", await tradeManager.moderationListReports(page, pageSize));
      } catch (error) {
        console.error("Unable to list trade reports:", error);
        socket.emit("moderation:error", { message: "Unable to list trade reports." });
      }
    });

    socket.on("disconnect", async (reason) => {
      const player = world.getPlayerBySocket(socket.id);
      const shouldPersistLocation =
        Boolean(player) &&
        typeof socket.data.userId === "number" &&
        player?.socketConnections.size === 1 &&
        player.socketConnections.has(socket.id);

      if (player && shouldPersistLocation && typeof socket.data.userId === "number") {
        try {
          await auth.savePlayerLocation(socket.data.userId, {
            mapId: player.currentMapId,
            x: player.x,
            y: player.y,
            surfing: player.isSurfing
          });
        } catch (error) {
          console.error("Unable to save player location on disconnect:", error);
        }
      }

      try {
        await battleManager.handleSocketDisconnect(socket.id);
      } catch (error) {
        console.error("Unable to reconcile battle on disconnect:", error);
      }

      if (
        typeof socket.data.userId === "number" &&
        player?.socketConnections.size === 1 &&
        player.socketConnections.has(socket.id)
      ) {
        eventRuntime.handleDisconnect(socket.data.userId);
      }

      const wasAuthenticated = typeof socket.data.userId === "number";
      world.removePlayer(socket.id);
      // A player leaving may drop them out of the online set — refresh admins.
      if (wasAuthenticated) {
        broadcastAdminPresence(io, world);
        // Only the user's LAST tab going away counts as leaving for friends.
        if (
          typeof socket.data.userId === "number" &&
          !world.getPlayerByUserId(socket.data.userId)
        ) {
          void socialManager.handlePlayerLeft(socket.data.userId);
          // Trades pause for a grace period, then cancel (see TRADING.md).
          tradeManager.handleUserDisconnected(socket.data.userId);
        }
      }
    });
  };
}

export default function registerSocketHandlers(
  io:TypedSocketServer,
  world:World,
  auth:Auth,
  designerSectionStore:DesignerSectionStore,
  playableMapsStore:PlayableMapsStore,
  _groundItemStore:GroundItemStore,
  redis:RedisClientType,
  mapAssetStore?:MapAssetStore,
  pokecraftApi?:PokecraftApiClient,
  mailService?:MailService
) {
  const battleManager = new BattleManager(io, world, auth, designerSectionStore);
  world.setBattleManager(battleManager);
  maintenanceRunner = new MaintenanceRunner(redis);
  // Inline maintenance actions (e.g. reset-all-adventures) run against the
  // live services instead of spawning a tool process.
  maintenanceRunner.setServices({ auth, world, io });
  maintenanceMailService = mailService ?? null;
  const eventRuntime = new EventRuntime(io, world, auth);
  const socialManager = new SocialManager(io, world, auth, battleManager, eventRuntime);

  // Follower venomon: resolve the party leader (slot 0) to an overworld
  // charset. Eggs can't walk and unknown species have no sheet — both mean
  // "no follower". The resolver is also re-run on every party mutation.
  world.followerSimulation?.setLeaderResolver(async (player) => {
    if (typeof player.userId !== "number" || !player.followerEnabled) {
      return null;
    }
    const user = await auth.getUserForBattle(player.userId);
    const leader = user?.pokemonParty?.[0];
    if (!leader || leader.isEgg) {
      return null;
    }
    if (isHouseInstanceMapId(player.currentMapId) && (user?.houseRoamIds ?? []).includes(leader.id)) {
      return null; // it is roaming the house instead (HouseRoamers)
    }
    const internalName = (leader.sourcePokemonId ?? "")
      .replace(/^pokemon-/, "")
      .toUpperCase();
    const charset = internalName ? speciesCharsetName(internalName) : null;
    return charset ? { charset } : null;
  });
  // Party venomons let out inside a house (house:set-roam) wander the room.
  world.houseRoamers.setResolver(async (player) => {
    if (typeof player.userId !== "number") {
      return [];
    }
    const user = await auth.getUserForBattle(player.userId);
    const allowed = new Set(user?.houseRoamIds ?? []);
    const roamers: Array<{ pokemonId: string; charset: string }> = [];
    for (const mon of user?.pokemonParty ?? []) {
      if (!allowed.has(mon.id) || mon.isEgg) continue;
      const internalName = (mon.sourcePokemonId ?? "").replace(/^pokemon-/, "").toUpperCase();
      const charset = internalName ? speciesCharsetName(internalName) : null;
      if (charset) roamers.push({ pokemonId: mon.id, charset });
    }
    return roamers;
  });
  auth.setPartyChangedListener((userId) => {
    const player = world.getPlayerByUserId(userId);
    if (player) {
      world.followerSimulation?.refreshFor(player);
      void world.houseRoamers.refreshFor(player);
    }
  });
  const tradeManager = new TradeManager(
    io,
    world,
    auth,
    designerSectionStore,
    battleManager,
    eventRuntime,
    redis
  );
  // No battle of any kind may start while a trade holds the party reserved.
  battleManager.setTradeGuard((userId) => tradeManager.isTrading(userId));
  // Event scripts can start real trainer battles (pbTrainerBattle).
  eventRuntime.setBattleManager(battleManager);
  // pbPokemonMart events open the regular store overlay; buy/sell requests
  // validate against the mart session the event runtime keeps per user.
  battleManager.setEventMartResolver((userId, placementId) =>
    eventRuntime.getActiveMartItems(userId, placementId)
  );
  // RMXP touch triggers (doors, cave mouths, floor events): the world detects
  // the bump/step, the event runtime plays the event. Cooldown keeps a held
  // arrow key from re-firing the same event every tick.
  // Designer portals are server-authoritative: the world detects the player
  // standing on (or bumping into) a portal cell and this handler performs the
  // transfer. Clients only render portals — a portal in an unreachable spot
  // or a stale client cache can no longer strand players.
  world.setPortalHandler((player, portal) => {
    const snapshot = world.getPlayableMapsState();
    if (!snapshot) return;
    // Any portal authored on a HOUSE template leads back to the apartment's
    // door when walked inside an instance (the exit mat).
    const houseExit = isHouseInstanceMapId(player.currentMapId)
      ? world.housing.exitDestination(player.currentMapId)
      : null;
    const destination = houseExit ?? resolvePlayableMapPortalDestination(snapshot, player.currentMapId, portal);
    if (!destination) return;

    player.stopMovement();
    player.teleport(destination.mapId, destination.x, destination.y);
    world.players.set(player.socketId, player);
    world.presentPlayerToMap(player);
    player.socketConnections.forEach((socketId) => {
      world.presentPlayersOnMapTo(socketId, player.currentMapId);
      // Door/exit chime on the traveling player's clients.
      io.to(socketId).emit("portal:used", { mapId: player.currentMapId });
    });
    if (typeof player.userId === "number") {
      void eventRuntime.runAutorunForMap(player.userId);
    }
  });

  const touchCooldowns = new Map<number, { placementId:string; at:number }>();
  // Map transfers persist the new location immediately (fire-and-forget);
  // relying on the disconnect handler alone loses the position on crashes
  // and re-strands players inside buildings they already exited.
  world.setLocationPersistHandler((player) => {
    if (typeof player.userId !== "number") return;
    void auth
      .savePlayerLocation(player.userId, {
        mapId: player.currentMapId,
        x: player.x,
        y: player.y,
        surfing: player.isSurfing
      })
      .catch((error) => {
        console.error("Unable to save player location on transfer:", error);
      });
    // Entering a fly-able town unlocks it as a Volar destination.
    recordTownVisit(io, world, auth, player.userId, player.currentMapId, player.socketConnections);
    // Map transfers also feed friends presence (same-map action gating).
    socialManager.handlePlayerMapChanged(player);
  });
  world.setEventTouchHandler((player, placementId, sightPushCell) => {
    const userId = player.userId;
    if (typeof userId !== "number") {
      return;
    }
    if (
      player.inBattle ||
      battleManager.isWildStartPendingOrBattling(player.socketId) ||
      eventRuntime.isRunning(userId)
    ) {
      // Busy (a wild battle started on this very step, or a cutscene is
      // playing): remember the trap instead of dropping it — it replays the
      // moment the player is free, so quest gates are never skipped.
      eventRuntime.queueMissedTouch(userId, placementId, sightPushCell ?? null, player.currentMapId);
      return;
    }
    const last = touchCooldowns.get(userId);
    const now = Date.now();
    if (last && last.placementId === placementId && now - last.at < 1500) {
      return;
    }
    touchCooldowns.set(userId, { placementId, at: now });
    void eventRuntime.startEvent(userId, placementId, { touch: true, sightPushCell: sightPushCell ?? null });
  });
  // A sight-trap push-back clears the cooldown: marching straight back into
  // the corridor must re-fire the trap, not slip through a cooldown window.
  eventRuntime.setTouchCooldownReset((userId) => touchCooldowns.delete(userId));
  // Battle over: replay any trap event that fired while it ran.
  world.setPlayerLeftBattleHandler((player) => {
    if (typeof player.userId === "number") {
      eventRuntime.firePendingTouch(player.userId);
    }
  });
  // RMXP interpreter lock: while an event session runs (dialog, trainer spot,
  // cutscene) the player cannot move, so line-of-sight traps actually hold.
  world.setEventMovementLockChecker(
    (player) => typeof player.userId === "number" && eventRuntime.isRunning(player.userId)
  );
  io.on("connection", createConnectionHandler(io, world, auth, designerSectionStore, playableMapsStore, battleManager, eventRuntime, socialManager, tradeManager, mapAssetStore, pokecraftApi));

  return { tradeManager, maintenanceRunner };
}
