# Essentials Progression Compatibility

How imported RPG Maker XP / Pokemon Essentials games (Venova Adventure today,
Venova Reforged next) keep their original progression rules inside the online
engine: which layer decides what, how events are evaluated, and how to extend
the system when a new project or script call shows up.

## Data model

Everything the runtime needs lives in the Redis maps payload
(`designer:section:maps`):

- `editorDataByMapId[mapId].npcs[]` — one placement per imported event. A
  placement carries `essentialsEvent = { eventId, essentialsMapId, pages[] }`
  with **every** original page: `conditions` (switch1/switch2/selfSwitch/
  variable), `graphic`, `trigger` (0 action, 1 player-touch, 2 event-touch,
  3 autorun, 4 parallel), `move` (incl. `through`), and the raw `commands`
  (`{code, indent, parameters}`). Multi-page events are never flattened.
- `editorDataByMapId[mapId].portals[]` — extracted Transfer Player commands.
  A portal with `essentialsConnection` is only a *marker*: when a placement
  with page data exists on its cell, the runtime ignores the portal and the
  event itself decides (see below). Designer-authored portals (no
  `essentialsConnection`) fire as configured.
- `state.essentialsSystem` — imported from `System.rxdata`:
  `scriptSwitches` (switch id → the expression after `s:`), `switchNames`,
  `variableNames`.

## Page selection (server and client agree)

`components/eventPageSelection.ts` implements RMXP rules: the active page is
the **highest-index** page whose conditions all hold for *this player*.
Condition sources:

- **Switches / variables / self-switches** — per-player, persisted on
  `auth:user:{id}` (`event_switches`, `event_variables`,
  `event_self_switches`). Variable page conditions are `>=`, like RMXP.
- **Script switches** — a switch whose System name starts with `s:` is an
  expression, evaluated by `evaluateScriptSwitchExpression`: `tsOn?/tsOff?`
  (temp switches), `PBDayNight.is*?` (server clock), `pbIsWeekday`,
  `cooledDown?*` (approximated per map visit), Safari/BugContest (false).
  Unknown expressions evaluate **false** (page hidden) and are logged.
- **Temp switches** — `setTempSwitchOn/Off("A")` state is per-event and
  session-scoped (`player.tempSwitches`), cleared on every map change,
  mirroring the original engine's per-Game_Event instance variables. This is
  what drives the Venova door template (autorun page + `s:tsOff?("A")`).
- **`ERASED`** — reserved self-switch written by `pbEraseThisEvent` (Cut
  trees, Rock Smash rocks): the event has no active page for that player.

The world (collision + touch detection), the event runtime, and the client
renderer all call the same selector. The client's copy
(`client-poke.io/src/components/game/npcEventState.ts`) is display-only: the
server re-selects the page on every interaction, touch, and transfer.

## Event execution and transfers

`components/EventRuntime.ts` interprets the active page's command list
server-side (text, choices, conditional branches, switches/variables/self
switches, labels, transfers, battles, item grants, marts, PC boxes...).

Presentation commands stream to the client as `event:step` payloads: pictures
(231/232/235), sounds (241–250), fades (221/222), screen tone (223), screen
flash (224), screen shake (225), camera pans (Scroll Map 203 + Wait for
Move's Completion 210, which holds the event for the pan), and Show Animation
(207, rendered as an emote bubble named by `data/Animations.json` plus its
timed sound effect). The Map158 "???" earthquake cutscene exercises most of
these end to end — `tools/e2e-cutscene.ts` drives it against a real server.

Parallel-process pages (trigger 4) run as one-shot autoruns on map entry and
after interactions, with two guards: a page that stays active after running
is not restarted during the same visit, and pages whose commands compile to
nothing observable (fog settings, move-route-only choreography) are skipped
(`pageHasObservableNodes`).

Transfer rules:

1. **Touch transfers (doors, mats, cave mouths)** — the world detects the
   bump/step, re-selects the active page for the player, and only fires the
   event when that page's trigger is 1/2. The transfer happens when (and only
   when) command flow reaches the `201` — behind whatever dialogue, choices
   or conditional branches the original author put in front of it.
