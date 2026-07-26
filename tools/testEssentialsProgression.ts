/**
 * Progression-compatibility test suite (no sockets / no Redis needed):
 *
 *   npx ts-node tools/testEssentialsProgression.ts
 *
 * Covers the RPG Maker / Pokemon Essentials semantics restored for Venova
 * Adventure: page selection (incl. script switches + temp switches), script
 * recognition across Essentials versions, command-tree parsing (conditional
 * transfers), portal gating, and client-teleport validation.
 */
import assert from "assert";
import {
  currentEventEnv,
  evaluateScriptSwitchExpression,
  selectActiveEventPage,
  selectConditionMetPage,
  tempSwitchKey,
  erasedSelfSwitchKey,
  type EssentialsEventRecord,
  type EventPlayerState
} from "../components/eventPageSelection";
import {
  recognizeScriptCondition,
  matchTrainerBattle,
  classifyIgnorableCommand,
  isScriptConditionHandled,
  isScriptCommandHandled,
  compareNumbers
} from "../components/essentialsScriptAdapters";
import { parseCommands } from "../components/EventRuntime";
import { isAllowedClientTeleport } from "../Server/registerSocketHandlers";
import World from "../components/world";
import Player from "../components/player";

let passed = 0;
let failed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`  ${(error as Error).message}`);
  }
};

const emptyState = (): EventPlayerState => ({
  switches: {},
  variables: {},
  selfSwitches: {},
  tempSwitches: {}
});

const page = (overrides: Record<string, unknown> = {}) => ({
  conditions: {},
  graphic: { characterName: "", direction: 2, pattern: 0 },
  trigger: 0,
  commands: [{ code: 101, indent: 0, parameters: ["hi"] }],
  ...overrides
});

const event = (pages: unknown[]): EssentialsEventRecord =>
  ({ eventId: 7, essentialsMapId: 3, pages } as EssentialsEventRecord);

// ---------------------------------------------------------------------------
// 1. RMXP page selection priority
// ---------------------------------------------------------------------------

test("page selection picks the highest-index page whose conditions hold", () => {
  const record = event([page(), page({ conditions: { switch1: 48 } })]);
  const state = emptyState();
  assert.strictEqual(selectActiveEventPage(record, state), record.pages[0]);
  state.switches["48"] = true;
  assert.strictEqual(selectActiveEventPage(record, state), record.pages[1]);
});

test("no page qualifies -> event hidden (door stays shut before its switch)", () => {
  const record = event([page({ conditions: { switch1: 48 }, trigger: 1 })]);
  assert.strictEqual(selectActiveEventPage(record, emptyState()), null);
});

test("self-switch page condition uses the event-scoped key (defeated trainer page)", () => {
  const record = event([page(), page({ conditions: { selfSwitch: "A" } })]);
  const state = emptyState();
  assert.strictEqual(selectActiveEventPage(record, state), record.pages[0]);
  state.selfSwitches["3:7:A"] = true;
  assert.strictEqual(selectActiveEventPage(record, state), record.pages[1]);
});

test("variable page condition is >= like RMXP", () => {
  const record = event([page({ conditions: { variable: { id: 14, value: 3 } } })]);
  const state = emptyState();
  assert.strictEqual(selectActiveEventPage(record, state), null);
  state.variables["14"] = 3;
  assert.notStrictEqual(selectActiveEventPage(record, state), null);
});

test("erased events (pbEraseThisEvent) have no active page", () => {
  const record = event([page()]);
  const state = emptyState();
  state.selfSwitches[erasedSelfSwitchKey({ essentialsMapId: 3, eventId: 7 })] = true;
  assert.strictEqual(selectActiveEventPage(record, state), null);
});

test("selectConditionMetPage returns command-less pages (collision), selectActiveEventPage does not", () => {
  const record = event([page({ commands: [{ code: 0, indent: 0, parameters: [] }], graphic: { characterName: "npc", direction: 2, pattern: 0 } })]);
  assert.notStrictEqual(selectConditionMetPage(record, emptyState()), null);
  assert.strictEqual(selectActiveEventPage(record, emptyState()), null);
});

// ---------------------------------------------------------------------------
// 2. Essentials script switches (s: names) + temp switches
// ---------------------------------------------------------------------------

const scriptOptions = (scriptSwitches: Record<string, string>, hour = 12, weekday = 1) => ({
  scriptSwitches,
  env: { hour, weekday }
});

