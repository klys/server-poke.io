import Player from "./player"
import Projectil from "./projectil"
import GameMath from "./gameMath";
import Pathfinding = require("pathfinding")
import type { MapEditorPortalPlacement, PlayableMapsStateSnapshot } from "./PlayableMapsState";
import { isSolidCollisionCell, type MapCollisionGrid } from "./TileMapGrid";
import type BattleManager from "./BattleManager";
import GroundItemStore, { type GroundItem } from "./GroundItemStore";
import {
    EMPTY_EVENT_PLAYER_STATE,
    selectConditionMetPage,
    type EssentialsEventRecord
} from "./eventPageSelection";

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
    collisionGridsByMapId: Map<string, MapCollisionGrid>;
    playableMapsState: PlayableMapsStateSnapshot | null;
    battleManager: BattleManager | null;
    groundItems: Map<string, GroundItem>;
    /** Per-snapshot cache of NPC collision rectangles by map. */
    private npcBlockerCache = new WeakMap<object, Map<string, Array<{ id:string; x:number; y:number; essentials:EssentialsEventRecord | null }>>>();
    /** Fires trigger-1/2 (touch) events; wired to the event runtime. */
    private eventTouchHandler:((player:Player, placementId:string) => void) | null = null;
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
        });
    }

    getMapObjects(mapId:string) {
        return this.objectsByMapId.get(mapId) ?? [];
    }

    getMapCollisionGrid(mapId:string) {
        return this.collisionGridsByMapId.get(mapId) ?? null;
    }

    private isRectBlockedByCollisionGrid(
        mapId:string,
        x:number,
        y:number,
        width:number,
        height:number
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
        if (this.isRectBlocked(player.currentMapId, x, y, width, height)) {
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

        for (const blocker of this.getNpcBlockers(player.currentMapId)) {
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
                player.eventState ?? EMPTY_EVENT_PLAYER_STATE
            );
            if (page && page.graphic?.characterName && !page.move?.through) {
                return true;
            }
        }

        return false;
    }

    setEventTouchHandler(handler:(player:Player, placementId:string) => void) {
        this.eventTouchHandler = handler;
    }

    setLocationPersistHandler(handler:(player:Player) => void) {
        this.locationPersistHandler = handler;
    }

    setPortalHandler(handler:(player:Player, portal:MapEditorPortalPlacement) => void) {
        this.portalHandler = handler;
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
        for (const blocker of this.getNpcBlockers(player.currentMapId)) {
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
                player.eventState ?? EMPTY_EVENT_PLAYER_STATE
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

        for (const blocker of this.getNpcBlockers(player.currentMapId)) {
            if (!blocker.essentials || blocker.x !== cellX * 32 || blocker.y !== cellY * 32) {
                continue;
            }
            const page = selectConditionMetPage(
                blocker.essentials,
                player.eventState ?? EMPTY_EVENT_PLAYER_STATE
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

    private getNpcBlockers(mapId:string) {
        const state = this.playableMapsState;
        if (!state) {
            return [] as Array<{ id:string; x:number; y:number; essentials:EssentialsEventRecord | null }>;
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
                const placement = npc as typeof npc & { essentialsEvent?: EssentialsEventRecord };
                if (
                    typeof placement.x !== "number" ||
                    typeof placement.y !== "number"
                ) {
                    continue;
                }
                if (placement.essentialsEvent) {
                    // Conditional blocker; page visibility is resolved per player.
                    blockers.push({
                        id: placement.id,
                        x: placement.x * 32,
                        y: placement.y * 32,
                        essentials: placement.essentialsEvent
                    });
                } else if (placement.previewImageSrc) {
                    blockers.push({ id: placement.id, x: placement.x * 32, y: placement.y * 32, essentials: null });
                }
            }
            byMap.set(mapId, blockers);
        }

        return blockers;
    }

    setPlayableMapsState(playableMapsState: PlayableMapsStateSnapshot) {
        this.playableMapsState = playableMapsState;
    }

    setBattleManager(battleManager: BattleManager) {
        this.battleManager = battleManager;
    }

    handlePlayerStep(player: Player) {
        this.battleManager?.handlePlayerStep(player);
        void this.handleGroundItemPickup(player);
        this.handleTouchEventStep(player);
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
        spawnState?: { mapId?: string; x?: number; y?: number },
        userId?: number | null,
        trainerProfile?: {
            username?: string;
            name?: string;
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
        const spawnPosition = this.resolveOpenPlayerPosition(mapId, unclampedX, unclampedY, 32, 32);

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
