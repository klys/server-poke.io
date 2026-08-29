// House pets walking their rooms — the ACTOR half of the pet system.
//
// HousePets.ts owns what a pet IS (hunger, moods, eggs, alerts — persistent,
// evaluated whether or not anyone is home). This file owns what a pet DOES
// while somebody is in the room: it wanders on A* paths several cells long,
// walks up to other pets to chat, chases and kicks the beach ball, dances
// with its courtship partner, and is a solid, pushable body — players push
// pets, pets push pets (and the ball) when something blocks their way.
//
// Actors ride the FOLLOWER wire protocol (follower:sync / update / steps /
// remove) with owner id `roam:<characterId>:<petId>`, so clients render them
// with FollowerSprite; emotions go out as `pet:emote`. Actors only exist on
// populated house instances: when the last player leaves, the pet's cell is
// recorded on its state and the actor is dropped; it re-materializes there
// when someone comes back.

import type World from "./world";
import type { FollowerSnapshot, FollowerStep } from "./FollowerActors";
import type { HousePetState } from "./HousePets";
import { petOwnerId } from "./HousePets";
import { isHouseInstanceMapId } from "./Housing";
import { findGridPath, type GridCell } from "./gridPath";

const TICK_MS = 100;
const SIZE = 32;
const WALK_STEP_MS = 300;
const CHASE_STEP_MS = 220;
const SHOVE_STEP_MS = 180;
const MIN_PAUSE_MS = 500;
const MAX_PAUSE_MS = 3200;
const WANDER_MIN_RADIUS = 2;
const WANDER_MAX_RADIUS = 7;
const SOCIAL_RADIUS = 6;
const EMOTE_GAP_MS = 500;
const MAX_KICKS_PER_PLAY = 6;
const BLOCKED_STREAK_LIMIT = 3;

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

function shuffle<T>(items: T[]): T[] {
    // Fisher-Yates: the old `sort(() => Math.random() - 0.5)` was biased and
    // made every pet drift toward the bottom-right corner.
    for (let index = items.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1));
        [items[index], items[swap]] = [items[swap], items[index]];
    }
    return items;
}

type GoalKind = "wander" | "pet" | "ball" | "mate";

type Roamer = {
    /** Follower-channel owner id. */
    id: string;
    petId: string;
    mapId: string;
    charset: string;
    cellX: number;
    cellY: number;
    toX: number;
    toY: number;
    facing: number;
    moving: boolean;
    stepStartedAt: number;
    stepMs: number;
    nextPlanAt: number;
    path: GridCell[];
    goal: GridCell | null;
    goalKind: GoalKind;
    /** Pet id / ball id the goal follows. */
    goalTarget: string | null;
    blockedStreak: number;
    shoveCooldownUntil: number;
    lastEmoteAt: number;
    kicksLeft: number;
};

