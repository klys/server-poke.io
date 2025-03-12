import Pathfinding = require("pathfinding")
import World from "./world"
import { point_direction } from "./gameMath";

export default class Player {
    x: number;
    y: number;
    width:number;
    height:number;
    speed:number;
    socketId:string;
    path:number[][];
    path_pos:number;
    angle:number; 
    finder:Pathfinding.Finder;
    life:number;
    death:boolean;
    waitTime:number;
    id:number;
    world:World;
    /*mMap:Pathfinding.Grid
    mPath:number[][];
    sPath:number[][];
    sPath_pos:number;*/

    constructor(x:number,y:number,socketId:string, world:World){
        this.x = x;
        this.y = y;
        this.width = 32;
        this.height = 32;
        this.life = 100;
        this.angle = 0;
        this.socketId = socketId;
        this.speed = 3;
        this.path = [];
        this.path_pos = 0;
        this.death = false;
        this.finder = new Pathfinding.AStarFinder({ diagonalMovement: 1 })
        this.waitTime = 15;
        this.id = Math.round(Math.random()*99999);
        this.world = world;

        /*this.mMap = new Pathfinding.Grid(40,40)
        this.mPath = [];
        this.sPath = [];
        this.sPath_pos = 0;*/
        //setInterval(this.mFinder.bind(this), 1)

        setInterval(this.move.bind(this), 1)
    }

    public move() {
        if (this.path.length === 0) return;
        if (this.path.length === this.path_pos) return;

        //console.log("player "+player.socketId+" moving to "+player.path[player.path_pos][0]+"/"+player.path[player.path_pos][1])

        const toX = this.path[this.path_pos][0]*World.moveScale;
        const toY = this.path[this.path_pos][1]*World.moveScale;

        
        
        
        let colliding = false;
        for (let i = 0; i < this.world.objects.length; i++) {
            if (this.world.checkCollision({
                x:toX,
                y:toY,
                width:this.width,
                height:this.height
            },
            this.world.objects[i]
            )) {
                colliding = true;
                break;
            }
        }

        if (colliding) {
            console.log("colliding: unable to move.")
            return;
        }

        this.angle = point_direction(this.x, this.y, toX, toY)+180
        this.x = toX;
        this.y = toY;

        this.path_pos = this.path_pos + 1;
        World.socketServer.emit("move"+this.socketId, {
            x:this.x,
            y:this.y,
            angle:this.angle,
            playerId:this.socketId, 
            id:this.id
        })

    }

    public findPath(world:World,x:number,y:number) {
        
        this.path = this.finder.findPath(Math.round(this.x/World.moveScale),Math.round(this.y/World.moveScale),
                                        Math.round(x/World.moveScale),Math.round(y/World.moveScale),
                                        world.grid.clone())
        this.path_pos = 0;
    }

    /*public mFinder() {
        if (this.path.length === 0) return;
        if (this.path.length === this.path_pos) return;


    }*/

    public data() {
        return{
            playerId:this.socketId,
            x:this.x,
            y:this.y,
            angle:this.angle,
            id:this.id
        }
    }

    public hurt(damage:number) {
        this.life -= damage;
        if (this.life <= 0) {
            this.die()
            console.log("playerDeath being sent.")
        } else {
            World.socketServer.emit("playerHurt", {playerId:this.socketId,life:this.life, id:this.id})
            console.log("playerHurt being sent.")
        } 
    }

    public reborn() {
        this.life = 100;
        this.death = false;
        World.socketServer.emit("playerReborn"+this.socketId, {playerId:this.socketId, id:this.id})
        World.socketServer.emit("playerReborn", {playerId:this.socketId, id:this.id})
    }

    public die() {
        this.death = true;
        this.waitTime = 15;
        World.socketServer.emit("playerDeath"+this.socketId, {playerId:this.socketId, id:this.id})
        World.socketServer.emit("playerDeath", {playerId:this.socketId, id:this.id})
    }
}