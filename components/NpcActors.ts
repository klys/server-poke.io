// Server-authoritative movement for map NPCs (imported RPG Maker events).
//
// Before this existed, "moving" NPCs were a client-only illusion: NpcSprite
// replayed a seeded random walk from `performance.now()`, so every client saw
// the same NPC in a different place, the walk ignored collision entirely, and
// the server's hitbox stayed parked on the authored tile forever.
//
// Now the world owns one actor per moving NPC. It steps cell-to-cell on a
// tick, is collision-checked against walls, other NPCs and players, routes
// around obstructions with A* (`gridPath.ts`), and broadcasts its steps to the
// map. Clients only interpolate what they are told, so every player on a map
// sees the same NPC on the same tile.

import { findGridPath, type GridCell } from "./gridPath";
import type { EssentialsEventRecord } from "./eventPageSelection";
import type World from "./world";

/** NPC hitboxes are tile-sized; `getNpcBlockers` uses the same constant. */
const NPC_SIZE = 32;
const TICK_MS = 50;
/** How far a random mover may stray from its authored tile, in cells. */
const WANDER_RADIUS = 3;
/** RMXP move_type 2 ("approach") only chases players inside this radius. */
const APPROACH_RADIUS_CELLS = 10;
/** Consecutive failed plans before the actor gives up on its current goal. */
const MAX_BLOCKED_RETRIES = 6;
/** Pause before retrying after a blocked plan — long enough for a player to move on. */
const BLOCKED_RETRY_MS = 400;
/** Safety-net full resync per populated map, in case a step packet is missed. */
const RESYNC_INTERVAL_MS = 15000;
/** Duration of a shove step (a player pushing the NPC): brisk, not a walk. */
const SHOVE_STEP_MS = 180;
/** Lifetime of the cached per-map dynamic-obstacle snapshot. */
const CONTEXT_TTL_MS = 25;

// RPG Maker facing codes.
const FACE_DOWN = 2;
const FACE_LEFT = 4;
const FACE_RIGHT = 6;
const FACE_UP = 8;

// RPG Maker move-route directional codes -> cell delta.
const ROUTE_MOVE_DELTAS: Record<number, { dx: number; dy: number }> = {
    1: { dx: 0, dy: 1 }, // down
    2: { dx: -1, dy: 0 }, // left
    3: { dx: 1, dy: 0 }, // right
    4: { dx: 0, dy: -1 } // up
};

// RPG Maker move-route "turn" codes -> facing.
const ROUTE_TURN_FACINGS: Record<number, number> = {
    16: FACE_DOWN,
    17: FACE_LEFT,
    18: FACE_RIGHT,
    19: FACE_UP
};

type RouteCommand = { code: number; parameters?: unknown[] };

type ActorMovement = {
    type: number;
    speed: number;
    frequency: number;
    route: RouteCommand[] | null;
    routeRepeat: boolean;
    through: boolean;
    facing: number;
};

/** A cell the route wants the actor to reach (or, for turn commands, face). */
type RouteWaypoint = { x: number; y: number; turnOnly: boolean; facing: number };

type NpcActor = {
    id: string;
    mapId: string;
    /** Authored tile — the anchor a random mover wanders around. */
    homeX: number;
    homeY: number;
    /** Cell the actor occupies (the origin of the step in progress). */
    cellX: number;
    cellY: number;
    /** Cell being stepped into; equals cellX/cellY while standing still. */
    toX: number;
    toY: number;
    facing: number;
    moving: boolean;
    stepStartedAt: number;
    /** Duration of the step in progress — a shove is faster than a walk. */
    stepMs: number;
    /** The actor's own walking cadence, derived from RMXP move_speed. */
    walkStepMs: number;
    /** Earliest time the actor may start its next step. */
    readyAt: number;
    movement: ActorMovement;
    waypoints: RouteWaypoint[];
    waypointIndex: number;
    /** Remaining A* cells to the current goal. */
    path: GridCell[];
    goal: GridCell | null;
    blockedStreak: number;
};

