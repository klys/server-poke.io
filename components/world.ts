import Player from "./player"
import Projectil from "./projectil"
import GameMath from "./gameMath";
import Pathfinding = require("pathfinding")
import type { MapEditorPortalPlacement, PlayableMapsStateSnapshot } from "./PlayableMapsState";
import { isSolidCollisionCell, type MapCollisionGrid } from "./TileMapGrid";
import {
    decodeU8RleGrid,
    isSurfableWaterTag,
    isDeepWaterTag,
    isWaterfallTag
} from "./terrainTags";
import { resolveDivePair } from "./diveMaps";
import type BattleManager from "./BattleManager";
import GroundItemStore, { type GroundItem } from "./GroundItemStore";
import {
    EMPTY_EVENT_PLAYER_STATE,
    currentEventEnv,
    selectConditionMetPage,
    type EssentialsEventRecord,
    type EventPlayerState,
    type PageSelectionOptions
} from "./eventPageSelection";
import { logUnsupportedScript } from "./essentialsScriptAdapters";
import NpcActorSimulation from "./NpcActors";
import FollowerActorSimulation from "./FollowerActors";
import BeachBalls from "./BeachBalls";

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

/**
 * An NPC as the collision/touch/sight layers see it. `x`/`y` are pixels —
 * the authored tile for a stationary NPC, or the live interpolated position
 * for one the actor simulation is walking. `facing` is non-null only while
 * an actor owns the NPC.
 */
type NpcBlocker = {
    id:string;
    x:number;
    y:number;
    name:string | null;
    sightRange:number;
    facing:number | null;
    essentials:EssentialsEventRecord | null;
};

