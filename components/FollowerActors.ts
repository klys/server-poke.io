// Server-authoritative follower venomon: the party leader walks the map one
// tile behind its trainer.
//
// Mirrors the NpcActors design (cell-based actors, step broadcasts, map-scoped
// sync for late joiners) but followers don't plan goals: they replay the
// breadcrumb trail of cells their owner vacates, so the follower always walks
// exactly where the trainer walked. Followers are solid, pushable bodies —
// World.shovePastObstacle displaces them like players — and they vanish from
// the map (no sprite, no collision) while the owner surfs or is underwater.

import { speciesCharsetName } from "./generated/speciesDex";
import { resolveDivePair } from "./diveMaps";
import type Player from "./player";
import type World from "./world";

const FOLLOWER_SIZE = 32;
const TICK_MS = 50;
/** Safety-net full resync per populated map (same cadence as NPC actors). */
const RESYNC_INTERVAL_MS = 15000;
/** Duration of a shove step (a player pushing the follower). */
const SHOVE_STEP_MS = 180;
/** Owner walk cadence: one 32px cell = 8 path nodes x 28ms ticks. */
const OWNER_CELL_MS = 224;
/** Breadcrumbs beyond this snap the follower to the owner instead of walking. */
const MAX_TRAIL = 4;

// RPG Maker facing codes — clients reuse the NpcSprite charset rows.
const FACE_DOWN = 2;
const FACE_LEFT = 4;
const FACE_RIGHT = 6;
const FACE_UP = 8;

function facingForDelta(dx: number, dy: number, fallback: number): number {
    if (dy > 0) return FACE_DOWN;
    if (dy < 0) return FACE_UP;
    if (dx < 0) return FACE_LEFT;
    if (dx > 0) return FACE_RIGHT;
    return fallback;
}

/** Owner angle (90=up, 270=down, 180=right, 0=left) -> RMXP facing code. */
function facingForAngle(angle: number): number {
    const normalized = ((Math.round(angle) % 360) + 360) % 360;
    if (normalized === 90) return FACE_UP;
    if (normalized === 270) return FACE_DOWN;
    if (normalized === 180) return FACE_RIGHT;
    return FACE_LEFT;
}

type FollowerActor = {
    /** The owning player's logical id (`user:{accountId}` / `guest:{socketId}`). */
    ownerId: string;
    mapId: string;
    /** Charset basename under /migration_exports/characters/, e.g. "025". */
    charset: string;
    cellX: number;
    cellY: number;
    toX: number;
    toY: number;
    facing: number;
    moving: boolean;
    stepStartedAt: number;
    stepMs: number;
    /** Not rendered and not solid (owner surfing / underwater map). */
    hidden: boolean;
    /** Cells the owner vacated, oldest first — the follower's walking script. */
    trail: Array<{ x: number; y: number }>;
    /** Owner cell observed on the last step hook, to detect cell changes. */
    lastOwnerCell: { x: number; y: number } | null;
    /** Earliest time this follower may be shoved again. */
    shoveCooldownUntil: number;
};

/** One follower step, broadcast to every client on the map. */
export type FollowerStep = {
    ownerId: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    facing: number;
    stepMs: number;
};

/** Full follower state, sent on map arrival / state changes. */
export type FollowerSnapshot = {
    ownerId: string;
    charset: string;
    x: number;
    y: number;
    toX: number;
    toY: number;
    facing: number;
    stepMs: number;
    /** Milliseconds already elapsed of the step in progress (0 when idle). */
    elapsedMs: number;
    hidden: boolean;
};

/**
 * Resolves the owner's current party leader to a follower look, or null when
 * there is nothing to follow (empty party, egg leader, unknown species,
 * follower disabled). Injected from the socket layer, which owns Auth.
 */
export type FollowerLeaderResolver = (player: Player) => Promise<{ charset: string } | null>;

/** True when the map is the underwater half of a dive pair. */
function isUnderwaterMap(mapId: string): boolean {
    return resolveDivePair(mapId)?.role === "underwater";
}

