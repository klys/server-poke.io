import World from "./world"
import GameMath from "./gameMath";

const PLAYER_MOVE_INTERVAL_MS = 28;
const POST_TELEPORT_TOUCH_LOCK_MS = 900;

/**
 * Represents a player entity in the game world.
 */
export default class Player {
    x: number;
    y: number;
    currentMapId:string;
    width:number;
    height:number;
    speed:number;
    /** Path nodes consumed per movement tick. 1 = walking, >1 = cycling. */
    speedMultiplier:number = 1;
    /** True while the Bicycle is out (drives speedMultiplier and the sprite). */
    cycling:boolean = false;
    /** True while Surf is active: water-tagged solid cells become passable. */
    isSurfing:boolean = false;
    socketId:string;
    socketConnections:Set<string>;
    userId:number | null;
    username:string;
    name:string;
    profileImage:string;
    description:string;
    characterSkinId:string;
    inBattle:boolean;
    path:number[][];
    path_pos:number;
    /** Cached RPG Maker event state (switches etc.), refreshed by the event
     * runtime; used synchronously for conditional NPC collision. */
    eventState:{
        switches:Record<string, boolean>;
        variables:Record<string, number>;
        selfSwitches:Record<string, boolean>;
    } | null = null;
    /** Last cell a standing-touch check ran for (touch events fire on cell
     * entry, and teleports seed this so arrivals don't instantly re-fire). */
    lastTouchCellKey:string = "";
    /** Touch triggers (standing AND bump) are suppressed until this time.
     * Set on teleport so a held movement key can't immediately bump the
     * paired door at the destination and warp the player straight back. */
    touchLockUntil:number = 0;
    angle:number; 
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
    constructor(
        x:number,
        y:number,
        playerId:string,
        world:World,
        currentMapId:string,
        initialSocketId:string,
        userId:number | null = null,
        trainerProfile?: {
            username?: string;
            name?: string;
            profileImage?: string;
            description?: string;
            characterSkinId?: string;
        }
    ){
        this.x = x;
        this.y = y;
        this.currentMapId = currentMapId;
        this.width = 32;
        this.height = 32;
        this.life = 100;
        this.angle = 270;
        this.socketId = playerId;
        this.socketConnections = new Set<string>([initialSocketId]);
        this.userId = userId;
        this.username = trainerProfile?.username ?? "";
        this.name = trainerProfile?.name ?? "";
        this.profileImage = trainerProfile?.profileImage ?? "";
        this.description = trainerProfile?.description ?? "";
        this.characterSkinId = trainerProfile?.characterSkinId ?? "";
        this.inBattle = false;
        this.speed = 1;
        this.path = [];
        this.path_pos = 0;
        this.death = false;
        this.waitTime = 15;
        this.id = Math.round(Math.random()*99999);
        this.world = world;

        /*this.mMap = new Pathfinding.Grid(40,40)
        this.mPath = [];
        this.sPath = [];
        this.sPath_pos = 0;*/
        //setInterval(this.mFinder.bind(this), 1)

        setInterval(this.move.bind(this), PLAYER_MOVE_INTERVAL_MS)
    }

    public attachSocket(socketId:string) {
        this.socketConnections.add(socketId);
    }

    public detachSocket(socketId:string) {
        this.socketConnections.delete(socketId);
    }

    public hasActiveSockets() {
        return this.socketConnections.size > 0;
    }

    /** Bicycle speed while cycling (path nodes consumed per movement tick). */
    static readonly CYCLE_SPEED_MULTIPLIER = 2;

    /** Toggles/sets the Bicycle. Cycling doubles movement speed. */
    setCycling(on: boolean) {
        this.cycling = on;
        this.speedMultiplier = on ? Player.CYCLE_SPEED_MULTIPLIER : 1;
    }

    /** The cell the player currently occupies (its collision-box centre). */
    getCurrentCell(cellSize: number) {
        return {
            x: Math.floor((this.x + this.width / 2) / cellSize),
            y: Math.floor((this.y + this.height / 2) / cellSize)
        };
    }

    /** The cell directly in front of the player, based on facing angle. */
    getFacingCell(cellSize: number) {
        const current = this.getCurrentCell(cellSize);
        // angle: 90=up, 270=down, 0/360=left, 180=right (see gameMath / client).
        const normalized = ((Math.round(this.angle) % 360) + 360) % 360;
        let dx = 0;
        let dy = 0;
        if (normalized === 90) dy = -1;
        else if (normalized === 270) dy = 1;
        else if (normalized === 180) dx = 1;
        else dx = -1; // 0 / 360 = left (default)
        return { x: current.x + dx, y: current.y + dy };
    }