/** A body World.shovePastObstacle can displace (push chains walk these). */
type PushableBody =
    | { kind:"player"; player:Player }
    | { kind:"npc"; id:string }
    | { kind:"follower"; ownerId:string }
    | { kind:"ball"; id:string };
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
    collisionGridsByMapId: Map<string, MapCollisionGrid>;
    /** Lazily-decoded per-cell terrain-tag grid per map (null = no tags). */
    private terrainGridsByMapId = new Map<string, { width: number; height: number; cellSize: number; tags: Uint8Array; passageTags: Uint8Array | null } | null>();
    playableMapsState: PlayableMapsStateSnapshot | null;
    battleManager: BattleManager | null;
    groundItems: Map<string, GroundItem>;
    /** Per-snapshot cache of NPC collision rectangles by map. */
    private npcBlockerCache = new WeakMap<object, Map<string, Array<NpcBlocker>>>();
    /** Server-authoritative movement for NPCs that walk (see NpcActors.ts). */
    npcSimulation: NpcActorSimulation | null = null;
    /** Party leaders walking behind their trainers (see FollowerActors.ts). */
    followerSimulation: FollowerActorSimulation | null = null;
    /** Pushable /pelota beach balls (see BeachBalls.ts). */
    beachBalls: BeachBalls;
    /** Short-lived overlay of live NPC positions; see `npcBlockersLive`. */
    private liveNpcBlockerCache = new Map<string, { at:number; blockers:Array<NpcBlocker> }>();
    private static readonly LIVE_NPC_BLOCKER_TTL_MS = 25;
    /** Minimum gap between two shoves of the same player (see shovePlayer). */
    private static readonly SHOVE_COOLDOWN_MS = 250;
    /** Fires trigger-1/2 (touch) events; wired to the event runtime. The
     * optional third argument is the tile a sight-spotted player must be
     * returned to when the event ends still armed (locked quest gates). */
    private eventTouchHandler:((player:Player, placementId:string, sightPushCell?:{ x:number; y:number } | null) => void) | null = null;
    /** True while the player is inside a running event (dialog/cutscene):
     * movement is frozen like RPG Maker, so sight-traps actually hold. */
    private eventMovementLockChecker:((player:Player) => boolean) | null = null;
    /** Fires queued trap events when a battle releases the player. */
    private playerLeftBattleHandler:((player:Player) => void) | null = null;
    private locationPersistHandler:((player:Player) => void) | null = null;
    private portalHandler:((player:Player, portal:MapEditorPortalPlacement) => void) | null = null;
    groundItemStore: GroundItemStore | null;
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
        this.collisionGridsByMapId = new Map<string, MapCollisionGrid>();
        this.playableMapsState = null;
        this.battleManager = null;
        this.groundItems = new Map<string, GroundItem>();
        this.groundItemStore = null;

        //this.finder = new Pathfinding.AStarFinder({ diagonalMovement: 1 })
        //this.grid_backup = this.grid.clone()
        //setInterval(this.moveIn.bind(this), 1)
        setInterval(this.livingProjectil.bind(this), 100)
        setInterval(this.playerWaiting.bind(this),1000)

        this.npcSimulation = new NpcActorSimulation(this);
        this.npcSimulation.start();

        this.followerSimulation = new FollowerActorSimulation(this);
        this.followerSimulation.start();

        this.beachBalls = new BeachBalls(this);
    }

    async initializeGroundItems(groundItemStore: GroundItemStore) {
        this.groundItemStore = groundItemStore;
        const items = await groundItemStore.readAll();
        this.groundItems = new Map(items.map((item) => [item.id, item]));
    }

    private persistGroundItems() {
        void this.groundItemStore?.saveAll(Array.from(this.groundItems.values()));
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
        const piterator = this.players.entries();
        let current = piterator.next()

        while(current.done === false) {
            let player = current.value[1];
            if (player.socketId !== element.ownerId &&
                player.death === false &&
                GameMath.collision_square(player, element)) return player;
            current = piterator.next();
        }
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
            collisionGrid?:MapCollisionGrid;
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

            const collisionGrid = definition.collisionGrid;
            if (
                collisionGrid &&
                collisionGrid.width > 0 &&
                collisionGrid.height > 0 &&
                collisionGrid.cellSize > 0 &&
                collisionGrid.cells.length === collisionGrid.width * collisionGrid.height
            ) {
                this.collisionGridsByMapId.set(definition.mapId, collisionGrid);
            } else {
                this.collisionGridsByMapId.delete(definition.mapId);
            }
            // Terrain grids are lazily re-derived from the fresh collision dims.
            this.terrainGridsByMapId.delete(definition.mapId);
        });
    }

    getMapObjects(mapId:string) {
        return this.objectsByMapId.get(mapId) ?? [];
    }

    getMapCollisionGrid(mapId:string) {
        return this.collisionGridsByMapId.get(mapId) ?? null;
    }

    /** Decoded terrain-tag grid for a map (lazy; cached; null when unavailable).
     * `passageTags` (when baked) carries the tag of the collision-DECIDING tile,
     * which tells plain water apart from obstacles drawn over water. */
    private getTerrainGrid(mapId: string) {
        if (this.terrainGridsByMapId.has(mapId)) {
            return this.terrainGridsByMapId.get(mapId) ?? null;
        }
        const collision = this.collisionGridsByMapId.get(mapId);
        const tileMap = this.playableMapsState?.editorDataByMapId?.[mapId]?.tileMap;
        let result:
            | { width: number; height: number; cellSize: number; tags: Uint8Array; passageTags: Uint8Array | null }
            | null = null;
        if (collision && tileMap?.terrainTags) {
            const tags = decodeU8RleGrid(tileMap.terrainTags, collision.width * collision.height);
            if (tags) {
                const passageTags = tileMap.passageTerrainTags
                    ? decodeU8RleGrid(tileMap.passageTerrainTags, collision.width * collision.height)
                    : null;
                result = { width: collision.width, height: collision.height, cellSize: collision.cellSize, tags, passageTags };
            }
        }
        this.terrainGridsByMapId.set(mapId, result);
        return result;
    }

    /** Terrain tag at a cell (0 when out of range / no terrain data). */
    getTerrainTagAtCell(mapId: string, cellX: number, cellY: number): number {
        const grid = this.getTerrainGrid(mapId);
        if (!grid || cellX < 0 || cellY < 0 || cellX >= grid.width || cellY >= grid.height) {
            return 0;
        }
        return grid.tags[cellY * grid.width + cellX];
    }

    /** True when a cell is genuinely open water for Surf/Fishing: water
     * terrain tag AND, when the passage-tag grid is baked, the collision-
     * deciding tile is itself water. A rock drawn over the sea keeps the
     * water terrain tag (tags take the first NON-ZERO tag top-down) but its
     * deciding tile has tag 0 — that cell must block surfers and casts. */
    isOpenWaterCell(mapId: string, cellX: number, cellY: number): boolean {
        const grid = this.getTerrainGrid(mapId);
        if (!grid || cellX < 0 || cellY < 0 || cellX >= grid.width || cellY >= grid.height) {
            return false;
        }
        const index = cellY * grid.width + cellX;
        if (!isSurfableWaterTag(grid.tags[index])) {
            return false;
        }
        if (grid.passageTags && !isSurfableWaterTag(grid.passageTags[index])) {
            return false;
        }
        return true;
    }

    /** The terrain tag of the cell the player currently occupies. */
    getPlayerTerrainTag(player: Player): number {
        const cellSize = this.getMapCellSize(player.currentMapId);
        const cell = player.getCurrentCell(cellSize);
        return this.getTerrainTagAtCell(player.currentMapId, cell.x, cell.y);
    }

    /** The map's collision-cell size (px), defaulting to 32. */
    getMapCellSize(mapId: string): number {
        return this.collisionGridsByMapId.get(mapId)?.cellSize ?? 32;
    }

    /** Place a player at an exact cell and broadcast, bypassing the open-position
     * search (Surf/Dive deliberately land on water, which is otherwise solid). */
    private forcePlayerToCell(player: Player, mapId: string, cellX: number, cellY: number) {
        const cellSize = this.getMapCellSize(mapId);
        player.currentMapId = mapId;
        player.x = cellX * cellSize;
        player.y = cellY * cellSize;
        player.path = [];
        player.path_pos = 0;
        player.lastTouchCellKey = `${mapId}:${cellX}:${cellY}`;
        player.touchLockUntil = Date.now() + 300;
        this.persistPlayerLocation(player);
        World.socketServer.emit("move" + player.socketId, player.movePayload({ teleported: true }));
        this.followerSimulation?.onOwnerTeleport(player);
    }

    /** Tell the player's own client AND everyone on their map whether Surf is
     * active. The self emit keeps the legacy `{surfing}` shape; the map
     * broadcast carries `playerId` so other clients can swap the mount sprite
     * for remote players. */
    broadcastSurfState(player: Player) {
        player.socketConnections.forEach((socketId) => {
            World.socketServer
                .to(socketId)
                .emit("player:surf-state", { surfing: player.isSurfing, playerId: player.socketId });
        });
        this.emitToMap(player.currentMapId, "player:surf-state", {
            surfing: player.isSurfing,
            playerId: player.socketId
        });
    }

    /** Central surf-state transition: assign, persist, and notify all viewers.
     * Every surf mount/dismount must go through here so reconnecting clients
     * and nearby players always reconstruct the right traversal state. */
    setSurfing(player: Player, surfing: boolean) {
        if (player.isSurfing === surfing) {
            return;
        }
        player.isSurfing = surfing;
        if (surfing) {
            // Essentials blocks running while surfing (pbCanRun?); the run
            // key must be re-pressed after dismounting.
            player.setRunning(false);
        }
        this.persistPlayerLocation(player);
        this.broadcastSurfState(player);
        // The follower waits on the shore: hidden while surfing/underwater.
        this.followerSimulation?.refreshVisibility(player);
    }

    /** Surf: from land facing water, mount the water and start surfing.
     * `target` (optional, from the water context menu) is an adjacent cell to
     * face first — never trusted beyond "adjacent"; the terrain check still
     * runs on whatever cell the player ends up facing. */
    async beginSurf(
        player: Player,
        userId: number,
        target?: { x: number; y: number }
    ): Promise<{ ok: boolean; message?: string }> {
        if (player.isSurfing) {
            return { ok: false, message: "Ya estás surfeando." };
        }
        const knows = this.battleManager
            ? await this.battleManager.partyKnowsFieldSkill(userId, "surf")
            : false;
        if (!knows) {
            return { ok: false, message: "Ningún Venomon de tu equipo conoce Surf." };
        }
        const cellSize = this.getMapCellSize(player.currentMapId);
        if (target) {
            const current = player.getCurrentCell(cellSize);
            const distance = Math.abs(current.x - target.x) + Math.abs(current.y - target.y);
            if (distance !== 1) {
                return { ok: false, message: "No puedes surfear desde esta posición." };
            }
            player.faceCell(target, cellSize);
        }
        const facing = player.getFacingCell(cellSize);
        if (!this.isOpenWaterCell(player.currentMapId, facing.x, facing.y)) {
            return { ok: false, message: "No hay agua por la que surfear." };
        }
        player.isSurfing = true;
        this.forcePlayerToCell(player, player.currentMapId, facing.x, facing.y);
        this.broadcastSurfState(player);
        return { ok: true };
    }

    /** Dive: descend to the paired underwater map (over deep water), or resurface. */
    async tryDive(player: Player, userId: number): Promise<{ ok: boolean; message?: string; mapChanged?: boolean }> {
        const pair = resolveDivePair(player.currentMapId);
        if (!pair) {
            return { ok: false, message: "No puedes bucear aquí." };
        }
        const knows = this.battleManager
            ? await this.battleManager.partyKnowsFieldSkill(userId, "dive")
            : false;
        if (!knows) {
            return { ok: false, message: "Ningún Venomon de tu equipo conoce Buceo." };
        }
        const cellSize = this.getMapCellSize(player.currentMapId);
        const cell = player.getCurrentCell(cellSize);
        if (pair.role === "surface") {
            if (!isDeepWaterTag(this.getPlayerTerrainTag(player))) {
                return { ok: false, message: "Debes estar sobre aguas profundas para bucear." };
            }
            player.isSurfing = false; // underwater floor is walkable
        } else {
            player.isSurfing = true; // resurface onto the water, surfing
        }
        this.forcePlayerToCell(player, pair.pairedMapId, cell.x, cell.y);
        this.broadcastSurfState(player);
        return { ok: true, mapChanged: true };
    }

    /** Waterfall: climb up/down the waterfall column the player faces. */
    async tryWaterfall(player: Player, userId: number): Promise<{ ok: boolean; message?: string }> {
        const knows = this.battleManager
            ? await this.battleManager.partyKnowsFieldSkill(userId, "waterfall")
            : false;
        if (!knows) {
            return { ok: false, message: "Ningún Venomon de tu equipo conoce Cascada." };
        }
        const cellSize = this.getMapCellSize(player.currentMapId);
        const start = player.getCurrentCell(cellSize);
        const facing = player.getFacingCell(cellSize);
        const dx = facing.x - start.x;
        const dy = facing.y - start.y;
        if (!isWaterfallTag(this.getTerrainTagAtCell(player.currentMapId, facing.x, facing.y))) {
            return { ok: false, message: "No hay ninguna cascada aquí." };
        }
        // Advance across the waterfall column to the water on the far side (capped).
        let cx = facing.x;
        let cy = facing.y;
        for (let step = 0; step < 32; step += 1) {
            const nextX = cx + dx;
            const nextY = cy + dy;
            if (isWaterfallTag(this.getTerrainTagAtCell(player.currentMapId, nextX, nextY))) {
                cx = nextX;
                cy = nextY;
                continue;
            }
            break;
        }
        player.isSurfing = true;
        this.forcePlayerToCell(player, player.currentMapId, cx, cy);
        this.broadcastSurfState(player);
        return { ok: true };
    }

    /** Strength: push the boulder the player faces one cell further, if free. */
    async tryStrengthPush(player: Player, userId: number): Promise<{ ok: boolean; message?: string }> {
        const knows = this.battleManager
            ? await this.battleManager.partyKnowsFieldSkill(userId, "strength")
            : false;
        if (!knows) {
            return { ok: false, message: "Ningún Venomon de tu equipo conoce Fuerza." };
        }
        const cellSize = this.getMapCellSize(player.currentMapId);
        const start = player.getCurrentCell(cellSize);
        const facing = player.getFacingCell(cellSize);
        const editorData = this.playableMapsState?.editorDataByMapId?.[player.currentMapId];
        const boulder = (editorData?.boulders ?? []).find(
            (candidate) => candidate.x === facing.x && candidate.y === facing.y
        );
        if (!boulder) {
            return { ok: false, message: "No hay ninguna roca que empujar aquí." };
        }
        const destX = facing.x + (facing.x - start.x);
        const destY = facing.y + (facing.y - start.y);
        if (this.isRectBlocked(player.currentMapId, destX * cellSize, destY * cellSize, cellSize, cellSize)) {
            return { ok: false, message: "La roca no se puede mover en esa dirección." };
        }
        if ((editorData?.boulders ?? []).some((candidate) => candidate.x === destX && candidate.y === destY)) {
            return { ok: false, message: "La roca no se puede mover en esa dirección." };
        }
        boulder.x = destX;
        boulder.y = destY;
        this.broadcastBoulderMoved(player.currentMapId, boulder.id, destX, destY);
        return { ok: true };
    }

    private broadcastBoulderMoved(mapId: string, boulderId: string, x: number, y: number) {
        this.emitToMap(mapId, "world:boulder-moved", { mapId, boulderId, x, y });
    }

    private isRectBlockedByCollisionGrid(
        mapId:string,
        x:number,
        y:number,
        width:number,
        height:number,
        passThroughWater = false
    ) {
        const grid = this.collisionGridsByMapId.get(mapId);
        if (!grid) {
            return false;
        }

        // Inset the hitbox so a tile-sized player can traverse one-tile
        // corridors and doors without pixel-perfect alignment.
        const inset = Math.min(grid.cellSize / 4, width / 2 - 1, height / 2 - 1);
        const left = x + inset;
        const top = y + inset;
        const right = x + width - inset;
        const bottom = y + height - inset;

        const firstColumn = Math.max(0, Math.floor(left / grid.cellSize));
        const firstRow = Math.max(0, Math.floor(top / grid.cellSize));
        const lastColumn = Math.min(grid.width - 1, Math.floor((right - 1) / grid.cellSize));
        const lastRow = Math.min(grid.height - 1, Math.floor((bottom - 1) / grid.cellSize));

        for (let row = firstRow; row <= lastRow; row += 1) {
            for (let column = firstColumn; column <= lastColumn; column += 1) {
                if (isSolidCollisionCell(grid.cells[row * grid.width + column])) {
                    // While surfing, OPEN water is solid to the grid but passable
                    // to us. Walls AND obstacles drawn over water (rocks — water
                    // terrain tag but a non-water deciding tile) still block.
                    if (passThroughWater && this.isOpenWaterCell(mapId, column, row)) {
                        continue;
                    }
                    return true;
                }
            }
        }

        return false;
    }

    isRectBlocked(
        mapId:string,
        x:number,
        y:number,
        width:number,
        height:number
    ) {
        const bounds = { x, y, width, height };

        if (this.getMapObjects(mapId).some((object) => this.checkCollision(bounds, object))) {
            return true;
        }

        return this.isRectBlockedByCollisionGrid(mapId, x, y, width, height);
    }

    /**
     * Movement collision for a specific player: static map collision plus
     * dynamic obstacles — other players on the map and NPC events whose active
     * page (for THIS player's event state) shows a sprite, like RPG Maker.
     *
     * Anti-trap rule: a dynamic obstacle that already overlaps the player's
     * CURRENT position never blocks — you can always walk out of a door tile
     * or another player you were dropped onto, just never into one.
     */
    isRectBlockedForPlayer(
        player:Player,
        x:number,
        y:number,
        width:number,
        height:number
    ) {
        // Legacy obstacle rectangles + static grid, but let a surfing player
        // cross water-tagged solids (Surf). Real walls always block.
        if (this.getMapObjects(player.currentMapId).some((object) => this.checkCollision({ x, y, width, height }, object))) {
            return true;
        }
        if (this.isRectBlockedByCollisionGrid(player.currentMapId, x, y, width, height, player.isSurfing)) {
            return true;
        }

        // Other players are solid (small inset so near-misses don't jam walkways).
        const inset = 2;
        const bounds = { x: x + inset, y: y + inset, width: width - inset * 2, height: height - inset * 2 };
        const currentBounds = {
            x: player.x + inset,
            y: player.y + inset,
            width: player.width - inset * 2,
            height: player.height - inset * 2
        };
        for (const other of Array.from(this.players.values())) {
            if (other.socketId === player.socketId || other.currentMapId !== player.currentMapId) {
                continue;
            }
            const otherBounds = { x: other.x + inset, y: other.y + inset, width: other.width - inset * 2, height: other.height - inset * 2 };
            if (this.checkCollision(currentBounds, otherBounds)) {
                continue; // already overlapping: let them separate
            }
            if (this.checkCollision(bounds, otherBounds)) {
                return true;
            }
        }

        for (const blocker of this.npcBlockersLive(player.currentMapId)) {
            const blockerBounds = { x: blocker.x + inset, y: blocker.y + inset, width: 32 - inset * 2, height: 32 - inset * 2 };
            if (this.checkCollision(currentBounds, blockerBounds)) {
                continue; // standing on it (e.g. arrived through a door): walk off freely
            }
            if (!this.checkCollision(bounds, blockerBounds)) {
                continue;
            }
            if (!blocker.essentials) {
                return true; // designer-authored NPC: always visible and solid
            }
            const page = selectConditionMetPage(
                blocker.essentials,
                this.eventStateFor(player),
                this.pageSelectionOptions()
            );
            if (page && page.graphic?.characterName && !page.move?.through) {
                return true;
            }
        }

        // Follower venomons and beach balls are solid, pushable bodies — same
        // anti-trap rule as players so overlaps can always separate.
        const softBodies = [
            ...(this.followerSimulation?.blockersOnMap(player.currentMapId) ?? []),
            ...this.beachBalls.blockersOnMap(player.currentMapId)
        ];
        for (const body of softBodies) {
            const bodyBounds = { x: body.x + inset, y: body.y + inset, width: 32 - inset * 2, height: 32 - inset * 2 };
            if (this.checkCollision(currentBounds, bodyBounds)) {
                continue;
            }
            if (this.checkCollision(bounds, bodyBounds)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Whether a cell holds any solid body (player, NPC, follower or ball).
     * Moving followers/balls reserve both their origin and destination cells,
     * like NPC actors, so two displaced bodies can't converge on one tile.
     * `exclude` skips the asking body itself.
     */
    isCellOccupiedByBody(
        mapId:string,
        cellX:number,
        cellY:number,
        exclude:{ kind:"player" | "npc" | "follower" | "ball"; id:string } | null
    ): boolean {
        const cellSize = this.getMapCellSize(mapId);
        const inset = 2;
        const cellBounds = {
            x: cellX * cellSize + inset,
            y: cellY * cellSize + inset,
            width: cellSize - inset * 2,
            height: cellSize - inset * 2
        };

        for (const player of Array.from(this.players.values())) {
            if (player.currentMapId !== mapId) {
                continue;
            }
            if (exclude?.kind === "player" && exclude.id === player.socketId) {
                continue;
            }
            const playerBounds = {
                x: player.x + inset,
                y: player.y + inset,
                width: player.width - inset * 2,
                height: player.height - inset * 2
            };
            if (this.checkCollision(cellBounds, playerBounds)) {
                return true;
            }
        }

        for (const blocker of this.npcBlockersLive(mapId)) {
            if (exclude?.kind === "npc" && exclude.id === blocker.id) {
                continue;
            }
            const blockerBounds = { x: blocker.x + inset, y: blocker.y + inset, width: 32 - inset * 2, height: 32 - inset * 2 };
            if (this.checkCollision(cellBounds, blockerBounds)) {
                return true;
            }
        }

        for (const follower of this.followerSimulation?.snapshotForMap(mapId) ?? []) {
            if (follower.hidden) {
                continue;
            }
            if (exclude?.kind === "follower" && exclude.id === follower.ownerId) {
                continue;
            }
            if (
                (follower.x === cellX && follower.y === cellY) ||
                (follower.toX === cellX && follower.toY === cellY)
            ) {
                return true;
            }
        }

        for (const ball of this.beachBalls.snapshotForMap(mapId)) {
            if (ball.deflated) {
                continue;
            }
            if (exclude?.kind === "ball" && exclude.id === ball.id) {
                continue;
            }
            if (
                (ball.x === cellX && ball.y === cellY) ||
                (ball.toX === cellX && ball.toY === cellY)
            ) {
                return true;
            }
        }

        return false;
    }

    /**
     * Displaces whatever is blocking a step one cell further along, so bodies
     * shoulder past each other instead of deadlocking: a player walking into
     * another player pushes them, and a player walking into a wandering NPC
     * pushes it too. Static scenery, walls and stationary NPCs never move.
     *
     * The push only lands when the destination cell is itself free — pushing
     * someone into a wall would either clip them through it or trap both
     * bodies, so in that case the pusher just stops, as before.
     *
     * Returns true when something was displaced.
     */
    shovePastObstacle(pusher:Player, targetX:number, targetY:number): boolean {
        // Shoves are cardinal: resolve the attempted step to its dominant axis
        // so a diagonal walk pushes along one axis rather than into a corner.
        const deltaX = targetX - pusher.x;
        const deltaY = targetY - pusher.y;

        if (deltaX === 0 && deltaY === 0) {
            return false;
        }

        const dx = Math.abs(deltaX) >= Math.abs(deltaY) ? Math.sign(deltaX) : 0;
        const dy = dx === 0 ? Math.sign(deltaY) : 0;

        if (dx === 0 && dy === 0) {
            return false;
        }

        const inset = 2;
        const targetBounds = {
            x: targetX + inset,
            y: targetY + inset,
            width: pusher.width - inset * 2,
            height: pusher.height - inset * 2
        };
        const pusherBounds = {
            x: pusher.x + inset,
            y: pusher.y + inset,
            width: pusher.width - inset * 2,
            height: pusher.height - inset * 2
        };

        const body = this.findPushableBodyAt(
            pusher.currentMapId,
            targetBounds,
            pusherBounds,
            new Set([`player:${pusher.socketId}`])
        );

        if (!body) {
            return false;
        }

        // The pusher's (secret) push depth caps how many bodies one bump can
        // displace in a row: depth 2 = pushing A also budges B behind A.
        return this.shoveBody(pusher.currentMapId, body, dx, dy, Math.max(1, pusher.pushDepth), new Set([`player:${pusher.socketId}`]));
    }

    /** Delay before a chained pushee re-tries its blocked step: long enough
     * for the body ahead to have (mostly) vacated the destination cell. */
    private static readonly CHAIN_RETRY_MS = 230;

    /**
     * The pushable body whose box overlaps `bounds`, or null. Bodies already
     * overlapping `sourceBounds` don't count (they are separating). Stationary
     * NPCs are never returned: they are scenery, not pushable.
     */
    private findPushableBodyAt(
        mapId:string,
        bounds:{ x:number; y:number; width:number; height:number },
        sourceBounds:{ x:number; y:number; width:number; height:number } | null,
        excludeKeys:Set<string>
    ): PushableBody | null {
        const inset = 2;

        for (const other of Array.from(this.players.values())) {
            if (other.currentMapId !== mapId || excludeKeys.has(`player:${other.socketId}`)) {
                continue;
            }
            const otherBounds = {
                x: other.x + inset,
                y: other.y + inset,
                width: other.width - inset * 2,
                height: other.height - inset * 2
            };
            if (sourceBounds && this.checkCollision(sourceBounds, otherBounds)) {
                continue;
            }
            if (this.checkCollision(bounds, otherBounds)) {
                return { kind: "player", player: other };
            }
        }

        const follower = this.followerSimulation?.findAt(mapId, bounds);

        if (follower && !excludeKeys.has(`follower:${follower.ownerId}`)) {
            return { kind: "follower", ownerId: follower.ownerId };
        }

        const ball = this.beachBalls.findAt(mapId, bounds);

        if (ball && !excludeKeys.has(`ball:${ball.id}`)) {
            return { kind: "ball", id: ball.id };
        }

        for (const blocker of this.npcBlockersLive(mapId)) {
            if (excludeKeys.has(`npc:${blocker.id}`)) {
                continue;
            }
            const blockerBounds = {
                x: blocker.x + inset,
                y: blocker.y + inset,
                width: 32 - inset * 2,
                height: 32 - inset * 2
            };
            if (sourceBounds && this.checkCollision(sourceBounds, blockerBounds)) {
                continue;
            }
            if (!this.checkCollision(bounds, blockerBounds)) {
                continue;
            }
            // Only NPCs the simulation actually walks can be pushed; shop
            // keepers and scenery events stay exactly where they were authored.
            if (this.npcSimulation?.liveStateOf(mapId, blocker.id)) {
                return { kind: "npc", id: blocker.id };
            }
        }

        return null;
    }

    private bodyKey(body:PushableBody): string {
        switch (body.kind) {
            case "player":
                return `player:${body.player.socketId}`;
            case "npc":
                return `npc:${body.id}`;
            case "follower":
                return `follower:${body.ownerId}`;
            case "ball":
                return `ball:${body.id}`;
        }
    }

    /**
     * Displaces a pushable body one cell, chaining through whatever pushable
     * body blocks ITS destination while `depth` allows. Chains resolve
     * back-to-front: the far body starts vacating now, and the near body
     * re-tries its own displacement after CHAIN_RETRY_MS, when the cell ahead
     * has cleared. `visited` breaks cycles (a ring of bodies pushing itself).
     */
    private shoveBody(
        mapId:string,
        body:PushableBody,
        dx:number,
        dy:number,
        depth:number,
        visited:Set<string>
    ): boolean {
        const key = this.bodyKey(body);

        if (visited.has(key)) {
            return false;
        }
        visited.add(key);

        if (body.kind === "player") {
            return this.shovePlayerChained(body.player, dx, dy, depth, visited);
        }

        const attempt = () => {
            switch (body.kind) {
                case "npc":
                    return this.npcSimulation?.shove(mapId, body.id, dx, dy) ?? false;
                case "follower":
                    return this.followerSimulation?.shove(mapId, body.ownerId, dx, dy) ?? false;
                case "ball":
                    return this.beachBalls.shove(mapId, body.id, dx, dy);
            }
            return false;
        };

        if (attempt()) {
            return true;
        }

        if (depth <= 1) {
            return false;
        }

        // The destination may be blocked by another pushable body: shove that
        // one along first, then repeat this displacement once it has moved.
        const cell = this.cellOfBody(mapId, body);

        if (!cell) {
            return false;
        }

        const cellSize = this.getMapCellSize(mapId);
        const inset = 2;
        const destBounds = {
            x: (cell.x + dx) * cellSize + inset,
            y: (cell.y + dy) * cellSize + inset,
            width: cellSize - inset * 2,
            height: cellSize - inset * 2
        };
        const blocker = this.findPushableBodyAt(mapId, destBounds, null, visited);

        if (!blocker || !this.shoveBody(mapId, blocker, dx, dy, depth - 1, visited)) {
            return false;
        }

        setTimeout(() => {
            attempt();
        }, World.CHAIN_RETRY_MS);

        return true;
    }

    private cellOfBody(mapId:string, body:PushableBody): { x:number; y:number } | null {
        switch (body.kind) {
            case "player": {
                const cellSize = this.getMapCellSize(mapId);
                return body.player.getCurrentCell(cellSize);
            }
            case "npc":
                return this.npcSimulation?.cellOf(mapId, body.id) ?? null;
            case "follower": {
                const actor = this.followerSimulation?.getActor(body.ownerId);
                return actor ? { x: actor.moving ? actor.toX : actor.cellX, y: actor.moving ? actor.toY : actor.cellY } : null;
            }
            case "ball": {
                const ball = this.beachBalls.getBall(body.id);
                return ball ? { x: ball.moving ? ball.toX : ball.cellX, y: ball.moving ? ball.toY : ball.cellY } : null;
            }
        }
    }

    /**
     * One-cell displacement of a pushed player, walked rather than teleported.
     * When the destination is held by another pushable body and `depth`
     * allows, that body is shoved first and this player's walk starts after
     * CHAIN_RETRY_MS — push-over-push.
     */
    private shovePlayerChained(pushee:Player, dx:number, dy:number, depth:number, visited:Set<string>): boolean {
        const now = Date.now();

        if (now < pushee.shoveCooldownUntil) {
            return false;
        }
        // Never yank someone out of a battle or a running cutscene: their
        // movement is frozen there, so the push would silently do nothing or
        // desync them from the event they are in.
        if (pushee.inBattle || this.isEventMovementLocked(pushee)) {
            return false;
        }

        const cellSize = this.getMapCellSize(pushee.currentMapId);
        const destinationX = pushee.x + dx * cellSize;
        const destinationY = pushee.y + dy * cellSize;

        const bounds = this.getMapBounds(pushee.currentMapId);

        if (
            destinationX < 0 ||
            destinationY < 0 ||
            destinationX + pushee.width > bounds.width ||
            destinationY + pushee.height > bounds.height
        ) {
            return false;
        }

        const displace = () => {
            pushee.shoveCooldownUntil = Date.now() + World.SHOVE_COOLDOWN_MS;
            // Hand the destination to the pushee's own movement tick instead of
            // teleporting: it re-runs collision per node, fires touch/portal
            // handling on arrival, and reaches clients as an ordinary walk that
            // the interpolation buffer glides through.
            pushee.stopMovement();
            pushee.findPath(this, destinationX, destinationY);
        };

        if (!this.isRectBlockedForPlayer(pushee, destinationX, destinationY, pushee.width, pushee.height)) {
            displace();
            return true;
        }

        if (depth <= 1) {
            return false;
        }

        const inset = 2;
        const destBounds = {
            x: destinationX + inset,
            y: destinationY + inset,
            width: pushee.width - inset * 2,
            height: pushee.height - inset * 2
        };
        const pusheeBounds = {
            x: pushee.x + inset,
            y: pushee.y + inset,
            width: pushee.width - inset * 2,
            height: pushee.height - inset * 2
        };
        const blocker = this.findPushableBodyAt(pushee.currentMapId, destBounds, pusheeBounds, visited);

        if (!blocker || !this.shoveBody(pushee.currentMapId, blocker, dx, dy, depth - 1, visited)) {
            return false;
        }

        // Reserve the pushee now so a held key can't start a second chain
        // while this one plays out; the delayed walk re-validates everything.
        pushee.shoveCooldownUntil = now + World.SHOVE_COOLDOWN_MS + World.CHAIN_RETRY_MS;
        const mapIdAtChain = pushee.currentMapId;

        setTimeout(() => {
            if (
                pushee.currentMapId !== mapIdAtChain ||
                pushee.inBattle ||
                this.isEventMovementLocked(pushee) ||
                this.isRectBlockedForPlayer(pushee, destinationX, destinationY, pushee.width, pushee.height)
            ) {
                return;
            }
            displace();
        }, World.CHAIN_RETRY_MS);

        return true;
    }

    /**
     * Options for RMXP page selection: the imported System script-switch
     * table ("s:" switches: day/night, temp switches...) plus the server
     * clock. Shared by collision, touch detection and the event runtime so
     * every layer agrees on which page an event shows for a player.
     */
    pageSelectionOptions(): PageSelectionOptions {
        return {
            scriptSwitches: this.playableMapsState?.essentialsSystem?.scriptSwitches,
            env: currentEventEnv(),
            onUnknownScriptSwitch: (switchId, expression) => {
                logUnsupportedScript("condition", `s:${expression}`, `script switch ${switchId}`);
            }
        };
    }

    /** Player state for page selection, including session temp switches. */
    private eventStateFor(player:Player): EventPlayerState {
        return player.eventState
            ? { ...player.eventState, tempSwitches: player.tempSwitches }
            : { ...EMPTY_EVENT_PLAYER_STATE, tempSwitches: player.tempSwitches };
    }

    setEventTouchHandler(handler:(player:Player, placementId:string, sightPushCell?:{ x:number; y:number } | null) => void) {
        this.eventTouchHandler = handler;
    }

    setEventMovementLockChecker(checker:(player:Player) => boolean) {
        this.eventMovementLockChecker = checker;
    }

    setPlayerLeftBattleHandler(handler:(player:Player) => void) {
        this.playerLeftBattleHandler = handler;
    }

    /** Called by Player.leaveBattle: replays trap events queued during battle. */
    notifyPlayerLeftBattle(player:Player) {
        this.playerLeftBattleHandler?.(player);
    }

    /** Movement freeze during a running event session (RMXP interpreter lock). */
    isEventMovementLocked(player:Player): boolean {
        return this.eventMovementLockChecker?.(player) ?? false;
    }

    setLocationPersistHandler(handler:(player:Player) => void) {
        this.locationPersistHandler = handler;
    }

    setPortalHandler(handler:(player:Player, portal:MapEditorPortalPlacement) => void) {
        this.portalHandler = handler;
    }

    /**
     * True when this portal was extracted from an imported Essentials event
     * whose full page data is available as a placement on the same cell. Such
     * portals must NOT blind-teleport: the source event decides (page
     * conditions, dialogue, conditional branches) through the regular event
     * flow, exactly like RPG Maker. Extracted portals without recovered event
     * data keep the legacy blind behavior so un-repaired maps stay traversable.
     */
    private portalDeferredToEvent(mapId:string, portal:MapEditorPortalPlacement): boolean {
        if (!portal.essentialsConnection) {
            return false; // designer-authored portal: fires as configured
        }
        return this.getNpcBlockers(mapId).some(
            (blocker) =>
                blocker.essentials !== null &&
                blocker.x === portal.x * 32 &&
                blocker.y === portal.y * 32 &&
                blocker.essentials.pages?.some((page) =>
                    (page.commands ?? []).some((command) => command.code === 201)
                )
        );
    }

    /**
     * Designer portals are SERVER-triggered (the client only renders them).
     * `eventScript` portals stay client-side — their sandboxed script API
     * (messages, toasts) only exists in the browser.
     */
    private firePortalIfPresent(player:Player, cellX:number, cellY:number) {
        const editorData = this.playableMapsState?.editorDataByMapId[player.currentMapId];
        const portal = (editorData?.portals ?? []).find(
            (candidate) => candidate.x === cellX && candidate.y === cellY
        );

        if (!portal) {
            return false;
        }
        if (this.portalDeferredToEvent(player.currentMapId, portal)) {
            return false; // the essentials event on this cell owns the transfer
        }
        if (portal.destinationType !== "event-script" && this.portalHandler) {
            this.portalHandler(player, portal);
        }
        return true;
    }

    /** Persist map/x/y for authenticated players. Called on map transfers so
     * a crash or disconnect mid-session can't re-strand the player on a map
     * they already left (previously only disconnect saved the location). */
    persistPlayerLocation(player:Player) {
        if (this.locationPersistHandler) {
            this.locationPersistHandler(player);
        }
    }

    /**
     * RMXP player-touch (bump): walking INTO a blocked event tile fires the
     * event when its active page is trigger 1/2 — this is how doors work (the
     * door sprite blocks the tile AND the touch transfer runs on contact).
     */
    notifyBlockedTouch(player:Player, x:number, y:number) {
        if (Date.now() < player.touchLockUntil) {
            return;
        }

        // Door-style portals: several migrated buildings (the farmatodo
        // stores) keep their exit portal ON the solid door tile, which can
        // never be stood on — walking INTO it must teleport, exactly like an
        // RMXP player-touch door. The blocked step only reaches ~4px into the
        // tile, so detect by AABB overlap; the axis ACROSS the movement must
        // overlap at least half a tile (same alignment rule as event doors).
        const portals =
            this.playableMapsState?.editorDataByMapId[player.currentMapId]?.portals ?? [];
        for (const portal of portals) {
            const portalX = portal.x * 32;
            const portalY = portal.y * 32;
            const overlapX = Math.min(x + player.width, portalX + 32) - Math.max(x, portalX);
            const overlapY = Math.min(y + player.height, portalY + 32) - Math.max(y, portalY);
            if (overlapX <= 0 || overlapY <= 0 || Math.max(overlapX, overlapY) < 16) {
                continue;
            }
            if (this.portalDeferredToEvent(player.currentMapId, portal)) {
                continue; // the event's own touch page decides (checked below)
            }
            if (portal.destinationType !== "event-script" && this.portalHandler) {
                this.portalHandler(player, portal);
            }
            return;
        }

        if (!this.eventTouchHandler) {
            return;
        }

        const inset = 2;
        const bounds = { x: x + inset, y: y + inset, width: player.width - inset * 2, height: player.height - inset * 2 };
        for (const blocker of this.npcBlockersLive(player.currentMapId)) {
            if (!blocker.essentials) {
                continue;
            }
            if (!this.checkCollision(bounds, { x: blocker.x + inset, y: blocker.y + inset, width: 32 - inset * 2, height: 32 - inset * 2 })) {
                continue;
            }
            // Require the player to actually be walking INTO the door, not
            // grazing its corner: on the axis across the movement the player
            // must overlap at least half the tile. Corner clips (a few px on
            // both axes) used to fire doors the player never aimed at.
            const overlapX = Math.min(x + player.width, blocker.x + 32) - Math.max(x, blocker.x);
            const overlapY = Math.min(y + player.height, blocker.y + 32) - Math.max(y, blocker.y);
            if (Math.max(overlapX, overlapY) < 16) {
                continue;
            }
            const page = selectConditionMetPage(
                blocker.essentials,
                this.eventStateFor(player),
                this.pageSelectionOptions()
            );
            if (page && (page.trigger === 1 || page.trigger === 2)) {
                this.eventTouchHandler(player, blocker.id);
                return;
            }
        }
    }

    /**
     * RMXP standing-touch: entering a walkable tile that hosts a graphicless
     * trigger 1/2 event (cave mouths, floor triggers) fires it. Tiles owned by
     * an extracted portal are skipped — the portal runtime handles those.
     */
    private handleTouchEventStep(player:Player) {
        if (!this.eventTouchHandler) {
            return;
        }

        const cellX = Math.floor((player.x + player.width / 2) / 32);
        const cellY = Math.floor((player.y + player.height / 2) / 32);
        const key = `${player.currentMapId}:${cellX}:${cellY}`;
        if (key === player.lastTouchCellKey) {
            return;
        }
        player.lastTouchCellKey = key;
        // Previous-tile tracking for sight-trap push-back: only an ordinary
        // adjacent step counts — after a teleport there is no "previous" tile.
        const cameFrom = player.currentCell;
        const adjacentStep =
            cameFrom !== null &&
            cameFrom.mapId === player.currentMapId &&
            Math.max(Math.abs(cameFrom.x - cellX), Math.abs(cameFrom.y - cellY)) === 1;
        player.previousCell = adjacentStep ? cameFrom : null;
        player.currentCell = { mapId: player.currentMapId, x: cellX, y: cellY };
        // Cells crossed during the post-teleport lock never fire: the key is
        // already updated above, so they won't fire retroactively either.
        if (Date.now() < player.touchLockUntil) {
            return;
        }

        const editorData = this.playableMapsState?.editorDataByMapId[player.currentMapId];
        if (!editorData) {
            return;
        }
        // Standing on a walkable portal cell teleports (server-authoritative);
        // portal tiles never double as essentials touch events.
        if (this.firePortalIfPresent(player, cellX, cellY)) {
            return;
        }

        for (const blocker of this.npcBlockersLive(player.currentMapId)) {
            // Rounded, not exact: a walking NPC sits between two tiles for most
            // of its step, and its touch trigger belongs to the tile it is
            // closest to rather than nowhere at all.
            if (
                !blocker.essentials ||
                Math.round(blocker.x / 32) !== cellX ||
                Math.round(blocker.y / 32) !== cellY
            ) {
                continue;
            }
            const page = selectConditionMetPage(
                blocker.essentials,
                this.eventStateFor(player),
                this.pageSelectionOptions()
            );
            if (
                page &&
                (page.trigger === 1 || page.trigger === 2) &&
                (!page.graphic?.characterName || page.move?.through)
            ) {
                this.eventTouchHandler(player, blocker.id);
                return;
            }
        }
    }

    /**
     * Essentials trainer line-of-sight: an event named "Trainer(X)" spots the
     * player up to X tiles straight ahead of its facing direction and starts
     * itself (pbEventCanReachPlayer?), which is how trainer ambushes and
     * road-block guards work. Only touch-trigger pages (1/2) fire — the
     * post-defeat / quest-satisfied pages of these events are Action Button
     * (trigger 0), so beaten trainers stop spotting automatically. Sight stops
     * at the first unwalkable tile, exactly like the original (trainers cannot
     * see through walls, trees or other NPCs).
     *
     * Unlike the tile-stepped original, players here move in pixels and can
     * cut corners diagonally, so the check runs on every movement node and
     * detects the player's rectangle overlapping the sight corridor (at least
     * half a tile across it, same alignment rule as doors) — a sight line can
     * never be hopped over.
     */
    private handleTrainerSightCheck(player:Player) {
        if (!this.eventTouchHandler || Date.now() < player.touchLockUntil) {
            return;
        }
        const playerCellX = Math.floor((player.x + player.width / 2) / 32);
        const playerCellY = Math.floor((player.y + player.height / 2) / 32);
        for (const blocker of this.npcBlockersLive(player.currentMapId)) {
            if (blocker.sightRange <= 0 || !blocker.essentials) {
                continue;
            }
            const eventCellX = Math.round(blocker.x / 32);
            const eventCellY = Math.round(blocker.y / 32);
            // Cheap pre-filter before touching page selection.
            if (
                Math.abs(playerCellX - eventCellX) > blocker.sightRange + 1 ||
                Math.abs(playerCellY - eventCellY) > blocker.sightRange + 1
            ) {
                continue;
            }
            const page = selectConditionMetPage(
                blocker.essentials,
                this.eventStateFor(player),
                this.pageSelectionOptions()
            );
            if (!page || (page.trigger !== 1 && page.trigger !== 2)) {
                continue;
            }
            // A walking trainer looks where it is walking, so its sight cone
            // follows the actor's live facing rather than the authored one.
            const direction = blocker.facing ?? page.graphic?.direction;
            const dx = direction === 6 ? 1 : direction === 4 ? -1 : 0;
            const dy = direction === 2 ? 1 : direction === 8 ? -1 : 0;
            if (dx === 0 && dy === 0) {
                continue;
            }
            // Corridor of visible tiles: in front of the NPC until the first
            // wall/solid event, at most sightRange tiles.
            let visibleTiles = 0;
            while (visibleTiles < blocker.sightRange) {
                const nextX = eventCellX + dx * (visibleTiles + 1);
                const nextY = eventCellY + dy * (visibleTiles + 1);
                if (this.isCellBlockedForSight(player, nextX, nextY)) {
                    break;
                }
                visibleTiles += 1;
            }
            if (visibleTiles < 1) {
                continue;
            }
            const corridor = {
                x: Math.min(eventCellX + dx, eventCellX + dx * visibleTiles) * 32,
                y: Math.min(eventCellY + dy, eventCellY + dy * visibleTiles) * 32,
                width: (dx !== 0 ? visibleTiles : 1) * 32,
                height: (dy !== 0 ? visibleTiles : 1) * 32
            };
            const overlapX = Math.min(player.x + player.width, corridor.x + corridor.width) - Math.max(player.x, corridor.x);
            const overlapY = Math.min(player.y + player.height, corridor.y + corridor.height) - Math.max(player.y, corridor.y);
            if (overlapX <= 0 || overlapY <= 0) {
                continue;
            }
            // Across the corridor the player must overlap at least half a tile
            // (grazing its edge while walking alongside is not "in sight").
            if ((dx !== 0 ? overlapY : overlapX) < 16) {
                continue;
            }
            const pushCell = this.resolveSightPushBackCell(
                player,
                { x: eventCellX, y: eventCellY },
                dx,
                dy,
                blocker.sightRange,
                visibleTiles
            );
            this.eventTouchHandler(player, blocker.id, pushCell);
            return;
        }
    }

    /**
     * Where a sight-trapped player is returned to if the event ends still
     * armed: their own tile when already outside the corridor (caught at its
     * edge), else the tile they came from, else the first tile beyond the
     * corridor's far end. Null when no safe tile exists (open-ended traps
     * simply re-fire on the next step instead).
     */
    private resolveSightPushBackCell(
        player:Player,
        eventCell:{ x:number; y:number },
        dx:number,
        dy:number,
        range:number,
        visibleTiles:number
    ): { x:number; y:number } | null {
        const inCorridor = (cell:{ x:number; y:number }) => {
            const alongAxis = dx !== 0 ? cell.y === eventCell.y : cell.x === eventCell.x;
            if (!alongAxis) {
                return false;
            }
            const distance = dx !== 0 ? (cell.x - eventCell.x) * dx : (cell.y - eventCell.y) * dy;
            return distance >= 0 && distance <= range; // includes the NPC's own tile
        };
        const bounds = this.getMapBounds(player.currentMapId);
        const usable = (cell:{ x:number; y:number } | null): cell is { x:number; y:number } => {
            if (!cell || inCorridor(cell)) {
                return false;
            }
            if (cell.x < 0 || cell.y < 0 || (cell.x + 1) * 32 > bounds.width || (cell.y + 1) * 32 > bounds.height) {
                return false;
            }
            return !this.isCellBlockedForSight(player, cell.x, cell.y);
        };

        const sameMapCell = (cell:{ mapId:string; x:number; y:number } | null) =>
            cell && cell.mapId === player.currentMapId ? { x: cell.x, y: cell.y } : null;
        const own = sameMapCell(player.currentCell);
        if (usable(own)) {
            return own;
        }
        const previous = sameMapCell(player.previousCell);
        if (usable(previous)) {
            return previous;
        }
        // Beyond the corridor's far end — only reachable when sight ran its
        // full range (a wall-truncated corridor has no far side to stand on).
        if (visibleTiles === range) {
            const beyond = { x: eventCell.x + dx * (range + 1), y: eventCell.y + dy * (range + 1) };
            if (usable(beyond)) {
                return beyond;
            }
        }
        return null;
    }

    /**
     * Sight-line passability for one tile: static collision plus NPC events
     * whose active page shows a solid sprite for THIS player. Other players
     * never break line of sight — a friend standing in the way must not smuggle
     * anyone past a trainer.
     */
    private isCellBlockedForSight(player:Player, cellX:number, cellY:number): boolean {
        const inset = 4;
        const x = cellX * 32 + inset;
        const y = cellY * 32 + inset;
        const size = 32 - inset * 2;
        if (this.getMapObjects(player.currentMapId).some((object) => this.checkCollision({ x, y, width: size, height: size }, object))) {
            return true;
        }
        if (this.isRectBlockedByCollisionGrid(player.currentMapId, x, y, size, size, player.isSurfing)) {
            return true;
        }
        for (const blocker of this.npcBlockersLive(player.currentMapId)) {
            if (Math.round(blocker.x / 32) !== cellX || Math.round(blocker.y / 32) !== cellY) {
                continue;
            }
            if (!blocker.essentials) {
                return true;
            }
            const page = selectConditionMetPage(
                blocker.essentials,
                this.eventStateFor(player),
                this.pageSelectionOptions()
            );
            if (page && page.graphic?.characterName && !page.move?.through) {
                return true;
            }
        }
        return false;
    }

    /**
     * NPC blockers with the live positions of any that are walking. The static
     * `getNpcBlockers` cache still supplies identity and page data; only x/y
     * (and the facing an actor is actually walking in) are overlaid.
     *
     * Memoized for a fraction of the simulation tick because this sits on the
     * 28ms-per-player movement path: without it every player would rebuild the
     * whole list ~36 times a second.
     */
    private npcBlockersLive(mapId:string) {
        const base = this.getNpcBlockers(mapId);

        if (!this.npcSimulation?.hasActors(mapId)) {
            return base;
        }

        const now = Date.now();
        const cached = this.liveNpcBlockerCache.get(mapId);

        if (cached && now - cached.at < World.LIVE_NPC_BLOCKER_TTL_MS) {
            return cached.blockers;
        }

        const blockers = base.map((blocker) => {
            const live = this.npcSimulation?.liveStateOf(mapId, blocker.id);
            return live
                ? { ...blocker, x: live.x, y: live.y, facing: live.facing }
                : blocker;
        });

        this.liveNpcBlockerCache.set(mapId, { at: now, blockers });
        return blockers;
    }

    /** The NPC actor simulation's view of static blockers (public for it). */
    npcBlockersOnMap(mapId:string) {
        return this.getNpcBlockers(mapId);
    }

    private getNpcBlockers(mapId:string) {
        const state = this.playableMapsState;
        if (!state) {
            return [] as Array<NpcBlocker>;
        }

        let byMap = this.npcBlockerCache.get(state);
        if (!byMap) {
            byMap = new Map();
            this.npcBlockerCache.set(state, byMap);
        }

        let blockers = byMap.get(mapId);
        if (!blockers) {
            blockers = [];
            const npcs = state.editorDataByMapId[mapId]?.npcs ?? [];
            for (const npc of npcs) {
                const placement = npc as typeof npc & { essentialsEvent?: EssentialsEventRecord; name?: string };
                if (
                    typeof placement.x !== "number" ||
                    typeof placement.y !== "number"
                ) {
                    continue;
                }
                const name = typeof placement.name === "string" ? placement.name : null;
                // Essentials "Trainer(X)" naming: line-of-sight range in tiles.
                const sightMatch = name ? /trainer\s*\(\s*(\d+)\s*\)/i.exec(name) : null;
                const sightRange = sightMatch ? Math.min(Number(sightMatch[1]), 10) : 0;
                if (placement.essentialsEvent) {
                    // Conditional blocker; page visibility is resolved per player.
                    blockers.push({
                        id: placement.id,
                        x: placement.x * 32,
                        y: placement.y * 32,
                        name,
                        sightRange,
                        facing: null,
                        essentials: placement.essentialsEvent
                    });
                } else if (placement.previewImageSrc) {
                    blockers.push({ id: placement.id, x: placement.x * 32, y: placement.y * 32, name, sightRange: 0, facing: null, essentials: null });
                }
            }
            byMap.set(mapId, blockers);
        }

        return blockers;
    }

    setPlayableMapsState(playableMapsState: PlayableMapsStateSnapshot) {
        this.playableMapsState = playableMapsState;
        // Placements (and their move routes) may have changed; drop the actors
        // and the live-position overlay so both rebuild from the new payload.
        this.npcSimulation?.reset();
        this.liveNpcBlockerCache.clear();
    }

    setBattleManager(battleManager: BattleManager) {
        this.battleManager = battleManager;
    }

    handlePlayerStep(player: Player) {
        // Surf ends the moment the player steps back onto dry land.
        if (player.isSurfing && !isSurfableWaterTag(this.getPlayerTerrainTag(player))) {
            this.setSurfing(player, false);
        }
        this.followerSimulation?.onOwnerStep(player);
        this.battleManager?.handlePlayerStep(player);
        this.battleManager?.handleEggStep(player);
        this.battleManager?.handleRepelStep(player);
        void this.handleGroundItemPickup(player);
        this.handleTouchEventStep(player);
        this.handleTrainerSightCheck(player);
    }

    getPlayableMapsState() {
        return this.playableMapsState;
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
        const safeX = Number.isFinite(x) ? x : 0;
        const safeY = Number.isFinite(y) ? y : 0;

        return {
            x: Math.max(0, Math.min(Math.round(safeX), maxX)),
            y: Math.max(0, Math.min(Math.round(safeY), maxY))
        };
    }

    private isPlayerPositionBlocked(
        mapId:string,
        x:number,
        y:number,
        playerWidth:number,
        playerHeight:number
    ) {
        return this.isRectBlocked(mapId, x, y, playerWidth, playerHeight);
    }

    isOpenPlayerPosition(
        mapId:string,
        x:number,
        y:number,
        playerWidth:number,
        playerHeight:number
    ) {
        const mapBounds = this.getMapBounds(mapId);
        const maxX = Math.max(0, mapBounds.width - playerWidth);
        const maxY = Math.max(0, mapBounds.height - playerHeight);

        return (
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            x >= 0 &&
            y >= 0 &&
            x <= maxX &&
            y <= maxY &&
            !this.isPlayerPositionBlocked(mapId, x, y, playerWidth, playerHeight)
        );
    }

    /** Like isOpenPlayerPosition but STATIC geometry only and surf-aware:
     * while surfing, water-tagged solid cells count as open. Used by the
     * per-tick out-of-bounds relocation so it doesn't snap surfing players
     * back to shore (water is collision-solid by design). */
    isOpenPositionForPlayer(player:Player, x:number, y:number) {
        const mapBounds = this.getMapBounds(player.currentMapId);
        const maxX = Math.max(0, mapBounds.width - player.width);
        const maxY = Math.max(0, mapBounds.height - player.height);

        return (
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            x >= 0 &&
            y >= 0 &&
            x <= maxX &&
            y <= maxY &&
            !this.isRectBlockedByCollisionGrid(
                player.currentMapId,
                x,
                y,
                player.width,
                player.height,
                player.isSurfing
            )
        );
    }

    resolveOpenPlayerPosition(
        mapId:string,
        x:number,
        y:number,
        playerWidth:number,
        playerHeight:number
    ) {
        const mapBounds = this.getMapBounds(mapId);
        const maxX = Math.max(0, mapBounds.width - playerWidth);
        const maxY = Math.max(0, mapBounds.height - playerHeight);
        const requestedPosition = this.clampPlayerPosition(mapId, x, y, playerWidth, playerHeight);

        if (!this.isPlayerPositionBlocked(
            mapId,
            requestedPosition.x,
            requestedPosition.y,
            playerWidth,
            playerHeight
        )) {
            return requestedPosition;
        }

        const stepSize = Math.max(1, Math.min(playerWidth, playerHeight));
        const maxRadius = Math.ceil(Math.max(maxX, maxY) / stepSize);

        for (let radius = 1; radius <= maxRadius; radius += 1) {
            for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
                for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
                    if (Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== radius) {
                        continue;
                    }

                    const candidateX = Math.max(
                        0,
                        Math.min(requestedPosition.x + offsetX * stepSize, maxX)
                    );
                    const candidateY = Math.max(
                        0,
                        Math.min(requestedPosition.y + offsetY * stepSize, maxY)
                    );

                    if (!this.isPlayerPositionBlocked(
                        mapId,
                        candidateX,
                        candidateY,
                        playerWidth,
                        playerHeight
                    )) {
                        return {
                            x: candidateX,
                            y: candidateY
                        };
                    }
                }
            }
        }

        return requestedPosition;
    }

    /**
     * Picks a safe, non-stuck spot on a map with no requested coordinates —
     * the "automatic placement" the admin panel uses. Seeds from the map's
     * designer-authored initial spawn (falling back to the map centre) and
     * spirals out with resolveOpenPlayerPosition until it lands on a cell the
     * player is not blocked inside. Coordinates are map pixels, matching
     * savedLocation / teleport.
     */
    resolveAutomaticPlacement(
        mapId:string,
        playerWidth = 32,
        playerHeight = 32
    ) {
        const config = this.playableMapsState?.items.find(
            (item) => item.id === mapId
        )?.playableMapConfig;

        let seedX:number;
        let seedY:number;
        if (
            config &&
            typeof config.initialPositionX === "number" &&
            Number.isFinite(config.initialPositionX) &&
            typeof config.initialPositionY === "number" &&
            Number.isFinite(config.initialPositionY)
        ) {
            seedX = config.initialPositionX;
            seedY = config.initialPositionY;
        } else {
            const bounds = this.getMapBounds(mapId);
            seedX = Math.round(bounds.width / 2);
            seedY = Math.round(bounds.height / 2);
        }

        return this.resolveOpenPlayerPosition(mapId, seedX, seedY, playerWidth, playerHeight);
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

    getPlayerByUserId(userId:number) {
        return this.players.get(this.getAuthenticatedPlayerId(userId));
    }

    /**
     * Distinct authenticated user ids that currently have at least one live
     * player in the world. Powers the admin panel's real-time "who is online"
     * indicator.
     */
    getOnlineUserIds():number[] {
        const userIds = new Set<number>();
        this.players.forEach((player) => {
            if (typeof player.userId === "number") {
                userIds.add(player.userId);
            }
        });
        return Array.from(userIds);
    }

    getOnlineMapsOverview() {
        const maps = new Map<string, {
            mapId:string;
            players:Array<{
                playerId:string;
                userId:number | null;
                username:string;
                name:string;
                x:number;
                y:number;
                connectedSockets:number;
            }>;
        }>();

        this.players.forEach((player) => {
            const currentMap = maps.get(player.currentMapId) ?? {
                mapId: player.currentMapId,
                players: []
            };

            currentMap.players.push({
                playerId: player.socketId,
                userId: player.userId,
                username: player.username,
                name: player.name,
                x: player.x,
                y: player.y,
                connectedSockets: player.socketConnections.size
            });
            maps.set(player.currentMapId, currentMap);
        });

        return Array.from(maps.values())
            .map((map) => ({
                ...map,
                onlinePlayers: map.players.length
            }))
            .sort((left, right) => right.onlinePlayers - left.onlinePlayers || left.mapId.localeCompare(right.mapId));
    }

    addPlayer(
        socketId:string,
        spawnState?: { mapId?: string; x?: number; y?: number; surfing?: boolean },
        userId?: number | null,
        trainerProfile?: {
            username?: string;
            name?: string;
            characterId?: number;
            profileImage?: string;
            description?: string;
            characterSkinId?: string;
        }
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
        // Reconnecting while surfing: the saved cell is water (collision-solid),
        // so the open-position search would silently relocate the player onto
        // land. When the saved surf flag checks out against the terrain, keep
        // the exact water cell and restore the surfing traversal state.
        const cellSize = this.getMapCellSize(mapId);
        const savedCellX = Math.floor((unclampedX + 16) / cellSize);
        const savedCellY = Math.floor((unclampedY + 16) / cellSize);
        const restoreSurf =
            spawnState?.surfing === true &&
            this.isOpenWaterCell(mapId, savedCellX, savedCellY);
        const spawnPosition = restoreSurf
            ? this.clampPlayerPosition(mapId, unclampedX, unclampedY, 32, 32)
            : this.resolveOpenPlayerPosition(mapId, unclampedX, unclampedY, 32, 32);

        const player = new Player(
            spawnPosition.x,
            spawnPosition.y,
            playerId,
            this,
            mapId,
            socketId,
            typeof userId === "number" ? userId : null,
            trainerProfile
        );
        player.isSurfing = restoreSurf;

        this.players.set(playerId, player);
        this.socketToPlayerId.set(socketId, playerId);
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

    presentPlayersOnMapTo(socketId:string, mapId:string) {
        const currentPlayerId = this.socketToPlayerId.get(socketId);
        this.players.forEach((player) => {
            if (player.socketId === currentPlayerId || player.currentMapId !== mapId) {
                return;
            }

            World.socketServer.in(socketId).emit("addPlayer", player.data());
        });

        // Arriving on a map is exactly when a client needs the walking NPCs'
        // current tiles: without this it would render them on their authored
        // tiles until the next step packet, which for an idling NPC is never.
        this.presentNpcActorsTo(socketId, mapId);
        this.presentFollowersTo(socketId, mapId);
        this.presentBeachBallsTo(socketId, mapId);
    }

    /** Sends the full follower state of a map to one socket. */
    presentFollowersTo(socketId:string, mapId:string) {
        const followers = this.followerSimulation?.snapshotForMap(mapId) ?? [];

        if (followers.length === 0) {
            return;
        }

        World.socketServer.in(socketId).emit("follower:sync", { mapId, t: Date.now(), followers });
    }

    /** Sends the live beach balls of a map to one socket. */
    presentBeachBallsTo(socketId:string, mapId:string) {
        const balls = this.beachBalls.snapshotForMap(mapId);

        if (balls.length === 0) {
            return;
        }

        World.socketServer.in(socketId).emit("ball:sync", { mapId, t: Date.now(), balls });
    }

    /** Sends the full NPC actor state of a map to one socket. */
    presentNpcActorsTo(socketId:string, mapId:string) {
        const npcs = this.npcSimulation?.snapshotForMap(mapId) ?? [];

        if (npcs.length === 0) {
            return;
        }

        World.socketServer.in(socketId).emit("npc:sync", { mapId, t: Date.now(), npcs });
    }

    /**
     * Emits an event only to the sockets of players currently on the given
     * map. Movement traffic must stay map-local: a global broadcast makes
     * every connected client (other maps, admin panels) receive and process
     * every step of every player in the world.
     */
    emitToMap(mapId:string, event:string, payload:unknown) {
        const socketIds:string[] = [];
        this.players.forEach((player) => {
            if (player.currentMapId !== mapId) {
                return;
            }

            player.socketConnections.forEach((socketId) => {
                socketIds.push(socketId);
            });
        });

        if (socketIds.length > 0) {
            World.socketServer.to(socketIds).emit(event, payload);
        }
    }

    presentPlayerToMap(player:Player, mapId = player.currentMapId) {
        this.players.forEach((targetPlayer) => {
            if (targetPlayer.socketId === player.socketId || targetPlayer.currentMapId !== mapId) {
                return;
            }

            targetPlayer.socketConnections.forEach((socketId) => {
                World.socketServer.in(socketId).emit("addPlayer", player.data());
            });
        });
    }

    /**
     * Broadcasts world objects (like rocks/environment elements) to a targeted client.
     * @param socketId - The socket ID of the targeted client.
     */
    presentObjectsTo(socketId:string) {
        const mapId = this.getPlayerBySocket(socketId)?.currentMapId ?? DEFAULT_PLAYER_MAP_ID;
        this.getMapObjects(mapId).forEach( (object) => {
            World.socketServer.in(socketId).emit("addObject", object)
        })
        this.groundItems.forEach((item) => {
            if (item.mapId === mapId && !item.hidden) {
                World.socketServer.in(socketId).emit("world:item-dropped", item);
            }
        });
        this.presentFollowersTo(socketId, mapId);
        this.presentBeachBallsTo(socketId, mapId);
    }

    /**
     * Nearest still-hidden ground item on the player's map, with a compass
     * direction and tile distance. Powers the Dowsing Machine / Itemfinder.
     */
    findNearestHiddenGroundItem(player:Player, cellSize:number) {
        const here = player.getCurrentCell(cellSize);
        let best: { item: GroundItem; distanceTiles: number; direction: string } | null = null;

        for (const item of this.groundItems.values()) {
            if (item.mapId !== player.currentMapId || !item.hidden) {
                continue;
            }
            const itemCellX = Math.floor((item.x + item.width / 2) / cellSize);
            const itemCellY = Math.floor((item.y + item.height / 2) / cellSize);
            const dx = itemCellX - here.x;
            const dy = itemCellY - here.y;
            const distanceTiles = Math.abs(dx) + Math.abs(dy);
            let direction = "here";
            if (distanceTiles > 0) {
                direction = Math.abs(dx) >= Math.abs(dy)
                    ? (dx > 0 ? "east" : "west")
                    : (dy > 0 ? "south" : "north");
            }
            if (!best || distanceTiles < best.distanceTiles) {
                best = { item, distanceTiles, direction };
            }
        }

        return best;
    }

    /** Reveals a hidden ground item so it renders and can be picked up. */
    revealGroundItem(groundItemId:string) {
        const item = this.groundItems.get(groundItemId);
        if (!item || !item.hidden) {
            return null;
        }
        const revealed: GroundItem = { ...item, hidden: false };
        this.groundItems.set(groundItemId, revealed);
        this.persistGroundItems();
        World.socketServer.emit("world:item-dropped", revealed);
        return revealed;
    }

    dropGroundItem(item: Omit<GroundItem, "id" | "droppedAt" | "width" | "height"> & Partial<Pick<GroundItem, "width" | "height">>) {
        const groundItem: GroundItem = {
            ...item,
            id: `ground-item-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            width: item.width ?? 32,
            height: item.height ?? 32,
            droppedAt: new Date().toISOString()
        };

        this.groundItems.set(groundItem.id, groundItem);
        this.persistGroundItems();
        World.socketServer.emit("world:item-dropped", groundItem);

        return groundItem;
    }

    private async handleGroundItemPickup(player: Player) {
        if (typeof player.userId !== "number") {
            return;
        }

        const playerBounds = {
            x: player.x,
            y: player.y,
            width: player.width,
            height: player.height
        };

        const groundItem = Array.from(this.groundItems.values()).find((item) =>
            item.mapId === player.currentMapId &&
            !item.hidden &&
            this.checkCollision(playerBounds, item)
        );

        if (!groundItem || !this.battleManager) {
            return;
        }

        const pickedUp = await this.battleManager.pickUpGroundItem(player, groundItem);

        if (!pickedUp) {
            return;
        }

        this.groundItems.delete(groundItem.id);
        this.persistGroundItems();
        World.socketServer.emit("world:item-picked-up", { groundItemId: groundItem.id });
    }

    /**
     * Removes a player from the world and notifies clients.
     * @param socketId - The socket ID of the player to remove.
     */
    /**
     * Fully removes an authenticated player's world entity regardless of how
     * many sockets are attached (character switch: the client re-joins as the
     * newly selected character).
     */
    removePlayerByUserId(userId:number) {
        const player = this.getPlayerByUserId(userId);
        if (!player) {
            return false;
        }
        for (const socketId of player.socketConnections) {
            this.socketToPlayerId.delete(socketId);
        }
        World.socketServer.emit("removePlayer", { playerId: player.socketId, id: player.id });
        this.players.delete(player.socketId);
        this.followerSimulation?.removeFor(player.socketId);
        return true;
    }

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
        this.followerSimulation?.removeFor(playerId);

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
