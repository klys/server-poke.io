import Pathfinding = require("pathfinding")
import World from "./world"
import GameMath from "./gameMath";

/**
 * Represents a player entity in the game world.
 */
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

    /**
     * Creates a new player.
     * @param x - The initial x coordinate.
     * @param y - The initial y coordinate.
     * @param socketId - The network socket ID of the player.
     * @param world - Reference to the game world.
     */
    constructor(x:number,y:number,socketId:string, world:World){
        this.x = x;
        this.y = y;
        this.width = 32;
        this.height = 32;
        this.life = 100;
        this.angle = 270;
        this.socketId = socketId;
        this.speed = 1;
        this.path = [];
        this.path_pos = 0;
        this.death = false;
        this.finder = new Pathfinding.AStarFinder()
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

    /**
     * Evaluates the current path segment and moves the player towards it.
     */
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
            console.log("colliding: unable to move." ,{x:toX,y:toY})
            return;
        }

        const direction = GameMath.point_direction(this.x, this.y, toX, toY) + 180;
        this.angle = GameMath.roundToQuadrant(direction);
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

    /**
     * Computes a path from the current position to the specified coordinates.
     * @param world - Reference to the game world for pathfinding grid cloning.
     * @param x - Target x coordinate.
     * @param y - Target y coordinate.
     */
    public findPath(world:World,x:number,y:number) {
        const maxGridX = Math.floor(world.width / World.moveScale) - 1;
        const maxGridY = Math.floor(world.height / World.moveScale) - 1;

        const fromX = this.normalizeGridCoordinate(this.x, maxGridX);
        const fromY = this.normalizeGridCoordinate(this.y, maxGridY);
        const toX = this.normalizeGridCoordinate(x, maxGridX);
        const toY = this.normalizeGridCoordinate(y, maxGridY);

        this.path = this.finder.findPath(fromX, fromY, toX, toY, world.grid.clone())
        this.path_pos = 0;
    }

    private normalizeGridCoordinate(value:number, max:number) {
        const scaledValue = Math.floor(value / World.moveScale);
        return Math.max(0, Math.min(scaledValue, max));
    }

    /*public mFinder() {
        if (this.path.length === 0) return;
        if (this.path.length === this.path_pos) return;


    }*/

    /**
     * Retrieves the basic state data of the player.
     * @returns An object containing the current player details.
     */
    public data() {
        const playerData = {
            playerId:this.socketId,
            x:this.x,
            y:this.y,
            angle:this.angle,
            id:this.id
        }
        console.log("presenting existing player with data:", playerData)
        return{
            playerId:this.socketId,
            x:this.x,
            y:this.y,
            angle:this.angle,
            id:this.id
        }
    }

    /**
     * Applies damage to the player and handles death logic if life reaches 0.
     * @param damage - The amount of health to deduct.
     */
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

    /**
     * Restores the player to full health and clears the death state.
     */
    public reborn() {
        this.life = 100;
        this.death = false;
        World.socketServer.emit("playerReborn"+this.socketId, {playerId:this.socketId, id:this.id})
        World.socketServer.emit("playerReborn", {playerId:this.socketId, id:this.id})
    }

    /**
     * Marks the player as dead and initiates the respawn wait timer.
     */
    public die() {
        this.death = true;
        this.waitTime = 15;
        World.socketServer.emit("playerDeath"+this.socketId, {playerId:this.socketId, id:this.id})
        World.socketServer.emit("playerDeath", {playerId:this.socketId, id:this.id})
    }
}
