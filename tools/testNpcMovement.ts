/**
 * Behavioural harness for the NPC actor simulation + shove mechanic.
 * Runs the real World / Player / NpcActorSimulation against a synthetic map.
 */
import World from "../components/world";
import Player from "../components/player";
import { COLLISION_SOLID_MASK } from "../components/TileMapGrid";

const CELL = 32;
const MAP_W = 20;
const MAP_H = 20;
const MAP_ID = "testmap";

let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}`, extra ?? "");
  } else {
    console.log(`ok   ${name}`);
  }
};

const emitted: Array<{ event: string; payload: any }> = [];
(World as any).socketServer = {
  to: () => ({ emit: (event: string, payload: any) => emitted.push({ event, payload }) }),
  in: () => ({ emit: (event: string, payload: any) => emitted.push({ event, payload }) }),
  emit: (event: string, payload: any) => emitted.push({ event, payload })
};

function makeEvent(id: number, moveType: number, opts: { speed?: number; route?: any } = {}) {
  return {
    eventId: id,
    essentialsMapId: 1,
    pages: [
      {
        conditions: {},
        graphic: { characterName: "walker", direction: 2, pattern: 0 },
        trigger: 0,
        commands: [],
        move: {
          type: moveType,
          speed: opts.speed ?? 4,
          frequency: 5,
          route: opts.route ?? null,
          through: false,
          walkAnime: true
        }
      }
    ]
  };
}

function buildWorld(npcs: any[], solidCells: Array<{ x: number; y: number }> = []) {
  const world = new World(MAP_W * CELL, MAP_H * CELL);
  const cells = new Uint8Array(MAP_W * MAP_H);
  for (const cell of solidCells) {
    cells[cell.y * MAP_W + cell.x] = COLLISION_SOLID_MASK;
  }
  world.registerMapDefinitions([
    {
      mapId: MAP_ID,
      width: MAP_W * CELL,
      height: MAP_H * CELL,
      obstacles: [],
      collisionGrid: { width: MAP_W, height: MAP_H, cellSize: CELL, cells }
    }
  ]);
  world.setPlayableMapsState({
    categories: [],
    items: [{ id: MAP_ID }],
    editorDataByMapId: { [MAP_ID]: { npcs, objects: [], portals: [], boulders: [] } }
  } as any);
  return world;
}

function addPlayer(world: World, id: string, cellX: number, cellY: number) {
  const player = new Player(cellX * CELL, cellY * CELL, id, world, MAP_ID, `sock-${id}`, 1, {});
  world.players.set(id, player);
  world.socketToPlayerId.set(`sock-${id}`, id);
  return player;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // ---------------------------------------------------------------- moves ---
  {
    const world = buildWorld([
      { id: "npc-a", x: 10, y: 10, previewImageSrc: "x.png", essentialsEvent: makeEvent(1, 1) }
    ]);
    addPlayer(world, "watcher", 2, 2);

    const start = world.npcSimulation!.snapshotForMap(MAP_ID)[0];
    check("actor created for a random mover", Boolean(start), start);

    await sleep(3000);
    const now = world.npcSimulation!.snapshotForMap(MAP_ID)[0];
    check(
      "random mover actually moved off its authored tile",
      now.x !== 10 || now.y !== 10,
      now
    );
    check(
      "random mover stayed inside its wander radius",
      Math.abs(now.x - 10) <= 3 && Math.abs(now.y - 10) <= 3,
      now
    );

    const steps = emitted.filter((entry) => entry.event === "npc:steps");
    check("steps were broadcast to the map", steps.length > 0, steps.length);
    const sample = steps[0]?.payload?.steps?.[0];
    check(
      "step payload carries cells + duration",
      sample &&
        typeof sample.id === "string" &&
        Number.isFinite(sample.fromX) &&
        Number.isFinite(sample.toX) &&
        sample.stepMs > 0,
      sample
    );
    // A step is always exactly one cell.
    const allOneCell = steps.every((entry) =>
      entry.payload.steps.every(
        (step: any) => Math.abs(step.toX - step.fromX) + Math.abs(step.toY - step.fromY) === 1
      )
    );
    check("every step is exactly one cell", allOneCell);
    world.npcSimulation!.stop();
  }

  // -------------------------------------------------- never enters a wall ---
  emitted.length = 0;
  {
    // Boxed in a 3x3 room with walls: the NPC may only occupy the 9 inner cells.
    const walls: Array<{ x: number; y: number }> = [];
    for (let x = 4; x <= 8; x += 1) {
      walls.push({ x, y: 4 }, { x, y: 8 });
    }
    for (let y = 4; y <= 8; y += 1) {
      walls.push({ x: 4, y }, { x: 8, y });
    }
    const world = buildWorld(
      [{ id: "npc-b", x: 6, y: 6, previewImageSrc: "x.png", essentialsEvent: makeEvent(2, 1) }],
      walls
    );
    addPlayer(world, "watcher2", 1, 1);

    await sleep(4000);
    const steps = emitted.filter((entry) => entry.event === "npc:steps");
    const visited = steps.flatMap((entry) => entry.payload.steps.map((step: any) => step));
    const insideRoom = visited.every(
      (step: any) => step.toX > 4 && step.toX < 8 && step.toY > 4 && step.toY < 8
    );
    check("walled NPC never steps into a solid cell", insideRoom, visited.slice(0, 5));
    check("walled NPC still moved", visited.length > 0, visited.length);
    world.npcSimulation!.stop();
  }

  // ------------------------------------------- never walks onto a player ----
  emitted.length = 0;
  {
    // 1-wide corridor: NPC at x=10, player parked at x=12. The NPC's only
    // route east is through the player, so it must never reach or pass x=12.
    const walls: Array<{ x: number; y: number }> = [];
    for (let x = 0; x < MAP_W; x += 1) {
      walls.push({ x, y: 9 }, { x, y: 11 });
    }
    const world = buildWorld(
      [{ id: "npc-c", x: 10, y: 10, previewImageSrc: "x.png", essentialsEvent: makeEvent(3, 1) }],
      walls
    );
    addPlayer(world, "wall-player", 12, 10);

    await sleep(4000);
    const steps = emitted
      .filter((entry) => entry.event === "npc:steps")
      .flatMap((entry) => entry.payload.steps);
    const neverReachedPlayer = steps.every((step: any) => !(step.toX === 12 && step.toY === 10));
    check("NPC never steps onto the player's tile", neverReachedPlayer, steps);
    const neverPassed = steps.every((step: any) => step.toX < 12);
    check("NPC never passes through the player", neverPassed, steps);
    world.npcSimulation!.stop();
  }

  // ------------------------------------------------- A* routes around it ----
  emitted.length = 0;
  {
    // Deterministic: a custom route walking four cells east from (10,10), with
    // a player parked squarely on the third waypoint (13,10). The NPC must not
    // walk through them, and must reach the far waypoint (14,10) by going
    // around — which means leaving row 10 at some point.
    const route = { list: [{ code: 3 }, { code: 3 }, { code: 3 }, { code: 3 }], repeat: false };
    const world = buildWorld([
      {
        id: "npc-d",
        x: 10,
        y: 10,
        previewImageSrc: "x.png",
        essentialsEvent: makeEvent(4, 3, { route })
      }
    ]);
    addPlayer(world, "blocker", 13, 10);

    await sleep(8000);
    const steps = emitted
      .filter((entry) => entry.event === "npc:steps")
      .flatMap((entry) => entry.payload.steps);
    check("route mover produced steps", steps.length > 0, steps.length);
    check(
      "route mover never entered the blocking player's tile",
      steps.every((step: any) => !(step.toX === 13 && step.toY === 10)),
      steps.map((step: any) => `${step.fromX},${step.fromY}->${step.toX},${step.toY}`)
    );
    const leftTheRow = steps.some((step: any) => step.toY !== 10);
    check(
      "A* detoured off the blocked row",
      leftTheRow,
      steps.map((step: any) => `${step.fromX},${step.fromY}->${step.toX},${step.toY}`)
    );
    const reachedFarWaypoint = steps.some((step: any) => step.toX === 14 && step.toY === 10);
    check(
      "route mover still reached the waypoint beyond the player",
      reachedFarWaypoint,
      steps.map((step: any) => `${step.fromX},${step.fromY}->${step.toX},${step.toY}`)
    );
    world.npcSimulation!.stop();
  }

  // -------------------------------------------------- push: player -> NPC ---
  emitted.length = 0;
  {
    const world = buildWorld([
      { id: "npc-e", x: 10, y: 10, previewImageSrc: "x.png", essentialsEvent: makeEvent(5, 1) }
    ]);
    const pusher = addPlayer(world, "pusher", 9, 10);
    // Freeze the NPC's own wandering so the test observes the push alone.
    const actorBefore = world.npcSimulation!.snapshotForMap(MAP_ID)[0];
    check("npc actor present before push", Boolean(actorBefore), actorBefore);

    // Walk the pusher east into the NPC repeatedly.
    let pushed = false;
    for (let attempt = 0; attempt < 40 && !pushed; attempt += 1) {
      const npc = world.npcSimulation!.snapshotForMap(MAP_ID)[0];
      pusher.x = (npc.x - 1) * CELL;
      pusher.y = npc.y * CELL;
      const before = { x: npc.x, y: npc.y };
      const moved = world.shovePastObstacle(pusher, pusher.x + CELL, pusher.y);
      if (moved) {
        await sleep(250);
        const after = world.npcSimulation!.snapshotForMap(MAP_ID)[0];
        pushed = after.x === before.x + 1 && after.y === before.y;
        check("player push moved the NPC one cell east", pushed, { before, after });
      }
      await sleep(60);
    }
    check("a push landed at all", pushed);
    world.npcSimulation!.stop();
  }

  // ----------------------------------------------- push: player -> player ---
  emitted.length = 0;
  {
    const world = buildWorld([]);
    const pusher = addPlayer(world, "p1", 5, 5);
    const pushee = addPlayer(world, "p2", 6, 5);

    const startX = pushee.x;
    const shoved = world.shovePastObstacle(pusher, pusher.x + CELL, pusher.y);
    check("player-vs-player push reported success", shoved);

    // The pushee walks the cell over its own movement ticks.
    await sleep(500);
    check(
      "pushed player advanced one cell east",
      pushee.x === startX + CELL && pushee.y === 5 * CELL,
      { x: pushee.x, y: pushee.y, expected: startX + CELL }
    );

    // A wall behind the pushee must make the push fail rather than clip them.
    const world2 = buildWorld([], [{ x: 7, y: 5 }]);
    const pusher2 = addPlayer(world2, "p3", 5, 5);
    const pushee2 = addPlayer(world2, "p4", 6, 5);
    const blockedPush = world2.shovePastObstacle(pusher2, pusher2.x + CELL, pusher2.y);
    check("push into a wall is refused", blockedPush === false);
    await sleep(200);
    check("refused push left the pushee still", pushee2.x === 6 * CELL, pushee2.x);
    world.npcSimulation!.stop();
    world2.npcSimulation!.stop();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
