import World from "./components/world"
import {Server} from "socket.io"
import * as express from "express";
import { createServer } from "http";
import ServerToClientEvents from "./Server/ServerToClientEvents";
import ClientToServerEvents from "./Server/ClientToServerEvents";
import InterServerEvents from "./Server/InterServerEvents";

interface SocketData {
  name: string;
  age: number;
}

const app = express();
const httpServer = createServer(app);

const io = new Server<
ClientToServerEvents, 
ServerToClientEvents, 
InterServerEvents, 
SocketData>
(httpServer,{ cors:{origin: "*"} });

const world = new World(400,400);

world.setSocketServer(io)
//world.shotProjectil() // test

io.on("connection", (socket) => {
  console.log("Client connected!")
  
  socket.on("addPlayer", () => {
    if (world.addPlayer(socket.id)) {
      world.presentPlayersTo(socket.id);
      world.presentObjectsTo(socket.id);
    }
  });

  socket.on("move", (data) => {
    //console.log("move: ", data)
    const dataO = ("string" == typeof data) ? JSON.parse(data) : data;
    const x = dataO.x | data.x;
    const y = dataO.y | data.y;
    const player = world.players.get(socket.id)
      if (!player) return;
      console.log(socket.id+" moving to "+x+" and "+y)
        //world.grid_backup = world.grid.clone()
        player.findPath(world, x,y)
        //world.grid = world.grid_backup;
        
        world.players.set(player.socketId, player)
    })

    socket.on("shotProjectil", (data) => {
      console.log("shotProjectil")
      world.shotProjectil(data.mouse_x,data.mouse_y, socket.id)
    })
    
    socket.on("disconnect", (reason) => {
      // remove player from all instances
      console.log(reason)
      world.removePlayer(socket.id)
    });

});  




//io.listen(3001);

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT);
console.log("Listening on port "+PORT)