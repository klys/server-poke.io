import "@dotenvx/dotenvx/config";
import Auth from "./components/Auth";
import DBInit from "./components/DBInit";
import DesignerSectionStore from "./components/DesignerSectionStore";
import GroundItemStore from "./components/GroundItemStore";
import MailService from "./components/MailService";
import PlayableMapsStore from "./components/PlayableMapsStore";
import World from "./components/world"
import {Server} from "socket.io"
import { createServer } from "http";
import ServerToClientEvents from "./Server/ServerToClientEvents";
import ClientToServerEvents from "./Server/ClientToServerEvents";
import InterServerEvents from "./Server/InterServerEvents";
import registerSocketHandlers, { type SocketData } from "./Server/registerSocketHandlers";

const PORT = Number(process.env.PORT || 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || ["http://localhost:3000","https://pokecraft.klys.dev"];

async function bootstrap() {
  const httpServer = createServer();
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: {
      origin: CLIENT_ORIGIN,
      credentials: true
    }
  });
  const redis = await new DBInit().initialize();
  const mailService = new MailService();
  await mailService.initialize();
  const auth = new Auth(redis, mailService);
  const designerSectionStore = new DesignerSectionStore(redis);
  const groundItemStore = new GroundItemStore(redis);
  const playableMapsStore = new PlayableMapsStore(redis);
  const world = new World(400,400);

  await auth.initialize();
  world.setSocketServer(io);
  await world.initializeGroundItems(groundItemStore);
  registerSocketHandlers(io, world, auth, designerSectionStore, playableMapsStore, groundItemStore);

  httpServer.listen(PORT, () => {
    console.log("Listening on port "+PORT);
  });
}

void bootstrap().catch((error) => {
  console.error("Unable to start server.", error);
  process.exit(1);
});
