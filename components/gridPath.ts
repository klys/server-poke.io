// Grid A* used by the NPC actor simulation to route around obstacles
// (walls, other NPCs and — the reason this exists — players standing in the
// way). Deliberately independent of the `pathfinding` package: that one wants
// a pre-baked static grid, while every query here has to see the CURRENT
// dynamic blockers, which change every tick.

export type GridCell = { x: number; y: number };

export type FindGridPathOptions = {
    /** Grid extents in cells. */
    width: number;
    height: number;
    /** Dynamic passability. Called at most `maxExpandedNodes * 4` times. */
    isBlocked: (x: number, y: number) => boolean;
    /**
     * Stop on a cell orthogonally adjacent to the goal instead of entering it.
     * Used by "approach" movers: the target is a player, and walking INTO a
     * player is exactly what we must never do.
     */
    stopAdjacentToGoal?: boolean;
    /**
     * Hard cap on expanded nodes. The tick runs every 50ms for every actor on
     * every populated map, so an unreachable goal must fail fast instead of
     * flood-filling a 200x200 map.
     */
    maxExpandedNodes?: number;
};

const DEFAULT_MAX_EXPANDED_NODES = 900;

// 4-way movement only: RPG Maker overworld characters never move diagonally.
const NEIGHBOUR_DELTAS = [
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 }
];

/**
 * Min-heap of (node, score) pairs. The score is copied into the entry rather
 * than read back from a map: a decrease-key pushes a second, better entry and
 * the stale one is discarded on pop via the closed set (lazy deletion).
 * Reading a shared, later-mutated score map here would silently break the
 * heap invariant and yield non-shortest paths.
 */
class ScoreHeap {
    private readonly entries: Array<{ key: number; score: number }> = [];

    get size() {
        return this.entries.length;
    }

    push(key: number, score: number) {
        this.entries.push({ key, score });
        let index = this.entries.length - 1;

        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (this.entries[parent].score <= this.entries[index].score) {
                break;
            }
            this.swap(parent, index);
            index = parent;
        }
    }

    pop(): number | undefined {
        if (this.entries.length === 0) {
            return undefined;
        }

        const top = this.entries[0].key;
        const last = this.entries.pop() as { key: number; score: number };

        if (this.entries.length > 0) {
            this.entries[0] = last;
            let index = 0;

            for (;;) {
                const left = index * 2 + 1;
                const right = left + 1;
                let smallest = index;

                if (left < this.entries.length && this.entries[left].score < this.entries[smallest].score) {
                    smallest = left;
                }
                if (right < this.entries.length && this.entries[right].score < this.entries[smallest].score) {
                    smallest = right;
                }
                if (smallest === index) {
                    break;
                }
                this.swap(smallest, index);
                index = smallest;
            }
        }

        return top;
    }

    private swap(first: number, second: number) {
        const held = this.entries[first];
        this.entries[first] = this.entries[second];
        this.entries[second] = held;
    }
}

/**
 * Shortest 4-way path from `start` to `goal`, honouring `isBlocked`.
 *
 * Returns the cells to walk THROUGH, excluding `start` and (when
 * `stopAdjacentToGoal`) excluding `goal`. `null` means unreachable within the
 * node budget — the caller is expected to wait and retry rather than force a
 * step, so a player parked in a doorway makes an NPC pause instead of
 * clipping through.
 */
export function findGridPath(
    start: GridCell,
    goal: GridCell,
    options: FindGridPathOptions
): GridCell[] | null {
    const { width, height, isBlocked, stopAdjacentToGoal = false } = options;
    const maxExpandedNodes = options.maxExpandedNodes ?? DEFAULT_MAX_EXPANDED_NODES;

    if (width <= 0 || height <= 0) {
        return null;
    }

    const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;

    if (!inBounds(start.x, start.y) || !inBounds(goal.x, goal.y)) {
        return null;
    }

    const goalKey = goal.y * width + goal.x;
    const startKey = start.y * width + start.x;
    const manhattan = (x: number, y: number) => Math.abs(x - goal.x) + Math.abs(y - goal.y);

    const isGoalReached = (x: number, y: number) =>
        stopAdjacentToGoal ? manhattan(x, y) === 1 : x === goal.x && y === goal.y;

    if (isGoalReached(start.x, start.y)) {
        return [];
    }
    // A goal we may not enter and cannot reach the edge of is hopeless up front.
    if (!stopAdjacentToGoal && isBlocked(goal.x, goal.y)) {
        return null;
    }

    const cameFrom = new Map<number, number>();
    const costSoFar = new Map<number, number>([[startKey, 0]]);
    const open = new ScoreHeap();
    const closed = new Set<number>();

    open.push(startKey, manhattan(start.x, start.y));

    let expanded = 0;

    while (open.size > 0) {
        const currentKey = open.pop() as number;

        if (closed.has(currentKey)) {
            continue;
        }
        closed.add(currentKey);

        const currentX = currentKey % width;
        const currentY = (currentKey - currentX) / width;

        if (isGoalReached(currentX, currentY)) {
            return reconstruct(cameFrom, currentKey, startKey, width);
        }

        expanded += 1;
        if (expanded > maxExpandedNodes) {
            return null;
        }

        const currentCost = costSoFar.get(currentKey) ?? 0;

        for (const delta of NEIGHBOUR_DELTAS) {
            const nextX = currentX + delta.dx;
            const nextY = currentY + delta.dy;

            if (!inBounds(nextX, nextY)) {
                continue;
            }

            const nextKey = nextY * width + nextX;

            if (closed.has(nextKey)) {
                continue;
            }
            if (stopAdjacentToGoal && nextKey === goalKey) {
                continue; // never path THROUGH the thing we are approaching
            }
            if (isBlocked(nextX, nextY)) {
                continue;
            }

            const nextCost = currentCost + 1;

            if (nextCost >= (costSoFar.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
                continue;
            }

            cameFrom.set(nextKey, currentKey);
            costSoFar.set(nextKey, nextCost);
            open.push(nextKey, nextCost + manhattan(nextX, nextY));
        }
    }

    return null;
}

function reconstruct(
    cameFrom: Map<number, number>,
    endKey: number,
    startKey: number,
    width: number
): GridCell[] {
    const cells: GridCell[] = [];
    let key: number | undefined = endKey;

    while (key !== undefined && key !== startKey) {
        const x = key % width;
        cells.push({ x, y: (key - x) / width });
        key = cameFrom.get(key);
    }

    return cells.reverse();
}