    /**
     * Turns to face an adjacent cell (no movement) and broadcasts the new
     * facing so every client re-orients the sprite. Used by click-to-fish so
     * the player looks at the water tile they tapped before casting.
     */
    public faceCell(target: { x: number; y: number }, cellSize: number) {
        const current = this.getCurrentCell(cellSize);
        const dx = target.x - current.x;
        const dy = target.y - current.y;
        if (dx === 0 && dy === 0) return;
        // Inverse of getFacingCell: 90=up, 270=down, 180=right, 0=left.
        if (Math.abs(dx) >= Math.abs(dy)) {
            this.angle = dx > 0 ? 180 : 0;
        } else {
            this.angle = dy > 0 ? 270 : 90;
        }
        this.world.emitToMap(this.currentMapId, "move" + this.socketId, {
            x: this.x,
            y: this.y,
            angle: this.angle,
            playerId: this.socketId,
            id: this.id,
            currentMapId: this.currentMapId,
            stopped: true
        });
    }

    /**
     * Evaluates the current path segment and moves the player towards it.
     * While cycling, up to `speedMultiplier` path nodes are consumed per tick
     * (each still runs the full block/slide/touch logic), so the Bicycle just
     * advances the walk faster without a separate faster interval.
     */
    public move() {
        if (this.inBattle) return;
        if (this.relocateInsideMapIfNeeded()) return;

        const steps = Math.max(1, Math.round(this.speedMultiplier));
        for (let i = 0; i < steps; i++) {
            if (this.path.length === 0 || this.path.length === this.path_pos) {
                return;
            }
            if (!this.stepAlongPath()) {
                return; // blocked or sliding — don't over-advance this tick
            }
        }
    }

    /**
     * Advances one path node. Returns true when the walk may continue this
     * tick (a clean node advance), false when it stalled (blocked or a slide).
     */
    private stepAlongPath(): boolean {
        const toX = this.path[this.path_pos][0]*World.moveScale;
        const toY = this.path[this.path_pos][1]*World.moveScale;

        const isBlocked = (x:number, y:number) =>
            this.world.isRectBlockedForPlayer(this, x, y, this.width, this.height);

        let nextX = toX;
        let nextY = toY;
        let advancePath = true;

        if (isBlocked(toX, toY)) {
            // Wall slide: a diagonal step that clips a wall corner decomposes
            // into its free axis instead of dead-stopping the walk.
            const canSlideX = toX !== this.x && !isBlocked(toX, this.y);
            const canSlideY = toY !== this.y && !isBlocked(this.x, toY);

            if (canSlideX || canSlideY) {
                nextX = canSlideX ? toX : this.x;
                nextY = canSlideX ? this.y : toY;
                advancePath = false; // keep aiming at the same node next tick
            } else {
                // Fully blocked: still TURN toward the obstacle so the player
                // can face walls/NPCs (and interact with what's in front).
                const blockedDirection = GameMath.point_direction(this.x, this.y, toX, toY) + 180;
                this.angle = GameMath.roundToQuadrant(blockedDirection);
                this.path = [];
                this.path_pos = 0;
                // Walk/turn/stop updates stay map-local (see World.emitToMap);
                // only teleport() broadcasts globally, because the map change
                // is what tells viewers on the old map to hide this player.
                this.world.emitToMap(this.currentMapId, "move"+this.socketId, {
                    x:this.x,
                    y:this.y,
                    angle:this.angle,
                    playerId:this.socketId,
                    id:this.id,
                    currentMapId:this.currentMapId,
                    stopped:true
                })
                // RMXP bump-touch: walking into a blocked trigger-1/2 event
                // (a door) fires it even though the step itself is denied.
                this.world.notifyBlockedTouch(this, toX, toY);
                return false;
            }
        }

        const direction = GameMath.point_direction(this.x, this.y, nextX, nextY) + 180;
        this.angle = GameMath.roundToQuadrant(direction);
        this.x = nextX;
        this.y = nextY;

        if (!advancePath) {
            this.world.emitToMap(this.currentMapId, "move"+this.socketId, {
                x:this.x,
                y:this.y,
                angle:this.angle,
                playerId:this.socketId,
                id:this.id,
                currentMapId:this.currentMapId
            })
            this.world.handlePlayerStep(this);
            return false;
        }

        this.path_pos = this.path_pos + 1;
        this.world.emitToMap(this.currentMapId, "move"+this.socketId, {
            x:this.x,
            y:this.y,
            angle:this.angle,
            playerId:this.socketId,
            id:this.id,
            currentMapId:this.currentMapId
        })
        this.world.handlePlayerStep(this);
        return true;
    }

    private relocateInsideMapIfNeeded() {
        if (this.world.isOpenPlayerPosition(
            this.currentMapId,
            this.x,
            this.y,
            this.width,
            this.height
        )) {
            return false;
        }

        const nextPosition = this.world.resolveOpenPlayerPosition(
            this.currentMapId,
            this.x,
            this.y,
            this.width,
            this.height
        );

        this.x = nextPosition.x;
        this.y = nextPosition.y;
        this.path = [];
        this.path_pos = 0;

        // Same-map relocation: only viewers of this map need the correction.
        this.world.emitToMap(this.currentMapId, "move"+this.socketId, {
            x:this.x,
            y:this.y,
            angle:this.angle,
            playerId:this.socketId,
            id:this.id,
            currentMapId:this.currentMapId,
            teleported:true
        })

        return true;
    }

