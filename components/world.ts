import Player from "./player"
import Projectil from "./projectil"
import GameMath from "./gameMath";
import Pathfinding = require("pathfinding")

const DEFAULT_PLAYER_MAP_ID = "default-world";
const DEFAULT_PLAYER_X = 100;
const DEFAULT_PLAYER_Y = 100;

type MapObstacle = {
    x:number;
    y:number;
    width:number;
    height:number;
};

type MapBounds = {
    width:number;
    height:number;
};
//pf = require("pathfinding");

/**
 * Main game world representing the environment, tracking players, objects, projectiles, and grid state.
 */
export default class World {
    public width:number;
    public height:number;
    players:Map<string, Player>;
    socketToPlayerId: Map<string, string>;
    projectiles:Map<number, Projectil>
    roomId:string;
    static socketServer:any;
    static moveScale:number = 4;
    grid:Pathfinding.Grid;
    objectsByMapId: Map<string, MapObstacle[]>;
    mapBoundsByMapId: Map<string, MapBounds>;
    //finder:Pathfinding.Finder;
    //grid_backup:Pathfinding.Grid;
    
    

    /**
     * Creates a new game world instance.
     * @param width - The width of the game world grid.
     * @param height - The height of the game world grid.
     */
    constructor(width:number, height:number) {
        this.height = height;
        this.width = width;
        this.roomId = (Math.random()*999).toFixed(5).toString();
        this.players = new Map<string, Player>();
        this.socketToPlayerId = new Map<string, string>();
        this.grid = new Pathfinding.Grid(this.width, this.height)
        this.projectiles = new Map<number, Projectil>();
        this.objectsByMapId = new Map<string, MapObstacle[]>();
        this.mapBoundsByMapId = new Map<string, MapBounds>();

        //this.finder = new Pathfinding.AStarFinder({ diagonalMovement: 1 })
        //this.grid_backup = this.grid.clone()
        //setInterval(this.moveIn.bind(this), 1)
        setInterval(this.livingProjectil.bind(this), 100)
        setInterval(this.playerWaiting.bind(this),1000)
    }

    /**
     * Spawns a projectile originating from a player towards mouse coordinates.
     * @param mouse_x - The target mouse x position.
     * @param mouse_y - The target mouse y position.
     * @param ownerId - The socket ID of the player shooting the projectile.
     */
    shotProjectil(mouse_x:number,mouse_y:number, ownerId:string) {
        const player = this.getPlayerBySocket(ownerId);
        if (player === undefined) return;
        if (player.death === true) return;
        const angle = GameMath.point_direction(player.x,player.y,mouse_x,mouse_y)
        const projectil = new Projectil(player.x,player.y,angle);
        projectil.ownerId = player.socketId;
        this.projectiles.set(projectil.id, projectil);
        World.socketServer.emit("shotProjectil", projectil.data())
    }

    /**
     * Main loop tick for processing projectile movements, collisions, and explosions.
     */
    livingProjectil () {
        this.projectiles.forEach((projectil) => {
            if (projectil.explode) {
                World.socketServer.emit("explodeProjectil", projectil.data())
                this.projectiles.delete(projectil.id)
                return;
            }
            projectil.move();
            let playerCollided = this.collision_player(projectil);
            if (playerCollided !== undefined) {
                projectil.trigger();
                playerCollided.hurt(projectil.damage)
                console.log("COLLISION!")
                World.socketServer.emit("explodeProjectil", projectil.data())
            }
            World.socketServer.emit("moveProjectil"+projectil.id, projectil.data())
        })
        
    }

    /**
     * Loop tick for managing dead players waiting to respawn.
     */
    playerWaiting() {
        const piterator = this.players.entries();
        let current = piterator.next();
        while(current.done === false) {
            let player = current.value[1];
            // ...
            if (player.death) {
                player.waitTime -= 1;
                if (player.waitTime == 0) {
                    // player Reborn
                    player.reborn()
                }
            }
            // ...
            current = piterator.next();
        }
    }

    /**
     * Checks if a given element (like a projectile) is colliding with any alive player.
     * @param element - The entity (usually projectile) checking collision against players.
     * @returns The collided Player instance if found, undefined otherwise.
     */
    collision_player(element:any):any {
        console.log("collision_player->element:",element)
        
        const piterator = this.players.entries();
        let current = piterator.next()
        
        while(current.done === false) {
            let player = current.value[1];
            console.log(player);
            console.log("checking IF colliding with "+player.socketId)
            if (player.socketId !== element.ownerId &&
                player.death === false &&
                GameMath.collision_square(player, element)) {console.log("COLLIDING!!!!"); return player;};
            current = piterator.next();
        }
        console.log("NOT colliding.")
        return undefined;
    }

