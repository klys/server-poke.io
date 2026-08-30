/**
 * Unit-style test for the beach-ball wall bounce (no Redis, no server): a
 * synthetic 5x3-cell map (default world bounds, no collision grid) where the
 * map EDGES are the static geometry.
 *
 *   T1  push into open ground rolls one cell (no bounce)
 *   T2  push into the right map edge bounces the ball 2 cells back (over the pusher)
 *   T3  push into a corner (bottom edge) bounces back along the push axis
 *   T4  bounce lands on the diagonal fallback when the direct cell is taken
 *
 * Run:  cd server-poke.io && node_modules/.bin/ts-node tools/testBallBounce.ts
 */
import World from "../components/world";

const CELL = 32;
const MAP = "bounce-map";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const fail: (msg: string) => never = (msg) => {
    console.error(`ASSERTION FAILED: ${msg}`);
    process.exit(1);
};
const pass = (msg: string) => {
    passed += 1;
    console.log(`  ✓ ${msg}`);
};

async function main() {
    // 5x3 cells of open ground; beyond it, the map edge.
    const world = new World(5 * CELL, 3 * CELL);
    World.socketServer = {
        emit() {},
        to() {
            return { emit() {} };
        },
        in() {
            return { emit() {} };
        }
    };

    const events: Array<{ event: string; payload: any }> = [];
    world.emitToMap = ((_mapId: string, event: string, payload: unknown) => {
        events.push({ event, payload });
    }) as typeof world.emitToMap;

    const spawned = world.beachBalls.spawn(MAP, { x: 2, y: 1 }, true);
    if (!spawned || spawned.ball.x !== 2 || spawned.ball.y !== 1) {
        fail(`spawn expected at (2,1), got ${JSON.stringify(spawned?.ball)}`);
    }
    const id = spawned!.ball.id;
    const lastStep = () => events.filter((e) => e.event === "ball:step").pop()?.payload;

    // T1: open-ground roll.
    if (!world.beachBalls.shove(MAP, id, 1, 0)) fail("T1: shove refused");
    let step = lastStep();
    if (step.toX !== 3 || step.toY !== 1 || step.bounced) {
        fail(`T1: expected roll to (3,1), got ${JSON.stringify(step)}`);
    }
    pass("open-ground push rolls one cell, no bounce");
    await sleep(250);

    // Roll to the rightmost cell (4,1).
    if (!world.beachBalls.shove(MAP, id, 1, 0)) fail("setup: roll to (4,1) refused");
    await sleep(250);

    // T2: push into the right edge -> bounce back to (2,1), over the pusher at (3,1).
    if (!world.beachBalls.shove(MAP, id, 1, 0)) fail("T2: edge shove refused");
    step = lastStep();
    if (!step.bounced || step.toX !== 2 || step.toY !== 1) {
        fail(`T2: expected bounce to (2,1), got ${JSON.stringify(step)}`);
    }
    pass("right-edge push bounces the ball 2 cells back behind the pusher");
    await sleep(400);

    // Move to the bottom edge: (2,1) -> (2,2).
    if (!world.beachBalls.shove(MAP, id, 0, 1)) fail("setup: roll to (2,2) refused");
    await sleep(400);

    // T3: push down into the bottom edge (corner region) -> bounce to (2,0).
    if (!world.beachBalls.shove(MAP, id, 0, 1)) fail("T3: corner shove refused");
    step = lastStep();
    if (!step.bounced || step.toX !== 2 || step.toY !== 0) {
        fail(`T3: expected bounce to (2,0), got ${JSON.stringify(step)}`);
    }
    pass("bottom-edge push bounces back along the push axis");
    await sleep(400);

    // T4: diagonal fallback. Ball at (2,0); a second ball occupies the direct
    // bounce target of a downward... instead: push the ball LEFT to the left
    // edge, with a blocker ball on its direct bounce cell.
    if (!world.beachBalls.shove(MAP, id, -1, 0)) fail("setup: roll to (1,0) refused");
    await sleep(400);
    if (!world.beachBalls.shove(MAP, id, -1, 0)) fail("setup: roll to (0,0) refused");
    await sleep(400);
    // Direct bounce target of a leftward push from (0,0) is (2,0); occupy it.
    const blocker = world.beachBalls.spawn(MAP, { x: 2, y: 0 }, true);
    if (!blocker || blocker.ball.x !== 2 || blocker.ball.y !== 0) {
        fail(`T4: blocker expected at (2,0), got ${JSON.stringify(blocker?.ball)}`);
    }
    events.length = 0;
    if (!world.beachBalls.shove(MAP, id, -1, 0)) fail("T4: left-edge shove refused");
    step = lastStep();
    // (2,0) taken -> diagonal fallback (2,1) (perpendicular +1 on the y axis).
    if (!step.bounced || step.id !== id || step.toX !== 2 || step.toY !== 1) {
        fail(`T4: expected diagonal bounce to (2,1), got ${JSON.stringify(step)}`);
    }
    pass("bounce falls back to the diagonal cell when the direct one is taken");

    console.log(`\nALL ${passed} CHECKS PASSED ✔`);
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