test("s:tsOff?(A) is true by default and false after setTempSwitchOn (door template)", () => {
  const record = event([
    page({ trigger: 1, commands: [{ code: 201, indent: 0, parameters: [0, 10, 5, 5, 2, 1] }] }),
    page({ conditions: { switch1: 22 }, trigger: 3, commands: [{ code: 355, indent: 0, parameters: ['setTempSwitchOn("A")'] }] })
  ]);
  const options = scriptOptions({ "22": 'tsOff?("A")' });
  const state = emptyState();
  // Default: the autorun page (higher index) is active, like RMXP.
  assert.strictEqual(selectActiveEventPage(record, state, options), record.pages[1]);
  // After the autorun sets temp switch A, the touch-transfer page takes over.
  state.tempSwitches![tempSwitchKey({ essentialsMapId: 3, eventId: 7 }, "A")] = true;
  assert.strictEqual(selectActiveEventPage(record, state, options), record.pages[0]);
});

test("day/night script switches follow the provided clock", () => {
  const ctx = { essentialsMapId: 3, eventId: 7 };
  assert.strictEqual(evaluateScriptSwitchExpression("PBDayNight.isNight?", ctx, emptyState(), { hour: 23, weekday: 0 }), true);
  assert.strictEqual(evaluateScriptSwitchExpression("PBDayNight.isNight?", ctx, emptyState(), { hour: 12, weekday: 0 }), false);
  assert.strictEqual(evaluateScriptSwitchExpression("PBDayNight.isDay?", ctx, emptyState(), { hour: 12, weekday: 0 }), true);
  assert.strictEqual(evaluateScriptSwitchExpression("PBDayNight.isMorning?", ctx, emptyState(), { hour: 8, weekday: 0 }), true);
});

test("pbIsWeekday matches the day list; negation supported", () => {
  const ctx = { essentialsMapId: 3, eventId: 7 };
  assert.strictEqual(evaluateScriptSwitchExpression("pbIsWeekday(-1,2,4,6)", ctx, emptyState(), { hour: 12, weekday: 4 }), true);
  assert.strictEqual(evaluateScriptSwitchExpression("!pbIsWeekday(-1,2,4,6)", ctx, emptyState(), { hour: 12, weekday: 3 }), true);
});

test("unknown script-switch expressions hide the page (fail closed)", () => {
  const record = event([page({ conditions: { switch1: 99 } })]);
  let reported: string | null = null;
  const options = {
    scriptSwitches: { "99": "someUnknownThing?" },
    env: currentEventEnv(),
    onUnknownScriptSwitch: (_id: number, expression: string) => {
      reported = expression;
    }
  };
  assert.strictEqual(selectActiveEventPage(record, emptyState(), options), null);
  assert.strictEqual(reported, "someUnknownThing?");
});

// ---------------------------------------------------------------------------
// 3. Version adapters: script recognition
// ---------------------------------------------------------------------------

test("key-item quantity gates recognized (Venova v3 sailor)", () => {
  const match = recognizeScriptCondition("$PokemonBag.pbQuantity(PBItems::OLDSEAMAP)>0");
  assert.deepStrictEqual(match, { kind: "itemQuantity", itemSymbol: "OLDSEAMAP", op: ">", value: 0 });
});

test("v21 bag quantity recognized (Reforged adapter)", () => {
  const match = recognizeScriptCondition("$bag.quantity(:OLDSEAMAP) >= 1");
  assert.deepStrictEqual(match, { kind: "itemQuantity", itemSymbol: "OLDSEAMAP", op: ">=", value: 1 });
});

test("trainer battles recognized in both Essentials spellings", () => {
  assert.deepStrictEqual(
    matchTrainerBattle('pbTrainerBattle(PBTrainers::BEAUTY,"Victoria",_I("Rayos...."),false,0,false,0)'),
    { trainerType: "BEAUTY", trainerName: "Victoria" }
  );
  assert.deepStrictEqual(
    matchTrainerBattle('TrainerBattle.start(:BEAUTY, "Victoria")'),
    { trainerType: "BEAUTY", trainerName: "Victoria" }
  );
});

