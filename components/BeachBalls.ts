// Transient beach balls, spawned by the /pelota (or /ball) chat command.
//
// A ball is a solid, pushable map entity: players (and push chains) roll it
// one cell at a time. After BALL_MAX_PUSHES displacements it deflates — the
// clients play the deflate strip of /objects/BeachBall.png — and disappears.
// Only one ball may exist per map: a second spawn arrives already deflating,
// unless the admin global setting `allowMultipleBeachBalls` bypasses the rule.
// Balls live in memory only; a server restart simply clears the beach.

import type World from "./world";

const BALL_SIZE = 32;
/** Displacements before the ball deflates. */
const BALL_MAX_PUSHES = 30;
/** Duration of one rolled cell — brisk, it's being kicked. */
const BALL_STEP_MS = 180;
/** Duration of a wall bounce (a 2-cell arc over the pusher's head). */
const BALL_BOUNCE_STEP_MS = 340;
/** How long clients get to play the deflate animation before removal. */
const DEFLATE_LINGER_MS = 2500;

export type BeachBallSnapshot = {
    id: string;
    mapId: string;
    x: number;
    y: number;
    toX: number;
    toY: number;
    stepMs: number;
    /** Milliseconds already elapsed of the roll in progress (0 when idle). */
    elapsedMs: number;
    pushesLeft: number;
    deflated: boolean;
};

type BeachBall = {
    id: string;
    mapId: string;
    cellX: number;
    cellY: number;
    toX: number;
    toY: number;
    moving: boolean;
    stepStartedAt: number;
    stepMs: number;
    pushesLeft: number;
    deflated: boolean;
};

export default class BeachBalls {
    private readonly ballsById = new Map<string, BeachBall>();
    private sequence = 0;

    constructor(private readonly world: World) {}

    /** Lands a finished roll (cell state trails the animation lazily). */
    private settle(ball: BeachBall) {
        if (ball.moving && Date.now() - ball.stepStartedAt >= ball.stepMs) {
            ball.cellX = ball.toX;
            ball.cellY = ball.toY;
            ball.moving = false;
        }
    }

    snapshotForMap(mapId: string): BeachBallSnapshot[] {
        const snapshots: BeachBallSnapshot[] = [];

        this.ballsById.forEach((ball) => {
            if (ball.mapId === mapId) {
                this.settle(ball);
                snapshots.push(this.snapshot(ball));
            }
        });

        return snapshots;
    }

    /** Solid ball boxes on a map (pixel space), for player collision. */
    blockersOnMap(mapId: string): Array<{ id: string; x: number; y: number }> {
        const blockers: Array<{ id: string; x: number; y: number }> = [];

        this.ballsById.forEach((ball) => {
            if (ball.mapId !== mapId || ball.deflated) {
                return;
            }
            this.settle(ball);
            blockers.push({ id: ball.id, x: this.pixelX(ball), y: this.pixelY(ball) });
        });

        return blockers;
    }

    /** The ball whose solid body overlaps `bounds`, or null. */
    findAt(mapId: string, bounds: { x: number; y: number; width: number; height: number }): BeachBall | null {
        for (const ball of Array.from(this.ballsById.values())) {
            if (ball.mapId !== mapId || ball.deflated) {
                continue;
            }
            this.settle(ball);
            const inset = 2;
            const ballBounds = {
                x: this.pixelX(ball) + inset,
                y: this.pixelY(ball) + inset,
                width: BALL_SIZE - inset * 2,
                height: BALL_SIZE - inset * 2
            };
            if (this.world.checkCollision(bounds, ballBounds)) {
                return ball;
            }
        }

        return null;
    }

    getBall(id: string): BeachBall | null {
        return this.ballsById.get(id) ?? null;
    }

    /** True when a live (non-deflated) ball already sits on the map. */
    hasLiveBall(mapId: string): boolean {
        for (const ball of Array.from(this.ballsById.values())) {
            if (ball.mapId === mapId && !ball.deflated) {
                return true;
            }
        }

        return false;
    }

