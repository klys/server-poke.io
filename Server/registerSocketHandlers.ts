import { type Server, type Socket } from "socket.io";
import Auth, { type AuthenticatedUser } from "../components/Auth";
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

function createConnectionHandler(world:World, auth:Auth) {
  return (socket:ServerSocket) => {
    console.log("Client connected!", socket.id);

    void auth.resolveSession(readSocketToken(socket)).then((session) => {
      applySocketAuth(socket.data, session.user);
      if (session.token) {
        socket.data.token = session.token;
      }
    }).catch((error) => {
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

    socket.on("addPlayer", () => {
      console.log("addPlayer");
      if (world.addPlayer(socket.id)) {
        world.presentPlayersTo(socket.id);
        world.presentObjectsTo(socket.id);
      }
    });

    socket.on("move", (data) => {
      const { x, y } = data;
      const player = world.players.get(socket.id);
      if (!player) return;
      console.log(socket.id+" moving to "+x+" and "+y);
      player.findPath(world, x,y);
      world.players.set(player.socketId, player);
    });

    socket.on("shotProjectil", (data) => {
      console.log("shotProjectil");
      world.shotProjectil(data.mouse_x,data.mouse_y, socket.id);
    });

    socket.on("disconnect", (reason) => {
      console.log(reason);
      world.removePlayer(socket.id);
    });
  };
}

export default function registerSocketHandlers(io:TypedSocketServer, world:World, auth:Auth) {
  io.on("connection", createConnectionHandler(world, auth));
}
