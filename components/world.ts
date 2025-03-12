import Player from "./player"
import Projectil from "./projectil"
import { collision_square, point_direction } from "./gameMath";
import Pathfinding = require("pathfinding")
//pf = require("pathfinding");

export default class World {
    public width:number;
    public height:number;
    players:Map<string, Player>;
    projectiles:Map<number, Projectil>
    roomId:string;
    static socketServer:any;
    static moveScale:number = 8;
    grid:Pathfinding.Grid;
    objects: any[];
    //finder:Pathfinding.Finder;
    //grid_backup:Pathfinding.Grid;
    
    

    constructor(width:number, height:number) {
        this.height = height;
        this.width = width;
        this.roomId = (Math.random()*999).toFixed(5).toString();
        this.players = new Map<string, Player>();
        this.grid = new Pathfinding.Grid(this.width, this.height)
        this.projectiles = new Map<number, Projectil>();
        this.objects = [
            {
                x:200,
                y:200,
                type:"rock0",
                width:32,
                height:32
            },
            {
                x:200,
                y:300,
                type:"rock0",
                width:32,
                height:32
            },
            {
                x:400,
                y:200,
                type:"rock0",
                width:32,
                height:32
            }
        ];

        //this.finder = new Pathfinding.AStarFinder({ diagonalMovement: 1 })
        //this.grid_backup = this.grid.clone()
        //setInterval(this.moveIn.bind(this), 1)
        setInterval(this.livingProjectil.bind(this), 100)
        setInterval(this.playerWaiting.bind(this),1000)
    }

    shotProjectil(mouse_x:number,mouse_y:number, ownerId:string) {
        if (this.players.has(ownerId) === false) return;
        const player = this.players.get(ownerId);
        if (player === undefined) return;
        if (player.death === true) return;
        const angle = point_direction(player.x,player.y,mouse_x,mouse_y)
        const projectil = new Projectil(player.x,player.y,angle);
        projectil.ownerId = ownerId;
        this.projectiles.set(projectil.id, projectil);
        World.socketServer.emit("shotProjectil", projectil.data())
    }

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

    collision_player(element:any):any {
        console.log("collision_player->element:",element)
        
        const piterator = this.players.entries();
        let current = piterator.next()
        
        while(current.done === false) {
            let player = current.value[1];
            console.log(player);
            console.log("checking IF colliding with "+player.socketId)
            if (player.socketId !== element.ownerId)
            if (player.death === false)
            if (collision_square(player, element)) {console.log("COLLIDING!!!!"); return player;};
            current = piterator.next();
        }
        console.log("NOT colliding.")
        return undefined;
    }

    checkCollision(object1:any, object2:any) {
        return (
          object1.x < object2.x + object2.width &&
          object1.x + object1.width > object2.x &&
          object1.y < object2.y + object2.height &&
          object1.y + object1.height > object2.y
        );
      }

    addPlayer(socketId:string):boolean {
        if (this.players.has(socketId) === true) return false;
        this.players.set(socketId, new Player(100,100,socketId, this));
        console.log("players in map: ", this.players.size);
        World.socketServer.emit("addPlayer", this.players.get(socketId)?.data());
        this.presentObjectsTo(socketId);
        return true;
        
    }

    presentPlayersTo(socketId:string) {
        this.players.forEach( (player) => {
            (player.socketId != socketId) ? World.socketServer.in(socketId).emit("addPlayer", player.data()) : null;
        })
    }

    presentObjectsTo(socketId:string) {
        console.log("sending objects to client...")
        this.objects.forEach( (object) => {
            World.socketServer.in(socketId).emit("addObject", object)
        })
    }

    removePlayer(socketId:string) {
        if (!this.players.has(socketId)) return;
        let id = this.players.get(socketId)?.id;
        if (typeof id === "undefined") return;
        World.socketServer.emit("removePlayer", {playerId: socketId, id:id})
        this.players.delete(socketId);
        
        
    }

    setSocketServer(socket:any) {
        World.socketServer = socket;
    }

    testSocket() {
        console.log("test socket executed. ",this.players.size)
        this.players.forEach( (player) => {
            World.socketServer.in(player.socketId).emit("test", {test:"hello test!"})
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