2. **Essentials portals** — deferred to their source event whenever its page
   data is present (`World.portalDeferredToEvent`). Portals without recovered
   event data keep the legacy blind behavior *and are listed as BLOCKERs by
   the migration report* until `tools/repairEssentialsEvents.ts` attaches the
   event.
3. **`player:teleport` requests** — validated in
   `Server/registerSocketHandlers.ts` (`isAllowedClientTeleport`): same-map
   nudges (≤10 tiles), edge crossings along imported map connections landing
   in the entry strip of the correct edge, or standing next to an
   event-script portal. Everything else is rejected and the client is snapped
   back. Admin/designer accounts bypass.

## Conditions fail closed

Script conditional branches (`111` type 12) are recognized by
`components/essentialsScriptAdapters.ts`. Recognized kinds include trainer
and wild battles (the battle result selects the branch), gift Pokemon/eggs,
item balls and grants, badge count/possession, **key-item quantity gates**
(`$PokemonBag.pbQuantity(PBItems::X) > 0`), bag/box space, temp switches,
`get_character(0).onEvent?`, `$game_switches[n]`, `pbGet(n)` comparisons, and
not-simulated systems (Pokerus, Mystery Gift, phone rematches, Safari) which
evaluate the way they would for a player outside those modes.

Anything unrecognized **fails closed**: the else-branch runs, the script is
recorded in the unsupported-script log
(`getUnsupportedScriptLog()`), and the migration report lists it. The same
applies to unknown conditional-branch types (actor/timer/...) and to unknown
script *commands* (skipped as no-ops, never unlocking progression).

## State scopes

- Per-player (default for all imported story progression): switches,
  variables, self-switches, badges, defeated trainers (self-switch A),
  consumed item balls, erased obstacles, egg cooldowns.
- Session (per connection + map): temp switches.
- World-shared (opt-in only): a switch id listed in the
  `world:event-switch-globals` JSON array reads/writes through
  `world:event-switches` for every player. Nothing is shared by default.

`admin:user:reset-progress` clears all of it, including badges and egg
cooldowns.

## Version adapters

`essentialsScriptAdapters.ts` keeps per-generation spellings isolated:

- `venovaAdventureAdapter` — Essentials v3.1.1 (`PBItems::X`, `Kernel.pbFoo`,
  `pbTrainerBattle`, `$PokemonBag`, `$Trainer`).
- `essentialsV21Adapter` — Essentials v21.x (`:SYMBOL`, `TrainerBattle.start`,
  `$bag`, `$player`) for Venova Reforged.

The runtime consumes normalized descriptors, so supporting a new Essentials
version means adding/extending an adapter — not touching the interpreter.
The shared regex constants at the top of the module already accept both
generations where their syntax overlaps.

## Tools

- `npx ts-node tools/repairEssentialsEvents.ts "<rxdata_json dir>" [--dry-run]`
  Attaches full page data for every event the original map defines that has
  no placement yet (the 305 portal-source events among them) and imports the
  System script-switch table. Idempotent; never modifies existing placements.
  **Must be run against every environment's Redis (dev and prod).**
- `npm run report:migration` (`tools/essentialsMigrationReport.ts`)
  Read-only audit: blind portals, unsupported script conditions/commands,
  unsupported script switches, state-writing parallel pages, unknown item
  symbols, missing destination maps — each with severity and recommended fix.
- `npm run test:progression` (`tools/testEssentialsProgression.ts`)
  Unit/integration tests for page selection, script switches, adapters,
  command-tree parsing, portal gating, teleport validation, temp-switch
  scoping.

## Known approximations

- `cooledDown?` / `cooledDownDays?` (daily berries/gifts) reset per map visit
  instead of per real-time window (original timestamps are not persisted).
- Parallel-process pages (trigger 4) run once per map visit instead of
  looping continuously; pure-cosmetic loops (fog, tone flicker) are skipped.
- Phone rematches, Mystery Gift, Safari Zone, Bug Contest, day-care
  deposits/breeding are not simulated; their branches resolve as they would
  for a player outside those systems.
- Scripted move routes (`209`) during cutscenes are not replayed; NPC idle
  move routes are animated client-side.