test("temp switch / onEvent / game switch / pbGet conditions recognized", () => {
  assert.deepStrictEqual(recognizeScriptCondition('tsOff?("A")'), { kind: "tempSwitch", channel: "A", on: false });
  assert.deepStrictEqual(recognizeScriptCondition("get_character(0).onEvent?"), { kind: "onEvent" });
  assert.deepStrictEqual(recognizeScriptCondition("!$game_switches[48]"), { kind: "gameSwitch", id: 48, negated: true });
  assert.deepStrictEqual(recognizeScriptCondition("pbGet(14)>=3"), { kind: "variableCompare", id: 14, op: ">=", value: 3 });
});

test("unsimulated systems recognized as always-false, cosmetic commands as ignorable", () => {
  assert.deepStrictEqual(recognizeScriptCondition("Kernel.pbPokerus?"), { kind: "alwaysFalse", reason: "pokerus-not-simulated" });
  assert.strictEqual(recognizeScriptCondition('pbPhoneBattleCount(PBTrainers::CAMPER,"x")>=3')?.kind, "alwaysFalse");
  assert.strictEqual(classifyIgnorableCommand("Kernel.pbNoticePlayer(get_character(0))"), "trainer-notice-animation");
  assert.strictEqual(classifyIgnorableCommand("pbTrainerEnd"), "trainer-battle-epilogue");
});

test("coverage predicates: the top Venova scripts are all handled", () => {
  const conditions = [
    'pbTrainerBattle(PBTrainers::TEAMROCKET_M,"Grunt",_I("..."),false,0,false,0)',
    "$Trainer.numbadges>=4",
    "$PokemonBag.pbQuantity(PBItems::AURORATICKET)>0",
    "Kernel.pbRockSmash",
    "Kernel.pbItemBall(:TM24)",
    "!pbBoxesFull?",
    "Kernel.pbPokerus?",
    "$PokemonBag.pbCanStore?(PBItems::FRESHWATER)",
    "get_character(0).onEvent?",
    "pbWildBattle(:CYNDAQUIL,30)",
    "Kernel.pbGenerateEgg(:EEVEE)",
    "$Trainer.party.length>=6"
  ];
  for (const text of conditions) {
    assert.ok(isScriptConditionHandled(text), `condition not handled: ${text}`);
  }
  const commands = [
    'setTempSwitchOn("A")',
    "pbTrainerEnd",
    "Kernel.pbNoticePlayer(get_character(0))",
    "Kernel.pbItemBall(pbGet(1))",
    "pbEraseThisEvent",
    'pbSetSelfSwitch(20,"A",true)',
    "Kernel.pbSetPokemonCenter",
    "pbPokeCenterPC",
    "pbPokemonMart([\n:POKEBALL,\n:POTION\n])",
    "pbShowMap",
    "$Trainer.badges[3]=true"
  ];
  for (const text of commands) {
    assert.ok(isScriptCommandHandled(text), `command not handled: ${text}`);
  }
});

test("compareNumbers implements every operator", () => {
  assert.ok(compareNumbers(">=", 3, 3) && compareNumbers("<", 2, 3) && !compareNumbers("==", 1, 2));
});

// ---------------------------------------------------------------------------
// 4. Command-tree parsing: conditional transfer stays behind its branch
// ---------------------------------------------------------------------------

test("transfer nested in a conditional branch parses under the branch, not top-level", () => {
  // Marinero-style: branch(item) { text; transfer } else { refusal }
  const nodes = parseCommands([
    { code: 111, indent: 0, parameters: [12, "$PokemonBag.pbQuantity(PBItems::OLDSEAMAP)>0"] },
    { code: 101, indent: 1, parameters: ["All aboard!"] },
    { code: 201, indent: 1, parameters: [0, 10, 16, 26, 2, 1] },
    { code: 411, indent: 0, parameters: [] },
    { code: 101, indent: 1, parameters: ["You need the map."] },
    { code: 412, indent: 0, parameters: [] }
  ]);
  assert.strictEqual(nodes.length, 1);
  const branch = nodes[0] as { kind: string; test: { kind: string }; then: Array<{ kind: string }>; otherwise: Array<{ kind: string }> };
  assert.strictEqual(branch.kind, "condition");
  assert.strictEqual(branch.test.kind, "script");
  assert.deepStrictEqual(branch.then.map((node) => node.kind), ["text", "transfer"]);
  assert.deepStrictEqual(branch.otherwise.map((node) => node.kind), ["text"]);
});

