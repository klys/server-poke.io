// Free-roaming party venomons inside house instances.
//
// A player standing in a house (Housing.ts) can let any of their party
// venomons out; each one becomes a roamer that wanders the room on its own
// (random one-cell steps, pausing between them). Roamers ride the FOLLOWER
// wire protocol (follower:sync / update / steps / remove) with a synthetic
// owner id — `roam:<characterId>:<pokemonId>` — so clients render them with
// the existing FollowerSprite and no contract change. They are soft: players
// walk through them (they are not collision bodies), but roamers themselves
// avoid walls, furniture, players and each other when choosing a step.
//
// The roster is per owner and per map: leaving the house (or logging out)
// removes the owner's roamers; entering re-materializes the ones enabled in
// the character's `house_roam_ids` list.

import type World from "./world";
import type Player from "./player";
import type { FollowerSnapshot, FollowerStep } from "./FollowerActors";
import { isHouseInstanceMapId } from "./Housing";

const TICK_MS = 100;
const STEP_MS = 320;
const MIN_PAUSE_MS = 500;
const MAX_PAUSE_MS = 2800;
const SIZE = 32;

const FACE_DOWN = 2;
const FACE_LEFT = 4;
const FACE_RIGHT = 6;
const FACE_UP = 8;
const DIRECTIONS = [
    { dx: 0, dy: 1, facing: FACE_DOWN },
    { dx: 0, dy: -1, facing: FACE_UP },
    { dx: -1, dy: 0, facing: FACE_LEFT },
    { dx: 1, dy: 0, facing: FACE_RIGHT }
];

type Roamer = {
    id: string;
    ownerId: string;
    mapId: string;
    charset: string;
    cellX: number;
    cellY: number;
    toX: number;
    toY: number;
    facing: number;
    moving: boolean;
    stepStartedAt: number;
    nextPlanAt: number;
};

/** Resolves which party venomons of a player roam: injected by the socket
 * layer (owns Auth and the species dex). */
export type RoamerResolver = (player: Player) => Promise<Array<{ pokemonId: string; charset: string }>>;

export function roamerOwnerId(characterId: number, pokemonId: string): string {
    return `roam:${characterId}:${pokemonId}`;
}

export default class HouseRoamerSimulation {
    private readonly roamers = new Map<string, Roamer>();
    private resolver: RoamerResolver | null = null;
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

    setResolver(resolver: RoamerResolver) {
        this.resolver = resolver;
    }

    /** Follower-shaped snapshots of the roamers on a map. */
    snapshotForMap(mapId: string): FollowerSnapshot[] {
        const now = Date.now();
        const out: FollowerSnapshot[] = [];
        this.roamers.forEach((roamer) => {
            if (roamer.mapId === mapId) out.push(this.snapshot(roamer, now));
        });
        return out;
    }

    /** Re-materializes the roamers of a player from their saved preference. */
    async refreshFor(player: Player) {
        if (!this.resolver || player.characterId === null || !isHouseInstanceMapId(player.currentMapId)) {
            const hadRoamers = Array.from(this.roamers.values()).some((roamer) => roamer.ownerId === player.socketId);
            this.removeFor(player.socketId);
            if (hadRoamers) this.world.followerSimulation?.refreshFor(player);
            return;
        }
        let wanted: Array<{ pokemonId: string; charset: string }> = [];
        try {
            wanted = await this.resolver(player);
        } catch (error) {
            console.error("[house-roamers] resolver failed", error);
        }
        // The player may have left the house while we awaited.
        if (!isHouseInstanceMapId(player.currentMapId)) {
            this.removeFor(player.socketId);
            return;
        }
        const keep = new Set<string>();
        for (const entry of wanted) {
            const id = roamerOwnerId(player.characterId, entry.pokemonId);
            keep.add(id);
            const existing = this.roamers.get(id);
            if (existing && existing.mapId === player.currentMapId) {
                if (existing.charset !== entry.charset) {
                    existing.charset = entry.charset;
                    this.broadcastUpdate(existing);
                }
                continue;
            }
            if (existing) this.remove(existing);
            this.spawn(id, player, entry.charset);
        }
        this.roamers.forEach((roamer) => {
            if (roamer.ownerId === player.socketId && !keep.has(roamer.id)) this.remove(roamer);
        });
        // The follower resolver hides the leader while it roams and brings it
        // back once it is called in (or the player leaves the house).
        this.world.followerSimulation?.refreshFor(player);
    }

    removeFor(ownerId: string) {
        this.roamers.forEach((roamer) => {
            if (roamer.ownerId === ownerId) this.remove(roamer);
        });
    }