/** One NPC step, as broadcast to every client on the map. */
type NpcActorStep = {
    id: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    facing: number;
    stepMs: number;
};

/** Full actor state, sent on map arrival so late joiners land in phase. */
type NpcActorSnapshot = {
    id: string;
    x: number;
    y: number;
    toX: number;
    toY: number;
    facing: number;
    stepMs: number;
    /** Milliseconds already elapsed of the step in progress (0 when idle). */
    elapsedMs: number;
};

function facingForDelta(dx: number, dy: number, fallback: number): number {
    if (dy > 0) return FACE_DOWN;
    if (dy < 0) return FACE_UP;
    if (dx < 0) return FACE_LEFT;
    if (dx > 0) return FACE_RIGHT;
    return fallback;
}

/**
 * Movement config for an NPC placement.
 *
 * RPG Maker resolves movement from whichever page is active, but pages are
 * selected per player here (switches are per-player state) and an actor has
 * exactly ONE position shared by everybody. So the actor takes its motion
 * from the first page that both shows a graphic and declares movement, and
 * page-conditional VISIBILITY stays per player exactly as before. Stationary
 * NPCs get no actor at all and keep their authored tile.
 */
function resolveMovement(record: EssentialsEventRecord | null): ActorMovement | null {
    if (!record?.pages?.length) {
        return null;
    }

    for (const page of record.pages) {
        const move = page.move;

        if (!page.graphic?.characterName || !move) {
            continue;
        }

        const type = typeof move.type === "number" ? move.type : 0;

        if (type !== 1 && type !== 2 && type !== 3) {
            continue;
        }

        const rawRoute = move.route;
        const list = Array.isArray(rawRoute?.list) ? (rawRoute?.list as RouteCommand[]) : null;

        // move_type 3 is "custom route"; without route data there is nothing to
        // walk, so the NPC stays put rather than inventing a path.
        if (type === 3 && (!list || list.length === 0)) {
            continue;
        }

        return {
            type,
            speed: typeof move.speed === "number" ? move.speed : 3,
            frequency: typeof move.frequency === "number" ? move.frequency : 3,
            route: list,
            routeRepeat: rawRoute?.repeat !== false,
            through: move.through === true,
            facing: typeof page.graphic.direction === "number" ? page.graphic.direction : FACE_DOWN
        };
    }

    return null;
}

/** Absolute cells a custom route visits, accumulated from the authored tile. */
function buildRouteWaypoints(movement: ActorMovement, homeX: number, homeY: number): RouteWaypoint[] {
    if (!movement.route) {
        return [];
    }

    const waypoints: RouteWaypoint[] = [];
    let x = homeX;
    let y = homeY;
    let facing = movement.facing;

    for (const command of movement.route) {
        const delta = ROUTE_MOVE_DELTAS[command.code];

        if (delta) {
            x += delta.dx;
            y += delta.dy;
            facing = facingForDelta(delta.dx, delta.dy, facing);
            waypoints.push({ x, y, turnOnly: false, facing });
            continue;
        }

        const turnFacing = ROUTE_TURN_FACINGS[command.code];

        if (turnFacing !== undefined) {
            facing = turnFacing;
            waypoints.push({ x, y, turnOnly: true, facing });
        }
        // Waits, speed/anim toggles and script commands don't move the actor.
    }

    return waypoints;
}

/** Cached dynamic obstacles for one map; see `contextFor`. */
type MapObstacleContext = {
    at: number;
    width: number;
    height: number;
    playerBoxes: Array<{ x: number; y: number; width: number; height: number }>;
    /** Cell keys (y * width + x) held by NPCs that never move. */
    staticNpcCells: Set<number>;
};

