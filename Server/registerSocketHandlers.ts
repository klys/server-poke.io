import { type Server, type Socket } from "socket.io";
import Auth, {
  type AuthenticatedUser,
  type RolePermission,
  type UserRoleKey
} from "../components/Auth";
import BattleManager from "../components/BattleManager";
import DesignerSectionStore, {
  isDesignerSectionKey,
  type DesignerSectionKey,
  type DesignerSectionSyncPayload,
} from "../components/DesignerSectionStore";
import type GroundItemStore from "../components/GroundItemStore";
import PlayableMapsStore, {
  applyPlayableMapsStateToWorld,
  type PlayableMapsSyncPayload,
} from "../components/PlayableMapsStore";
import {
  resolveInitialSpawnFromPlayableMapsState,
} from "../components/PlayableMapsState";
import World from "../components/world";
import ClientToServerEvents from "./ClientToServerEvents";
import InterServerEvents from "./InterServerEvents";
import ServerToClientEvents from "./ServerToClientEvents";

export interface SocketData {
  authenticated: boolean;
  token?: string;
  userId?: number;
  username?: string;
  email?: string;
  role?: UserRoleKey;
  permissions?: RolePermission[];
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
    delete socketData.role;
    delete socketData.permissions;
    return;
  }

  socketData.userId = user.id;
  socketData.username = user.username;
  socketData.email = user.email;
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

function requireDesignerAccess(
  socket:ServerSocket,
  errorEvent: "designer:section:error" | "playableMaps:error",
  message:string
) {
  if (
    socket.data.authenticated &&
    socket.data.permissions?.includes("designer.access")
  ) {
    return true;
  }

  socket.emit(errorEvent, { message });
  return false;
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

  if (typeof clientVersion === "number" && clientVersion === payload.version) {
    emitPlayableMapsVersion(socket, payload);
    return;
  }

  socket.emit("playableMaps:state", payload);
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
      const session = await sanitizeAuthSessionInventory(
        await auth.resolveSession(candidateSocket.data.token),
        auth,
        designerSectionStore
      );

      applyAndEmitAuthSession(candidateSocket, session);
    })
  );
}

