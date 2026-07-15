import "@dotenvx/dotenvx/config";
import Auth from "./components/Auth";
import DBInit from "./components/DBInit";
import DesignerSectionStore, { type DesignerSectionKey } from "./components/DesignerSectionStore";
import GroundItemStore from "./components/GroundItemStore";
import MailService from "./components/MailService";
import MapAssetStore from "./components/MapAssetStore";
import PlayableMapsStore from "./components/PlayableMapsStore";
import PokecraftApiClient from "./components/PokecraftApiClient";
import World from "./components/world"
import {Server} from "socket.io"
import { createServer } from "http";
import ServerToClientEvents from "./Server/ServerToClientEvents";
import ClientToServerEvents from "./Server/ClientToServerEvents";
import InterServerEvents from "./Server/InterServerEvents";
import registerSocketHandlers, { type SocketData } from "./Server/registerSocketHandlers";

const PORT = Number(process.env.PORT || 3001);
// The git commit this image was built from, baked in via the Dockerfile
// `GIT_SHA` build arg. Exposed at /version so the deploy pipeline can verify
// prod is actually running the pushed commit instead of a stale image.
const GIT_SHA = process.env.GIT_SHA || "unknown";
const STARTED_AT = new Date().toISOString();
// `https://localhost` / `capacitor://localhost` are the origins the Capacitor
// (Android/iOS) app's WebView uses, so the mobile client can connect to this
// server during local testing.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || ["http://localhost:3000","https://pokecraft.klys.dev","https://localhost","capacitor://localhost"];

function buildCorsHeaders(requestOrigin:string | undefined) {
  const allowedOrigins = Array.isArray(CLIENT_ORIGIN) ? CLIENT_ORIGIN : [CLIENT_ORIGIN];
  const origin = requestOrigin && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin"
  };
}

async function bootstrap() {
  const mapAssetStore = new MapAssetStore();

  // The playable-maps payload is tens of MB. Streaming it through Socket.IO
  // starved the websocket (heartbeats queue behind the transfer → "ping
  // timeout"/"transport error" storms), so clients fetch it here over plain
  // HTTP instead: the browser HTTP cache holds it (localStorage can't) and
  // the ETag turns repeat loads into cheap 304s. The socket sync remains as
  // a fallback for older clients.
  let playableMapsHttpCache = { etag: "", body: "" };
  const servePlayableMaps = async (
    request:import("http").IncomingMessage,
    response:import("http").ServerResponse
  ) => {
    try {
      const payload = await playableMapsStore.read();
      const headers:Record<string, string> = buildCorsHeaders(request.headers.origin);

      if (!payload) {
        response.writeHead(404, headers);
        response.end();
        return;
      }

      const etag = `"pm-${payload.version}-${playableMapsStore.currentProbe()}"`;
      headers["ETag"] = etag;
      headers["Cache-Control"] = "no-cache";

      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, headers);
        response.end();
        return;
      }

      if (playableMapsHttpCache.etag !== etag) {
        playableMapsHttpCache = { etag, body: JSON.stringify(payload) };
      }

      headers["Content-Type"] = "application/json";
      response.writeHead(200, headers);
      response.end(playableMapsHttpCache.body);
    } catch (error) {
      console.error("Unable to serve playable maps over HTTP:", error);
      response.writeHead(500);
      response.end();
    }
  };

  // Shared designer sections every player needs (the same whitelist the
  // socket layer exposes to authenticated non-designers). Served over HTTP so
  // the native-app build pipeline can snapshot them into the bundled cache
  // (and so native clients could refresh them without the socket).
  const PUBLIC_SECTION_KEYS = new Set([
    "pokemons",
    "npcs",
    "players",
    "skillsGfx",
    "audio",
    "types",
    "battleInterface"
  ]);
  const sectionHttpCache = new Map<string, { etag:string; body:string }>();
  const serveDesignerSection = async (
    sectionKey:string,
    request:import("http").IncomingMessage,
    response:import("http").ServerResponse
  ) => {
    try {
      const payload = await designerSectionStore.read(sectionKey as DesignerSectionKey);
      const headers:Record<string, string> = buildCorsHeaders(request.headers.origin);

      if (!payload) {
        response.writeHead(404, headers);
        response.end();
        return;
      }

      const etag = `"ds-${sectionKey}-${payload.version}-${payload.updatedAt ?? ""}"`;
      headers["ETag"] = etag;
      headers["Cache-Control"] = "no-cache";

      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, headers);
        response.end();
        return;
      }

      const cached = sectionHttpCache.get(sectionKey);
      if (!cached || cached.etag !== etag) {
        sectionHttpCache.set(sectionKey, { etag, body: JSON.stringify(payload) });
      }

      headers["Content-Type"] = "application/json";
      response.writeHead(200, headers);
      response.end(sectionHttpCache.get(sectionKey)!.body);
    } catch (error) {
      console.error(`Unable to serve designer section ${sectionKey} over HTTP:`, error);
      response.writeHead(500);
      response.end();
    }
  };

  // Static assets (including /map-assets/...) are served by the standalone
  // asset-storage nginx server; this process only handles Socket.IO traffic
  // plus the endpoints below.
  const httpServer = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
      return;
    }

    if (request.url === "/version") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sha: GIT_SHA, startedAt: STARTED_AT }));
      return;
    }

    if (request.url === "/playable-maps.json") {
      void servePlayableMaps(request, response);
      return;
    }

    const sectionMatch = request.url?.match(/^\/designer-sections\/([a-zA-Z]+)\.json$/);
    if (sectionMatch && PUBLIC_SECTION_KEYS.has(sectionMatch[1])) {
      void serveDesignerSection(sectionMatch[1], request, response);
      return;
    }

    response.writeHead(404);
    response.end();
  });
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: {
      origin: CLIENT_ORIGIN,
      credentials: true
    },
    // Baked map surface uploads (designer:mapAssets:update) exceed the 1MB default.
    maxHttpBufferSize: 32 * 1024 * 1024,
    // Heartbeat tuning: the defaults (20s timeout) drop connections whenever a
    // large designer upload or a burst of admin queries delays a pong, which
    // showed up as constant "ping timeout" disconnects in the admin panel.
    pingInterval: 25000,
    pingTimeout: 60000,
    // Let briefly-disconnected clients resume their session (rooms — e.g.
    // admin:presence — and missed packets) instead of coming back cold.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000
    }
  });
  const redis = await new DBInit().initialize();
  const mailService = new MailService();
  await mailService.initialize();
  const auth = new Auth(redis, mailService);
  const designerSectionStore = new DesignerSectionStore(redis);
  const groundItemStore = new GroundItemStore(redis);
  const playableMapsStore = new PlayableMapsStore(redis);
  const pokecraftApi = new PokecraftApiClient();
  const world = new World(400,400);

  if (!pokecraftApi.isConfigured()) {
    console.warn(
      "POKECRAFT_API_ADMIN_KEY is not set — admin API key management will be unavailable."
    );
  }

  await auth.initialize();
  world.setSocketServer(io);
  await world.initializeGroundItems(groundItemStore);
  registerSocketHandlers(io, world, auth, designerSectionStore, playableMapsStore, groundItemStore, mapAssetStore, pokecraftApi);

  httpServer.listen(PORT, () => {
    console.log(`server-poke.io build ${GIT_SHA} started at ${STARTED_AT}`);
    console.log("Listening on port "+PORT);
  });
}

void bootstrap().catch((error) => {
  console.error("Unable to start server.", error);
  process.exit(1);
});