    /**
     * Spawns a ball on the first free cell around `cell`. When the map already
     * has a live ball and multiples are not allowed, the new ball still spawns
     * — but immediately deflates, so the beach never fills up with balls.
     * Returns null only when no free cell exists around the spawner.
     */
    spawn(
        mapId: string,
        cell: { x: number; y: number },
        allowMultiple: boolean
    ): { ball: BeachBallSnapshot; deflatedOnArrival: boolean } | null {
        const spot = this.findFreeCellAround(mapId, cell);

        if (!spot) {
            return null;
        }

        const ball: BeachBall = {
            id: `ball-${Date.now()}-${(this.sequence += 1)}`,
            mapId,
            cellX: spot.x,
            cellY: spot.y,
            toX: spot.x,
            toY: spot.y,
            moving: false,
            stepStartedAt: 0,
            stepMs: BALL_STEP_MS,
            pushesLeft: BALL_MAX_PUSHES,
            deflated: false
        };

        const deflatedOnArrival = !allowMultiple && this.hasLiveBall(mapId);

        this.ballsById.set(ball.id, ball);
        this.world.emitToMap(mapId, "ball:spawn", { mapId, t: Date.now(), ball: this.snapshot(ball) });

        // Two balls on one map: the newcomer pops the moment it lands (also
        // covers two players racing the command — spawns are serialized, so
        // the second spawn always sees the first).
        if (deflatedOnArrival) {
            this.deflate(ball);
        }

        return { ball: this.snapshot(ball), deflatedOnArrival };
    }

    /**
     * Rolls the ball one cell — a player (or push chain) kicked it. Each roll
     * consumes one push; the last one deflates the ball on landing.
     */
    shove(mapId: string, id: string, dx: number, dy: number): boolean {
        const ball = this.ballsById.get(id);
        const now = Date.now();

        if (!ball || ball.mapId !== mapId || ball.deflated) {
            return false;
        }
        if (ball.moving && now - ball.stepStartedAt < ball.stepMs) {
            return false;
        }
        if (ball.moving) {
            // The previous roll finished but nothing observed it land yet.
            ball.cellX = ball.toX;
            ball.cellY = ball.toY;
            ball.moving = false;
        }

        const destX = ball.cellX + dx;
        const destY = ball.cellY + dy;

        if (!this.isCellFree(ball, destX, destY)) {
            // Kicked into a map edge, wall or corner: the ball bounces back
            // over the pusher instead of pinning against the geometry. A cell
            // blocked only by another BODY is not a bounce — the push chain
            // (World.shoveBody) owns that case and shoves the body along.
            if (this.isStaticallyBlocked(ball.mapId, destX, destY)) {
                return this.bounceBack(ball, dx, dy, now);
            }
            return false;
        }

        return this.roll(ball, destX, destY, BALL_STEP_MS, false, now);
    }

    /**
     * The bounce: the ball flies back past the pusher (who stands one cell
     * behind it), landing on the cell behind them — or a diagonal neighbor of
     * that cell when it is taken (typically by the pusher's own follower).
     */
    private bounceBack(ball: BeachBall, dx: number, dy: number, now: number): boolean {
        // Perpendicular axis, for the diagonal fallback landings.
        const px = dx === 0 ? 1 : 0;
        const py = dx === 0 ? 0 : 1;
        const candidates = [
            { x: ball.cellX - dx * 2, y: ball.cellY - dy * 2 },
            { x: ball.cellX - dx * 2 + px, y: ball.cellY - dy * 2 + py },
            { x: ball.cellX - dx * 2 - px, y: ball.cellY - dy * 2 - py }
        ];

        for (const cell of candidates) {
            if (this.isCellFree(ball, cell.x, cell.y)) {
                return this.roll(ball, cell.x, cell.y, BALL_BOUNCE_STEP_MS, true, now);
            }
        }

        return false;
    }

    /** Starts a roll (or bounce arc) and broadcasts it. Consumes one push. */
    private roll(
        ball: BeachBall,
        destX: number,
        destY: number,
        stepMs: number,
        bounced: boolean,
        now: number
    ): boolean {
        ball.toX = destX;
        ball.toY = destY;
        ball.moving = true;
        ball.stepStartedAt = now;
        ball.stepMs = stepMs;
        ball.pushesLeft = Math.max(0, ball.pushesLeft - 1);

        this.world.emitToMap(ball.mapId, "ball:step", {
            mapId: ball.mapId,
            t: now,
            id: ball.id,
            fromX: ball.cellX,
            fromY: ball.cellY,
            toX: destX,
            toY: destY,
            stepMs,
            pushesLeft: ball.pushesLeft,
            bounced
        });

        if (ball.pushesLeft === 0) {
            // Let the last roll play out before the pop.
            setTimeout(() => this.deflate(ball), stepMs);
        }

        return true;
    }

