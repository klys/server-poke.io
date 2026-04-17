import { type Server, type Socket } from "socket.io";
import Auth, { type AuthenticatedUser } from "../components/Auth";
import DesignerObjectsStore from "../components/DesignerObjectsStore";
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

const DESIGNER_OBJECTS_ROOM = "designer:objects";

function requireDesignerObjectsAccess(socket:ServerSocket) {
  if (socket.data.authenticated) {
    return true;
  }

  socket.emit("designer:objects:error", {
    message: "You must be authenticated to use the map objects designer."
  });

  return false;
}

function createConnectionHandler(world:World, auth:Auth, designerObjectsStore:DesignerObjectsStore) {
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

    socket.on("designer:objects:join", async (data) => {
      if (!requireDesignerObjectsAccess(socket)) {
        return;
      }

      socket.join(DESIGNER_OBJECTS_ROOM);

      try {
        const payload = await designerObjectsStore.getOrCreate(data?.seedState);
        socket.emit("designer:objects:state", payload);
      } catch (error) {
        console.error("Unable to load designer objects state:", error);
        socket.emit("designer:objects:error", {
          message: "Unable to load the collaborative map objects state."
        });
      }
    });

    socket.on("designer:objects:leave", () => {
      socket.leave(DESIGNER_OBJECTS_ROOM);
    });

    socket.on("designer:objects:update", async (data) => {
      if (!requireDesignerObjectsAccess(socket)) {
        return;
      }

      socket.join(DESIGNER_OBJECTS_ROOM);

      try {
        const payload = await designerObjectsStore.save(
          data.state,
          socket.data.userId ?? null,
          socket.data.username ?? null
        );

        socket.emit("designer:objects:state", payload);
        socket.broadcast.to(DESIGNER_OBJECTS_ROOM).emit("designer:objects:state", payload);
      } catch (error) {
        console.error("Unable to save designer objects state:", error);
        socket.emit("designer:objects:error", {
          message: "Unable to save the collaborative map objects state."
        });
      }
    });

    socket.on("addPlayer", async (data) => {
      console.log("addPlayer");

      if (Array.isArray(data?.mapDefinitions) && data.mapDefinitions.length > 0) {
        world.registerMapDefinitions(data.mapDefinitions);
      }

      try {
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
      const initialMapId =
        typeof data?.initialMapId === "string" && data.initialMapId.length > 0
          ? data.initialMapId
          : undefined;
      const initialX =
        typeof data?.initialX === "number" && Number.isFinite(data.initialX)
          ? Math.round(data.initialX)
          : undefined;
      const initialY =
        typeof data?.initialY === "number" && Number.isFinite(data.initialY)
          ? Math.round(data.initialY)
          : undefined;
      const spawnState = savedLocation ?? { mapId: initialMapId, x: initialX, y: initialY };

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
  designerObjectsStore:DesignerObjectsStore
) {
  io.on("connection", createConnectionHandler(world, auth, designerObjectsStore));
}
