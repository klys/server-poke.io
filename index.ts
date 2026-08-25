import "@dotenvx/dotenvx/config";
import Auth from "./components/Auth";
import DBInit from "./components/DBInit";
import DesignerSectionStore, { isDesignerSectionKey, type DesignerSectionKey } from "./components/DesignerSectionStore";
import GroundItemStore from "./components/GroundItemStore";
import { BerryPlotStore } from "./components/BerryPlots";
import MailService from "./components/MailService";
import MapAssetStore from "./components/MapAssetStore";
import PlayableMapsStore from "./components/PlayableMapsStore";
import PokecraftApiClient from "./components/PokecraftApiClient";
import RxdataUploadStore, { MAX_ZIP_BYTES } from "./components/RxdataUploadStore";
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
  // Heavy media catalogs (tilesets ~36MB, assets ~134MB) are art data, not
  // secrets — the same graphics are already public on the asset-storage
  // origin. They are served here instead of the websocket because emitting
  // them through Socket.IO stalls the event loop and starves heartbeats for
  // every connected player; the socket only ever announces version stubs and
  // clients (including designers) download the state from this endpoint,
  // where ETag/304 plus the browser HTTP cache absorb repeat loads.
  const HEAVY_SECTION_KEYS = new Set([
    "assets",
    "tilesets",
    "battleBackgrounds"
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

      const body = sectionHttpCache.get(sectionKey)!.body;
      headers["Content-Type"] = "application/json";
      // Explicit length (instead of chunked transfer) so the designer's
      // download progress bar has a total to report against.
      headers["Content-Length"] = String(Buffer.byteLength(body));
      response.writeHead(200, headers);
      response.end(body);
    } catch (error) {
      console.error(`Unable to serve designer section ${sectionKey} over HTTP:`, error);
      response.writeHead(500);
      response.end();
    }
  };

  // CanaimaDex species data for the client's venomon stats window. Proxied
  // here (not fetched by the browser) because pokecraft-api requires an API
  // key on every /api/* request and that key must stay server-side.
  const serveDexSpecies = async (
    essentialsId:string,
    request:import("http").IncomingMessage,
    response:import("http").ServerResponse
  ) => {
    const headers:Record<string, string> = buildCorsHeaders(request.headers.origin);

    if (!pokecraftApi.isConfigured()) {
      response.writeHead(503, headers);
      response.end();
      return;
    }

    try {
      const detail = await pokecraftApi.getSpeciesDetailByEssentialsId(essentialsId);

      if (!detail) {
        response.writeHead(404, headers);
        response.end();
        return;
      }

      headers["Content-Type"] = "application/json";
      // Species data only changes on designer/PBS reloads; let clients keep
      // it for a while so reopening stats windows doesn't refetch.
      headers["Cache-Control"] = "public, max-age=600";
      response.writeHead(200, headers);
      response.end(JSON.stringify(detail));
    } catch (error) {
      console.error(`Unable to serve dex species ${essentialsId}:`, error);
      response.writeHead(502, headers);
      response.end();
    }
  };

  // Designer-only sections (items, skills, trainers, ...) are also served
  // over HTTP so the designer UI can lazy-load them per page instead of
  // streaming every catalog through the websocket at connect. They require a
  // session token with designer.access, passed as "Authorization: Bearer".
  const readBearerToken = (request:import("http").IncomingMessage) => {
    const header = request.headers.authorization;

    return typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : undefined;
  };
  const serveDesignerOnlySection = async (
    sectionKey:string,
    request:import("http").IncomingMessage,
    response:import("http").ServerResponse
  ) => {
    try {
      const session = await auth.resolveSession(readBearerToken(request));
      const permissions = session.user?.permissions ?? [];

      if (!permissions.includes("designer.access")) {
        response.writeHead(session.authenticated ? 403 : 401, buildCorsHeaders(request.headers.origin));
        response.end();
        return;
      }

      await serveDesignerSection(sectionKey, request, response);
    } catch (error) {
      console.error(`Unable to authorize designer section ${sectionKey}:`, error);
      response.writeHead(500, buildCorsHeaders(request.headers.origin));
      response.end();
    }
  };

  // rxdata_json zip uploads for the admin panel's "Repair Essentials Events"
  // maintenance action. Uploaded over HTTP (not Socket.IO) because a dump zip
  // is a multi-MB binary blob — exactly the kind of payload that must stay
  // off the websocket. Requires an admin.access session token.
  const handleRxdataUpload = async (
    request:import("http").IncomingMessage,
    response:import("http").ServerResponse
  ) => {
    const headers:Record<string, string> = {
      ...buildCorsHeaders(request.headers.origin),
      "Content-Type": "application/json"
    };

    try {
      const session = await auth.resolveSession(readBearerToken(request));
      const permissions = session.user?.permissions ?? [];
      if (!permissions.includes("admin.access")) {
        response.writeHead(session.authenticated ? 403 : 401, headers);
        response.end(JSON.stringify({ ok: false, errors: ["Admin access is required."] }));
        return;
      }
      if (maintenanceRunner?.running) {
        response.writeHead(409, headers);
        response.end(JSON.stringify({ ok: false, errors: ["A maintenance action is running — try again when it finishes."] }));
        return;
      }

      const chunks:Buffer[] = [];
      let totalBytes = 0;
      let aborted = false;
      await new Promise<void>((resolve, reject) => {
        request.on("data", (chunk:Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_ZIP_BYTES) {
            aborted = true;
            request.destroy();
            resolve();
            return;
          }
          chunks.push(chunk);
        });
        request.on("end", () => resolve());
        request.on("error", (error) => (aborted ? resolve() : reject(error)));
      });
      if (aborted) {
        response.writeHead(413, headers);
        response.end(JSON.stringify({ ok: false, errors: ["The zip exceeds the upload size limit."] }));
        return;
      }

      const originalName = decodeURIComponent(String(request.headers["x-file-name"] ?? "upload.zip")).slice(0, 120);
      const uploadStore = maintenanceRunner?.rxdataUploads ?? new RxdataUploadStore();
      const result = await uploadStore.stageZip(Buffer.concat(chunks), {
        uploadedBy: session.user?.username ? `@${session.user.username}` : `user:${session.user?.id ?? "?"}`,
        originalName
      });
      response.writeHead(result.ok ? 200 : 422, headers);
      response.end(JSON.stringify(result));
    } catch (error) {
      console.error("Unable to process rxdata upload:", error);
      response.writeHead(500, headers);
      response.end(JSON.stringify({ ok: false, errors: ["Unexpected server error while processing the upload."] }));
    }
  };

  // Static assets (including /map-assets/...) are served by the standalone
  // asset-storage nginx server; this process only handles Socket.IO traffic
  // plus the endpoints below.
  const httpServer = createServer((request, response) => {
    // Preflight for requests carrying the Authorization header (designer-only
    // section downloads, admin rxdata uploads). Socket.IO handles its own
    // preflights.
    if (
      request.method === "OPTIONS" &&
      (request.url?.startsWith("/designer-sections/") || request.url === "/admin/maintenance/rxdata-upload")
    ) {
      response.writeHead(204, {
        ...buildCorsHeaders(request.headers.origin),
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name",
        "Access-Control-Max-Age": "86400"
      });
      response.end();
      return;
    }

    if (request.method === "POST" && request.url === "/admin/maintenance/rxdata-upload") {
      void handleRxdataUpload(request, response);
      return;
    }

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
    if (sectionMatch && isDesignerSectionKey(sectionMatch[1])) {
      if (PUBLIC_SECTION_KEYS.has(sectionMatch[1]) || HEAVY_SECTION_KEYS.has(sectionMatch[1])) {
        void serveDesignerSection(sectionMatch[1], request, response);
      } else {
        void serveDesignerOnlySection(sectionMatch[1], request, response);
      }
      return;
    }

    const dexMatch = request.url?.match(/^\/dex\/species\/([A-Za-z0-9_-]{1,64})\.json$/);
    if (dexMatch) {
      void serveDexSpecies(dexMatch[1], request, response);
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
    // Baked map surface uploads (designer:mapAssets:update) exceed the 1MB
    // default, and designer:section:update for the tilesets catalog currently
    // ships the full ~36MB state — Socket.IO hard-disconnects any client whose
    // packet exceeds this cap, so keep headroom above the largest saved blob.
    maxHttpBufferSize: 64 * 1024 * 1024,
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
  await world.initializeBerryPlots(new BerryPlotStore(redis));
  const { tradeManager, maintenanceRunner } = registerSocketHandlers(io, world, auth, designerSectionStore, playableMapsStore, groundItemStore, redis, mapAssetStore, pokecraftApi, mailService);
  // Trades never survive a restart: drop any player claims and asset
  // reservations a previous run left behind before accepting connections.
  await tradeManager.initialize();

  httpServer.listen(PORT, () => {
    console.log(`server-poke.io build ${GIT_SHA} started at ${STARTED_AT}`);
    console.log("Listening on port "+PORT);
  });
}

void bootstrap().catch((error) => {
  console.error("Unable to start server.", error);
  process.exit(1);
});