    /**
     * Generic AABB bounding box collision check between two objects.
     * @param object1 - The first rectangle.
     * @param object2 - The second rectangle.
     * @returns True if they overlap, otherwise false.
     */
    checkCollision(object1:any, object2:any) {
        return (
          object1.x < object2.x + object2.width &&
          object1.x + object1.width > object2.x &&
          object1.y < object2.y + object2.height &&
          object1.y + object1.height > object2.y
        );
      }

    registerMapDefinitions(
        mapDefinitions:Array<{
            mapId:string;
            width:number;
            height:number;
            obstacles:Array<{
                x:number;
                y:number;
                width:number;
                height:number;
            }>;
        }>
    ) {
        mapDefinitions.forEach((definition) => {
            if (typeof definition.mapId !== "string" || definition.mapId.length === 0) {
                return;
            }

            if (
                typeof definition.width === "number" &&
                Number.isFinite(definition.width) &&
                definition.width > 0 &&
                typeof definition.height === "number" &&
                Number.isFinite(definition.height) &&
                definition.height > 0
            ) {
                this.mapBoundsByMapId.set(definition.mapId, {
                    width: Math.max(1, Math.round(definition.width)),
                    height: Math.max(1, Math.round(definition.height))
                });
            }

            const sanitizedObstacles = Array.isArray(definition.obstacles)
                ? definition.obstacles
                    .filter((obstacle) =>
                        typeof obstacle?.x === "number" &&
                        Number.isFinite(obstacle.x) &&
                        typeof obstacle?.y === "number" &&
                        Number.isFinite(obstacle.y) &&
                        typeof obstacle?.width === "number" &&
                        Number.isFinite(obstacle.width) &&
                        obstacle.width > 0 &&
                        typeof obstacle?.height === "number" &&
                        Number.isFinite(obstacle.height) &&
                        obstacle.height > 0
                    )
                    .map((obstacle) => ({
                        x: Math.max(0, Math.round(obstacle.x)),
                        y: Math.max(0, Math.round(obstacle.y)),
                        width: Math.max(1, Math.round(obstacle.width)),
                        height: Math.max(1, Math.round(obstacle.height))
                    }))
                : [];

            this.objectsByMapId.set(definition.mapId, sanitizedObstacles);
        });
    }

    getMapObjects(mapId:string) {
        return this.objectsByMapId.get(mapId) ?? [];
    }

    getMapBounds(mapId:string) {
        return this.mapBoundsByMapId.get(mapId) ?? {
            width: this.width,
            height: this.height
        };
    }

    clampPlayerPosition(mapId:string, x:number, y:number, playerWidth:number, playerHeight:number) {
        const mapBounds = this.getMapBounds(mapId);
        const maxX = Math.max(0, mapBounds.width - playerWidth);
        const maxY = Math.max(0, mapBounds.height - playerHeight);

        return {
            x: Math.max(0, Math.min(Math.round(x), maxX)),
            y: Math.max(0, Math.min(Math.round(y), maxY))
        };
    }

    createGridForMap(mapId:string) {
        const mapBounds = this.getMapBounds(mapId);
        const gridWidth = Math.max(1, Math.ceil(mapBounds.width / World.moveScale));
        const gridHeight = Math.max(1, Math.ceil(mapBounds.height / World.moveScale));

        return new Pathfinding.Grid(gridWidth, gridHeight);
    }

    /**
     * Adds a new player to the game world map.
     * @param socketId - The unique socket ID representing the player.
     * @returns True if added successfully, false if the player already exists.
     */
    private getAuthenticatedPlayerId(userId:number) {
        return `user:${userId}`;
    }

    private getGuestPlayerId(socketId:string) {
        return `guest:${socketId}`;
    }

    getPlayerBySocket(socketId:string) {
        const playerId = this.socketToPlayerId.get(socketId);
        return playerId ? this.players.get(playerId) : undefined;
    }