    private spawn(id: string, player: Player, charset: string) {
        const cellSize = this.world.getMapCellSize(player.currentMapId);
        const origin = player.getCurrentCell(cellSize);
        const cell = this.findFreeCellNear(player.currentMapId, origin) ?? origin;
        const roamer: Roamer = {
            id,
            ownerId: player.socketId,
            mapId: player.currentMapId,
            charset,
            cellX: cell.x,
            cellY: cell.y,
            toX: cell.x,
            toY: cell.y,
            facing: FACE_DOWN,
            moving: false,
            stepStartedAt: Date.now(),
            nextPlanAt: Date.now() + MIN_PAUSE_MS + Math.random() * 800
        };
        this.roamers.set(id, roamer);
        this.broadcastUpdate(roamer);
    }

    private remove(roamer: Roamer) {
        this.roamers.delete(roamer.id);
        this.world.emitToMap(roamer.mapId, "follower:remove", { mapId: roamer.mapId, ownerId: roamer.id });
    }

    private findFreeCellNear(mapId: string, origin: { x: number; y: number }) {
        for (let radius = 1; radius <= 4; radius += 1) {
            const candidates: Array<{ x: number; y: number }> = [];
            for (let dx = -radius; dx <= radius; dx += 1) {
                for (let dy = -radius; dy <= radius; dy += 1) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                    candidates.push({ x: origin.x + dx, y: origin.y + dy });
                }
            }
            candidates.sort(() => Math.random() - 0.5);
            for (const cell of candidates) {
                if (this.isCellFree(mapId, cell.x, cell.y, null)) return cell;
            }
        }
        return null;
    }

    private isCellFree(mapId: string, cellX: number, cellY: number, self: Roamer | null): boolean {
        const bounds = this.world.getMapBounds(mapId);
        if (cellX < 0 || cellY < 0 || (cellX + 1) * SIZE > bounds.width || (cellY + 1) * SIZE > bounds.height) {
            return false;
        }
        if (this.world.isRectBlocked(mapId, cellX * SIZE, cellY * SIZE, SIZE, SIZE)) {
            return false;
        }
        // Players, NPCs, followers and beach balls on that cell.
        if (this.world.isCellOccupiedByBody(mapId, cellX, cellY, null)) {
            return false;
        }
        for (const other of Array.from(this.roamers.values())) {
            if (other === self || other.mapId !== mapId) continue;
            if ((other.cellX === cellX && other.cellY === cellY) || (other.toX === cellX && other.toY === cellY)) {
                return false;
            }
        }
        return true;
    }

    private tick() {
        const now = Date.now();
        const populated = new Set<string>();
        this.world.players.forEach((player) => populated.add(player.currentMapId));
        const stepsByMap = new Map<string, FollowerStep[]>();

        this.roamers.forEach((roamer) => {
            if (!populated.has(roamer.mapId)) return;
            if (roamer.moving) {
                if (now - roamer.stepStartedAt < STEP_MS) return;
                roamer.cellX = roamer.toX;
                roamer.cellY = roamer.toY;
                roamer.moving = false;
                roamer.nextPlanAt = now + MIN_PAUSE_MS + Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS);
                return;
            }
            if (now < roamer.nextPlanAt) return;
            const order = [...DIRECTIONS].sort(() => Math.random() - 0.5);
            for (const direction of order) {
                const toX = roamer.cellX + direction.dx;
                const toY = roamer.cellY + direction.dy;
                if (!this.isCellFree(roamer.mapId, toX, toY, roamer)) continue;
                roamer.facing = direction.facing;
                roamer.toX = toX;
                roamer.toY = toY;
                roamer.moving = true;
                roamer.stepStartedAt = now;
                const bucket = stepsByMap.get(roamer.mapId) ?? [];
                bucket.push({
                    ownerId: roamer.id,
                    fromX: roamer.cellX,
                    fromY: roamer.cellY,
                    toX,
                    toY,
                    facing: roamer.facing,
                    stepMs: STEP_MS
                });
                stepsByMap.set(roamer.mapId, bucket);
                return;
            }
            // Boxed in: face somewhere else and wait.
            roamer.facing = order[0].facing;
            roamer.nextPlanAt = now + MIN_PAUSE_MS;
        });

        stepsByMap.forEach((steps, mapId) => {
            this.world.emitToMap(mapId, "follower:steps", { mapId, t: now, steps });
        });
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
            stepMs: STEP_MS,
            elapsedMs: roamer.moving ? Math.max(0, Math.min(STEP_MS, now - roamer.stepStartedAt)) : 0,
            hidden: false
        };
    }
}