function toInventoryCategory(value: string) {
  switch (value.toLowerCase()) {
    case "berries":
      return "berries" as const;
    case "skill item":
    case "machines":
      return "moves" as const;
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
  _io:TypedSocketServer,
  world:World,
  auth:Auth,
  designerSectionStore:DesignerSectionStore,
  playableMapsStore:PlayableMapsStore,
  battleManager:BattleManager
) {
  return (socket:ServerSocket) => {
    console.log("Client connected!", socket.id);

    void hydrateSocketAuth(socket, auth).catch((error) => {
      console.error("Unable to hydrate socket auth state:", error);
    });

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
        (sectionKey === "pokemons" || sectionKey === "npcs" || sectionKey === "players");

      if (!canReadSharedSection && !requireDesignerSectionAccess(socket)) {
        return;
      }

      socket.join(getDesignerSectionRoom(sectionKey));

      try {
        const payload = await designerSectionStore.getOrCreate(sectionKey, data?.seedState);

        if (typeof data?.version === "number" && data.version === payload.version) {
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
      socket.join(room);

      try {
        const payload = await designerSectionStore.save(
          sectionKey,
          data.state,
          socket.data.userId ?? null,
          socket.data.username ?? null
        );

        socket.emit("designer:section:state", payload);
        socket.broadcast.to(room).emit("designer:section:state", payload);
      } catch (error) {
        console.error(`Unable to save designer ${sectionKey} state:`, error);
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

        const result = await auth.updateUserByAdmin(userId, data.updates ?? {});
        if ("error" in result) {
          socket.emit("admin:error", {
            message: result.error
          });
          return;
        }

        if (data.updates?.savedLocation) {
          const player = world.getPlayerByUserId(userId);
          if (player) {
            player.teleport(
              data.updates.savedLocation.mapId,
              data.updates.savedLocation.x,
              data.updates.savedLocation.y
            );
            world.players.set(player.socketId, player);
            world.presentPlayerToMap(player);
            player.socketConnections.forEach((socketId) => {
              world.presentPlayersOnMapTo(socketId, player.currentMapId);
            });
          }
        }

        socket.emit("admin:user:details", {
          user: result.user
        });
        socket.emit("auth:info", {
          message: `Updated ${result.user.username}.`
        });
        await emitRefreshedAuthSessionToUserSockets(
          _io,
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
      console.log("addPlayer");

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
          (session.user.pokemonParty.length === 0 || !session.user.characterSkinId)
        ) {
          applySocketAuth(socket.data, session.user);
          socket.emit("auth:session", session);
          return;
        }
      } catch (error) {
        console.error("Unable to hydrate auth before addPlayer:", error);
      }

      const session = await sanitizeAuthSessionInventory(
        await auth.resolveSession(socket.data.token),
        auth,
        designerSectionStore
      );
      const savedLocation =
        typeof socket.data.userId === "number"
          ? await auth.getSavedPlayerLocation(socket.data.userId)
          : null;
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
              profileImage: session.user.profileImage,
              description: session.user.description,
              characterSkinId: session.user.characterSkinId
            }
          : undefined
      );

      if (playerRegistration.player) {
        socket.emit("myPlayer", { playerId: playerRegistration.player.socketId });
        world.presentPlayersTo(socket.id);
        battleManager.resumeBattleForPlayer(playerRegistration.player);
      }
    });

    socket.on("move", (data) => {
      const { x, y } = data;
      const player = world.getPlayerBySocket(socket.id);
      if (!player) return;
      if (player.inBattle) return;
      console.log(socket.id+" moving to "+x+" and "+y);
      player.findPath(world, x,y);
      world.players.set(player.socketId, player);
    });

    socket.on("stopMove", () => {
      const player = world.getPlayerBySocket(socket.id);
      if (!player) return;

      player.stopMovement();
      world.players.set(player.socketId, player);
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

      player.teleport(data.mapId, data.x, data.y);
      world.players.set(player.socketId, player);
      world.presentPlayerToMap(player);
      player.socketConnections.forEach((socketId) => {
        world.presentPlayersOnMapTo(socketId, player.currentMapId);
      });
    });

    socket.on("shotProjectil", (data) => {
      console.log("shotProjectil");
      world.shotProjectil(data.mouse_x,data.mouse_y, socket.id);
    });

    socket.on("battle:challenge-player", (data) => {
      battleManager.requestChallenge(socket.id, data);
    });

    socket.on("battle:challenge-response", (data) => {
      battleManager.respondToChallenge(socket.id, data);
    });

    socket.on("battle:trade-request", (data) => {
      battleManager.requestTrade(socket.id, data);
    });

    socket.on("battle:trade-response", (data) => {
      battleManager.respondToTrade(socket.id, data);
    });

    socket.on("battle:action", (data) => {
      battleManager.submitAction(socket.id, data);
    });

    socket.on("inventory:use-item", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to use items." });
        return;
      }

      const result = await battleManager.useInventoryItem(
        socket.data.userId,
        data.itemId,
        data.targetPokemonId
      );

      if (!result.ok) {
        socket.emit("auth:error", { message: result.message });
        return;
      }

      socket.emit("auth:session", { authenticated: true, user: result.user ?? null });
      socket.emit("auth:info", { message: result.message });
    });

    socket.on("inventory:teach-move", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to teach moves." });
        return;
      }

      const result = await battleManager.teachInventoryMove(
        socket.data.userId,
        data.itemId,
        data.targetPokemonId
      );

      if (!result.ok) {
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

    socket.on("npc:store-buy", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to shop with NPCs." });
        return;
      }

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

    socket.on("npc:store-sell", async (data) => {
      if (typeof socket.data.userId !== "number") {
        socket.emit("auth:error", { message: "Log in to sell items." });
        return;
      }

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

    socket.on("disconnect", async (reason) => {
      console.log(reason);

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
            y: player.y
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

      world.removePlayer(socket.id);
    });
  };
}

export default function registerSocketHandlers(
  io:TypedSocketServer,
  world:World,
  auth:Auth,
  designerSectionStore:DesignerSectionStore,
  playableMapsStore:PlayableMapsStore,
  _groundItemStore:GroundItemStore
) {
  const battleManager = new BattleManager(io, world, auth, designerSectionStore);
  world.setBattleManager(battleManager);
  io.on("connection", createConnectionHandler(io, world, auth, designerSectionStore, playableMapsStore, battleManager));
}