    addPlayer(
        socketId:string,
        spawnState?: { mapId?: string; x?: number; y?: number },
        userId?: number | null
    ) {
        const existingPlayerForSocket = this.getPlayerBySocket(socketId);
        if (existingPlayerForSocket) {
            return { player: existingPlayerForSocket, created: false };
        }

        const playerId =
            typeof userId === "number"
                ? this.getAuthenticatedPlayerId(userId)
                : this.getGuestPlayerId(socketId);
        const existingPlayer = this.players.get(playerId);

        if (existingPlayer) {
            existingPlayer.attachSocket(socketId);
            this.socketToPlayerId.set(socketId, playerId);
            World.socketServer.in(socketId).emit("addPlayer", existingPlayer.data());
            this.presentObjectsTo(socketId);
            return { player: existingPlayer, created: false };
        }

        const mapId =
            typeof spawnState?.mapId === "string" && spawnState.mapId.length > 0
                ? spawnState.mapId
                : DEFAULT_PLAYER_MAP_ID;
        const unclampedX =
            typeof spawnState?.x === "number" && Number.isFinite(spawnState.x)
                ? spawnState.x
                : DEFAULT_PLAYER_X;
        const unclampedY =
            typeof spawnState?.y === "number" && Number.isFinite(spawnState.y)
                ? spawnState.y
                : DEFAULT_PLAYER_Y;
        const spawnPosition = this.clampPlayerPosition(mapId, unclampedX, unclampedY, 32, 32);

        const player = new Player(
            spawnPosition.x,
            spawnPosition.y,
            playerId,
            this,
            mapId,
            socketId,
            typeof userId === "number" ? userId : null
        );

        this.players.set(playerId, player);
        this.socketToPlayerId.set(socketId, playerId);
        console.log("players in map: ", this.players.size);
        World.socketServer.emit("addPlayer", player.data());
        this.presentObjectsTo(socketId);
        return { player, created: true };
        
    }

    /**
     * Emits events to present all *other* players to a specific, newly connected player.
     * @param socketId - The socket ID of the targeted client.
     */
    presentPlayersTo(socketId:string) {
        const currentPlayerId = this.socketToPlayerId.get(socketId);
        this.players.forEach( (player) => {
            (player.socketId != currentPlayerId) ? World.socketServer.in(socketId).emit("addPlayer", player.data()) : null;
        })
    }

    /**
     * Broadcasts world objects (like rocks/environment elements) to a targeted client.
     * @param socketId - The socket ID of the targeted client.
     */
    presentObjectsTo(socketId:string) {
        console.log("sending objects to client...")
        const mapId = this.getPlayerBySocket(socketId)?.currentMapId ?? DEFAULT_PLAYER_MAP_ID;
        this.getMapObjects(mapId).forEach( (object) => {
            World.socketServer.in(socketId).emit("addObject", object)
        })
    }

    /**
     * Removes a player from the world and notifies clients.
     * @param socketId - The socket ID of the player to remove.
     */
    removePlayer(socketId:string) {
        const playerId = this.socketToPlayerId.get(socketId);
        if (!playerId) {
            return { player: null, removed: false };
        }

        const player = this.players.get(playerId);
        if (!player) {
            this.socketToPlayerId.delete(socketId);
            return { player: null, removed: false };
        }

        player.detachSocket(socketId);
        this.socketToPlayerId.delete(socketId);

        if (player.hasActiveSockets()) {
            return { player, removed: false };
        }

        World.socketServer.emit("removePlayer", {playerId: player.socketId, id:player.id})
        this.players.delete(playerId);

        return { player, removed: true };
    }

    /**
     * Sets the static Socket.IO server instance for the World class to dispatch events.
     * @param socket - The Socket.IO server instance.
     */
    setSocketServer(socket:any) {
        World.socketServer = socket;
    }

    /**
     * Emits a test message to all connected players.
     */
    testSocket() {
        console.log("test socket executed. ",this.players.size)
        this.players.forEach( (player) => {
            player.socketConnections.forEach((socketId) => {
                World.socketServer.in(socketId).emit("test", {test:"hello test!"})
            });
        })
        
    }

    /*moveIn() {
        //console.log("moveIn cycle ran.")
        this.players.forEach((player) => {
            
            
            if (player.path.length === 0) return;
            if (player.path.length === player.path_pos) return;

            //console.log("player "+player.socketId+" moving to "+player.path[player.path_pos][0]+"/"+player.path[player.path_pos][1])

            
            player.angle = point_direction(player.x, player.y, player.path[player.path_pos][0], player.path[player.path_pos][1])+180
            player.x = player.path[player.path_pos][0];
            player.y = player.path[player.path_pos][1];


            player.path_pos = player.path_pos + 1;
            this.socketServer.emit("move", {x:player.x,y:player.y,angle:player.angle,playerId:player.socketId})

        })
        
        
        
    }*/

    
}