export default class FollowerActorSimulation {
    private readonly actorsByOwner = new Map<string, FollowerActor>();
    private readonly lastResyncByMap = new Map<string, number>();
    private leaderResolver: FollowerLeaderResolver | null = null;
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly world: World) {}

    start() {
        if (this.timer) {
            return;
        }
        this.timer = setInterval(() => {
            try {
                this.tick();
            } catch (error) {
                console.error("[follower-actors] tick failed", error);
            }
        }, TICK_MS);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    setLeaderResolver(resolver: FollowerLeaderResolver) {
        this.leaderResolver = resolver;
    }

    /** Extra follower-shaped actors (house roamers) merged into map syncs. */
    private extraSnapshots: ((mapId: string) => FollowerSnapshot[]) | null = null;

    setExtraSnapshotProvider(provider: (mapId: string) => FollowerSnapshot[]) {
        this.extraSnapshots = provider;
    }

    /** Live followers on a map, for collision and hydration. */
    snapshotForMap(mapId: string): FollowerSnapshot[] {
        const snapshots: FollowerSnapshot[] = [];
        const now = Date.now();

        this.actorsByOwner.forEach((actor) => {
            if (actor.mapId === mapId) {
                snapshots.push(this.snapshot(actor, now));
            }
        });

        if (this.extraSnapshots) {
            snapshots.push(...this.extraSnapshots(mapId));
        }

        return snapshots;
    }

    /** Solid follower boxes on a map (pixel space), for player collision. */
    blockersOnMap(mapId: string): Array<{ ownerId: string; x: number; y: number }> {
        const blockers: Array<{ ownerId: string; x: number; y: number }> = [];

        this.actorsByOwner.forEach((actor) => {
            if (actor.mapId !== mapId || actor.hidden) {
                return;
            }
            blockers.push({
                ownerId: actor.ownerId,
                x: actor.cellX * FOLLOWER_SIZE,
                y: actor.cellY * FOLLOWER_SIZE
            });
        });

        return blockers;
    }

    /** The follower whose solid body overlaps `bounds`, or null. */
    findAt(mapId: string, bounds: { x: number; y: number; width: number; height: number }): FollowerActor | null {
        for (const actor of Array.from(this.actorsByOwner.values())) {
            if (actor.mapId !== mapId || actor.hidden) {
                continue;
            }
            const inset = 2;
            const actorBounds = {
                x: actor.cellX * FOLLOWER_SIZE + inset,
                y: actor.cellY * FOLLOWER_SIZE + inset,
                width: FOLLOWER_SIZE - inset * 2,
                height: FOLLOWER_SIZE - inset * 2
            };
            if (this.world.checkCollision(bounds, actorBounds)) {
                return actor;
            }
        }

        return null;
    }

    getActor(ownerId: string): FollowerActor | null {
        return this.actorsByOwner.get(ownerId) ?? null;
    }

    /**
     * Re-resolves the owner's leader and creates/updates/removes the follower
     * accordingly. Fire-and-forget safe; call on join, party changes, map
     * changes and the follower toggle.
     */
    refreshFor(player: Player) {
        const resolver = this.leaderResolver;

        if (!resolver) {
            return;
        }

        void resolver(player)
            .then((leader) => {
                // The player may have disconnected while we read Redis.
                if (!this.world.players.has(player.socketId)) {
                    this.removeFor(player.socketId);
                    return;
                }
                if (!leader || !player.followerEnabled) {
                    this.removeFor(player.socketId);
                    return;
                }
                this.ensureActor(player, leader.charset);
            })
            .catch((error) => {
                console.error("[follower-actors] leader refresh failed", error);
            });
    }

    /** Drops the follower (owner left, follower disabled, or nothing to follow). */
    removeFor(ownerId: string) {
        const actor = this.actorsByOwner.get(ownerId);

        if (!actor) {
            return;
        }

        this.actorsByOwner.delete(ownerId);
        this.world.emitToMap(actor.mapId, "follower:remove", { mapId: actor.mapId, ownerId });
    }

    /**
     * Per-node owner movement hook (from World.handlePlayerStep): records the
     * cell the owner vacated as the next breadcrumb for the follower to walk.
     */
    onOwnerStep(player: Player) {
        const actor = this.actorsByOwner.get(player.socketId);

        if (!actor || actor.mapId !== player.currentMapId) {
            return;
        }

        const cellSize = this.world.getMapCellSize(player.currentMapId);
        const ownerCell = player.getCurrentCell(cellSize);
        const last = actor.lastOwnerCell;

        if (!last) {
            actor.lastOwnerCell = ownerCell;
            return;
        }
        if (last.x === ownerCell.x && last.y === ownerCell.y) {
            return;
        }

        // The owner moved one cell: the cell they left is the follower's next
        // waypoint (skip it when the follower already stands there).
        actor.lastOwnerCell = ownerCell;

        const tail = actor.trail[actor.trail.length - 1];

        if (
            !(tail && tail.x === last.x && tail.y === last.y) &&
            !(actor.trail.length === 0 && !actor.moving && actor.cellX === last.x && actor.cellY === last.y)
        ) {
            actor.trail.push({ x: last.x, y: last.y });
        }
    }

    /** Owner teleported (portal, Fly, dive, admin): the follower jumps too. */
    onOwnerTeleport(player: Player) {
        const actor = this.actorsByOwner.get(player.socketId);

        if (!actor) {
            return;
        }

        const previousMapId = actor.mapId;
        this.placeBehindOwner(actor, player);

        if (previousMapId !== actor.mapId) {
            this.world.emitToMap(previousMapId, "follower:remove", {
                mapId: previousMapId,
                ownerId: actor.ownerId
            });
        }

        this.refreshVisibility(player);
        this.broadcastUpdate(actor);
    }

    /** Owner surf state changed (mount/dismount): show or hide the follower. */
    refreshVisibility(player: Player) {
        const actor = this.actorsByOwner.get(player.socketId);

        if (!actor) {
            return;
        }

        const hidden = player.isSurfing || isUnderwaterMap(player.currentMapId);

        if (actor.hidden === hidden) {
            return;
        }

        actor.hidden = hidden;

        // Re-appearing: materialize behind the owner, never at the stale spot
        // the follower was hidden at (possibly across the water).
        if (!hidden) {
            this.placeBehindOwner(actor, player);
        }

        this.broadcastUpdate(actor);
    }

    /**
     * Displaces the follower one cell — a player walking into it pushes it.
     * Returns false when the destination is not free.
     */
    shove(mapId: string, ownerId: string, dx: number, dy: number): boolean {
        const actor = this.actorsByOwner.get(ownerId);

        if (!actor || actor.mapId !== mapId || actor.hidden || actor.moving) {
            return false;
        }

        const now = Date.now();

        if (now < actor.shoveCooldownUntil) {
            return false;
        }

        const destX = actor.cellX + dx;
        const destY = actor.cellY + dy;

        if (!this.isCellFree(actor, destX, destY)) {
            return false;
        }

        // A shove derails the breadcrumb walk: drop the script and let the
        // snap-behind logic recover once the owner moves again.
        actor.trail = [];
        actor.shoveCooldownUntil = now + SHOVE_STEP_MS;
        this.beginStep(actor, destX, destY, SHOVE_STEP_MS, now);
        return true;
    }

    private tick() {
        const now = Date.now();
        const populatedMapIds = new Set<string>();

        this.world.players.forEach((player) => {
            populatedMapIds.add(player.currentMapId);
        });

        const stepsByMap = new Map<string, FollowerStep[]>();

        this.actorsByOwner.forEach((actor) => {
            if (!populatedMapIds.has(actor.mapId)) {
                return;
            }

            if (actor.moving) {
                if (now - actor.stepStartedAt < actor.stepMs) {
                    return;
                }
                actor.cellX = actor.toX;
                actor.cellY = actor.toY;
                actor.moving = false;
            }

            if (actor.hidden || actor.trail.length === 0) {
                return;
            }

            // Way behind (owner outran the trail): snap right behind the owner.
            if (actor.trail.length > MAX_TRAIL) {
                const target = actor.trail[actor.trail.length - 1];
                actor.trail = [];
                actor.cellX = target.x;
                actor.cellY = target.y;
                actor.toX = target.x;
                actor.toY = target.y;
                actor.moving = false;
                this.broadcastUpdate(actor);
                return;
            }

            const next = actor.trail[0];

            if (next.x === actor.cellX && next.y === actor.cellY) {
                actor.trail.shift();
                return;
            }

            // A shove knocked the follower off its script: breadcrumbs are only
            // walkable from adjacent cells, so from further away snap instead.
            if (Math.max(Math.abs(next.x - actor.cellX), Math.abs(next.y - actor.cellY)) > 1) {
                actor.trail.shift();
                actor.cellX = next.x;
                actor.cellY = next.y;
                actor.toX = next.x;
                actor.toY = next.y;
                actor.moving = false;
                this.broadcastUpdate(actor);
                return;
            }

            actor.trail.shift();

            const owner = this.world.players.get(actor.ownerId);
            const stepMs = Math.max(
                80,
                Math.round(OWNER_CELL_MS / Math.max(1, owner?.speedMultiplier ?? 1))
            );
            const step = this.beginStep(actor, next.x, next.y, stepMs, now, false);
            const bucket = stepsByMap.get(actor.mapId) ?? [];
            bucket.push(step);
            stepsByMap.set(actor.mapId, bucket);
        });

        stepsByMap.forEach((steps, mapId) => {
            this.world.emitToMap(mapId, "follower:steps", { mapId, t: now, steps });
        });

        populatedMapIds.forEach((mapId) => {
            const lastResync = this.lastResyncByMap.get(mapId) ?? 0;

            if (now - lastResync < RESYNC_INTERVAL_MS) {
                return;
            }
            this.lastResyncByMap.set(mapId, now);
            this.world.emitToMap(mapId, "follower:sync", {
                mapId,
                t: now,
                followers: this.snapshotForMap(mapId)
            });
        });
    }

    private ensureActor(player: Player, charset: string) {
        const existing = this.actorsByOwner.get(player.socketId);

        if (existing) {
            const charsetChanged = existing.charset !== charset;
            existing.charset = charset;

            if (existing.mapId !== player.currentMapId) {
                this.onOwnerTeleport(player);
            } else if (charsetChanged) {
                this.broadcastUpdate(existing);
            }
            this.refreshVisibility(player);
            return;
        }

        const actor: FollowerActor = {
            ownerId: player.socketId,
            mapId: player.currentMapId,
            charset,
            cellX: 0,
            cellY: 0,
            toX: 0,
            toY: 0,
            facing: facingForAngle(player.angle),
            moving: false,
            stepStartedAt: Date.now(),
            stepMs: OWNER_CELL_MS,
            hidden: player.isSurfing || isUnderwaterMap(player.currentMapId),
            trail: [],
            lastOwnerCell: null,
            shoveCooldownUntil: 0
        };

        this.placeBehindOwner(actor, player);
        this.actorsByOwner.set(player.socketId, actor);
        this.broadcastUpdate(actor);
    }

    /**
     * Parks the follower on the walkable cell behind the owner (falling back
     * to the owner's own cell) and aligns its state with the owner's map.
     */
    private placeBehindOwner(actor: FollowerActor, player: Player) {
        const cellSize = this.world.getMapCellSize(player.currentMapId);
        const ownerCell = player.getCurrentCell(cellSize);
        const facing = facingForAngle(player.angle);
        const behind = {
            x: ownerCell.x - (facing === FACE_RIGHT ? 1 : facing === FACE_LEFT ? -1 : 0),
            y: ownerCell.y - (facing === FACE_DOWN ? 1 : facing === FACE_UP ? -1 : 0)
        };

        const cell = this.world.isRectBlocked(
            player.currentMapId,
            behind.x * FOLLOWER_SIZE,
            behind.y * FOLLOWER_SIZE,
            FOLLOWER_SIZE,
            FOLLOWER_SIZE
        )
            ? ownerCell
            : behind;

        actor.mapId = player.currentMapId;
        actor.cellX = cell.x;
        actor.cellY = cell.y;
        actor.toX = cell.x;
        actor.toY = cell.y;
        actor.moving = false;
        actor.facing = facing;
        actor.trail = [];
        actor.lastOwnerCell = ownerCell;
    }

    private beginStep(
        actor: FollowerActor,
        toX: number,
        toY: number,
        stepMs: number,
        now = Date.now(),
        broadcast = true
    ): FollowerStep {
        const fromX = actor.cellX;
        const fromY = actor.cellY;

        actor.facing = facingForDelta(toX - fromX, toY - fromY, actor.facing);
        actor.toX = toX;
        actor.toY = toY;
        actor.moving = true;
        actor.stepStartedAt = now;
        actor.stepMs = stepMs;

        const step: FollowerStep = {
            ownerId: actor.ownerId,
            fromX,
            fromY,
            toX,
            toY,
            facing: actor.facing,
            stepMs
        };

        if (broadcast) {
            this.world.emitToMap(actor.mapId, "follower:steps", {
                mapId: actor.mapId,
                t: now,
                steps: [step]
            });
        }

        return step;
    }

    /** Static walkability + solid bodies, for shove destinations. */
    private isCellFree(actor: FollowerActor, cellX: number, cellY: number): boolean {
        const bounds = this.world.getMapBounds(actor.mapId);

        if (
            cellX < 0 ||
            cellY < 0 ||
            (cellX + 1) * FOLLOWER_SIZE > bounds.width ||
            (cellY + 1) * FOLLOWER_SIZE > bounds.height
        ) {
            return false;
        }

        const x = cellX * FOLLOWER_SIZE;
        const y = cellY * FOLLOWER_SIZE;

        if (this.world.isRectBlocked(actor.mapId, x, y, FOLLOWER_SIZE, FOLLOWER_SIZE)) {
            return false;
        }

        return !this.world.isCellOccupiedByBody(actor.mapId, cellX, cellY, {
            kind: "follower",
            id: actor.ownerId
        });
    }

    private broadcastUpdate(actor: FollowerActor) {
        this.world.emitToMap(actor.mapId, "follower:update", {
            mapId: actor.mapId,
            t: Date.now(),
            follower: this.snapshot(actor, Date.now())
        });
    }

    private snapshot(actor: FollowerActor, now: number): FollowerSnapshot {
        return {
            ownerId: actor.ownerId,
            charset: actor.charset,
            x: actor.cellX,
            y: actor.cellY,
            toX: actor.toX,
            toY: actor.toY,
            facing: actor.facing,
            stepMs: actor.stepMs,
            elapsedMs: actor.moving ? Math.max(0, Math.min(actor.stepMs, now - actor.stepStartedAt)) : 0,
            hidden: actor.hidden
        };
    }
}