    /** Map bounds / collision-grid blockage only — bodies don't count. */
    private isStaticallyBlocked(mapId: string, cellX: number, cellY: number): boolean {
        const bounds = this.world.getMapBounds(mapId);

        if (
            cellX < 0 ||
            cellY < 0 ||
            (cellX + 1) * BALL_SIZE > bounds.width ||
            (cellY + 1) * BALL_SIZE > bounds.height
        ) {
            return true;
        }

        return this.world.isRectBlocked(mapId, cellX * BALL_SIZE, cellY * BALL_SIZE, BALL_SIZE, BALL_SIZE);
    }

    private deflate(ball: BeachBall) {
        if (ball.deflated) {
            return;
        }

        ball.deflated = true;
        this.world.emitToMap(ball.mapId, "ball:deflate", {
            mapId: ball.mapId,
            t: Date.now(),
            id: ball.id
        });

        setTimeout(() => {
            this.ballsById.delete(ball.id);
        }, DEFLATE_LINGER_MS);
    }

    /** Spawner's facing cell first, then its neighbors, then the cell itself. */
    private findFreeCellAround(mapId: string, cell: { x: number; y: number }): { x: number; y: number } | null {
        const candidates = [
            cell,
            { x: cell.x, y: cell.y + 1 },
            { x: cell.x, y: cell.y - 1 },
            { x: cell.x - 1, y: cell.y },
            { x: cell.x + 1, y: cell.y }
        ];

        for (const candidate of candidates) {
            if (this.isSpawnCellFree(mapId, candidate.x, candidate.y)) {
                return candidate;
            }
        }

        return null;
    }

    private isSpawnCellFree(mapId: string, cellX: number, cellY: number): boolean {
        const bounds = this.world.getMapBounds(mapId);

        if (
            cellX < 0 ||
            cellY < 0 ||
            (cellX + 1) * BALL_SIZE > bounds.width ||
            (cellY + 1) * BALL_SIZE > bounds.height
        ) {
            return false;
        }

        const x = cellX * BALL_SIZE;
        const y = cellY * BALL_SIZE;

        if (this.world.isRectBlocked(mapId, x, y, BALL_SIZE, BALL_SIZE)) {
            return false;
        }

        return !this.world.isCellOccupiedByBody(mapId, cellX, cellY, null);
    }

    private isCellFree(ball: BeachBall, cellX: number, cellY: number): boolean {
        const bounds = this.world.getMapBounds(ball.mapId);

        if (
            cellX < 0 ||
            cellY < 0 ||
            (cellX + 1) * BALL_SIZE > bounds.width ||
            (cellY + 1) * BALL_SIZE > bounds.height
        ) {
            return false;
        }

        const x = cellX * BALL_SIZE;
        const y = cellY * BALL_SIZE;

        if (this.world.isRectBlocked(ball.mapId, x, y, BALL_SIZE, BALL_SIZE)) {
            return false;
        }

        return !this.world.isCellOccupiedByBody(ball.mapId, cellX, cellY, {
            kind: "ball",
            id: ball.id
        });
    }

    private pixelX(ball: BeachBall): number {
        if (!ball.moving) {
            return ball.cellX * BALL_SIZE;
        }
        const progress = Math.max(0, Math.min(1, (Date.now() - ball.stepStartedAt) / ball.stepMs));
        return Math.round((ball.toX * progress + ball.cellX * (1 - progress)) * BALL_SIZE);
    }

    private pixelY(ball: BeachBall): number {
        if (!ball.moving) {
            return ball.cellY * BALL_SIZE;
        }
        const progress = Math.max(0, Math.min(1, (Date.now() - ball.stepStartedAt) / ball.stepMs));
        return Math.round((ball.toY * progress + ball.cellY * (1 - progress)) * BALL_SIZE);
    }

    private snapshot(ball: BeachBall): BeachBallSnapshot {
        const now = Date.now();

        return {
            id: ball.id,
            mapId: ball.mapId,
            x: ball.cellX,
            y: ball.cellY,
            toX: ball.toX,
            toY: ball.toY,
            stepMs: ball.stepMs,
            elapsedMs: ball.moving ? Math.max(0, Math.min(ball.stepMs, now - ball.stepStartedAt)) : 0,
            pushesLeft: ball.pushesLeft,
            deflated: ball.deflated
        };
    }
}