export default class HouseRoamerSimulation {
    private readonly roamers = new Map<string, Roamer>();
    private readonly byPet = new Map<string, Roamer>();
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly world: World) {}

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            try {
                this.tick();
            } catch (error) {
                console.error("[house-roamers] tick failed", error);
            }
        }, TICK_MS);
    }

    // ── Queries used by World (collision / push) and HousePets ────────────

    /** Lands a finished step right away (cell state trails the tick lazily). */
    private settle(roamer: Roamer, now = Date.now()) {
        if (roamer.moving && now - roamer.stepStartedAt >= roamer.stepMs) {
            roamer.cellX = roamer.toX;
            roamer.cellY = roamer.toY;
            roamer.moving = false;
            this.world.housePets.recordPosition(roamer.petId, roamer.cellX, roamer.cellY);
        }
    }

    /** Follower-shaped snapshots of the pets on a map. */
    snapshotForMap(mapId: string): FollowerSnapshot[] {
        const now = Date.now();
        const out: FollowerSnapshot[] = [];
        this.roamers.forEach((roamer) => {
            if (roamer.mapId === mapId) out.push(this.snapshot(roamer, now));
        });
        return out;
    }

    /** Solid pet boxes on a map (pixel space), for player collision. */
    blockersOnMap(mapId: string): Array<{ ownerId: string; x: number; y: number }> {
        const blockers: Array<{ ownerId: string; x: number; y: number }> = [];
        this.roamers.forEach((roamer) => {
            if (roamer.mapId !== mapId) return;
            this.settle(roamer);
            blockers.push({ ownerId: roamer.id, x: roamer.cellX * SIZE, y: roamer.cellY * SIZE });
        });
        return blockers;
    }

    /** The pet whose solid body overlaps `bounds`, or null. */
    findAt(mapId: string, bounds: { x: number; y: number; width: number; height: number }): { id: string; petId: string } | null {
        const inset = 2;
        for (const roamer of Array.from(this.roamers.values())) {
            if (roamer.mapId !== mapId) continue;
            this.settle(roamer);
            const box = { x: roamer.cellX * SIZE + inset, y: roamer.cellY * SIZE + inset, width: SIZE - inset * 2, height: SIZE - inset * 2 };
            if (this.world.checkCollision(bounds, box)) return { id: roamer.id, petId: roamer.petId };
        }
        return null;
    }

    /** Reserved cell of a pet by follower owner id (destination while moving). */
    cellOf(ownerId: string): { x: number; y: number } | null {
        const roamer = this.roamers.get(ownerId);
        if (!roamer) return null;
        return { x: roamer.moving ? roamer.toX : roamer.cellX, y: roamer.moving ? roamer.toY : roamer.cellY };
    }

    cellOfPet(petId: string): { x: number; y: number } | null {
        const roamer = this.byPet.get(petId);
        return roamer ? this.cellOf(roamer.id) : null;
    }

    /**
     * Displaces a pet one cell — a player (or another pet / a push chain)
     * bumped into it. Returns false when the destination is not free.
     */
    shove(mapId: string, ownerId: string, dx: number, dy: number): boolean {
        const roamer = this.roamers.get(ownerId);
        const now = Date.now();
        if (!roamer || roamer.mapId !== mapId) return false;
        this.settle(roamer, now);
        if (roamer.moving || now < roamer.shoveCooldownUntil) return false;
        const destX = roamer.cellX + dx;
        const destY = roamer.cellY + dy;
        if (!this.isCellFree(mapId, destX, destY, roamer)) return false;
        // Being pushed cancels whatever it was doing.
        roamer.path = [];
        roamer.goal = null;
        roamer.shoveCooldownUntil = now + SHOVE_STEP_MS;
        roamer.nextPlanAt = now + SHOVE_STEP_MS + 400;
        const step = this.beginStep(roamer, destX, destY, SHOVE_STEP_MS, now);
        // Keep facing the pusher (RMXP pushes don't turn the pushee around).
        step.facing = roamer.facing = facingForDelta(-dx, -dy, roamer.facing);
        this.world.emitToMap(mapId, "follower:steps", { mapId, t: now, steps: [step] });
        this.emoteRoamer(roamer, "💢", 1200, now);
        return true;
    }

    /** Emotion bubble over a pet (no-op when nobody watches its room). */
    emote(petId: string, emoji: string, ms = 2000) {
        const roamer = this.byPet.get(petId);
        if (roamer) this.emoteRoamer(roamer, emoji, ms, Date.now(), true);
    }

    /** A player patted the pet: it turns to look at them. */
    faceToward(petId: string, cell: { x: number; y: number }) {
        const roamer = this.byPet.get(petId);
        if (!roamer || roamer.moving) return;
        roamer.facing = facingForDelta(cell.x - roamer.cellX, cell.y - roamer.cellY, roamer.facing);
        roamer.path = [];
        roamer.goal = null;
        roamer.nextPlanAt = Date.now() + 2500;
        this.broadcastUpdate(roamer);
    }

    /** "Play" action: the pet goes for the ball right away. */
    sendToPlay(petId: string) {
        const roamer = this.byPet.get(petId);
        if (!roamer) return;
        roamer.kicksLeft = MAX_KICKS_PER_PLAY;
        roamer.path = [];
        roamer.goal = null;
        roamer.nextPlanAt = 0;
        this.planBall(roamer, Date.now(), true);
    }

    /** A pet was just left in a populated room: put its actor down now. */
    materialize(pet: HousePetState, mapId: string, cell: { x: number; y: number }) {
        if (this.byPet.has(pet.id)) return;
        this.spawn(pet, mapId, cell);
    }

    /** The pet left the house (taken back): drop its actor for everyone. */
    removePet(petId: string) {
        const roamer = this.byPet.get(petId);
        if (!roamer) return;
        this.roamers.delete(roamer.id);
        this.byPet.delete(petId);
        this.world.emitToMap(roamer.mapId, "follower:remove", { mapId: roamer.mapId, ownerId: roamer.id });
    }

    /** First free cell around `origin` (nearest ring first, random within a ring). */
    findFreeCellNear(mapId: string, origin: { x: number; y: number }): { x: number; y: number } | null {
        if (this.isCellFree(mapId, origin.x, origin.y, null)) return origin;
        for (let radius = 1; radius <= 4; radius += 1) {
            const candidates: Array<{ x: number; y: number }> = [];
            for (let dx = -radius; dx <= radius; dx += 1) {
                for (let dy = -radius; dy <= radius; dy += 1) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                    candidates.push({ x: origin.x + dx, y: origin.y + dy });
                }
            }
            for (const cell of shuffle(candidates)) {
                if (this.isCellFree(mapId, cell.x, cell.y, null)) return cell;
            }
        }
        return null;
    }

    // ── Internals ────────────────────────────────────────────────────────

    private spawn(pet: HousePetState, mapId: string, cell: { x: number; y: number }) {
        const now = Date.now();
        const roamer: Roamer = {
            id: petOwnerId(pet.ownerCharacterId, pet.id),
            petId: pet.id,
            mapId,
            charset: pet.charset,
            cellX: cell.x,
            cellY: cell.y,
            toX: cell.x,
            toY: cell.y,
            facing: FACE_DOWN,
            moving: false,
            stepStartedAt: now,
            stepMs: WALK_STEP_MS,
            nextPlanAt: now + MIN_PAUSE_MS + Math.random() * 1000,
            path: [],
            goal: null,
            goalKind: "wander",
            goalTarget: null,
            blockedStreak: 0,
            shoveCooldownUntil: 0,
            lastEmoteAt: 0,
            kicksLeft: 0
        };
        this.roamers.set(roamer.id, roamer);
        this.byPet.set(pet.id, roamer);
        this.world.housePets.recordPosition(pet.id, cell.x, cell.y);
        this.broadcastUpdate(roamer);
    }

    /** Actor dropped because the room emptied: remember where it stood. */
    private park(roamer: Roamer) {
        const cell = this.cellOf(roamer.id) ?? { x: roamer.cellX, y: roamer.cellY };
        this.world.housePets.recordPosition(roamer.petId, cell.x, cell.y);
        this.roamers.delete(roamer.id);
        this.byPet.delete(roamer.petId);
    }

    private isCellFree(mapId: string, cellX: number, cellY: number, self: Roamer | null): boolean {
        const bounds = this.world.getMapBounds(mapId);
        if (cellX < 0 || cellY < 0 || (cellX + 1) * SIZE > bounds.width || (cellY + 1) * SIZE > bounds.height) {
            return false;
        }
        if (this.world.isRectBlocked(mapId, cellX * SIZE, cellY * SIZE, SIZE, SIZE)) {
            return false;
        }
        // Players, NPCs, followers, other pets (they are follower snapshots) and balls.
        return !this.world.isCellOccupiedByBody(mapId, cellX, cellY, self ? { kind: "follower", id: self.id } : null);
    }

    /** The pet standing on / reserving a cell, other than `self`. */
    private roamerAt(mapId: string, x: number, y: number, self: Roamer): Roamer | null {
        for (const other of Array.from(this.roamers.values())) {
            if (other === self || other.mapId !== mapId) continue;
            if ((other.cellX === x && other.cellY === y) || (other.moving && other.toX === x && other.toY === y)) return other;
        }
        return null;
    }

    private tick() {
        const now = Date.now();
        const populated = new Set<string>();
        this.world.players.forEach((player) => {
            if (isHouseInstanceMapId(player.currentMapId)) populated.add(player.currentMapId);
        });

        // Rooms that emptied: park their actors. Rooms that got company:
        // materialize every pet that lives there.
        this.roamers.forEach((roamer) => {
            if (!populated.has(roamer.mapId)) this.park(roamer);
        });
        populated.forEach((mapId) => {
            for (const pet of this.world.housePets.petsOnMap(mapId)) {
                if (this.byPet.has(pet.id)) continue;
                const home = this.world.housePets.petHomeCell(pet, mapId);
                this.spawn(pet, mapId, this.findFreeCellNear(mapId, home) ?? home);
            }
        });

        const stepsByMap = new Map<string, FollowerStep[]>();
        const pushStep = (mapId: string, step: FollowerStep) => {
            const bucket = stepsByMap.get(mapId) ?? [];
            bucket.push(step);
            stepsByMap.set(mapId, bucket);
        };

        this.roamers.forEach((roamer) => {
            if (roamer.moving) {
                if (now - roamer.stepStartedAt < roamer.stepMs) return;
                this.settle(roamer, now);
                if (roamer.path.length === 0) {
                    this.onArrived(roamer, now);
                    return;
                }
            }
            if (now < roamer.nextPlanAt) return;

            if (roamer.path.length === 0) {
                if (!this.plan(roamer, now)) {
                    roamer.nextPlanAt = now + MIN_PAUSE_MS + Math.random() * 800;
                    return;
                }
                // The goal was already adjacent: acted on the spot, nothing to walk.
                if (roamer.path.length === 0) return;
            }

            const next = roamer.path[0];
            if (next.x === roamer.cellX && next.y === roamer.cellY) {
                roamer.path.shift();
                return;
            }
            if (Math.abs(next.x - roamer.cellX) + Math.abs(next.y - roamer.cellY) !== 1) {
                // Stale path (we were pushed): replan next tick.
                roamer.path = [];
                return;
            }
            if (!this.isCellFree(roamer.mapId, next.x, next.y, roamer)) {
                roamer.blockedStreak += 1;
                roamer.facing = facingForDelta(next.x - roamer.cellX, next.y - roamer.cellY, roamer.facing);
                // Another pet in the way? Shoulder it aside like players do.
                const blocker = this.roamerAt(roamer.mapId, next.x, next.y, roamer);
                if (blocker && Math.random() < 0.5) {
                    this.shove(roamer.mapId, blocker.id, next.x - roamer.cellX, next.y - roamer.cellY);
                }
                if (roamer.blockedStreak > BLOCKED_STREAK_LIMIT) {
                    roamer.path = [];
                    roamer.goal = null;
                    roamer.blockedStreak = 0;
                    roamer.nextPlanAt = now + MIN_PAUSE_MS;
                } else {
                    roamer.nextPlanAt = now + 250;
                }
                return;
            }
            roamer.blockedStreak = 0;
            roamer.path.shift();
            const stepMs = roamer.goalKind === "ball" || roamer.goalKind === "mate" ? CHASE_STEP_MS : WALK_STEP_MS;
            pushStep(roamer.mapId, this.beginStep(roamer, next.x, next.y, stepMs, now));
        });

        stepsByMap.forEach((steps, mapId) => {
            this.world.emitToMap(mapId, "follower:steps", { mapId, t: now, steps });
        });
    }

    /** Picks what to do next. Returns false when nothing was planned. */
    private plan(roamer: Roamer, now: number): boolean {
        const pet = this.world.housePets.getPet(roamer.petId);
        if (!pet) return false;

        // Courtship: walk to the partner — but keep living in between the
        // ❤️ moments (already side by side: sometimes wander off instead).
        if (this.world.housePets.isCourting(pet, now) && pet.courtingWith) {
            const partner = this.byPet.get(pet.courtingWith);
            if (partner && partner.mapId === roamer.mapId) {
                const adjacent = Math.abs(partner.cellX - roamer.cellX) + Math.abs(partner.cellY - roamer.cellY) <= 1;
                if (!adjacent || Math.random() < 0.4) {
                    if (this.setGoal(roamer, { x: partner.cellX, y: partner.cellY }, "mate", partner.petId, true)) return true;
                }
            }
        }

        const needs = this.world.housePets.needs(pet, now);
        const roll = Math.random();

        // The ball: irresistible when bored, tempting otherwise.
        if (roamer.kicksLeft > 0 || roll < (needs.boredom > 40 ? 0.45 : 0.2)) {
            if (this.planBall(roamer, now, roamer.kicksLeft > 0)) return true;
        }
        // Company: go say hi to a pet nearby.
        if (roll < 0.35) {
            const others = shuffle(
                Array.from(this.roamers.values()).filter(
                    (other) =>
                        other !== roamer &&
                        other.mapId === roamer.mapId &&
                        Math.abs(other.cellX - roamer.cellX) + Math.abs(other.cellY - roamer.cellY) <= SOCIAL_RADIUS
                )
            );
            for (const other of others) {
                if (this.setGoal(roamer, { x: other.cellX, y: other.cellY }, "pet", other.petId, true)) return true;
            }
        }
        return this.planWander(roamer);
    }

    private planBall(roamer: Roamer, now: number, force: boolean): boolean {
        const ball = this.world.beachBalls.snapshotForMap(roamer.mapId).find((candidate) => !candidate.deflated);
        if (!ball) {
            roamer.kicksLeft = 0;
            return false;
        }
        if (!force && roamer.kicksLeft <= 0) roamer.kicksLeft = MAX_KICKS_PER_PLAY;
        // Snapshots carry the destination cell of a roll in progress.
        const target = { x: ball.toX, y: ball.toY };
        void now;
        return this.setGoal(roamer, target, "ball", ball.id, true);
    }

    private planWander(roamer: Roamer): boolean {
        const offsets: GridCell[] = [];
        for (let dx = -WANDER_MAX_RADIUS; dx <= WANDER_MAX_RADIUS; dx += 1) {
            for (let dy = -WANDER_MAX_RADIUS; dy <= WANDER_MAX_RADIUS; dy += 1) {
                const distance = Math.abs(dx) + Math.abs(dy);
                if (distance < WANDER_MIN_RADIUS || distance > WANDER_MAX_RADIUS) continue;
                offsets.push({ x: dx, y: dy });
            }
        }
        shuffle(offsets);
        let attempts = 0;
        for (const offset of offsets) {
            if (attempts >= 10) break;
            const goal = { x: roamer.cellX + offset.x, y: roamer.cellY + offset.y };
            if (!this.isCellFree(roamer.mapId, goal.x, goal.y, roamer)) continue;
            attempts += 1;
            if (this.setGoal(roamer, goal, "wander", null, false)) return true;
        }
        // Boxed in: at least turn around.
        roamer.facing = shuffle([FACE_DOWN, FACE_LEFT, FACE_RIGHT, FACE_UP])[0];
        this.broadcastUpdate(roamer);
        return false;
    }

    private setGoal(roamer: Roamer, goal: GridCell, kind: GoalKind, target: string | null, stopAdjacent: boolean): boolean {
        const bounds = this.world.getMapBounds(roamer.mapId);
        const path = findGridPath({ x: roamer.cellX, y: roamer.cellY }, goal, {
            width: Math.max(1, Math.floor(bounds.width / SIZE)),
            height: Math.max(1, Math.floor(bounds.height / SIZE)),
            stopAdjacentToGoal: stopAdjacent,
            maxExpandedNodes: 600,
            isBlocked: (x, y) => !(stopAdjacent && x === goal.x && y === goal.y) && !this.isCellFree(roamer.mapId, x, y, roamer)
        });
        if (!path) return false;
        // Drop a leading node equal to where we stand.
        if (path.length > 0 && path[0].x === roamer.cellX && path[0].y === roamer.cellY) path.shift();
        if (path.length === 0) {
            if (!stopAdjacent) return false;
            // Already adjacent: act immediately.
            roamer.goal = goal;
            roamer.goalKind = kind;
            roamer.goalTarget = target;
            roamer.path = [];
            this.onArrived(roamer, Date.now());
            return true;
        }
        roamer.goal = goal;
        roamer.goalKind = kind;
        roamer.goalTarget = target;
        roamer.path = path;
        roamer.blockedStreak = 0;
        return true;
    }

    /** The path ran out: act on the goal, then rest. */
    private onArrived(roamer: Roamer, now: number) {
        const kind = roamer.goalKind;
        const target = roamer.goalTarget;
        roamer.goal = null;
        roamer.goalTarget = null;
        roamer.nextPlanAt = now + MIN_PAUSE_MS + Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS);

        if (kind === "ball" && target) {
            const ball = this.world.beachBalls.getBall(target);
            if (!ball || ball.deflated) {
                roamer.kicksLeft = 0;
                return;
            }
            const bx = ball.moving ? ball.toX : ball.cellX;
            const by = ball.moving ? ball.toY : ball.cellY;
            const dx = Math.sign(bx - roamer.cellX);
            const dy = Math.sign(by - roamer.cellY);
            if (Math.abs(bx - roamer.cellX) + Math.abs(by - roamer.cellY) !== 1) {
                roamer.nextPlanAt = now + 200; // it rolled away: chase again
                return;
            }
            roamer.facing = facingForDelta(dx, dy, roamer.facing);
            this.broadcastUpdate(roamer);
            if (this.world.beachBalls.shove(roamer.mapId, ball.id, dx, dy)) {
                roamer.kicksLeft = Math.max(0, roamer.kicksLeft - 1);
                this.world.housePets.notePlayed(roamer.petId);
                this.emoteRoamer(roamer, "⚽", 1500, now);
                roamer.nextPlanAt = now + 350 + Math.random() * 400;
            } else {
                roamer.kicksLeft = 0;
            }
            return;
        }
        if ((kind === "pet" || kind === "mate") && target) {
            const other = this.byPet.get(target);
            if (!other || other.mapId !== roamer.mapId) return;
            if (Math.abs(other.cellX - roamer.cellX) + Math.abs(other.cellY - roamer.cellY) > 1) {
                roamer.nextPlanAt = now + 300;
                return;
            }
            roamer.facing = facingForDelta(other.cellX - roamer.cellX, other.cellY - roamer.cellY, roamer.facing);
            this.broadcastUpdate(roamer);
            if (!other.moving) {
                other.facing = facingForDelta(roamer.cellX - other.cellX, roamer.cellY - other.cellY, other.facing);
                other.path = [];
                other.goal = null;
                other.nextPlanAt = now + 2500;
                this.broadcastUpdate(other);
            }
            const emoji = kind === "mate" ? "❤️" : "💬";
            this.emoteRoamer(roamer, emoji, 2500, now);
            this.emoteRoamer(other, emoji, 2500, now);
            this.world.housePets.noteSocialized(roamer.petId);
            this.world.housePets.noteSocialized(other.petId);
            roamer.nextPlanAt = now + 2500 + Math.random() * 1500;
        }
    }

    private beginStep(roamer: Roamer, toX: number, toY: number, stepMs: number, now: number): FollowerStep {
        const fromX = roamer.cellX;
        const fromY = roamer.cellY;
        roamer.facing = facingForDelta(toX - fromX, toY - fromY, roamer.facing);
        roamer.toX = toX;
        roamer.toY = toY;
        roamer.moving = true;
        roamer.stepStartedAt = now;
        roamer.stepMs = stepMs;
        return { ownerId: roamer.id, fromX, fromY, toX, toY, facing: roamer.facing, stepMs };
    }

    private emoteRoamer(roamer: Roamer, emoji: string, ms: number, now: number, force = false) {
        if (!force && now - roamer.lastEmoteAt < EMOTE_GAP_MS) return;
        roamer.lastEmoteAt = now;
        this.world.emitToMap(roamer.mapId, "pet:emote", { mapId: roamer.mapId, t: now, ownerId: roamer.id, emoji, ms });
    }

    private broadcastUpdate(roamer: Roamer) {
        this.world.emitToMap(roamer.mapId, "follower:update", {
            mapId: roamer.mapId,
            t: Date.now(),
            follower: this.snapshot(roamer, Date.now())
        });
    }

    private snapshot(roamer: Roamer, now: number): FollowerSnapshot {
        return {
            ownerId: roamer.id,
            charset: roamer.charset,
            x: roamer.cellX,
            y: roamer.cellY,
            toX: roamer.toX,
            toY: roamer.toY,
            facing: roamer.facing,
            stepMs: roamer.stepMs,
            elapsedMs: roamer.moving ? Math.max(0, Math.min(roamer.stepMs, now - roamer.stepStartedAt)) : 0,
            hidden: false
        };
    }
}