test("item conditional branch (type 8) parses as an item test", () => {
  const nodes = parseCommands([
    { code: 111, indent: 0, parameters: [8, 82] },
    { code: 101, indent: 1, parameters: ["You have it"] },
    { code: 412, indent: 0, parameters: [] }
  ]);
  const branch = nodes[0] as { kind: string; test: { kind: string; legacyId?: number } };
  assert.strictEqual(branch.test.kind, "item");
  assert.strictEqual(branch.test.legacyId, 82);
});

test("unknown conditional-branch types parse as unsupported (fail closed at runtime)", () => {
  const nodes = parseCommands([
    { code: 111, indent: 0, parameters: [4, 1] }, // actor check
    { code: 101, indent: 1, parameters: ["secret"] },
    { code: 412, indent: 0, parameters: [] }
  ]);
  const branch = nodes[0] as { kind: string; test: { kind: string; branchType?: number } };
  assert.strictEqual(branch.test.kind, "unsupported");
  assert.strictEqual(branch.test.branchType, 4);
});

// ---------------------------------------------------------------------------
// 5. Portal gating + client-teleport validation (world-level)
// ---------------------------------------------------------------------------

function buildWorld() {
  // teleport() broadcasts through the static socket server; stub it out.
  (World as unknown as { socketServer: unknown }).socketServer = { emit: () => undefined };
  const world = new World(200, 200);
  const doorEvent = {
    eventId: 2,
    essentialsMapId: 1,
    pages: [
      {
        conditions: { switch1: 48 },
        graphic: { characterName: "", direction: 2, pattern: 0 },
        trigger: 1,
        commands: [{ code: 201, indent: 0, parameters: [0, 277, 64, 27, 2, 1] }]
      }
    ]
  };
  const snapshot = {
    categories: [],
    items: [
      {
        id: "map-essentials-001",
        name: "Iglesia",
        category: "Pokemon Essentials",
        playableMapConfig: {
          cellSize: 32, sizePreset: "custom", width: 30, height: 30,
          isInitialMap: false, initialPositionX: null, initialPositionY: null,
          regionName: "", regionX: 0, regionY: 0, mapType: "grassland",
          backgroundColor: "#000", backgroundImageSrc: "", backgroundImageMode: "repeat",
          connections: [{ direction: "north", targetMapId: "map-essentials-002", offsetXCells: 0, offsetYCells: -30 }]
        }
      },
      {
        id: "map-essentials-002",
        name: "North",
        category: "Pokemon Essentials",
        playableMapConfig: {
          cellSize: 32, sizePreset: "custom", width: 30, height: 30,
          isInitialMap: false, initialPositionX: null, initialPositionY: null,
          regionName: "", regionX: 0, regionY: 0, mapType: "grassland",
          backgroundColor: "#000", backgroundImageSrc: "", backgroundImageMode: "repeat"
        }
      }
    ],
    editorDataByMapId: {
      "map-essentials-001": {
        version: 1,
        objects: [],
        portals: [
          {
            id: "portal-map-essentials-001-2",
            x: 5, y: 5,
            destinationType: "other-map",
            sameMapX: 0, sameMapY: 0,
            targetMapId: "map-essentials-002", targetMapX: 3, targetMapY: 3,
            eventScript: "",
            essentialsConnection: {
              sourceMapId: "1", sourceX: 5, sourceY: 5,
              targetMapId: "277", targetX: 64, targetY: 27
            }
          },
          {
            id: "portal-map-essentials-001-orphan",
            x: 9, y: 9,
            destinationType: "other-map",
            sameMapX: 0, sameMapY: 0,
            targetMapId: "map-essentials-002", targetMapX: 3, targetMapY: 3,
            eventScript: "",
            essentialsConnection: {
              sourceMapId: "1", sourceX: 9, sourceY: 9,
              targetMapId: "277", targetX: 64, targetY: 27
            }
          },
          {
            id: "portal-designer",
            x: 12, y: 12,
            destinationType: "event-script",
            sameMapX: 0, sameMapY: 0,
            targetMapId: "", targetMapX: 0, targetMapY: 0,
            eventScript: "teleportToMap('map-essentials-002', 3, 3)"
          }
        ],
        grass: [],
        npcs: [
          {
            id: "npc-map-essentials-001-ev2",
            npcId: "essentials-event-1-2",
            name: "North door right",
            category: "Pokemon Essentials",
            previewImageSrc: "",
            npcType: "sign", aiType: "standing",
            interactionDistanceSquares: 2,
            x: 5, y: 5,
            eventId: 2,
            essentialsEvent: doorEvent
          }
        ]
      },
      "map-essentials-002": { version: 1, objects: [], portals: [], grass: [], npcs: [] }
    }
  };
  world.setPlayableMapsState(snapshot as never);
  return { world, snapshot };
}

