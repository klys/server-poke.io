import "@dotenvx/dotenvx/config";
import Auth from "./components/Auth";
import DBInit from "./components/DBInit";
import DesignerSectionStore from "./components/DesignerSectionStore";
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
// `https://localhost` / `capacitor://localhost` are the origins the Capacitor
// (Android/iOS) app's WebView uses, so the mobile client can connect to this
// server during local testing.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || ["http://localhost:3000","https://pokecraft.klys.dev","https://localhost","capacitor://localhost"];

async function bootstrap() {
  const mapAssetStore = new MapAssetStore();
  // Static assets (including /map-assets/...) are served by the standalone
  // asset-storage nginx server; this process only handles Socket.IO traffic.
  const httpServer = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
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
    maxHttpBufferSize: 32 * 1024 * 1024
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
    console.log("Listening on port "+PORT);
  });
}

void bootstrap().catch((error) => {
  console.error("Unable to start server.", error);
  process.exit(1);
});