export default class NpcActorSimulation {
    private readonly actorsByMap = new Map<string, Map<string, NpcActor>>();
    /** Snapshot the current actors were built from; a swap rebuilds them. */
    private builtFrom: object | null = null;
    private readonly lastResyncByMap = new Map<string, number>();
    private readonly contextByMap = new Map<string, MapObstacleContext>();
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
                console.error("[npc-actors] tick failed", error);
            }
        }, TICK_MS);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Drops every actor so the next tick rebuilds from the new map payload. */
    reset() {
        this.actorsByMap.clear();
        this.lastResyncByMap.clear();
        this.contextByMap.clear();
        this.builtFrom = null;
    }

    hasActors(mapId: string): boolean {
        const actors = this.actorsForMap(mapId);
        return actors !== null && actors.size > 0;
    }

    /** Live pixel position + facing of an NPC, or null when it has no actor. */
    liveStateOf(mapId: string, npcId: string): { x: number; y: number; facing: number } | null {
        const actor = this.actorsForMap(mapId)?.get(npcId);

        if (!actor) {
            return null;
        }

        const position = this.pixelPosition(actor, Date.now());

        return { x: position.x, y: position.y, facing: actor.facing };
    }

    /** Live cell of an NPC (the cell it is closest to), or null. */
    cellOf(mapId: string, npcId: string): GridCell | null {
        const actor = this.actorsForMap(mapId)?.get(npcId);

        if (!actor) {
            return null;
        }

        const position = this.pixelPosition(actor, Date.now());

        return {
            x: Math.round(position.x / NPC_SIZE),
            y: Math.round(position.y / NPC_SIZE)
        };
    }

    snapshotForMap(mapId: string): NpcActorSnapshot[] {
        const actors = this.actorsForMap(mapId);

        if (!actors) {
            return [];
        }

        const now = Date.now();

        return Array.from(actors.values()).map((actor) => ({
            id: actor.id,
            x: actor.cellX,
            y: actor.cellY,
            toX: actor.toX,
            toY: actor.toY,
            facing: actor.facing,
            stepMs: actor.stepMs,
            elapsedMs: actor.moving ? Math.max(0, Math.min(actor.stepMs, now - actor.stepStartedAt)) : 0
        }));
    }

    /**
     * Displaces an NPC one cell — a player walking into it pushes it along.
     * Returns false when the destination is not free, which leaves the NPC
     * solid and the player blocked.
     */
    shove(mapId: string, npcId: string, dx: number, dy: number): boolean {
        const actor = this.actorsForMap(mapId)?.get(npcId);

        if (!actor || actor.moving) {
            return false;
        }

        const destX = actor.cellX + dx;
        const destY = actor.cellY + dy;

        if (!this.isCellFreeForActor(actor, destX, destY)) {
            return false;
        }

        // A shove overrides the current plan: the actor re-routes from wherever
        // it lands rather than trying to resume a path that no longer starts
        // at its position.
        actor.path = [];
        actor.goal = null;
        actor.blockedStreak = 0;
        this.beginStep(actor, destX, destY, SHOVE_STEP_MS, true);
        return true;
    }

    private tick() {
        this.rebuildIfSnapshotChanged();

        const now = Date.now();
        const populatedMapIds = new Set<string>();

        this.world.players.forEach((player) => {
            populatedMapIds.add(player.currentMapId);
        });

        populatedMapIds.forEach((mapId) => {
            const actors = this.actorsForMap(mapId);

            if (!actors || actors.size === 0) {
                return;
            }

            const steps: NpcActorStep[] = [];

            actors.forEach((actor) => {
                const step = this.advance(actor, now);

                if (step) {
                    steps.push(step);
                }
            });

            if (steps.length > 0) {
                this.world.emitToMap(mapId, "npc:steps", { mapId, t: now, steps });
            }

            const lastResync = this.lastResyncByMap.get(mapId) ?? 0;

            if (now - lastResync >= RESYNC_INTERVAL_MS) {
                this.lastResyncByMap.set(mapId, now);
                this.world.emitToMap(mapId, "npc:sync", {
                    mapId,
                    t: now,
                    npcs: this.snapshotForMap(mapId)
                });
            }
        });
    }

    /** Runs one actor forward; returns a step to broadcast when one starts. */
    private advance(actor: NpcActor, now: number): NpcActorStep | null {
        if (actor.moving) {
            if (now - actor.stepStartedAt < actor.stepMs) {
                return null;
            }
            // Landed.
            actor.cellX = actor.toX;
            actor.cellY = actor.toY;
            actor.moving = false;
            actor.readyAt = now + this.pauseMsFor(actor);
            return null;
        }

        if (now < actor.readyAt) {
            return null;
        }

        if (actor.path.length === 0 && !this.plan(actor)) {
            actor.readyAt = now + BLOCKED_RETRY_MS;
            return null;
        }

        const next = actor.path[0];

        if (!next) {
            actor.readyAt = now + BLOCKED_RETRY_MS;
            return null;
        }

        if (!this.isCellFreeForActor(actor, next.x, next.y)) {
            // Something moved into our lane (almost always a player). Turn to
            // face it, then try to route around it instead of shoving through.
            actor.facing = facingForDelta(next.x - actor.cellX, next.y - actor.cellY, actor.facing);
            actor.path = [];

            if (!this.replanToGoal(actor)) {
                actor.blockedStreak += 1;

                if (actor.blockedStreak >= MAX_BLOCKED_RETRIES) {
                    this.abandonGoal(actor);
                }
                actor.readyAt = now + BLOCKED_RETRY_MS;
                return null;
            }

            return this.startPlannedStep(actor, now);
        }

        return this.startPlannedStep(actor, now);
    }

    private startPlannedStep(actor: NpcActor, now: number): NpcActorStep | null {
        const next = actor.path[0];

        if (!next) {
            return null;
        }

        actor.path.shift();
        actor.blockedStreak = 0;

        // walkStepMs, not stepMs: stepMs holds the CURRENT step's duration and
        // a shove overwrites it, so reading it back would make every step after
        // a push permanently run at shove speed.
        const step = this.beginStep(actor, next.x, next.y, actor.walkStepMs, false, now);

        // Arriving at the goal retires it, so the next plan picks a fresh one.
        if (actor.goal && next.x === actor.goal.x && next.y === actor.goal.y) {
            this.onGoalReached(actor);
        }

        return step;
    }

    private beginStep(
        actor: NpcActor,
        toX: number,
        toY: number,
        stepMs: number,
        broadcast: boolean,
        now = Date.now()
    ): NpcActorStep {
        const fromX = actor.cellX;
        const fromY = actor.cellY;

        actor.facing = facingForDelta(toX - fromX, toY - fromY, actor.facing);
        actor.toX = toX;
        actor.toY = toY;
        actor.moving = true;
        actor.stepStartedAt = now;
        actor.stepMs = stepMs;

        const step: NpcActorStep = {
            id: actor.id,
            fromX,
            fromY,
            toX,
            toY,
            facing: actor.facing,
            stepMs
        };

        if (broadcast) {
            this.world.emitToMap(actor.mapId, "npc:steps", {
                mapId: actor.mapId,
                t: now,
                steps: [step]
            });
        }

        return step;
    }

    /** Chooses a goal and A*s to it. Returns false when nothing is walkable. */
    private plan(actor: NpcActor): boolean {
        if (actor.movement.type === 3) {
            return this.planRoute(actor);
        }

        if (actor.movement.type === 2 && this.planApproach(actor)) {
            return true;
        }

        return this.planWander(actor);
    }

    private planRoute(actor: NpcActor): boolean {
        if (actor.waypoints.length === 0) {
            return false;
        }

        for (let attempt = 0; attempt < actor.waypoints.length; attempt += 1) {
            const waypoint = actor.waypoints[actor.waypointIndex];

            if (waypoint.turnOnly || (waypoint.x === actor.cellX && waypoint.y === actor.cellY)) {
                // Turn in place and move on to the next waypoint immediately.
                if (actor.facing !== waypoint.facing) {
                    actor.facing = waypoint.facing;
                    this.world.emitToMap(actor.mapId, "npc:turn", {
                        mapId: actor.mapId,
                        id: actor.id,
                        facing: actor.facing,
                        t: Date.now()
                    });
                }
                if (!this.advanceWaypointIndex(actor)) {
                    return false;
                }
                continue;
            }

            actor.goal = { x: waypoint.x, y: waypoint.y };

            if (this.replanToGoal(actor)) {
                return true;
            }

            actor.blockedStreak += 1;

            if (actor.blockedStreak < MAX_BLOCKED_RETRIES) {
                return false; // wait for the obstruction to clear
            }
            // Give up on this waypoint and try the next one, so a permanently
            // blocked route can't freeze the NPC forever.
            actor.blockedStreak = 0;

            if (!this.advanceWaypointIndex(actor)) {
                return false;
            }
        }

        return false;
    }

    /** Returns false when a non-repeating route has run out of waypoints. */
    private advanceWaypointIndex(actor: NpcActor): boolean {
        const next = actor.waypointIndex + 1;

        if (next < actor.waypoints.length) {
            actor.waypointIndex = next;
            return true;
        }

        if (!actor.movement.routeRepeat) {
            actor.waypoints = [];
            return false;
        }

        actor.waypointIndex = 0;
        return true;
    }

    private planApproach(actor: NpcActor): boolean {
        let closest: { x: number; y: number; distance: number } | null = null;

        this.world.players.forEach((player) => {
            if (player.currentMapId !== actor.mapId) {
                return;
            }

            const cellX = Math.floor((player.x + player.width / 2) / NPC_SIZE);
            const cellY = Math.floor((player.y + player.height / 2) / NPC_SIZE);
            const distance = Math.abs(cellX - actor.cellX) + Math.abs(cellY - actor.cellY);

            if (distance > APPROACH_RADIUS_CELLS || distance === 0) {
                return;
            }
            if (!closest || distance < closest.distance) {
                closest = { x: cellX, y: cellY, distance };
            }
        });

        if (!closest) {
            return false;
        }

        const target = closest as { x: number; y: number; distance: number };
        actor.goal = { x: target.x, y: target.y };

        const path = this.findPath(actor, actor.goal, true);

        if (!path || path.length === 0) {
            actor.goal = null;
            return false;
        }

        actor.path = path;
        return true;
    }

    private planWander(actor: NpcActor): boolean {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const goalX = actor.homeX + Math.floor(Math.random() * (WANDER_RADIUS * 2 + 1)) - WANDER_RADIUS;
            const goalY = actor.homeY + Math.floor(Math.random() * (WANDER_RADIUS * 2 + 1)) - WANDER_RADIUS;

            if (goalX === actor.cellX && goalY === actor.cellY) {
                continue;
            }
            if (!this.isCellFreeForActor(actor, goalX, goalY)) {
                continue;
            }

            const goal = { x: goalX, y: goalY };
            const path = this.findPath(actor, goal, false);

            if (path && path.length > 0) {
                actor.goal = goal;
                actor.path = path;
                return true;
            }
        }

        return false;
    }

    private replanToGoal(actor: NpcActor): boolean {
        if (!actor.goal) {
            return false;
        }

        const path = this.findPath(actor, actor.goal, actor.movement.type === 2);

        if (!path || path.length === 0) {
            return false;
        }

        actor.path = path;
        return true;
    }

    private onGoalReached(actor: NpcActor) {
        actor.goal = null;
        actor.path = [];
        actor.blockedStreak = 0;

        if (actor.movement.type === 3 && actor.waypoints.length > 0) {
            this.advanceWaypointIndex(actor);
        }
    }

    private abandonGoal(actor: NpcActor) {
        actor.blockedStreak = 0;
        actor.goal = null;
        actor.path = [];

        if (actor.movement.type === 3 && actor.waypoints.length > 0) {
            this.advanceWaypointIndex(actor);
        }
    }

    private findPath(actor: NpcActor, goal: GridCell, stopAdjacentToGoal: boolean): GridCell[] | null {
        // One context for the whole search: obstacles must not shift between
        // node expansions or A* can return a path it already invalidated.
        const context = this.contextFor(actor.mapId, Date.now());

        return findGridPath({ x: actor.cellX, y: actor.cellY }, goal, {
            width: context.width,
            height: context.height,
            stopAdjacentToGoal,
            isBlocked: (x, y) => !this.isCellFreeForActor(actor, x, y, context)
        });
    }

    /**
     * Per-map dynamic-obstacle snapshot, rebuilt at most every
     * CONTEXT_TTL_MS. A single A* query expands up to ~900 nodes, so testing
     * each one against every player and every NPC placement in turn would be
     * tens of thousands of comparisons per plan; this collapses all of it to
     * set lookups plus a handful of player boxes.
     */
    private contextFor(mapId: string, now: number): MapObstacleContext {
        const cached = this.contextByMap.get(mapId);

        if (cached && now - cached.at < CONTEXT_TTL_MS) {
            return cached;
        }

        const bounds = this.world.getMapBounds(mapId);
        const width = Math.max(1, Math.floor(bounds.width / NPC_SIZE));
        const height = Math.max(1, Math.floor(bounds.height / NPC_SIZE));
        const actors = this.actorsByMap.get(mapId);

        const playerBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];

        this.world.players.forEach((player) => {
            if (player.currentMapId !== mapId) {
                return;
            }
            playerBoxes.push({
                x: player.x,
                y: player.y,
                width: player.width,
                height: player.height
            });
        });

        // Stationary NPCs only: the ones with actors are tested from their live
        // positions instead, so including them here would block their own path.
        const staticNpcCells = new Set<number>();

        for (const blocker of this.world.npcBlockersOnMap(mapId)) {
            if (actors?.has(blocker.id)) {
                continue;
            }
            staticNpcCells.add(Math.round(blocker.y / NPC_SIZE) * width + Math.round(blocker.x / NPC_SIZE));
        }

        const context: MapObstacleContext = { at: now, width, height, playerBoxes, staticNpcCells };
        this.contextByMap.set(mapId, context);
        return context;
    }

    /**
     * Passability for an NPC step: static map collision plus every dynamic
     * body — players, other actors and stationary NPCs. Players block: the
     * whole point is that an NPC never walks through one.
     */
    private isCellFreeForActor(
        actor: NpcActor,
        cellX: number,
        cellY: number,
        context = this.contextFor(actor.mapId, Date.now())
    ): boolean {
        if (cellX < 0 || cellY < 0 || cellX >= context.width || cellY >= context.height) {
            return false;
        }

        const x = cellX * NPC_SIZE;
        const y = cellY * NPC_SIZE;

        // `through` events ignore terrain in RPG Maker, but never other bodies
        // here — a ghost NPC drifting through a player would be worse than the
        // static sprite it replaces.
        if (!actor.movement.through && this.world.isRectBlocked(actor.mapId, x, y, NPC_SIZE, NPC_SIZE)) {
            return false;
        }

        if (context.staticNpcCells.has(cellY * context.width + cellX)) {
            return false;
        }

        const inset = 2;
        const bodyBounds = {
            x: x + inset,
            y: y + inset,
            width: NPC_SIZE - inset * 2,
            height: NPC_SIZE - inset * 2
        };

        for (const box of context.playerBoxes) {
            const playerBounds = {
                x: box.x + inset,
                y: box.y + inset,
                width: box.width - inset * 2,
                height: box.height - inset * 2
            };

            if (this.world.checkCollision(bodyBounds, playerBounds)) {
                return false;
            }
        }

        // Read the built map directly: this runs inside the tick loop, and
        // going through actorsForMap could rebuild (and invalidate) the very
        // collection the caller is iterating.
        const actors = this.actorsByMap.get(actor.mapId);

        if (actors) {
            for (const other of Array.from(actors.values())) {
                if (other.id === actor.id) {
                    continue;
                }
                // Reserve both the cell an actor stands on and the one it is
                // stepping into, so two NPCs can't converge on the same tile.
                if (
                    (other.cellX === cellX && other.cellY === cellY) ||
                    (other.toX === cellX && other.toY === cellY)
                ) {
                    return false;
                }
            }
        }

        return true;
    }

    private pixelPosition(actor: NpcActor, now: number): { x: number; y: number } {
        if (!actor.moving || actor.stepMs <= 0) {
            return { x: actor.cellX * NPC_SIZE, y: actor.cellY * NPC_SIZE };
        }

        const progress = Math.max(0, Math.min(1, (now - actor.stepStartedAt) / actor.stepMs));

        return {
            x: (actor.cellX + (actor.toX - actor.cellX) * progress) * NPC_SIZE,
            y: (actor.cellY + (actor.toY - actor.cellY) * progress) * NPC_SIZE
        };
    }

    private pauseMsFor(actor: NpcActor): number {
        // Mirrors the cadence the client-side animation used to render, so the
        // world doesn't visibly change pace with this switch-over.
        const base = Math.max(0, (5 - actor.movement.frequency) * 120);
        return base + (actor.movement.type === 3 ? 0 : 420);
    }

    private stepMsFor(movement: ActorMovement): number {
        return Math.max(140, Math.min(900, Math.round(900 / Math.max(1, movement.speed))));
    }

    private actorsForMap(mapId: string): Map<string, NpcActor> | null {
        this.rebuildIfSnapshotChanged();
        return this.actorsByMap.get(mapId) ?? this.buildMap(mapId);
    }

    private rebuildIfSnapshotChanged() {
        const state = this.world.playableMapsState;

        if (state !== this.builtFrom) {
            this.actorsByMap.clear();
            this.lastResyncByMap.clear();
            this.contextByMap.clear();
            this.builtFrom = state;
        }
    }

    private buildMap(mapId: string): Map<string, NpcActor> | null {
        const state = this.world.playableMapsState;

        if (!state) {
            return null;
        }

        const actors = new Map<string, NpcActor>();
        const npcs = state.editorDataByMapId[mapId]?.npcs ?? [];
        const now = Date.now();

        for (const npc of npcs) {
            const placement = npc as typeof npc & { essentialsEvent?: EssentialsEventRecord };

            if (typeof placement.x !== "number" || typeof placement.y !== "number") {
                continue;
            }

            const movement = resolveMovement(placement.essentialsEvent ?? null);

            if (!movement) {
                continue;
            }

            const actor: NpcActor = {
                id: placement.id,
                mapId,
                homeX: placement.x,
                homeY: placement.y,
                cellX: placement.x,
                cellY: placement.y,
                toX: placement.x,
                toY: placement.y,
                facing: movement.facing,
                moving: false,
                stepStartedAt: now,
                stepMs: this.stepMsFor(movement),
                walkStepMs: this.stepMsFor(movement),
                // Stagger the first step so a map full of NPCs doesn't march in
                // lockstep the moment the first player walks in.
                readyAt: now + Math.floor(Math.random() * 900),
                movement,
                waypoints: buildRouteWaypoints(movement, placement.x, placement.y),
                waypointIndex: 0,
                path: [],
                goal: null,
                blockedStreak: 0
            };

            actors.set(actor.id, actor);
        }

        this.actorsByMap.set(mapId, actors);
        return actors;
    }
}