function buildPlayer(world: World, mapId: string, x: number, y: number) {
  const player = new Player(x, y, `player-${Math.random()}`, world, mapId, `sock-${Math.random()}`);
  player.eventState = { switches: {}, variables: {}, selfSwitches: {} };
  return player;
}

test("essentials portal with page-aware owner defers to the event (no blind teleport)", () => {
  const { world } = buildWorld();
  const deferred = (world as never as { portalDeferredToEvent: (mapId: string, portal: unknown) => boolean });
  const editorData = world.getPlayableMapsState()!.editorDataByMapId["map-essentials-001"];
  assert.strictEqual(deferred.portalDeferredToEvent("map-essentials-001", editorData.portals[0]), true);
  // Orphan portal (no recovered event data) keeps legacy behavior.
  assert.strictEqual(deferred.portalDeferredToEvent("map-essentials-001", editorData.portals[1]), false);
  // Designer portals never defer.
  assert.strictEqual(deferred.portalDeferredToEvent("map-essentials-001", editorData.portals[2]), false);
});

test("gated door: bump fires no event while switch 48 is off, fires when on", () => {
  const { world } = buildWorld();
  const fired: string[] = [];
  world.setEventTouchHandler((_player, placementId) => fired.push(placementId));
  const player = buildPlayer(world, "map-essentials-001", 5 * 32, 6 * 32 + 4);
  // Bump into the door cell (5,5) from below.
  world.notifyBlockedTouch(player, 5 * 32, 5 * 32 + 20);
  assert.deepStrictEqual(fired, []);
  player.eventState!.switches["48"] = true;
  world.notifyBlockedTouch(player, 5 * 32, 5 * 32 + 20);
  assert.deepStrictEqual(fired, ["npc-map-essentials-001-ev2"]);
});

test("client teleport: same-map nudge allowed, long same-map jump rejected", () => {
  const { world } = buildWorld();
  const player = buildPlayer(world, "map-essentials-001", 100, 100);
  assert.strictEqual(isAllowedClientTeleport(world, player, { mapId: "map-essentials-001", x: 160, y: 130 }), true);
  assert.strictEqual(isAllowedClientTeleport(world, player, { mapId: "map-essentials-001", x: 900, y: 900 }), false);
});

test("client teleport: edge crossing must land in the entry strip of the right edge", () => {
  const { world } = buildWorld();
  const player = buildPlayer(world, "map-essentials-001", 100, 2);
  const targetHeight = 30 * 32;
  // Crossing north: must arrive near the neighbor's SOUTH edge.
  assert.strictEqual(
    isAllowedClientTeleport(world, player, { mapId: "map-essentials-002", x: 100, y: targetHeight - 64 }),
    true
  );
  // Forged landing in the middle of the neighbor: rejected.
  assert.strictEqual(
    isAllowedClientTeleport(world, player, { mapId: "map-essentials-002", x: 100, y: 300 }),
    false
  );
});

test("client teleport: event-script portal only works next to the portal", () => {
  const { world } = buildWorld();
  const nearPlayer = buildPlayer(world, "map-essentials-001", 12 * 32 + 40, 12 * 32);
  assert.strictEqual(
    isAllowedClientTeleport(world, nearPlayer, { mapId: "map-essentials-002", x: 96, y: 300 }),
    true
  );
  const farPlayer = buildPlayer(world, "map-essentials-001", 700, 700);
  assert.strictEqual(
    isAllowedClientTeleport(world, farPlayer, { mapId: "map-essentials-002", x: 96, y: 300 }),
    false
  );
});

test("temp switches are session-scoped: cleared when the player changes map", () => {
  const { world } = buildWorld();
  const player = buildPlayer(world, "map-essentials-001", 100, 100);
  player.tempSwitches["1:2:A"] = true;
  player.teleport("map-essentials-002", 64, 64);
  assert.deepStrictEqual(player.tempSwitches, {});
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
