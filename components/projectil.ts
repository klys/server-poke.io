import GameMath from "./gameMath"
import World from "./world"

/**
 * Represents a projectile fired by a player.
 */
export default class Projectil {
    x:number;
    y:number;
    width:number;
    height:number;
    angle:number;
    toX:number;
    toY:number;
    id:number;
    maxDistance:number;
    distance:number;
    speed:number;
    explode:boolean;
    ownerId:string;
    damage:number;

    /**
     * Creates a new projectile.
     * @param x - The starting x coordinate.
     * @param y - The starting y coordinate.
     * @param angle - The angle at which the projectile is fired.
     */
    constructor(x:number, y:number, angle:number) {
        this.ownerId = '';
        this.explode = false;
        this.x = x;
        this.y = y;
        this.width = 32;
        this.height = 32;
        this.angle = angle;
        const maxDistance = GameMath.polar_move(x,y,this.angle,1000);
        this.maxDistance = 300;
        this.distance = 0 ;
        this.toX = maxDistance.x;
        this.toY = maxDistance.y;
        this.speed = 2;
        this.damage = 15;
        console.log("max distance this projectil will reach: ("+this.toX+", "+this.toY+")")
        this.id = Math.round(Math.random()*99999);
    }

    /**
     * Sets the owner ID of the projectile so players cannot hit themselves.
     * @param id - The socket ID of the player who fired the projectile.
     */
    setOwnership(id:string):void {
        this.ownerId = id;
    }

    /**
     * Retrieves the core data of the projectile for network transmission.
     * @returns An object containing the projectile's basic state.
     */
    data() {
        return {
            x:this.x,
            y:this.y,
            id:this.id,
            angle:this.angle
        }
    }

    /**
     * Sets the destination coordinates manually.
     * @param x - The destination x coordinate.
     * @param y - The destination y coordinate.
     */
    setMove(x:number,y:number) {
        this.toX = x;
        this.toY = y;
    }

    /**
     * Updates the projectile's position based on its speed and angle.
     */
    move() {
        if (this.distance < this.maxDistance) {
            // if we are not in the right position
            // move to it
            this.distance += this.speed;
            const newPos = GameMath.polar_move(this.x,this.y,this.angle,this.speed);
            this.x = newPos.x;
            this.y = newPos.y;
            console.log("projectil moving ... ("+this.x+", "+this.y+")")
        } else this.trigger();
    }

    /**
     * Triggers the projectile to explode.
     */
    trigger() {
        this.explode = true;
    }




}