    /**
     * Computes a path from the current position to the specified coordinates.
     * @param world - Reference to the game world for pathfinding grid cloning.
     * @param x - Target x coordinate.
     * @param y - Target y coordinate.
     */
    public findPath(world:World,x:number,y:number) {
        const mapBounds = world.getMapBounds(this.currentMapId);
        const maxTravelX = Math.max(0, mapBounds.width - this.width);
        const maxTravelY = Math.max(0, mapBounds.height - this.height);
        const maxGridX = Math.max(0, Math.ceil(maxTravelX / World.moveScale));
        const maxGridY = Math.max(0, Math.ceil(maxTravelY / World.moveScale));

        const fromX = this.normalizeGridCoordinate(this.x, maxGridX);
        const fromY = this.normalizeGridCoordinate(this.y, maxGridY);
        const toX = this.normalizeGridCoordinate(x, maxGridX);
        const toY = this.normalizeGridCoordinate(y, maxGridY);

        this.path = this.createDirectPath(fromX, fromY, toX, toY);
        this.path_pos = 0;

        // Aiming outside the map (edge-clamped to the current cell) still
        // turns the player toward the requested direction, so facing-based
        // interaction works at map borders.
        if (this.path.length === 0 && (x !== this.x || y !== this.y)) {
            const direction = GameMath.point_direction(this.x, this.y, x, y) + 180;
            this.angle = GameMath.roundToQuadrant(direction);
            this.world.emitToMap(this.currentMapId, "move"+this.socketId, {
                x:this.x,
                y:this.y,
                angle:this.angle,
                playerId:this.socketId,
                id:this.id,
                currentMapId:this.currentMapId,
                stopped:true
            })
        }
    }

    private normalizeGridCoordinate(value:number, max:number) {
        const scaledValue = Math.floor(value / World.moveScale);
        return Math.max(0, Math.min(scaledValue, max));
    }

    private createDirectPath(fromX:number, fromY:number, toX:number, toY:number) {
        const deltaX = toX - fromX;
        const deltaY = toY - fromY;
        const steps = Math.max(Math.abs(deltaX), Math.abs(deltaY));

        if (steps === 0) {
            return [];
        }

        const path:number[][] = [];

        for (let step = 1; step <= steps; step += 1) {
            const nextX = Math.round(fromX + (deltaX * step) / steps);
            const nextY = Math.round(fromY + (deltaY * step) / steps);
            const lastNode = path[path.length - 1];

            if (!lastNode || lastNode[0] !== nextX || lastNode[1] !== nextY) {
                path.push([nextX, nextY]);
            }
        }

        return path;
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
        return{
            playerId:this.socketId,
            currentMapId:this.currentMapId,
            x:this.x,
            y:this.y,
            angle:this.angle,
            id:this.id,
            username:this.username,
            name:this.name,
            profileImage:this.profileImage,
            description:this.description,
            characterSkinId:this.characterSkinId
        }
    }

    public teleport(mapId:string, x:number, y:number) {
        const nextPosition = this.world.resolveOpenPlayerPosition(mapId, x, y, this.width, this.height);

        // Landing anywhere via teleport/Fly ends surfing (destinations are land).
        this.isSurfing = false;
        this.currentMapId = mapId;
        this.x = nextPosition.x;
        this.y = nextPosition.y;
        this.path = [];
        this.path_pos = 0;
        // Seed the touch cell so landing on a touch event (door mats, cave
        // mouths) doesn't instantly fire it back — classic transfer behavior.
        this.lastTouchCellKey = `${mapId}:${Math.floor((this.x + this.width / 2) / 32)}:${Math.floor((this.y + this.height / 2) / 32)}`;
        // Also lock bump-touch for a moment: exiting a building lands the
        // player next to the (solid) entrance door, and a still-held arrow key
        // would otherwise bump it on the very next tick and warp them back in.
        this.touchLockUntil = Date.now() + POST_TELEPORT_TOUCH_LOCK_MS;
        this.world.persistPlayerLocation(this);

        World.socketServer.emit("move"+this.socketId, {
            x:this.x,
            y:this.y,
            angle:this.angle,
            playerId:this.socketId,
            id:this.id,
            currentMapId:this.currentMapId,
            teleported:true
        })
    }

    public stopMovement() {
        this.path = [];
        this.path_pos = 0;

        this.world.emitToMap(this.currentMapId, "move"+this.socketId, {
            x:this.x,
            y:this.y,
            angle:this.angle,
            playerId:this.socketId,
            id:this.id,
            currentMapId:this.currentMapId,
            stopped:true
        })
    }

    public enterBattle() {
        this.inBattle = true;
        this.stopMovement();
    }

    public leaveBattle() {
        this.inBattle = false;
    }

    /**
     * Applies damage to the player and handles death logic if life reaches 0.
     * @param damage - The amount of health to deduct.
     */
    public hurt(damage:number) {
        this.life -= damage;
        if (this.life <= 0) {
            this.die()
        } else {
            World.socketServer.emit("playerHurt", {playerId:this.socketId,life:this.life, id:this.id})
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
