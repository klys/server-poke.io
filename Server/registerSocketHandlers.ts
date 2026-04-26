import { type Server, type Socket } from "socket.io";
import Auth, { type AuthenticatedUser } from "../components/Auth";
import DesignerSectionStore, {
  isDesignerSectionKey,
  type DesignerSectionKey,
  type DesignerSectionSyncPayload,
} from "../components/DesignerSectionStore";
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
    return;
  }

  socketData.userId = user.id;
  socketData.username = user.username;
  socketData.email = user.email;
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
  if (socket.data.authenticated) {
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

function createConnectionHandler(
  world:World,
  auth:Auth,
  designerSectionStore:DesignerSectionStore,
  playableMapsStore:PlayableMapsStore
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

        socket.data.token = result.session.token;
        applySocketAuth(socket.data, result.session.user);
        socket.emit("auth:session", result.session);
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

        socket.data.token = result.session.token;
        applySocketAuth(socket.data, result.session.user);
        socket.emit("auth:session", result.session);
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
          const session = await auth.resolveSession(socket.data.token);
          applySocketAuth(socket.data, session.user);
          socket.emit("auth:session", session);
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
        const result = await auth.updateProfile(socket.data.token, data);
        if (!("session" in result)) {
          socket.emit("auth:error", { message: result.error });
          return;
        }

        applySocketAuth(socket.data, result.session.user);
        socket.emit("auth:session", result.session);
        socket.emit("auth:info", { message: "Profile updated successfully." });
      } catch (error) {
        console.error("Auth update profile event failed:", error);
        socket.emit("auth:error", {
          message: "Unable to update profile right now."
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

        const session = await auth.resolveSession(readSocketToken(socket));
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

    socket.on("addPlayer", async (data) => {
      console.log("addPlayer");

      try {
        const playableMapsPayload = await playableMapsStore.read();
        applyPlayableMapsStateToWorld(world, playableMapsPayload);

        if (!socket.data.authenticated && (readSocketToken(socket) || data?.token)) {
          await hydrateSocketAuthWithToken(socket, auth, data?.token);
        }
      } catch (error) {
        console.error("Unable to hydrate auth before addPlayer:", error);
      }

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
        socket.data.userId ?? null
      );

      if (playerRegistration.player) {
        socket.emit("myPlayer", { playerId: playerRegistration.player.socketId });
        world.presentPlayersTo(socket.id);
      }
    });

    socket.on("move", (data) => {
      const { x, y } = data;
      const player = world.getPlayerBySocket(socket.id);
      if (!player) return;
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

      world.removePlayer(socket.id);
    });
  };
}

export default function registerSocketHandlers(
  io:TypedSocketServer,
  world:World,
  auth:Auth,
  designerSectionStore:DesignerSectionStore,
  playableMapsStore:PlayableMapsStore
) {
  io.on("connection", createConnectionHandler(world, auth, designerSectionStore, playableMapsStore));
}
