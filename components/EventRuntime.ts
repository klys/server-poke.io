import type { Server } from "socket.io";
import { templateMapIdFor } from "./Housing";
import type Auth from "./Auth";
import type BattleManager from "./BattleManager";
import type World from "./world";
import type Player from "./player";
import type ClientToServerEvents from "../Server/ClientToServerEvents";
import type InterServerEvents from "../Server/InterServerEvents";
import type ServerToClientEvents from "../Server/ServerToClientEvents";
import type { SocketData } from "../Server/registerSocketHandlers";
import {
  resolveInitialSpawnFromPlayableMapsState,
  sanitizeNpcStoreItems,
} from "./PlayableMapsState";
import {
  ERASED_SELF_SWITCH,
  currentEventEnv,
  selectActiveEventPage as selectActiveEventPageShared,
  type EssentialsEventRecord,
  type EventPlayerState
} from "./eventPageSelection";
import {
  RE_ADD_POKEMON,
  RE_GENERATE_EGG,
  RE_EGG_GENERATED,
  RE_DAYCARE_GENERATE_EGG,
  RE_PARTY_LENGTH,
  RE_POKEMON_COUNT,
  RE_RECEIVE_ITEM,
  RE_ITEM_BALL,
  RE_ITEM_BALL_VAR,
  RE_STORE_ITEM,
  RE_POKEDEX,
  RE_RUNNING_SHOES,
  RE_AWARD_BADGE,
  RE_RECEIVE_BADGE,
  RE_NUMBADGES,
  RE_HAS_BADGE,
  RE_HEAL,
  RE_CHANGE_PLAYER,
  RE_WILD_BATTLE,
  RE_TRAINER_NAME,
  RE_TONE_CHANGE,
  RE_SET_POKECENTER,
  RE_POKEMON_MART,
  RE_POKEMON_PC,
  RE_SE_PLAY,
  RE_PB_WAIT,
  RE_BUTTON_SCREEN,
  RE_CUT,
  RE_ROCKSMASH_COND,
  RE_ERASE_EVENT,
  RE_ROCKSMASH_ENCOUNTER,
  RE_SET_TEMP_SWITCH,
  RE_SET_SELF_SWITCH_OTHER,
  RE_CHOOSE_POKEMON,
  RE_START_TRADE,
  RE_CHOOSE_ITEM_LIST,
  RE_DELETE_ITEM,
  RE_RECEIVE_ITEM_VAR,
  RE_CONVERT_ITEM_TO_ITEM,
  RE_CONVERT_ITEM_TO_POKEMON,
  RE_SET_VAR_ITEM_NAME,
  RE_SET_VAR_SPECIES_NAME,
  RE_ADD_TO_PARTY_VAR,
  RE_PICK_BERRY,
  RE_TEXT_ENTRY,
  RE_GET_POKEMON_EGG,
  RE_GET_POKEMON_SHADOW,
  RE_GET_POKEMON_FOREIGN,
  RE_CHECK_ABLE_VAR,
  RE_RENAME_TO_SPECIES,
  RE_RENAME_TO_VAR,
  RE_VAR_EQ_PKMN_NAME,
  RE_STRING_VAR_EMPTY_OR_EQ,
  RE_PLAYER_CELL_COORD,
  matchTrainerBattle,
  recognizeScriptCondition,
  classifyIgnorableCommand,
  logUnsupportedScript,
  compareNumbers
} from "./essentialsScriptAdapters";
import LEGACY_ITEM_INTERNAL_BY_NUMBER from "./legacyItemNumbers";
import { BUNDLED_RXDATA_DIR } from "./RxdataUploadStore";
import { readFileSync } from "fs";
import path from "path";

/** Reverse of the legacy item table: internal name (uppercase) -> numeric id. */
const LEGACY_ITEM_NUMBER_BY_INTERNAL = new Map<string, number>(
  Object.entries(LEGACY_ITEM_INTERNAL_BY_NUMBER).map(([number, internal]) => [
    internal.toUpperCase(),
    Number(number)
  ])
);

type TypedSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

// Show Animation (207) metadata from the bundled rxdata dump: the animation's
// editor name (the client picks an emote bubble from it — "Exclaim bubble",
// "Question bubble") and its first timed sound effect. Cosmetic, so a missing
// or unparseable Animations.json just degrades to id-only payloads.
let animationMetaCache: Map<number, { name: string; se?: string }> | null = null;
function animationMeta(animationId: number): { name: string; se?: string } | null {
  if (!animationMetaCache) {
    animationMetaCache = new Map();
    try {
      const file = path.join(BUNDLED_RXDATA_DIR, "data", "Animations.json");
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed as { data?: unknown[] } | null)?.data;
      for (const entry of Array.isArray(list) ? list : []) {
        const animation = entry as
          | { id?: unknown; name?: unknown; timings?: Array<{ se?: { name?: unknown } }> }
          | null;
        if (!animation || typeof animation.id !== "number") {
          continue;
        }
        const se = (animation.timings ?? [])
          .map((timing) => timing?.se?.name)
          .find((name): name is string => typeof name === "string" && name.length > 0);
        animationMetaCache.set(animation.id, {
          name: typeof animation.name === "string" ? animation.name : "",
          se
        });
      }
    } catch {
      // fall through with an empty cache
    }
  }
  return animationMetaCache.get(animationId) ?? null;
}

type RawCommand = { code: number; indent: number; parameters: unknown[] };

type PageConditions = {
  switch1?: number;
  switch2?: number;
  selfSwitch?: string;
  variable?: { id: number; value: number };
};

type EventPage = {
  conditions: PageConditions;
  graphic: { characterName: string; direction: number; pattern: number };
  trigger: number;
  commands: RawCommand[];
};

type EssentialsEvent = {
  eventId: number;
  essentialsMapId: number;
  pages: EventPage[];
};

// Parsed command tree ------------------------------------------------------
type ConditionTest =
  | { kind: "switch"; id: number; on: boolean }
  | { kind: "selfSwitch"; ch: string; on: boolean }
  | { kind: "variable"; id: number; op: number; constant: boolean; value: number }
  | { kind: "gold"; amount: number; gte: boolean }
  | { kind: "item"; legacyId: number }
  | { kind: "script"; text: string }
  | { kind: "unsupported"; branchType: number }
  | { kind: "always"; value: boolean };

// Control Variables (122) / Change Gold (125) operands.
type Operand =
  | { type: "const"; value: number }
  | { type: "variable"; id: number }
  | { type: "random"; min: number; max: number };

type Node =
  | { kind: "text"; text: string }
  | { kind: "choices"; prompt: string; choices: string[]; cancelType: number; branches: Array<{ when: number | "cancel"; body: Node[] }> }
  | { kind: "condition"; test: ConditionTest; then: Node[]; otherwise: Node[] }
  | { kind: "script"; text: string }
  | { kind: "switch"; start: number; end: number; on: boolean }
  | { kind: "variable"; start: number; end: number; op: number; operand: Operand }
  | { kind: "gold"; add: boolean; operand: Operand }
  | { kind: "selfSwitch"; ch: string; on: boolean }
  | { kind: "label"; name: string }
  | { kind: "jump"; name: string }
  | { kind: "wait"; frames: number }
  | { kind: "picture"; op: "show" | "move" | "erase"; slot: number; name?: string; origin?: number; x?: number; y?: number; opacity?: number; durationMs?: number }
  | { kind: "sound"; soundKind: "SE" | "ME" | "BGM" | "BGS" | "BGMStop" | "BGSStop"; name?: string; volume?: number }
  | { kind: "screen"; effect: "fadeout" | "fadein" | "tone" | "flash" | "shake"; durationMs?: number; darken?: number; power?: number }
  | { kind: "scrollMap"; direction: number; distance: number; speed: number }
  | { kind: "waitScroll" }
  | { kind: "animation"; animationId: number; onEvent: boolean }
  | { kind: "transfer"; mapId: number; x: number; y: number }
  | { kind: "recoverAll" }
  | { kind: "exit" };

/** Thrown by a Jump to Label (119); caught by the nearest scope holding the label. */
class JumpToLabel {
  constructor(public readonly name: string) {}
}

// Script recognition (RE_* patterns, per-Essentials-version adapters, and the
// unsupported-script log) lives in essentialsScriptAdapters.ts.

// A player can receive a fresh egg from the same egg NPC once per week.
const EGG_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Venova gender pick (pbChangePlayer 0/1) -> migrated protagonist skins.
const PLAYER_SKIN_BY_INDEX: Record<string, string> = {
  "0": "player-player-a-pokemontrainer-red",
  "1": "player-player-b-pokemontrainer-leaf"
};

const CONTROLS_HELP_TEXT =
  "Controles de PokeCraft: muévete con las flechas o haciendo clic en el mapa. " +
  "Pulsa Espacio para hablar o interactuar con lo que tengas delante. " +
  "En los diálogos, Enter/Espacio avanza y las flechas eligen una opción. " +
  "Camina sobre la hierba alta para encontrar Pokémon salvajes.";

type EventStep =
  | { type: "text"; npcName: string; text: string; portraitSrc?: string; portraitPokemonId?: string }
  | { type: "choices"; npcName: string; text: string; choices: string[]; portraitSrc?: string; portraitPokemonId?: string }
  | { type: "info"; npcName: string; text: string; portraitSrc?: string; portraitPokemonId?: string }
  | { type: "nameInput"; npcName: string; text: string; defaultName: string }
  | { type: "picture"; op: "show" | "move" | "erase"; slot: number; name?: string; origin?: number; x?: number; y?: number; opacity?: number; durationMs?: number }
  | { type: "sound"; kind: "SE" | "ME" | "BGM" | "BGS" | "BGMStop" | "BGSStop"; name?: string; volume?: number }
  | {
      type: "screen";
      effect: "fadeout" | "fadein" | "tone" | "flash" | "shake";
      durationMs?: number;
      darken?: number;
      power?: number;
    }
  | { type: "camera"; op: "scroll"; direction: number; distanceTiles: number; durationMs: number }
  | {
      type: "animation";
      animationId: number;
      name?: string;
      se?: string;
      targetCell?: { x: number; y: number } | null;
    }
  // pbPokemonMart: opens the store overlay stocked with these items; buying/
  // selling goes through the regular npc:store-buy/npc:store-sell sockets,
  // validated against the mart session this runtime keeps per user. x/y are
  // the clerk's cell coordinates — the client closes the overlay when the
  // player walks out of interaction range of that spot.
  | {
      type: "store";
      npcName: string;
      placementId: string;
      x: number;
      y: number;
      interactionDistanceSquares: number;
      items: EventMartItem[];
    }
  // pbPokeCenterPC / pbTrainerPC: opens the PC box storage overlay. Deposits/
  // withdrawals go through the pokemon:box-deposit / pokemon:box-withdraw
  // sockets, which mutate Redis directly. x/y are the computer's cell — the
  // client closes the overlay when the player walks out of range.
  | {
      type: "pcBox";
      npcName: string;
      placementId: string;
      x: number;
      y: number;
      interactionDistanceSquares: number;
    }
  | { type: "end" };

export type EventMartItem = {
  itemId: string;
  itemName: string;
  quantity: number;
  price: number;
};

type Pending =
  | { kind: "advance"; resolve: () => void }
  | { kind: "choice"; resolve: (index: number) => void }
  | { kind: "name"; resolve: (name: string) => void };

type EventStateWrites = {
  switches: Record<string, boolean>; // false = clear
  variables: Record<string, number>;
  selfSwitches: Record<string, boolean>; // false = clear
};

type Session = {
  userId: number;
  token: number;
  player: Player;
  npcName: string;
  npcPortraitSrc: string; // the speaking NPC's trimmed sprite, shown in the box
  selfSwitchPrefix: string; // `${essMapId}:${eventId}:`
  essentials: EssentialsEvent; // the running event (for script conditions with event context)
  eventCell: { x: number; y: number } | null; // event cell coords (get_character(0).onEvent?)
  placementId: string; // map placement that hosts this event ("" for resumes)
  isTouch: boolean; // started by walking into/onto the event (doors, mats)
  // Sight-trap push-back: when a Trainer(X) line-of-sight event ends with its
  // touch page still armed (the gate stayed locked), the player is returned to
  // this tile — outside the sight corridor — so the trap can never be crossed
  // by simply closing the dialog and walking on.
  sightPushCell: { x: number; y: number } | null;
  startMapId: string;
  // Session-scoped STRING variables: Essentials events store item/species/
  // entered names in $game_variables for \v[N] text interpolation (Kurt,
  // fossil reviver, name rater). Numeric variables persist as usual; these
  // string values only live for the session that produced them.
  stringVars: Record<string, string>;
  nodesRun: number; // hang guard against mis-authored label loops
  // Switch/variable/self-switch changes buffer here and only persist at
  // checkpoints (side-effectful nodes and clean session end). An aborted
  // session (app closed mid-dialog) discards them, so a partially-played
  // autorun — the intro — replays from the top on the next join instead of
  // stranding the player with half-applied state.
  pendingWrites: EventStateWrites;
  // The most recent step shown, re-emitted when a client (re)joins while the
  // session is still alive so the dialog reappears instead of a dead screen.
  lastStep: EventStep | null;
  // When the latest Scroll Map (203) pan finishes, so a following Wait for
  // Move's Completion (210) can hold the event until the camera arrives.
  scrollEndsAt: number;
};

function emptyEventStateWrites(): EventStateWrites {
  return { switches: {}, variables: {}, selfSwitches: {} };
}

export default class EventRuntime {
  private io: TypedSocketServer;
  private world: World;
  private auth: Auth;
  private battleManager: BattleManager | null = null;
  private sessions = new Map<number, Session>();
  private pending = new Map<number, Pending>();
  private tokenCounter = 0;
  private touchCooldownReset: ((userId: number) => void) | null = null;
  // Touch/sight events that fired while the player was in a battle or another
  // event; replayed when they are free (see queueMissedTouch).
  private pendingTouches = new Map<
    number,
    { placementId: string; sightPushCell: { x: number; y: number } | null; mapId: string; at: number }
  >();
  // pbPokemonMart sessions: what each user's currently-open mart sells. The
  // buy/sell socket handlers validate against this (plus the usual placement
  // proximity check), so prices/stock can't be forged client-side.
  private activeMartsByUser = new Map<
    number,
    { placementId: string; items: EventMartItem[]; expiresAt: number }
  >();

  constructor(io: TypedSocketServer, world: World, auth: Auth) {
    this.io = io;
    this.world = world;
    this.auth = auth;
  }

  public setBattleManager(battleManager: BattleManager) {
    this.battleManager = battleManager;
  }

  public isRunning(userId: number) {
    return this.sessions.has(userId);
  }

  /** Items of the user's active pbPokemonMart at this placement, or null. */
  public getActiveMartItems(userId: number, placementId: string) {
    const mart = this.activeMartsByUser.get(userId);

    if (!mart || mart.placementId !== placementId || Date.now() > mart.expiresAt) {
      return null;
    }

    return mart.items;
  }

  // -- entry point ---------------------------------------------------------
  public async startEvent(
    userId: number,
    npcPlacementId?: string,
    options?: { touch?: boolean; sightPushCell?: { x: number; y: number } | null }
  ) {
    if (typeof npcPlacementId !== "string" || !npcPlacementId) {
      return { ok: false as const, message: "Choose someone to talk to." };
    }
    const player = this.world.getPlayerByUserId(userId);
    if (!player) {
      return { ok: false as const, message: "Enter the world before talking to NPCs." };
    }
    const snapshot = this.world.getPlayableMapsState();
    const placement = snapshot?.editorDataByMapId[templateMapIdFor(player.currentMapId)]?.npcs.find(
      (candidate) => candidate.id === npcPlacementId
    ) as (Record<string, unknown> & { name?: string; previewImageSrc?: string; x?: number; y?: number; interactionDistanceSquares?: number; essentialsEvent?: EssentialsEvent }) | undefined;

    if (!placement || !placement.essentialsEvent) {
      return { ok: false as const, message: "There is nothing to interact with here." };
    }

    // The client already range-checks before emitting event:interact, but the
    // server must not trust it: a forged interact against a distant event
    // (a gym leader, a story NPC) would run its commands from anywhere.
    if (options?.touch !== true && typeof placement.x === "number" && typeof placement.y === "number") {
      const playerCellX = Math.floor((player.x + player.width / 2) / 32);
      const playerCellY = Math.floor((player.y + player.height / 2) / 32);
      const reach = (typeof placement.interactionDistanceSquares === "number"
        ? placement.interactionDistanceSquares
        : 2) + 1;
      if (
        Math.abs(playerCellX - placement.x) > reach ||
        Math.abs(playerCellY - placement.y) > reach
      ) {
        return { ok: true as const, empty: true };
      }
    }

    const essentials = placement.essentialsEvent;
    // Halt before the first await: a sight-spotted or touch-triggered player
    // must freeze on the tile where the event caught them, not drift onward
    // while the event state loads.
    player.stopMovement();
    let state = await this.auth.getEventState(userId);
    // Re-gift: an egg NPC that permanently locks itself with a one-time Self
    // Switch ("Regala huevo" flips A after giving the egg) becomes available
    // again once its weekly cooldown elapses. Clear that lock when eligible so
    // the give-egg page runs instead of the "already gave it" page. Players who
    // got the egg before this feature existed have no recorded timestamp, so
    // they are eligible right away.
    const eggReset = this.scanEventForEggReset(essentials);
    if (eggReset.givesEgg && eggReset.selfSwitchChannels.length > 0) {
      const last = await this.auth.getEggGrantTimestamp(userId, npcPlacementId);
      const eligible = !last || last + EGG_COOLDOWN_MS <= Date.now();
      if (eligible) {
        let cleared = false;
        for (const ch of eggReset.selfSwitchChannels) {
          const key = `${essentials.essentialsMapId}:${essentials.eventId}:${ch}`;
          if (state.selfSwitches[key]) {
            await this.auth.setEventSelfSwitch(userId, key, false);
            cleared = true;
          }
        }
        if (cleared) {
          state = await this.auth.getEventState(userId);
        }
      }
    }
    const page = this.selectActivePage(essentials, player, state);
    // Only action/touch pages respond to a click; autorun/parallel pages are
    // driven by runAutorunForMap, not by talking.
    if (!page || (page.trigger !== 0 && page.trigger !== 1 && page.trigger !== 2)) {
      return { ok: true as const, empty: true };
    }

    // Cancel any previous run for this user before starting a new one.
    this.abort(userId);
    player.stopMovement();
    void this.executeSession(
      userId,
      player,
      placement.name ?? "NPC",
      placement.previewImageSrc ?? "",
      essentials,
      page,
      false,
      options?.touch === true,
      npcPlacementId,
      typeof placement.x === "number" && typeof placement.y === "number"
        ? { x: placement.x, y: placement.y }
        : null,
      options?.sightPushCell ?? null
    );
    return { ok: true as const };
  }

  /** ms remaining before this NPC hands out another egg (0 = eligible now). */
  private async eggCooldownRemaining(session: Session): Promise<number> {
    if (!session.placementId) {
      return 0;
    }
    const last = await this.auth.getEggGrantTimestamp(session.userId, session.placementId);
    if (!last) {
      return 0;
    }
    return Math.max(0, last + EGG_COOLDOWN_MS - Date.now());
  }

  /** Stamps "an egg was given now" so the weekly cooldown starts counting. */
  private async recordEggGrant(session: Session): Promise<void> {
    if (!session.placementId) {
      return;
    }
    await this.auth.setEggGrantTimestamp(session.userId, session.placementId, Date.now());
  }

  /**
   * Scans an event for the pbGenerateEgg give (so we know it is an egg NPC) and
   * the Self Switch channels it flips (code 123), which are the one-time locks
   * to clear when the weekly cooldown makes the egg available again.
   */
  private scanEventForEggReset(essentials: EssentialsEvent): { givesEgg: boolean; selfSwitchChannels: string[] } {
    let givesEgg = false;
    const channels = new Set<string>();
    for (const page of essentials.pages) {
      for (const command of page.commands) {
        // The pbGenerateEgg call sits in parameters[1] for a Conditional Branch
        // script (code 111) and parameters[0] for a plain Script (355), so scan
        // every string operand rather than assuming a slot.
        for (const param of command.parameters ?? []) {
          if (typeof param === "string" && RE_GENERATE_EGG.test(param)) {
            givesEgg = true;
          }
        }
        // Control Self Switch (123): parameters = [channel, 0|1].
        if (command.code === 123 && typeof command.parameters?.[0] === "string") {
          channels.add(command.parameters[0] as string);
        }
      }
    }
    return { givesEgg, selfSwitchChannels: [...channels] };
  }

  /**
   * Runs any autorun (trigger 3) events on the player's current map, chaining as
   * their state changes (e.g. the lab intro sets a switch that promotes the
   * controller to a follow-up autorun page). Called on map entry and after an
   * interaction ends. A guard cap prevents a mis-authored infinite autorun.
   */
  public async runAutorunForMap(userId: number): Promise<{ ready: boolean; ran: boolean }> {
    if (this.sessions.has(userId)) {
      return { ready: true, ran: false };
    }
    const player = this.world.getPlayerByUserId(userId);
    if (!player) {
      return { ready: false, ran: false };
    }
    let ranAny = false;
    // Parallel-process pages already played this visit (see below): a page
    // that stays active after running must not restart every chain round.
    const ranParallelPages = new Set<string>();
    // Guard cap: Venova's door template gives every doorway an autorun page
    // that self-disables via a temp switch, so a hub map can legitimately
    // chain a dozen autoruns on entry before settling.
    for (let guard = 0; guard < 64; guard += 1) {
      // A disconnect aborts the running session, but this loop would then
      // re-select the same (rolled-back) autorun page and restart it for a
      // player who is no longer there — a zombie session that blocks every
      // future join. Stop chaining once the player has no connections left.
      if (player.socketConnections.size === 0) {
        break;
      }
      // Re-resolve placements every round: an autorun can transfer the player
      // to another map (the intro does), and the next round must then look at
      // the destination map's events.
      const snapshot = this.world.getPlayableMapsState();
      if (!snapshot) {
        // World map state not hydrated yet — tell the caller so join-time
        // resume can retry instead of silently skipping the intro autorun.
        return { ready: false, ran: ranAny };
      }
      const placements = (snapshot.editorDataByMapId[templateMapIdFor(player.currentMapId)]?.npcs ?? []) as Array<
        Record<string, unknown> & { name?: string; previewImageSrc?: string; x?: number; y?: number; essentialsEvent?: EssentialsEvent }
      >;
      const eventPlacements = placements.filter((placement) => placement.essentialsEvent);
      const state = await this.auth.getEventState(userId);
      let ran = false;
      for (const runTrigger of [3, 4]) {
        for (const placement of eventPlacements) {
          const essentials = placement.essentialsEvent as EssentialsEvent;
          const page = this.selectActivePage(essentials, player, state);
          if (!page || page.trigger !== runTrigger) {
            continue;
          }
          // Parallel-process pages (trigger 4) run like one-shot autoruns —
          // Venova uses them for map-entry cutscenes (the "???" earthquake).
          // A true RMXP parallel loop never terminates, so two guards: a page
          // that stays active after running is not restarted this visit, and
          // pages whose commands compile to nothing observable (fog settings,
          // move-route-only choreography) are skipped instead of played as
          // seconds of dead air.
          if (page.trigger === 4) {
            const key = `${String(placement.id)}:${essentials.pages.indexOf(page)}`;
            if (ranParallelPages.has(key) || !pageHasObservableNodes(page)) {
              continue;
            }
            ranParallelPages.add(key);
          }
          const outcome = await this.executeSession(
            userId,
            player,
            placement.name ?? "NPC",
            placement.previewImageSrc ?? "",
            essentials,
            page,
            true,
            false,
            typeof placement.id === "string" ? placement.id : "",
            typeof placement.x === "number" && typeof placement.y === "number"
              ? { x: placement.x, y: placement.y }
              : null
          );
          if (outcome === "aborted") {
            // Disconnected (or superseded) mid-event: stop chaining; the
            // next join replays via resumeEventsOnJoin.
            return { ready: true, ran: ranAny };
          }
          ran = true;
          ranAny = true;
          break; // re-evaluate all events against the new state
        }
        if (ran) {
          break; // autoruns take priority over parallel pages each round
        }
      }
      if (!ran) {
        break;
      }
    }
    // Autorun may have flipped switches (e.g. the lab intro's permission switch);
    // refresh the client's copy so conditional NPCs update.
    await this.emitEventState(userId);
    // A trap/sight event that fired while another event (or a battle that has
    // since ended) held the player gets its turn now.
    this.firePendingTouch(userId);
    return { ready: true, ran: ranAny };
  }

  /**
   * A touch/sight event that fired while the player was busy (a wild battle
   * starting on the same step, a running cutscene) is remembered instead of
   * dropped, and replayed the moment the player is free — a trainer who
   * spotted you is never skipped because a Zubat got there first.
   */
  public queueMissedTouch(
    userId: number,
    placementId: string,
    sightPushCell: { x: number; y: number } | null,
    mapId: string
  ) {
    this.pendingTouches.set(userId, { placementId, sightPushCell, mapId, at: Date.now() });
  }

  /** Replays the queued touch event if the player is free and still on the map. */
  public firePendingTouch(userId: number) {
    const pending = this.pendingTouches.get(userId);
    if (!pending) {
      return;
    }
    if (this.sessions.has(userId)) {
      return; // still busy; the next session end tries again
    }
    const player = this.world.getPlayerByUserId(userId);
    if (!player || player.inBattle) {
      return; // still battling; the battle-end hook tries again
    }
    this.pendingTouches.delete(userId);
    if (Date.now() - pending.at > 5 * 60 * 1000 || player.currentMapId !== pending.mapId) {
      return; // stale (blackout teleport, map change): the moment has passed
    }
    void this.startEvent(userId, pending.placementId, {
      touch: true,
      sightPushCell: pending.sightPushCell
    });
  }

  /**
   * Join-time event recovery, called from addPlayer. Retries transient
   * failures (maps snapshot not applied yet, redis hiccup) instead of
   * silently skipping the autorun — a player parked on the intro map with no
   * running autorun has no exits and nothing to interact with, so a skipped
   * intro means a black screen with no way out.
   */
  public async resumeEventsOnJoin(userId: number) {
    // A session that survived the reconnect (brief network blip, or a second
    // device) keeps running server-side; re-show its pending step so the
    // rejoining client gets the dialog back instead of a dead screen.
    const existing = this.sessions.get(userId);
    if (existing) {
      await this.emitEventState(userId);
      if (existing.lastStep) {
        this.emitStep(existing, existing.lastStep);
      }
      return;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.emitEventState(userId);
        const result = await this.runAutorunForMap(userId);
        if (result.ready) {
          if (!result.ran) {
            await this.recoverStrandedOnInitialMap(userId);
          }
          return;
        }
      } catch (error) {
        console.error(`Join event resume failed for user:${userId}:`, error);
      }
      await this.sleep(2000 * (attempt + 1));
    }
  }

  /**
   * Un-brick: a player standing on the initial (intro) map whose autorun is
   * disabled by that event's own self-switches quit inside the
   * self-switch→transfer window (or carries legacy half-applied state). The
   * room is a dead end by construction — its only exit is the autorun's
   * transfer — so reset the blocking self-switches and replay the event.
   */
  private async recoverStrandedOnInitialMap(userId: number) {
    if (this.sessions.has(userId)) {
      return;
    }
    const player = this.world.getPlayerByUserId(userId);
    const snapshot = this.world.getPlayableMapsState();
    if (!player || !snapshot) {
      return;
    }
    const initialMapId = resolveInitialSpawnFromPlayableMapsState(snapshot)?.mapId;
    if (!initialMapId || player.currentMapId !== initialMapId) {
      return;
    }

    const placements = (snapshot.editorDataByMapId[initialMapId]?.npcs ?? []) as Array<
      Record<string, unknown> & { essentialsEvent?: EssentialsEvent }
    >;
    const state = await this.auth.getEventState(userId);
    let cleared = false;

    for (const placement of placements) {
      const essentials = placement.essentialsEvent;
      if (!essentials) {
        continue;
      }
      const prefix = `${essentials.essentialsMapId}:${essentials.eventId}:`;
      const activePage = this.selectActivePage(essentials, player, state);
      if (activePage && activePage.trigger === 3) {
        continue; // this autorun would already run — nothing to recover
      }
      // Would an autorun page activate if this event's self-switches were
      // cleared? Only then is the self-switch what strands the player.
      const strippedState = {
        ...state,
        selfSwitches: Object.fromEntries(
          Object.entries(state.selfSwitches).filter(([key]) => !key.startsWith(prefix))
        )
      };
      const strippedPage = this.selectActivePage(essentials, player, strippedState);
      if (strippedPage && strippedPage.trigger === 3) {
        if (await this.auth.clearEventSelfSwitchesByPrefix(userId, prefix)) {
          cleared = true;
        }
      }
    }

    if (cleared) {
      console.log(
        `Recovered stranded player user:${userId} on ${initialMapId}: replaying the intro autorun.`
      );
      await this.runAutorunForMap(userId);
    }
  }

  private async executeSession(
    userId: number,
    player: Player,
    placementName: string,
    portraitSrc: string,
    essentials: EssentialsEvent,
    page: EventPage,
    isAutorun: boolean,
    isTouch = false,
    placementId = "",
    eventCell: { x: number; y: number } | null = null,
    sightPushCell: { x: number; y: number } | null = null
  ) {
    const token = ++this.tokenCounter;
    const session: Session = {
      userId,
      token,
      player,
      npcName: this.resolveSpeaker(page, placementName),
      npcPortraitSrc: portraitSrc,
      selfSwitchPrefix: `${essentials.essentialsMapId}:${essentials.eventId}:`,
      essentials,
      eventCell,
      placementId,
      isTouch,
      sightPushCell,
      startMapId: player.currentMapId,
      stringVars: {},
      nodesRun: 0,
      pendingWrites: emptyEventStateWrites(),
      lastStep: null,
      scrollEndsAt: 0
    };
    this.sessions.set(userId, session);

    const nodes = parseCommands(page.commands);
    try {
      await this.run(session, nodes);
      // Clean end: commit the remaining buffered state changes. Aborted
      // sessions (stale token) and crashed scripts skip this on purpose —
      // discarding half-applied state lets the autorun replay next join.
      if (this.sessions.get(userId)?.token === token) {
        await this.flushEventWrites(session);
        // Sight-trap gate: if the event that spotted the player is STILL an
        // armed touch page (the guard was not satisfied, the trainer not
        // beaten), return the player to where they were before crossing the
        // sight line — closing the dialog must never open the way.
        await this.applySightPushBackIfArmed(session);
      }
    } finally {
      if (this.sessions.get(userId)?.token === token) {
        this.emitStep(session, { type: "end" });
        this.sessions.delete(userId);
        // Push updated event state so conditional NPCs re-evaluate after an event
        // changed switches/self-switches.
        void this.emitEventState(userId);
        // After a manual interaction, let follow-up autorun pages play (e.g. the
        // professor's congratulation once a starter has been chosen).
        if (!isAutorun) {
          void this.runAutorunForMap(userId);
        }
      }
    }
    // Tell callers (the autorun chaining loop) whether this run completed or
    // was aborted (abort() stamps token = -1), so an abort mid-loop doesn't
    // restart the same event for a player who just disconnected.
    return session.token === token ? ("completed" as const) : ("aborted" as const);
  }

  public submitAdvance(userId: number, text?: string) {
    const pending = this.pending.get(userId);
    if (pending?.kind === "advance") {
      this.pending.delete(userId);
      pending.resolve();
    } else if (pending?.kind === "name") {
      this.pending.delete(userId);
      pending.resolve(typeof text === "string" ? text : "");
    }
  }

  public submitChoice(userId: number, index: number) {
    const pending = this.pending.get(userId);
    if (pending?.kind === "choice") {
      this.pending.delete(userId);
      pending.resolve(index);
    }
  }

  /**
   * Re-selects the event's active page after the session's writes committed;
   * if it is still an armed touch/sight page, the gate stayed locked and the
   * spotted player is pushed back out of the sight corridor.
   */
  private async applySightPushBackIfArmed(session: Session) {
    if (!session.sightPushCell) {
      return;
    }
    const state = await this.auth.getEventState(session.userId);
    const page = this.selectActivePage(session.essentials, session.player, state);
    if (page && (page.trigger === 1 || page.trigger === 2)) {
      this.applySightPushBack(session);
    }
  }

  /** Returns a sight-spotted player to the tile they were caught from. */
  private applySightPushBack(session: Session) {
    const player = session.player;
    if (
      !session.sightPushCell ||
      player.currentMapId !== session.startMapId ||
      // Never relocate a surfing player: teleport() lands them as walkers and
      // could snap them out of the water entirely.
      player.isSurfing
    ) {
      return;
    }
    player.stopMovement();
    player.teleport(player.currentMapId, session.sightPushCell.x * 32, session.sightPushCell.y * 32);
    this.world.players.set(player.socketId, player);
    // The trap must re-fire immediately if they march straight back in.
    this.touchCooldownReset?.(session.userId);
  }

  /** Wired by the socket layer so a push-back clears the touch-event cooldown. */
  public setTouchCooldownReset(reset: (userId: number) => void) {
    this.touchCooldownReset = reset;
  }

  public abort(userId: number) {
    const session = this.sessions.get(userId);
    if (session) {
      session.token = -1; // invalidate the running interpreter
      // An aborted sight-trap session (disconnect mid-dialog, superseded run)
      // discards its writes, so the gate is by definition still locked: push
      // the player back out now — otherwise closing the app in front of a
      // guard and logging back in would leave them past the sight line.
      this.applySightPushBack(session);
    }
    const pending = this.pending.get(userId);
    if (pending) {
      this.pending.delete(userId);
      // Unblock any awaiting run so it can notice the stale token and stop.
      if (pending.kind === "choice") {
        pending.resolve(-1);
      } else if (pending.kind === "name") {
        pending.resolve("");
      } else {
        pending.resolve();
      }
    }
    this.sessions.delete(userId);
  }

  public handleDisconnect(userId: number) {
    this.pendingTouches.delete(userId);
    this.abort(userId);
  }

  /**
   * Pushes the player's RPG Maker event state (switches/variables/self-switches)
   * so the client can decide which conditional NPCs/events are actually active
   * and hide the rest (RMXP page conditions).
   */
  public async emitEventState(userId: number) {
    const player = this.world.getPlayerByUserId(userId);
    if (!player) {
      return;
    }
    const state = await this.auth.getEventState(userId);
    // Cache on the player so the world can resolve conditional NPC collision
    // synchronously during movement ticks.
    player.eventState = state;
    // Clients additionally receive the session temp switches and the server's
    // script-switch environment (clock) so their page-selection mirror agrees
    // with the server about which page each event shows.
    const payload = {
      ...state,
      tempSwitches: { ...player.tempSwitches },
      env: currentEventEnv()
    };
    player.socketConnections.forEach((socketId) => {
      this.io.to(socketId).emit("event:state", payload);
    });
  }

  // -- interpreter ---------------------------------------------------------
  private async run(session: Session, nodes: Node[]): Promise<"exit" | "done"> {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (this.sessions.get(session.userId)?.token !== session.token) {
        return "exit"; // superseded / aborted
      }
      // A mis-authored jump loop must end the session, not freeze the player.
      session.nodesRun += 1;
      if (session.nodesRun > 5000) {
        return "exit";
      }

      try {
        const flow = await this.runNode(session, node);
        if (flow === "exit") {
          return "exit";
        }
      } catch (signal) {
        if (signal instanceof JumpToLabel) {
          // Jump to Label: land on a label in THIS scope, else bubble up so an
          // ancestor scope (where RMXP labels usually live) can catch it.
          const target = nodes.findIndex(
            (candidate) => candidate.kind === "label" && candidate.name === signal.name
          );
          if (target === -1) {
            throw signal;
          }
          index = target; // continue after the label
          continue;
        }
        throw signal;
      }
    }
    return "done";
  }

  private async runNode(session: Session, node: Node): Promise<"exit" | "done"> {
    {
      switch (node.kind) {
        case "text": {
          this.emitStep(session, {
            type: "text",
            npcName: session.npcName,
            text: this.interpolateStringVars(session, node.text)
          });
          await this.waitAdvance(session.userId);
          break;
        }
        case "choices": {
          // If a choice leads to receiving a Pokemon (the lab starter), show that
          // Pokemon's portrait so the player sees what they'll get.
          const starterSpecies = findStarterSpecies(node.branches);
          this.emitStep(session, {
            type: "choices",
            npcName: session.npcName,
            text: this.interpolateStringVars(session, node.prompt),
            choices: node.choices,
            ...(starterSpecies ? { portraitPokemonId: `pokemon-${starterSpecies}` } : {})
          });
          const chosen = await this.waitChoice(session.userId);
          if (this.sessions.get(session.userId)?.token !== session.token) {
            return "exit";
          }
          const branch =
            node.branches.find((candidate) => candidate.when === chosen) ??
            node.branches.find((candidate) => candidate.when === "cancel");
          if (branch) {
            const result = await this.run(session, branch.body);
            if (result === "exit") {
              return "exit";
            }
          }
          break;
        }
        case "condition": {
          const pass = await this.evaluate(session, node.test);
          const result = await this.run(session, pass ? node.then : node.otherwise);
          if (result === "exit") {
            return "exit";
          }
          break;
        }
        case "switch": {
          const lo = Math.min(node.start, node.end);
          const hi = Math.max(node.start, node.end);
          for (let id = lo; id <= hi; id += 1) {
            session.pendingWrites.switches[String(id)] = node.on;
          }
          break;
        }
        case "variable": {
          const state = await this.getSessionEventState(session);
          const operand = this.resolveOperand(node.operand, state.variables);
          for (let id = node.start; id <= node.end; id += 1) {
            const current = Number(state.variables[String(id)] ?? 0);
            session.pendingWrites.variables[String(id)] =
              this.applyVariableOp(current, node.op, operand);
          }
          break;
        }
        case "gold": {
          // Money changes persist immediately (like battles/purchases);
          // checkpoint the buffered event state so they stay consistent.
          await this.flushEventWrites(session);
          const state = await this.getSessionEventState(session);
          const amount = this.resolveOperand(node.operand, state.variables);
          const user = await this.auth.getUserForBattle(session.userId);
          if (user && amount !== 0) {
            await this.auth.saveBattleState(session.userId, {
              money: user.money + (node.add ? amount : -amount)
            });
            await this.refreshSession(session);
          }
          break;
        }
        case "selfSwitch":
          session.pendingWrites.selfSwitches[`${session.selfSwitchPrefix}${node.ch}`] = node.on;
          break;
        case "script": {
          // Scripts can persist things on their own (pokemon grants, skin,
          // name, battles); checkpoint the buffered state first so those
          // side effects never outlive a later rollback.
          await this.flushEventWrites(session);
          if ((await this.applyScript(session, node.text)) === "exit") {
            return "exit";
          }
          break;
        }
        case "label":
          break;
        case "jump":
          throw new JumpToLabel(node.name);
        case "wait":
          // RMXP waits are 20 frames/second; capped so a mis-authored wait
          // can't freeze the session.
          await this.sleep(Math.min(node.frames * 50, 4000));
          break;
        case "picture":
          this.emitStep(session, {
            type: "picture",
            op: node.op,
            slot: node.slot,
            name: node.name,
            origin: node.origin,
            x: node.x,
            y: node.y,
            opacity: node.opacity,
            durationMs: node.durationMs
          });
          break;
        case "sound":
          this.emitStep(session, {
            type: "sound",
            kind: node.soundKind,
            name: node.name,
            volume: node.volume
          });
          break;
        case "screen":
          this.emitStep(session, {
            type: "screen",
            effect: node.effect,
            durationMs: node.durationMs,
            darken: node.darken,
            power: node.power
          });
          break;
        case "scrollMap": {
          // RMXP scroll: distance*128 map units drained at 2^speed units per
          // frame at 40fps — speed 4 over 30 tiles is the classic 6s pan.
          const frames = (node.distance * 128) / Math.pow(2, node.speed);
          const durationMs = Math.round(frames * 25);
          this.emitStep(session, {
            type: "camera",
            op: "scroll",
            direction: node.direction,
            distanceTiles: node.distance,
            durationMs
          });
          session.scrollEndsAt = Math.max(session.scrollEndsAt, Date.now() + durationMs);
          break;
        }
        case "waitScroll": {
          // Wait for Move's Completion (210): the interpreter side of move
          // routes lives in NpcActors, so the pending camera pan is what this
          // actually holds for. Capped so bad data can't freeze the session.
          const remainingMs = session.scrollEndsAt - Date.now();
          if (remainingMs > 0) {
            await this.sleep(Math.min(remainingMs, 20000));
          }
          break;
        }
        case "animation": {
          const meta = animationMeta(node.animationId);
          this.emitStep(session, {
            type: "animation",
            animationId: node.animationId,
            name: meta?.name,
            se: meta?.se,
            targetCell: node.onEvent ? session.eventCell : null
          });
          break;
        }
        case "transfer": {
          // Commit buffered state BEFORE moving the player: the intro sets
          // its "don't run again" self-switch a few commands before the
          // transfer out, and persisting the two together closes the window
          // where quitting the app left the switch set but the player still
          // parked in the (black, exit-less) intro room.
          await this.flushEventWrites(session);
          this.transferPlayer(session, node.mapId, node.x, node.y);
          break;
        }
        case "recoverAll": {
          await this.flushEventWrites(session);
          const healed = await this.auth.healPokemonParty(session.userId);
          if (healed) {
            await this.refreshSession(session);
          }
          break;
        }
        case "exit":
          return "exit";
      }
    }
    return "done";
  }

  /** RMXP Transfer Player (201): move to another map at a cell position. */
  private transferPlayer(session: Session, essentialsMapId: number, cellX: number, cellY: number) {
    const player = session.player;
    const mapId = `map-essentials-${String(essentialsMapId).padStart(3, "0")}`;
    const snapshot = this.world.getPlayableMapsState();
    if (!snapshot?.editorDataByMapId[mapId]) {
      return; // destination not imported; stay put instead of falling into a void
    }
    if (session.isTouch) {
      // Door/entrance chime for touch transfers (the original plays it from a
      // move-route SE we don't replay).
      this.emitStep(session, { type: "sound", kind: "SE", name: "Entering Door" });
    }
    player.stopMovement();
    player.teleport(mapId, cellX * 32, cellY * 32);
    this.world.players.set(player.socketId, player);
    this.world.presentPlayerToMap(player);
    player.socketConnections.forEach((socketId) => {
      this.world.presentPlayersOnMapTo(socketId, player.currentMapId);
    });
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  /**
   * Event-state reads inside a running session must see the session's own
   * buffered (not yet committed) writes, or in-event conditions that test a
   * switch the event just set would misbehave.
   */
  private async getSessionEventState(session: Session) {
    const state = await this.auth.getEventState(session.userId);
    for (const [id, on] of Object.entries(session.pendingWrites.switches)) {
      if (on) {
        state.switches[id] = true;
      } else {
        delete state.switches[id];
      }
    }
    for (const [id, value] of Object.entries(session.pendingWrites.variables)) {
      state.variables[id] = value;
    }
    for (const [key, on] of Object.entries(session.pendingWrites.selfSwitches)) {
      if (on) {
        state.selfSwitches[key] = true;
      } else {
        delete state.selfSwitches[key];
      }
    }
    return state;
  }

  /** Checkpoint: persist the session's buffered event-state writes. */
  private async flushEventWrites(session: Session) {
    const writes = session.pendingWrites;
    session.pendingWrites = emptyEventStateWrites();
    await this.auth.applyEventStateWrites(session.userId, writes);
  }

  private resolveOperand(operand: Operand, variables: Record<string, number>): number {
    switch (operand.type) {
      case "const":
        return operand.value;
      case "variable":
        return Number(variables[String(operand.id)] ?? 0);
      case "random":
        return operand.min + Math.floor(Math.random() * (operand.max - operand.min + 1));
    }
  }

  /** RMXP Control Variables operations: set/add/sub/mul/div/mod. */
  private applyVariableOp(current: number, op: number, operand: number): number {
    switch (op) {
      case 0: return operand;
      case 1: return current + operand;
      case 2: return current - operand;
      case 3: return current * operand;
      case 4: return operand !== 0 ? Math.trunc(current / operand) : current;
      case 5: return operand !== 0 ? current % operand : current;
      default: return current;
    }
  }

  /**
   * Grants an item named by an event script and (for item balls / gift items,
   * which announce themselves in Essentials) shows the pickup line. Returns
   * whether anything was actually granted.
   */
  private async grantScriptedItem(
    session: Session,
    ref: { symbol?: string; legacyNumber?: number },
    announce: "found" | "received" | null,
    quantity = 1
  ): Promise<boolean> {
    if (!this.battleManager) {
      return false;
    }
    const grant = await this.battleManager.grantEventItem(session.userId, ref, quantity);
    if (!grant.ok) {
      return false;
    }
    if (announce) {
      this.emitStep(session, {
        type: "info",
        npcName: session.npcName,
        text:
          announce === "found"
            ? `¡Has encontrado ${grant.itemName}!`
            : `¡Has recibido ${grant.itemName}!`
      });
      await this.waitAdvance(session.userId);
    }
    await this.refreshSession(session);
    return true;
  }

  /**
   * Item grants named inside a script — either a plain Script command or a
   * script *condition* (item balls live there: the pbItemBall call is the
   * test and the branch body sets Self Switch A to consume the ball).
   * Returns null when the script is not an item grant.
   */
  private async applyScriptedItemGrant(session: Session, text: string): Promise<boolean | null> {
    const ballVar = text.match(RE_ITEM_BALL_VAR);
    if (ballVar) {
      const state = await this.getSessionEventState(session);
      const legacyNumber = Number(state.variables[String(Number(ballVar[1]))] ?? 0);
      return this.grantScriptedItem(session, { legacyNumber }, "found");
    }
    const ball = text.match(RE_ITEM_BALL);
    if (ball) {
      return this.grantScriptedItem(session, { symbol: ball[1] }, "found");
    }
    const receiveVar = text.match(RE_RECEIVE_ITEM_VAR);
    if (receiveVar) {
      // Kurt's finished ball: `pbReceiveItem(pbGet(8))` — the variable holds a
      // legacy numeric item id written by pbConvertItemToItem.
      const state = await this.getSessionEventState(session);
      const legacyNumber = Number(state.variables[String(Number(receiveVar[1]))] ?? 0);
      return this.grantScriptedItem(session, { legacyNumber }, "received");
    }
    const receive = text.match(RE_RECEIVE_ITEM);
    if (receive) {
      return this.grantScriptedItem(session, { symbol: receive[1] }, "received");
    }
    const store = text.match(RE_STORE_ITEM);
    if (store) {
      return this.grantScriptedItem(session, { symbol: store[1] }, null);
    }
    return null;
  }

  private async evaluate(session: Session, test: ConditionTest): Promise<boolean> {
    const state = await this.getSessionEventState(session);
    switch (test.kind) {
      case "switch":
        return Boolean(state.switches[String(test.id)]) === test.on;
      case "selfSwitch":
        return Boolean(state.selfSwitches[`${session.selfSwitchPrefix}${test.ch}`]) === test.on;
      case "variable": {
        const left = Number(state.variables[String(test.id)] ?? 0);
        // RMXP operand: constant, or ANOTHER variable's value (quest counters
        // are sometimes compared variable-to-variable).
        const right = test.constant
          ? test.value
          : Number(state.variables[String(test.value)] ?? 0);
        switch (test.op) {
          case 0: return left === right;
          case 1: return left >= right;
          case 2: return left <= right;
          case 3: return left > right;
          case 4: return left < right;
          case 5: return left !== right;
          default: return false;
        }
      }
      case "item": {
        // Conditional Branch: [Item] in Inventory — the RMXP id maps to an
        // Essentials internal name via the legacy item table. An item the
        // catalogs don't know stays "not owned" (fails closed) and is surfaced
        // by the migration report.
        const symbol = LEGACY_ITEM_INTERNAL_BY_NUMBER[test.legacyId];
        if (!symbol || !this.battleManager) {
          logUnsupportedScript(
            "condition",
            `Conditional Branch item ${test.legacyId} (no legacy mapping)`,
            this.sessionContext(session)
          );
          return false;
        }
        return (await this.battleManager.getEventItemQuantity(session.userId, symbol)) > 0;
      }
      case "unsupported":
        logUnsupportedScript(
          "condition",
          `Conditional Branch type ${test.branchType}`,
          this.sessionContext(session)
        );
        return false;
      case "gold": {
        const user = await this.auth.getUserForBattle(session.userId);
        const money = user?.money ?? 0;
        return test.gte ? money >= test.amount : money <= test.amount;
      }
      case "script": {
        const trainerBattle = matchTrainerBattle(test.text);
        if (trainerBattle) {
          // The battle IS the condition: its outcome selects the branch
          // (win -> self switch A = trainer defeated, like Essentials).
          return this.runScriptedTrainerBattle(
            session,
            trainerBattle.trainerType,
            trainerBattle.trainerName
          );
        }
        const wildBattle = test.text.match(RE_WILD_BATTLE);
        if (wildBattle) {
          // Same idea for static wild encounters: catching/defeating the
          // venomon selects the branch that consumes the overworld event.
          return this.runScriptedWildBattle(session, wildBattle[1], Number(wildBattle[2]));
        }
        const giftPokemon = test.text.match(RE_ADD_POKEMON);
        if (giftPokemon) {
          // Hidden/gift venomons are authored as `Conditional Branch:
          // pbAddPokemon(:SPECIES, level)` — the grant IS the condition, and
          // the then-branch sets the Self Switch that consumes the event.
          // Only hand it over when there is an empty team slot; when the party
          // is full we refuse (return false, so the event is NOT consumed) and
          // ask the player to make room and come back.
          const result = await this.auth.givePokemonBySpecies(
            session.userId,
            giftPokemon[1],
            Number(giftPokemon[2]),
            { boxWhenFull: false }
          );
          if (result.ok) {
            this.emitStep(session, {
              type: "info",
              npcName: session.npcName,
              text: `¡Has recibido a ${result.pokemonName}!`
            });
            await this.waitAdvance(session.userId);
            await this.refreshSession(session);
            return true;
          }
          if (result.partyFull) {
            this.emitStep(session, {
              type: "info",
              npcName: session.npcName,
              text: "No tienes espacio en tu equipo. Haz sitio en tu equipo y vuelve más tarde."
            });
            await this.waitAdvance(session.userId);
            return false;
          }
          // Misconfigured gift (unknown species / missing account): grant
          // nothing and leave the event unconsumed so it can be fixed and
          // retried, rather than silently burning it.
          return false;
        }
        const eggGift = test.text.match(RE_GENERATE_EGG);
        if (eggGift) {
          // pbGenerateEgg mirrors the gift flow, but hands over an egg and
          // strictly requires a free PARTY slot (an egg is never boxed). When
          // full we refuse (return false, event not consumed) so the player can
          // make room and come back — exactly what the NPC's dialogue promises.
          const result = await this.auth.giveEggBySpecies(session.userId, eggGift[1]);
          if (result.ok) {
            await this.recordEggGrant(session);
            this.emitStep(session, {
              type: "info",
              npcName: session.npcName,
              text: "¡Has recibido un Huevo!"
            });
            await this.waitAdvance(session.userId);
            await this.refreshSession(session);
            return true;
          }
          if (result.partyFull) {
            this.emitStep(session, {
              type: "info",
              npcName: session.npcName,
              text: "No tienes espacio en tu equipo. Haz sitio para el Huevo y vuelve más tarde."
            });
            await this.waitAdvance(session.userId);
            return false;
          }
          return false;
        }
        const eggReady = test.text.match(RE_EGG_GENERATED);
        if (eggReady) {
          // Day Care ("Criador"): an egg is waiting whenever this NPC's weekly
          // cooldown has elapsed (or was never started). Saying yes then runs
          // pbDayCareGenerateEgg, which actually hands the egg over.
          return (await this.eggCooldownRemaining(session)) <= 0;
        }
        const partyLength = test.text.match(RE_PARTY_LENGTH);
        if (partyLength) {
          const user = await this.auth.getUserForBattle(session.userId);
          const count = user?.pokemonParty?.length ?? 0;
          return compareNumbers(partyLength[1], count, Number(partyLength[2]));
        }
        const pokemonCount = test.text.match(RE_POKEMON_COUNT);
        if (pokemonCount) {
          const user = await this.auth.getUserForBattle(session.userId);
          const count = (user?.pokemonParty ?? []).filter((pokemon) => !pokemon.isEgg).length;
          return compareNumbers(pokemonCount[1], count, Number(pokemonCount[2]));
        }
        // Item balls are usually authored as script conditions whose branch
        // body sets Self Switch A. Granting here (and failing the test when
        // nothing could be granted) means the ball is only consumed when the
        // player really got the item.
        const itemGrant = await this.applyScriptedItemGrant(session, test.text);
        if (itemGrant !== null) {
          return itemGrant;
        }
        // Gym progression gates. Badges are now real (see applyScript), so
        // `$Trainer.numbadges>=N` / `$Trainer.badges[N]` checkpoints actually
        // enforce instead of always passing.
        const numBadges = test.text.match(RE_NUMBADGES);
        if (numBadges) {
          const count = (await this.auth.getBadges(session.userId)).length;
          const target = Number(numBadges[2]);
          switch (numBadges[1]) {
            case ">=": return count >= target;
            case "<=": return count <= target;
            case ">": return count > target;
            case "<": return count < target;
            case "==": return count === target;
            case "!=": return count !== target;
            default: return true;
          }
        }
        const hasBadge = test.text.match(RE_HAS_BADGE);
        if (hasBadge) {
          const badges = await this.auth.getBadges(session.userId);
          return badges.includes(Number(hasBadge[1]));
        }
        // Field-skill obstacle gates (Cut trees, Rock Smash rocks): the branch —
        // whose body erases the obstacle — only runs when a party Venomon knows
        // the move. Otherwise the obstacle stays put and we hint what's needed.
        const isCut = RE_CUT.test(test.text);
        if (isCut || RE_ROCKSMASH_COND.test(test.text)) {
          const skill = isCut ? "cut" : "rocksmash";
          const knows = this.battleManager
            ? await this.battleManager.partyKnowsFieldSkill(session.userId, skill)
            : false;
          if (!knows) {
            this.emitStep(session, {
              type: "info",
              npcName: session.npcName,
              text: isCut
                ? "Parece que un árbol fino bloquea el paso. Se podría talar con Corte."
                : "Una roca resquebrajada bloquea el paso. Se podría romper con Golpe Roca."
            });
            await this.waitAdvance(session.userId);
          }
          return knows;
        }
        // Version-adapter recognizers (item quantities, temp switches,
        // game switches, feature checks...). These are the conditions that
        // gate key-item routes and story doors, so they must be real.
        // Fossil reviver pickup: `pbAddToParty(pbGet(9),1)` — the variable
        // still holds the fossil's legacy ITEM number (pbConvertItemToPokemon
        // keeps it); the species comes from this event's conversion pairs.
        const addToParty = test.text.match(RE_ADD_TO_PARTY_VAR);
        if (addToParty) {
          const legacyNumber = Number(state.variables[String(Number(addToParty[1]))] ?? 0);
          const species = this.resolveConvertedSpecies(session, legacyNumber);
          if (!species) {
            return false;
          }
          const level = Math.max(1, Number(addToParty[2] ?? 5) || 5);
          const result = await this.auth.givePokemonBySpecies(session.userId, species, level, {
            boxWhenFull: false
          });
          if (result.ok) {
            this.emitStep(session, {
              type: "info",
              npcName: session.npcName,
              text: `¡Has recibido a ${result.pokemonName}!`
            });
            await this.waitAdvance(session.userId);
            await this.refreshSession(session);
            return true;
          }
          if (result.partyFull) {
            this.emitStep(session, {
              type: "info",
              npcName: session.npcName,
              text: "No tienes espacio en tu equipo. Haz sitio en tu equipo y vuelve más tarde."
            });
            await this.waitAdvance(session.userId);
          }
          return false;
        }
        // Party-member introspection for chooser flows (name rater, trades):
        // the variable holds a party index written by pbChoosePokemon.
        const eggQuery = test.text.match(RE_GET_POKEMON_EGG);
        if (eggQuery) {
          const pokemon = await this.partyPokemonFromVar(session, Number(eggQuery[1]));
          return pokemon?.isEgg === true;
        }
        if (RE_GET_POKEMON_SHADOW.test(test.text)) {
          return false; // shadow venomons are not simulated
        }
        const foreignQuery = test.text.match(RE_GET_POKEMON_FOREIGN);
        if (foreignQuery) {
          const pokemon = await this.partyPokemonFromVar(session, Number(foreignQuery[1]));
          return Boolean(pokemon?.foreignOt);
        }
        const checkAble = test.text.match(RE_CHECK_ABLE_VAR);
        if (checkAble) {
          const pokemon = await this.partyPokemonFromVar(session, Number(checkAble[2]));
          const able = Boolean(pokemon && !pokemon.isEgg && pokemon.hp > 0);
          return checkAble[1] === "!" ? !able : able;
        }
        // Name rater: "kept the same nickname?" compares the entered string
        // variable against the current-name string variable.
        const stringCompare = test.text.match(RE_STRING_VAR_EMPTY_OR_EQ);
        if (stringCompare) {
          const entered = session.stringVars[String(Number(stringCompare[1]))] ?? "";
          const current = session.stringVars[String(Number(stringCompare[3]))] ?? "";
          return entered === "" || entered === current;
        }
        // Cutscene positioning checks ($game_player.x==N) — tile coordinates.
        const coordCheck = test.text.match(RE_PLAYER_CELL_COORD);
        if (coordCheck) {
          const player = session.player;
          const cell =
            coordCheck[1].toLowerCase() === "x"
              ? Math.floor((player.x + player.width / 2) / 32)
              : Math.floor((player.y + player.height / 2) / 32);
          return cell === Number(coordCheck[2]);
        }
        const recognized = recognizeScriptCondition(test.text);
        if (recognized) {
          switch (recognized.kind) {
            case "itemQuantity": {
              const quantity = this.battleManager
                ? await this.battleManager.getEventItemQuantity(session.userId, recognized.itemSymbol)
                : 0;
              return compareNumbers(recognized.op, quantity, recognized.value);
            }
            case "hasItem": {
              const quantity = this.battleManager
                ? await this.battleManager.getEventItemQuantity(session.userId, recognized.itemSymbol)
                : 0;
              return recognized.negated ? quantity <= 0 : quantity > 0;
            }
            case "canStoreItem":
              return true; // the online bag has no capacity limit
            case "boxesFull":
              // PC boxes are endless online, so they are never full.
              return recognized.negated;
            case "daycareDeposited":
              // The original day-care deposit system is not simulated.
              return compareNumbers(recognized.op, 0, recognized.value);
            case "tempSwitch": {
              const key = `${session.selfSwitchPrefix}${recognized.channel}`;
              const on = session.player.tempSwitches[key] === true;
              return recognized.on ? on : !on;
            }
            case "onEvent": {
              // get_character(0).onEvent?: the player stands exactly on this
              // event's tile (door/line-of-sight templates). Touch sessions
              // fired by standing on the event qualify by construction.
              if (!session.eventCell) {
                return session.isTouch;
              }
              const cellX = Math.floor((session.player.x + session.player.width / 2) / 32);
              const cellY = Math.floor((session.player.y + session.player.height / 2) / 32);
              return cellX === session.eventCell.x && cellY === session.eventCell.y;
            }
            case "gameSwitch": {
              const on = Boolean(state.switches[String(recognized.id)]);
              return recognized.negated ? !on : on;
            }
            case "variableCompare":
              return compareNumbers(
                recognized.op,
                Number(state.variables[String(recognized.id)] ?? 0),
                recognized.value
              );
            case "alwaysFalse":
              return false;
            case "alwaysTrue":
              return true;
          }
        }
        // Unknown script tests FAIL CLOSED: story gates live in script
        // conditions, and silently passing them is how sequence breaks
        // happened. The else-branch (usually a refusal line) runs instead,
        // and the script is logged for the migration report.
        logUnsupportedScript("condition", test.text, this.sessionContext(session));
        return false;
      }
      case "always":
        return test.value;
    }
  }

  /** map/event context string for the unsupported-script log. */
  private sessionContext(session: Session): string {
    return `map ${session.essentials.essentialsMapId} event ${session.essentials.eventId}`;
  }

  /** Runs a real trainer battle for a pbTrainerBattle script and reports the result. */
  private async runScriptedTrainerBattle(
    session: Session,
    trainerTypeEssentialsId: string,
    trainerName: string
  ): Promise<boolean> {
    if (!this.battleManager) {
      return true;
    }

    // Battle results persist immediately (party HP, exp); checkpoint the
    // buffered event state so a later abort can't roll back behind them.
    await this.flushEventWrites(session);

    // Close the dialog: the battle scene takes over; the event resumes after.
    this.emitStep(session, { type: "end" });

    const start = await this.battleManager.startScriptedTrainerBattle(
      session.userId,
      trainerTypeEssentialsId,
      trainerName
    );

    if (!start.ok) {
      this.emitStep(session, { type: "info", npcName: session.npcName, text: start.message });
      await this.waitAdvance(session.userId);
      return false; // no battle happened: the trainer is NOT defeated
    }

    return new Promise<boolean>((resolve) => {
      // Safety valve so an abandoned battle can't hold the session forever.
      const timer = setTimeout(() => resolve(false), 15 * 60 * 1000);
      this.battleManager!.onBattleEnd(start.battleId, (winnerSideId) => {
        clearTimeout(timer);
        resolve(winnerSideId === start.playerSideId);
      });
    });
  }

  /**
   * Runs a real wild battle for a pbWildBattle script. Returns true when the
   * player resolved the encounter (caught or defeated the wild venomon);
   * false when they fled, lost, or the battle could not start.
   */
  private async runScriptedWildBattle(
    session: Session,
    speciesEssentialsId: string,
    level: number
  ): Promise<boolean> {
    if (!this.battleManager) {
      return true;
    }

    // Battle results persist immediately (party HP, exp, the caught venomon);
    // checkpoint the buffered event state so a later abort can't roll back
    // behind them.
    await this.flushEventWrites(session);

    // Close the dialog: the battle scene takes over; the event resumes after.
    this.emitStep(session, { type: "end" });

    const start = await this.battleManager.startScriptedWildBattle(
      session.userId,
      speciesEssentialsId,
      level
    );

    if (!start.ok) {
      this.emitStep(session, { type: "info", npcName: session.npcName, text: start.message });
      await this.waitAdvance(session.userId);
      return false; // no battle happened: the encounter stays available
    }

    return new Promise<boolean>((resolve) => {
      // Safety valve so an abandoned battle can't hold the session forever.
      const timer = setTimeout(() => resolve(false), 15 * 60 * 1000);
      this.battleManager!.onBattleEnd(start.battleId, (winnerSideId) => {
        clearTimeout(timer);
        // Winning covers both catching and knocking out the wild venomon.
        resolve(winnerSideId === start.playerSideId);
      });
    });
  }

  /** Returns "exit" when the rest of the event must not run (e.g. an
   *  unresolved wild encounter whose later commands would consume it). */
  private async applyScript(session: Session, text: string): Promise<"exit" | undefined> {
    // Essentials temp switches: per-event, session-scoped state (the door and
    // daily-event templates). They refresh page selection immediately but are
    // never persisted — leaving the map resets them, like the original.
    const tempSwitch = text.match(RE_SET_TEMP_SWITCH);
    if (tempSwitch) {
      const key = `${session.selfSwitchPrefix}${tempSwitch[2]}`;
      if (tempSwitch[1].toLowerCase() === "on") {
        session.player.tempSwitches[key] = true;
      } else {
        delete session.player.tempSwitches[key];
      }
      await this.emitEventState(session.userId);
      return;
    }

    // pbSetSelfSwitch(20,"A",true): sets ANOTHER event's (persistent) self
    // switch on the same map — cutscenes use it to unlock doors / clear
    // blockers. Buffered like the event's own self-switch writes.
    const otherSelfSwitch = text.match(RE_SET_SELF_SWITCH_OTHER);
    if (otherSelfSwitch) {
      const key = `${session.essentials.essentialsMapId}:${Number(otherSelfSwitch[1])}:${otherSelfSwitch[2]}`;
      session.pendingWrites.selfSwitches[key] = otherSelfSwitch[3].toLowerCase() === "true";
      return;
    }

    // Cut / Rock Smash body: remove the obstacle (persist + push immediately so
    // it vanishes for this player even if a rock-smash encounter starts next),
    // then optionally roll a wild encounter for rocks.
    if (RE_ERASE_EVENT.test(text)) {
      session.pendingWrites.selfSwitches[`${session.selfSwitchPrefix}${ERASED_SELF_SWITCH}`] = true;
      await this.flushEventWrites(session);
      await this.emitEventState(session.userId);
      return;
    }
    if (RE_ROCKSMASH_ENCOUNTER.test(text)) {
      if (this.battleManager) {
        await this.battleManager.tryRockSmashEncounter(session.userId, session.player);
      }
      return;
    }

    const addPokemon = text.match(RE_ADD_POKEMON);
    if (addPokemon) {
      const result = await this.auth.givePokemonBySpecies(
        session.userId,
        addPokemon[1],
        Number(addPokemon[2])
      );
      if (result.ok) {
        this.emitStep(session, {
          type: "info",
          npcName: session.npcName,
          text: result.boxed
            ? `${result.pokemonName} was sent to storage.`
            : `You received ${result.pokemonName}!`
        });
        await this.waitAdvance(session.userId);
        await this.refreshSession(session);
      }
      return;
    }

    const generateEgg = text.match(RE_GENERATE_EGG);
    if (generateEgg) {
      // Egg authored as a plain Script command. Same rule as the gift path: an
      // egg needs a free party slot, otherwise the player is told to make room.
      const result = await this.auth.giveEggBySpecies(session.userId, generateEgg[1]);
      this.emitStep(session, {
        type: "info",
        npcName: session.npcName,
        text: result.ok
          ? "¡Has recibido un Huevo!"
          : "No tienes espacio en tu equipo para el Huevo."
      });
      await this.waitAdvance(session.userId);
      if (result.ok) {
        await this.recordEggGrant(session);
        await this.refreshSession(session);
      }
      return;
    }

    const daycareEgg = text.match(RE_DAYCARE_GENERATE_EGG);
    if (daycareEgg) {
      // Day Care ("Criador") egg pickup. The script's own Show Text already
      // announced the egg and guarded the party-space check ($Trainer.party
      // .length>=6), so here we just hand it over. Without a breeding sim the
      // egg is bred from the player's lead (non-egg) species.
      const user = await this.auth.getUserForBattle(session.userId);
      const lead = (user?.pokemonParty ?? []).find((pokemon) => !pokemon.isEgg);
      const speciesInternal = lead?.sourcePokemonId
        ? lead.sourcePokemonId.replace(/^pokemon-/i, "")
        : "EEVEE";
      const result = await this.auth.giveEggBySpecies(session.userId, speciesInternal);
      if (result.ok) {
        await this.recordEggGrant(session);
        await this.refreshSession(session);
      } else if (result.partyFull) {
        this.emitStep(session, {
          type: "info",
          npcName: session.npcName,
          text: "No tienes espacio en tu equipo para el Huevo."
        });
        await this.waitAdvance(session.userId);
      }
      return;
    }

    const mart = text.match(RE_POKEMON_MART);
    if (mart) {
      // pbPokemonMart([:POTION, :POKEBALL, ...]) — resolve the Essentials
      // symbols against the item catalog (prices live there) and open the
      // regular store overlay on the client.
      const placement = this.world
        .getPlayableMapsState()
        ?.editorDataByMapId[templateMapIdFor(session.player.currentMapId)]?.npcs.find(
          (candidate) => candidate.id === session.placementId
        ) as
        | {
            x?: number;
            y?: number;
            interactionDistanceSquares?: number;
            storeItems?: Array<{ itemId: string; itemName: string; quantity: number; price: number }>;
          }
        | undefined;
      // A designer stock override on the placement (map editor "Mart Stock")
      // replaces the imported script's item list entirely.
      const overrideItems = sanitizeNpcStoreItems(placement?.storeItems) ?? [];
      const symbols = Array.from(mart[1].matchAll(/:(\w+)/g)).map((match) => match[1]);
      const items =
        overrideItems.length > 0
          ? overrideItems
          : (await this.battleManager?.resolveMartItems(symbols)) ?? [];
      if (items.length === 0) {
        return;
      }
      this.activeMartsByUser.set(session.userId, {
        placementId: session.placementId,
        items,
        expiresAt: Date.now() + 10 * 60 * 1000
      });
      this.emitStep(session, {
        type: "store",
        npcName: session.npcName,
        placementId: session.placementId,
        x: typeof placement?.x === "number" ? placement.x : 0,
        y: typeof placement?.y === "number" ? placement.y : 0,
        interactionDistanceSquares:
          typeof placement?.interactionDistanceSquares === "number"
            ? placement.interactionDistanceSquares
            : 2,
        items
      });
      return;
    }

    if (RE_POKEMON_PC.test(text)) {
      // Pokemon Center / bedroom PC: open the box storage overlay anchored to
      // this computer's cell so walking away closes it (same as marts).
      const placement = this.world
        .getPlayableMapsState()
        ?.editorDataByMapId[templateMapIdFor(session.player.currentMapId)]?.npcs.find(
          (candidate) => candidate.id === session.placementId
        ) as { x?: number; y?: number; interactionDistanceSquares?: number } | undefined;
      this.emitStep(session, {
        type: "pcBox",
        npcName: session.npcName || "PC",
        placementId: session.placementId,
        x: typeof placement?.x === "number" ? placement.x : 0,
        y: typeof placement?.y === "number" ? placement.y : 0,
        interactionDistanceSquares:
          typeof placement?.interactionDistanceSquares === "number"
            ? placement.interactionDistanceSquares
            : 2
      });
      return;
    }

    const itemGrant = await this.applyScriptedItemGrant(session, text);
    if (itemGrant !== null) {
      return;
    }

    if (RE_POKEDEX.test(text)) {
      await this.auth.setEventSwitches(session.userId, 999, 999, true); // pokedex-owned marker
      return;
    }

    // `$PokemonGlobal.runningShoes=true` (Mamá's "Zapatos Nike" gift): the
    // original flips a bare flag; here the flag IS the RUNNINGSHOES quest
    // item, which also gates the run key server-side. The event's own Show
    // Text announces the gift, so the grant itself stays silent.
    const runningShoes = text.match(RE_RUNNING_SHOES);
    if (runningShoes) {
      const enable = runningShoes[1].toLowerCase() === "true";
      if (enable) {
        const owned =
          (await this.battleManager?.getEventItemQuantity(session.userId, "RUNNINGSHOES")) ?? 0;
        if (owned <= 0) {
          await this.grantScriptedItem(session, { symbol: "RUNNINGSHOES" }, null);
        }
      } else if (this.battleManager) {
        await this.battleManager.removeEventItem(session.userId, { symbol: "RUNNINGSHOES" });
        session.player.setRunning(false);
        await this.refreshSession(session);
      }
      return;
    }

    // Gym leaders award a badge via `$Trainer.badges[N]=true` (or
    // pbReceiveBadge(N)). These are no longer silent no-ops — the badge is
    // persisted so it shows on the Trainer Card and unlocks numbadges gates.
    const awardBadge = text.match(RE_AWARD_BADGE) ?? text.match(RE_RECEIVE_BADGE);
    if (awardBadge) {
      const index = Number(awardBadge[1]);
      const before = await this.auth.getBadges(session.userId);
      const after = await this.auth.awardBadge(session.userId, index);
      if (after.length > before.length) {
        this.emitStep(session, {
          type: "sound",
          kind: "ME",
          name: "001-Victory01"
        });
        this.emitStep(session, {
          type: "info",
          npcName: session.npcName,
          text: `¡Has conseguido la medalla de gimnasio #${index + 1}!`
        });
        await this.waitAdvance(session.userId);
        await this.refreshSession(session);
      }
      return;
    }

    if (RE_HEAL.test(text)) {
      // Party healing handled by dedicated healer NPCs; ignore here.
      return;
    }

    const trainerBattle = matchTrainerBattle(text);
    if (trainerBattle) {
      // Some events call pbTrainerBattle as a plain script (no branch).
      await this.runScriptedTrainerBattle(
        session,
        trainerBattle.trainerType,
        trainerBattle.trainerName
      );
      return;
    }

    const wildBattle = text.match(RE_WILD_BATTLE);
    if (wildBattle) {
      const resolvedEncounter = await this.runScriptedWildBattle(
        session,
        wildBattle[1],
        Number(wildBattle[2])
      );
      // The commands after the script consume the overworld venomon (Self
      // Switch A). Only let them run when the player actually caught or
      // defeated it — fleeing or losing keeps the encounter available.
      return resolvedEncounter ? undefined : "exit";
    }

    const changePlayer = text.match(RE_CHANGE_PLAYER);
    if (changePlayer) {
      const skinId = PLAYER_SKIN_BY_INDEX[changePlayer[1]];
      if (skinId) {
        await this.auth.setCharacterSkin(session.userId, skinId);
        session.player.characterSkinId = skinId;
        // Re-present so everyone on the map sees the new skin immediately —
        // including the acting player, whom presentPlayerToMap skips.
        this.world.presentPlayerToMap(session.player);
        this.presentPlayerToOwnClient(session.player);
        await this.refreshSession(session);
      }
      return;
    }

    if (RE_TRAINER_NAME.test(text)) {
      const user = await this.auth.getPublicUserData(session.userId);
      this.emitStep(session, {
        type: "nameInput",
        npcName: session.npcName,
        text: "¿Cuál es tu nombre?",
        defaultName: user?.name ?? ""
      });
      const name = await this.waitName(session.userId);
      if (this.sessions.get(session.userId)?.token !== session.token) {
        return;
      }
      const finalName = name.trim() || user?.name || "Trainer";
      if (await this.auth.setUserName(session.userId, finalName)) {
        session.player.name = finalName;
        this.world.presentPlayerToMap(session.player);
        this.presentPlayerToOwnClient(session.player);
        await this.refreshSession(session);
      }
      return;
    }

    const toneChange = text.match(RE_TONE_CHANGE);
    if (toneChange) {
      const red = Number(toneChange[1]);
      const green = Number(toneChange[2]);
      const blue = Number(toneChange[3]);
      const frames = Number(toneChange[4]);
      // Negative tones darken the screen; zero restores it.
      const darken = Math.min(1, Math.max(0, -(red + green + blue) / 3 / 255));
      this.emitStep(session, {
        type: "screen",
        effect: "tone",
        darken,
        durationMs: frames * 25
      });
      return;
    }

    if (RE_SET_POKECENTER.test(text)) {
      await this.auth.setRespawnPoint(session.userId, {
        mapId: session.player.currentMapId,
        x: session.player.x,
        y: session.player.y
      });
      return;
    }

    const sePlay = text.match(RE_SE_PLAY);
    if (sePlay) {
      this.emitStep(session, { type: "sound", kind: "SE", name: sePlay[1] });
      // Scripted SE loops (the nurse's per-ball chime) often pair with pbWait.
      const waitMatch = text.match(RE_PB_WAIT);
      if (waitMatch) {
        await this.sleep(Math.min(Number(waitMatch[1]) * 25, 2000));
      }
      return;
    }

    const pbWait = text.match(RE_PB_WAIT);
    if (pbWait) {
      await this.sleep(Math.min(Number(pbWait[1]) * 25, 2000));
      return;
    }

    if (RE_BUTTON_SCREEN.test(text)) {
      this.emitStep(session, { type: "info", npcName: session.npcName, text: CONTROLS_HELP_TEXT });
      await this.waitAdvance(session.userId);
      return;
    }

    // -- trade / conversion NPC family (in-game trades, Kurt, fossil
    // reviver, name rater) --------------------------------------------------

    // pbTextEntry("prompt", min, max, varN): free-text entry (the name rater's
    // new nickname). Checked before the rename scripts — its combined script
    // also references pbGetPokemon but must not rename anything.
    const textEntry = text.match(RE_TEXT_ENTRY);
    if (textEntry) {
      const varId = String(Number(textEntry[4]));
      const maxLength = Math.max(1, Number(textEntry[3]) || 12);
      let prompt = textEntry[1].replace(/\s*\n\s*/g, " ");
      const pkmnVar = text.match(/pbGetPokemon\(\s*(\d+)\s*\)/i);
      if (/#\{species\}/.test(prompt) && pkmnVar) {
        const pokemon = await this.partyPokemonFromVar(session, Number(pkmnVar[1]));
        const species = pokemon ? await this.speciesDisplayNameOf(pokemon) : "";
        prompt = prompt.replace(/#\{species\}/g, species ?? "");
      }
      prompt = prompt.replace(/#\{[^}]*\}/g, "");
      this.emitStep(session, {
        type: "nameInput",
        npcName: session.npcName,
        text: prompt,
        defaultName: ""
      });
      const entered = await this.waitName(session.userId);
      if (this.sessions.get(session.userId)?.token !== session.token) {
        return;
      }
      session.stringVars[varId] = entered.trim().slice(0, maxLength);
      return;
    }

    // Name rater renames: `pkmn=pbGetPokemon(V); pkmn.name=pbGet(W)` (apply
    // the entered nickname) or `pkmn.name=PBSpecies.getName(...)` (reset to
    // the species name). The optional trailing `$game_variables[N]=pkmn.name`
    // feeds the confirmation text's \v[N].
    const renameToVar = text.match(RE_RENAME_TO_VAR);
    const renameToSpecies = renameToVar ? null : text.match(RE_RENAME_TO_SPECIES);
    if (renameToVar || renameToSpecies) {
      const state = await this.getSessionEventState(session);
      const indexVar = String(Number((renameToVar ?? renameToSpecies)![1]));
      const index = Number(state.variables[indexVar] ?? -1);
      const newName = renameToVar
        ? session.stringVars[String(Number(renameToVar[2]))] ?? ""
        : null;
      if (index >= 0 && (renameToSpecies || newName)) {
        const applied = await this.auth.renamePartyPokemon(session.userId, index, newName);
        if (applied) {
          const varAssign = text.match(RE_VAR_EQ_PKMN_NAME);
          if (varAssign) {
            session.stringVars[String(Number(varAssign[1]))] = applied;
          }
          await this.refreshSession(session);
        }
      }
      return;
    }

    // pbChoosePokemon(varN, nameVarN[, proc]): party picker. The proc filter
    // (trade NPCs) restricts to a species and excludes eggs; without a proc
    // every party member (eggs included) can be chosen, like the original
    // party screen. Cancelling stores -1.
    const choosePokemon = text.match(RE_CHOOSE_POKEMON);
    if (choosePokemon) {
      const varId = String(Number(choosePokemon[1]));
      const nameVarId = String(Number(choosePokemon[2]));
      const speciesFilter =
        text.match(/\b\w+\.species\s*==\s*(?:PBSpecies::|:)(\w+)/i)?.[1] ?? null;
      const excludeEggs = speciesFilter !== null || /!\s*\w+\.egg\?/.test(text);
      const user = await this.auth.getUserForBattle(session.userId);
      const eligible: Array<{ index: number; label: string }> = [];
      (user?.pokemonParty ?? []).forEach((pokemon, index) => {
        if (excludeEggs && pokemon.isEgg) {
          return;
        }
        if (
          speciesFilter &&
          (pokemon.sourcePokemonId ?? "").toLowerCase() !== `pokemon-${speciesFilter.toLowerCase()}`
        ) {
          return;
        }
        eligible.push({
          index,
          label: pokemon.isEgg ? "Huevo" : pokemon.nickname || pokemon.name
        });
      });
      this.emitStep(session, {
        type: "choices",
        npcName: session.npcName,
        text: "Elige un Venomon.",
        choices: [...eligible.map((entry) => entry.label), "Cancelar"]
      });
      const picked = await this.waitChoice(session.userId);
      if (this.sessions.get(session.userId)?.token !== session.token) {
        return;
      }
      const chosen = picked >= 0 && picked < eligible.length ? eligible[picked] : null;
      session.pendingWrites.variables[varId] = chosen ? chosen.index : -1;
      session.stringVars[nameVarId] = chosen ? chosen.label : "";
      return;
    }

    // pbStartTrade(pbGet(V), SPECIES, "NICK"[, "OT"]): in-game NPC trade —
    // the chosen party member leaves, the NPC's venomon (same level, foreign
    // OT) takes its slot. The event's own text announces the trade.
    const startTrade = text.match(RE_START_TRADE);
    if (startTrade) {
      const state = await this.getSessionEventState(session);
      const index = Number(state.variables[String(Number(startTrade[1]))] ?? -1);
      if (index >= 0) {
        const result = await this.auth.tradePartyPokemon(
          session.userId,
          index,
          startTrade[2],
          startTrade[3] || null,
          startTrade[4] || null
        );
        if (result.ok) {
          await this.refreshSession(session);
        }
      }
      return;
    }

    // pbChooseItemFromList("prompt", varN, :ITEM, ...): pick one of the listed
    // items the player actually owns. Stores the item's legacy numeric id
    // (0 = owns none of them, -1 = cancelled), matching the branches events
    // test right after.
    const chooseItem = text.match(RE_CHOOSE_ITEM_LIST);
    if (chooseItem) {
      const varId = String(Number(chooseItem[2]));
      const symbols = Array.from(chooseItem[3].matchAll(/:(\w+)/g)).map((match) => match[1]);
      const owned: Array<{ symbol: string; label: string }> = [];
      for (const symbol of symbols) {
        const quantity = this.battleManager
          ? await this.battleManager.getEventItemQuantity(session.userId, symbol)
          : 0;
        if (quantity > 0) {
          const definition = await this.battleManager!.findEventItemDefinition({ symbol });
          owned.push({ symbol, label: definition?.name ?? symbol });
        }
      }
      if (owned.length === 0) {
        session.pendingWrites.variables[varId] = 0;
        return;
      }
      const prompt = chooseItem[1].replace(/<[^>]*>/g, "").replace(/\s*\n\s*/g, " ");
      this.emitStep(session, {
        type: "choices",
        npcName: session.npcName,
        text: prompt,
        choices: [...owned.map((entry) => entry.label), "Cancelar"]
      });
      const picked = await this.waitChoice(session.userId);
      if (this.sessions.get(session.userId)?.token !== session.token) {
        return;
      }
      const chosen = picked >= 0 && picked < owned.length ? owned[picked] : null;
      const legacyNumber = chosen
        ? LEGACY_ITEM_NUMBER_BY_INTERNAL.get(chosen.symbol.toUpperCase())
        : undefined;
      if (chosen && typeof legacyNumber !== "number") {
        logUnsupportedScript(
          "command",
          `pbChooseItemFromList item ${chosen.symbol} has no legacy number`,
          this.sessionContext(session)
        );
      }
      session.pendingWrites.variables[varId] = chosen ? legacyNumber ?? -1 : -1;
      return;
    }

    // $PokemonBag.pbDeleteItem(PBItems::X | pbGet(N)): hand the item over.
    const deleteItem = text.match(RE_DELETE_ITEM);
    if (deleteItem) {
      if (this.battleManager) {
        const ref = deleteItem[1]
          ? { symbol: deleteItem[1] }
          : {
              legacyNumber: Number(
                (await this.getSessionEventState(session)).variables[
                  String(Number(deleteItem[2]))
                ] ?? 0
              )
            };
        await this.battleManager.removeEventItem(session.userId, ref, 1);
        await this.refreshSession(session);
      }
      return;
    }

    // pbSet(N, PBItems.getName(pbGet(M))) — item display name into a string
    // variable for the following \v[N] text.
    const setItemName = text.match(RE_SET_VAR_ITEM_NAME);
    if (setItemName) {
      const target = String(Number(setItemName[1] ?? setItemName[2]));
      const legacyNumber = Number(
        (await this.getSessionEventState(session)).variables[String(Number(setItemName[3]))] ?? 0
      );
      const definition = this.battleManager
        ? await this.battleManager.findEventItemDefinition({ legacyNumber })
        : null;
      session.stringVars[target] = definition?.name ?? "";
      return;
    }

    // pbSet(N, PBSpecies.getName(pbGet(M))) — the variable holds the ITEM the
    // player handed over; the species is resolved through the event's own
    // pbConvertItemToPokemon pairs (see below).
    const setSpeciesName = text.match(RE_SET_VAR_SPECIES_NAME);
    if (setSpeciesName) {
      const target = String(Number(setSpeciesName[1] ?? setSpeciesName[2]));
      const legacyNumber = Number(
        (await this.getSessionEventState(session)).variables[
          String(Number(setSpeciesName[3]))
        ] ?? 0
      );
      const species = this.resolveConvertedSpecies(session, legacyNumber);
      session.stringVars[target] = species
        ? (await this.auth.getSpeciesDisplayName(species)) ?? species
        : "";
      return;
    }

    // pbConvertItemToItem(varN, [FROM,TO,...]): Kurt — the chosen apricorn's
    // number becomes the finished ball's number.
    const convertItem = text.match(RE_CONVERT_ITEM_TO_ITEM);
    if (convertItem) {
      const varId = String(Number(convertItem[1]));
      const current = Number(
        (await this.getSessionEventState(session)).variables[varId] ?? 0
      );
      const currentSymbol = LEGACY_ITEM_INTERNAL_BY_NUMBER[current];
      const symbols = Array.from(convertItem[2].matchAll(/:(\w+)/g)).map((match) => match[1]);
      for (let i = 0; i + 1 < symbols.length; i += 2) {
        if (currentSymbol && symbols[i].toUpperCase() === currentSymbol.toUpperCase()) {
          const mapped = LEGACY_ITEM_NUMBER_BY_INTERNAL.get(symbols[i + 1].toUpperCase());
          if (typeof mapped === "number") {
            session.pendingWrites.variables[varId] = mapped;
          } else {
            logUnsupportedScript(
              "command",
              `pbConvertItemToItem target ${symbols[i + 1]} has no legacy number`,
              this.sessionContext(session)
            );
          }
          break;
        }
      }
      return;
    }

    // pbConvertItemToPokemon(varN, [pairs]): deliberately keeps the ITEM
    // number in the variable — every later read (PBSpecies.getName,
    // pbAddToParty) resolves the species through these same pairs, so the
    // value stays meaningful across sessions ("come back later" NPCs).
    if (RE_CONVERT_ITEM_TO_POKEMON.test(text)) {
      return;
    }

    // pbPickBerry(:BERRY[, qty]): berry trees.
    const pickBerry = text.match(RE_PICK_BERRY);
    if (pickBerry) {
      await this.grantScriptedItem(
        session,
        { symbol: pickBerry[1] },
        "found",
        Math.max(1, Number(pickBerry[2] ?? 1) || 1)
      );
      return;
    }

    // Anything else: cosmetic calls are silently skipped; genuinely unknown
    // scripts are skipped too but recorded so the migration report can list
    // them (a skipped command must never unlock progression by itself).
    if (classifyIgnorableCommand(text) === null) {
      logUnsupportedScript("command", text, this.sessionContext(session));
    }
  }

  /** Party member indexed by an event variable (pbChoosePokemon result). */
  private async partyPokemonFromVar(session: Session, variableId: number) {
    const state = await this.getSessionEventState(session);
    const index = Number(state.variables[String(variableId)] ?? -1);
    if (index < 0) {
      return null;
    }
    const user = await this.auth.getUserForBattle(session.userId);
    return user?.pokemonParty?.[index] ?? null;
  }

  /** Species display name of a party member (nickname-independent). */
  private async speciesDisplayNameOf(pokemon: { sourcePokemonId?: string; name: string }) {
    const internal = (pokemon.sourcePokemonId ?? "").replace(/^pokemon-/i, "");
    if (!internal) {
      return pokemon.name;
    }
    return (await this.auth.getSpeciesDisplayName(internal)) ?? pokemon.name;
  }

  /**
   * Resolves an item's converted species through this event's own
   * pbConvertItemToPokemon pair list (fossil reviver). The event variable
   * keeps the ITEM's legacy number; the pairs give ITEM -> SPECIES.
   */
  private resolveConvertedSpecies(session: Session, legacyItemNumber: number): string | null {
    const itemSymbol = LEGACY_ITEM_INTERNAL_BY_NUMBER[legacyItemNumber];
    if (!itemSymbol) {
      return null;
    }
    for (const page of session.essentials.pages) {
      const commands = page.commands ?? [];
      for (let i = 0; i < commands.length; i++) {
        if (commands[i].code !== 355) {
          continue;
        }
        let joined = String(commands[i].parameters?.[0] ?? "");
        let j = i + 1;
        while (j < commands.length && commands[j].code === 655) {
          joined += `\n${String(commands[j].parameters?.[0] ?? "")}`;
          j += 1;
        }
        const match = joined.match(RE_CONVERT_ITEM_TO_POKEMON);
        if (!match) {
          continue;
        }
        const symbols = Array.from(match[2].matchAll(/:(\w+)/g)).map((entry) => entry[1]);
        for (let k = 0; k + 1 < symbols.length; k += 2) {
          if (symbols[k].toUpperCase() === itemSymbol.toUpperCase()) {
            return symbols[k + 1];
          }
        }
      }
    }
    return null;
  }

  /** Replaces \v[N] with session string variables (item/species/entered names). */
  private interpolateStringVars(session: Session, text: string): string {
    return text.replace(/\\[vV]\[(\d+)\]/g, (whole, id: string) => {
      const value = session.stringVars[String(Number(id))];
      return typeof value === "string" && value !== "" ? value : whole;
    });
  }

  // -- page selection ------------------------------------------------------
  /**
   * RMXP-compatible page selection (shared with the world's collision/touch
   * checks): highest-index page whose conditions hold for THIS player,
   * including Essentials script switches and session temp switches.
   */
  private selectActivePage(
    essentials: EssentialsEvent,
    player: Player,
    state: { switches: Record<string, boolean>; variables: Record<string, number>; selfSwitches: Record<string, boolean> }
  ): EventPage | null {
    const playerState: EventPlayerState = { ...state, tempSwitches: player.tempSwitches };
    return selectActiveEventPageShared(
      essentials as EssentialsEventRecord,
      playerState,
      this.world.pageSelectionOptions()
    ) as EventPage | null;
  }

  private resolveSpeaker(page: EventPage, fallback: string): string {
    // Prefer a "Name:" prefix from the first text line if present.
    for (const command of page.commands) {
      if (command.code === 101 && typeof command.parameters[0] === "string") {
        const match = (command.parameters[0] as string)
          .replace(/\\[a-zA-Z]\[[^\]]*\]/g, "")
          .replace(/\\[a-zA-Z]/g, "")
          .match(/^\s*([A-Za-zÁÉÍÓÚÑáéíóúñ .]{2,20}?):/);
        if (match) {
          return match[1].trim();
        }
        break;
      }
    }
    return fallback;
  }

  // -- transport -----------------------------------------------------------
  private emitStep(session: Session, step: EventStep) {
    // Default the portrait to the speaking NPC's sprite unless a step already
    // specifies one (e.g. a starter choice shows the Pokemon instead).
    const wantsPortrait =
      step.type === "text" || step.type === "choices" || step.type === "info";
    const enriched: EventStep =
      wantsPortrait &&
      session.npcPortraitSrc &&
      !("portraitPokemonId" in step && step.portraitPokemonId) &&
      !("portraitSrc" in step && step.portraitSrc)
        ? { ...step, portraitSrc: session.npcPortraitSrc }
        : step;
    // Remember what the client should currently show so a reconnect mid-event
    // can replay it (resumeEventsOnJoin).
    if (step.type !== "end") {
      session.lastStep = enriched;
    }
    session.player.socketConnections.forEach((socketId) => {
      this.io.to(socketId).emit("event:step", enriched);
    });
  }

  private async refreshSession(session: Session) {
    const user = await this.auth.getPublicUserData(session.userId);
    if (!user) {
      return;
    }
    session.player.socketConnections.forEach((socketId) => {
      this.io.to(socketId).emit("auth:session", { authenticated: true, user });
    });
  }

  /**
   * Push the player's own updated sprite (skin/name) to their own client.
   * world.presentPlayerToMap intentionally skips the acting socket to avoid
   * movement echo, so an in-event change (the intro's gender pick, name entry)
   * would otherwise only show up for *other* players until the acting player
   * refreshes and re-joins.
   */
  private presentPlayerToOwnClient(player: Player) {
    const data = player.data();
    player.socketConnections.forEach((socketId) => {
      this.io.to(socketId).emit("addPlayer", data);
    });
  }

  private waitAdvance(userId: number): Promise<void> {
    return new Promise((resolve) => {
      this.pending.set(userId, { kind: "advance", resolve });
    });
  }

  private waitChoice(userId: number): Promise<number> {
    return new Promise((resolve) => {
      this.pending.set(userId, { kind: "choice", resolve });
    });
  }

  private waitName(userId: number): Promise<string> {
    return new Promise((resolve) => {
      this.pending.set(userId, { kind: "name", resolve });
    });
  }
}

// ---------------------------------------------------------------------------
// Flat RMXP command list -> nested node tree.
// ---------------------------------------------------------------------------
/**
 * Whether a page's commands compile to anything a player would notice — text,
 * effects, state changes. Waits, labels and jumps alone don't count: a
 * parallel page made only of those (fog loops, move-route choreography the
 * compiler skips) would play as silent dead air, so callers skip it instead.
 */
export function pageHasObservableNodes(page: { commands: RawCommand[] }): boolean {
  const observable = (nodes: Node[]): boolean =>
    nodes.some((node) => {
      switch (node.kind) {
        case "wait":
        case "waitScroll":
        case "label":
        case "jump":
          return false;
        case "condition":
          return observable(node.then) || observable(node.otherwise);
        case "choices":
          return true;
        default:
          return true;
      }
    });
  return observable(parseCommands(page.commands));
}

export function parseCommands(commands: RawCommand[]): Node[] {
  const parsed = parseBlock(commands, 0, commands.length > 0 ? commands[0].indent : 0);
  return parsed.nodes;
}

function textOf(command: RawCommand): string {
  return typeof command.parameters[0] === "string" ? (command.parameters[0] as string) : "";
}

// Recursively finds the species a choice would grant via pbAddPokemon.
function findStarterSpecies(branches: Array<{ when: number | "cancel"; body: Node[] }>): string | null {
  const scan = (nodes: Node[]): string | null => {
    for (const node of nodes) {
      if (node.kind === "script") {
        const match = node.text.match(RE_ADD_POKEMON);
        if (match) {
          return match[1].toUpperCase();
        }
      } else if (node.kind === "condition") {
        return scan(node.then) ?? scan(node.otherwise);
      } else if (node.kind === "choices") {
        for (const branch of node.branches) {
          const found = scan(branch.body);
          if (found) {
            return found;
          }
        }
      }
    }
    return null;
  };
  for (const branch of branches) {
    const found = scan(branch.body);
    if (found) {
      return found;
    }
  }
  return null;
}

// Parses a Show Choices (102) block starting at `index`, with an optional prompt
// carried over from a preceding Show Text so the question and options render
// together instead of on separate screens.
function parseChoices(commands: RawCommand[], index: number, prompt: string): { node: Node; next: number } {
  const command = commands[index];
  const choices = Array.isArray(command.parameters[0])
    ? (command.parameters[0] as unknown[]).map((choice) => String(choice))
    : [];
  const cancelType = typeof command.parameters[1] === "number" ? command.parameters[1] : 0;
  const branches: Array<{ when: number | "cancel"; body: Node[] }> = [];
  const openIndent = command.indent;
  let i = index + 1;
  while (i < commands.length && (commands[i].code === 402 || commands[i].code === 403) &&
         commands[i].indent === openIndent) {
    const branchCommand = commands[i];
    const when: number | "cancel" =
      branchCommand.code === 403
        ? "cancel"
        : typeof branchCommand.parameters[0] === "number"
          ? (branchCommand.parameters[0] as number)
          : 0;
    i += 1;
    const body = parseBlock(commands, i, openIndent + 1);
    branches.push({ when, body: body.nodes });
    i = body.next;
  }
  if (i < commands.length && commands[i].code === 404 && commands[i].indent === openIndent) {
    i += 1;
  }
  return { node: { kind: "choices", prompt, choices, cancelType, branches }, next: i };
}

function parseBlock(commands: RawCommand[], start: number, indent: number): { nodes: Node[]; next: number } {
  const nodes: Node[] = [];
  let i = start;

  while (i < commands.length) {
    const command = commands[i];
    if (command.indent < indent) {
      break;
    }
    // Branch/terminator codes are consumed by their openers, not here.
    if (command.code === 402 || command.code === 403 || command.code === 404 ||
        command.code === 411 || command.code === 412) {
      break;
    }

    switch (command.code) {
      case 101: {
        const lines = [textOf(command)];
        i += 1;
        while (i < commands.length && commands[i].code === 401) {
          lines.push(textOf(commands[i]));
          i += 1;
        }
        const text = lines.filter((line) => line.length > 0).join(" ").trim();
        // A Show Text immediately followed by Show Choices is one screen: the
        // question stays visible with the options, not replaced by them.
        if (i < commands.length && commands[i].code === 102) {
          const result = parseChoices(commands, i, text);
          nodes.push(result.node);
          i = result.next;
        } else {
          nodes.push({ kind: "text", text });
        }
        break;
      }
      case 102: {
        const result = parseChoices(commands, i, "");
        nodes.push(result.node);
        i = result.next;
        break;
      }
      case 111: {
        const test = parseCondition(command.parameters);
        const openIndent = command.indent;
        i += 1;
        const thenBody = parseBlock(commands, i, openIndent + 1);
        i = thenBody.next;
        let otherwise: Node[] = [];
        if (i < commands.length && commands[i].code === 411 && commands[i].indent === openIndent) {
          i += 1;
          const elseBody = parseBlock(commands, i, openIndent + 1);
          otherwise = elseBody.nodes;
          i = elseBody.next;
        }
        if (i < commands.length && commands[i].code === 412 && commands[i].indent === openIndent) {
          i += 1;
        }
        nodes.push({ kind: "condition", test, then: thenBody.nodes, otherwise });
        break;
      }
      case 355: {
        let text = textOf(command);
        i += 1;
        while (i < commands.length && commands[i].code === 655) {
          text += `\n${textOf(commands[i])}`;
          i += 1;
        }
        nodes.push({ kind: "script", text });
        break;
      }
      case 121: {
        const startId = Number(command.parameters[0] ?? 0);
        const endId = Number(command.parameters[1] ?? startId);
        // RMXP operation: 0 = ON, 1 = OFF.
        nodes.push({ kind: "switch", start: startId, end: endId, on: command.parameters[2] === 0 });
        i += 1;
        break;
      }
      case 122: {
        // [start, end, operation, operandType, ...operand]. Operand types
        // beyond const/variable/random (item counts, actor stats) are rare
        // and read as 0. Apricorn trees rely on random: 21 + rand(0..6).
        const startId = Number(command.parameters[0] ?? 0);
        const endId = Number(command.parameters[1] ?? startId);
        const operandType = Number(command.parameters[3] ?? 0);
        const operand: Operand =
          operandType === 1
            ? { type: "variable", id: Number(command.parameters[4] ?? 0) }
            : operandType === 2
              ? {
                  type: "random",
                  min: Number(command.parameters[4] ?? 0),
                  max: Number(command.parameters[5] ?? 0)
                }
              : { type: "const", value: operandType === 0 ? Number(command.parameters[4] ?? 0) : 0 };
        nodes.push({
          kind: "variable",
          start: startId,
          end: endId,
          op: Number(command.parameters[2] ?? 0),
          operand
        });
        i += 1;
        break;
      }
      case 125: {
        // Change Gold: [operation(0 add/1 subtract), operandType(0 const/1 var), value].
        nodes.push({
          kind: "gold",
          add: command.parameters[0] === 0,
          operand:
            command.parameters[1] === 1
              ? { type: "variable", id: Number(command.parameters[2] ?? 0) }
              : { type: "const", value: Number(command.parameters[2] ?? 0) }
        });
        i += 1;
        break;
      }
      case 123: {
        const ch = typeof command.parameters[0] === "string" ? command.parameters[0] : "A";
        nodes.push({ kind: "selfSwitch", ch, on: command.parameters[1] === 0 });
        i += 1;
        break;
      }
      case 115:
        nodes.push({ kind: "exit" });
        i += 1;
        break;
      case 118: {
        const name = textOf(command);
        if (name) {
          nodes.push({ kind: "label", name });
        }
        i += 1;
        break;
      }
      case 119: {
        const name = textOf(command);
        if (name) {
          nodes.push({ kind: "jump", name });
        }
        i += 1;
        break;
      }
      case 106:
        nodes.push({ kind: "wait", frames: Number(command.parameters[0] ?? 0) });
        i += 1;
        break;
      case 231: {
        // [slot, name, origin, posType, x, y, zoomX, zoomY, opacity, blend]
        nodes.push({
          kind: "picture",
          op: "show",
          slot: Number(command.parameters[0] ?? 1),
          name: typeof command.parameters[1] === "string" ? command.parameters[1] : "",
          origin: Number(command.parameters[2] ?? 0),
          x: Number(command.parameters[4] ?? 0),
          y: Number(command.parameters[5] ?? 0),
          opacity: Number(command.parameters[8] ?? 255)
        });
        i += 1;
        break;
      }
      case 232: {
        // [slot, durationFrames, origin, posType, x, y, zoomX, zoomY, opacity, blend]
        nodes.push({
          kind: "picture",
          op: "move",
          slot: Number(command.parameters[0] ?? 1),
          durationMs: Number(command.parameters[1] ?? 0) * 50,
          origin: Number(command.parameters[2] ?? 0),
          x: Number(command.parameters[4] ?? 0),
          y: Number(command.parameters[5] ?? 0),
          opacity: Number(command.parameters[8] ?? 255)
        });
        i += 1;
        break;
      }
      case 235:
        nodes.push({ kind: "picture", op: "erase", slot: Number(command.parameters[0] ?? 1) });
        i += 1;
        break;
      case 221:
        nodes.push({ kind: "screen", effect: "fadeout", durationMs: 400 });
        i += 1;
        break;
      case 222:
        nodes.push({ kind: "screen", effect: "fadein", durationMs: 400 });
        i += 1;
        break;
      case 241:
      case 245:
      case 249:
      case 250: {
        const audio = command.parameters[0] as { name?: unknown; volume?: unknown } | undefined;
        const soundKind =
          command.code === 241 ? "BGM" : command.code === 245 ? "BGS" : command.code === 249 ? "ME" : "SE";
        if (audio && typeof audio.name === "string" && audio.name.length > 0) {
          nodes.push({
            kind: "sound",
            soundKind,
            name: audio.name,
            volume: Number(audio.volume ?? 100)
          });
        }
        i += 1;
        break;
      }
      case 242:
        nodes.push({ kind: "sound", soundKind: "BGMStop" });
        i += 1;
        break;
      case 246:
        nodes.push({ kind: "sound", soundKind: "BGSStop" });
        i += 1;
        break;
      case 201: {
        // [mode, mapId, x, y, direction, fade] — only direct (mode 0) transfers.
        if (command.parameters[0] === 0) {
          nodes.push({
            kind: "transfer",
            mapId: Number(command.parameters[1] ?? 0),
            x: Number(command.parameters[2] ?? 0),
            y: Number(command.parameters[3] ?? 0)
          });
        }
        i += 1;
        break;
      }
      case 314:
        nodes.push({ kind: "recoverAll" });
        i += 1;
        break;
      case 203: {
        // Scroll Map: [direction (2 down/4 left/6 right/8 up), distanceTiles, speed 1-6]
        nodes.push({
          kind: "scrollMap",
          direction: Number(command.parameters[0] ?? 2),
          distance: Number(command.parameters[1] ?? 0),
          speed: Number(command.parameters[2] ?? 4)
        });
        i += 1;
        break;
      }
      case 210:
        // Wait for Move's Completion — holds for a pending camera scroll.
        nodes.push({ kind: "waitScroll" });
        i += 1;
        break;
      case 207: {
        // Show Animation: [target (-1 player, 0 this event, >0 event id), animationId]
        nodes.push({
          kind: "animation",
          animationId: Number(command.parameters[1] ?? 0),
          onEvent: Number(command.parameters[0] ?? -1) !== -1
        });
        i += 1;
        break;
      }
      case 223: {
        // Change Screen Color Tone: [{red,green,blue,gray}, durationFrames].
        // Only the darkening component maps to the client's overlay; colored
        // tints approximate to how far below neutral the average channel sits.
        const tone = command.parameters[0] as
          | { red?: unknown; green?: unknown; blue?: unknown }
          | undefined;
        const average =
          (Number(tone?.red ?? 0) + Number(tone?.green ?? 0) + Number(tone?.blue ?? 0)) / 3;
        nodes.push({
          kind: "screen",
          effect: "tone",
          darken: Math.min(1, Math.max(0, -average / 255)),
          durationMs: Number(command.parameters[1] ?? 0) * 25
        });
        i += 1;
        break;
      }
      case 224:
        // Screen Flash: [color, durationFrames] — RMXP runs at 40fps.
        nodes.push({
          kind: "screen",
          effect: "flash",
          durationMs: Number(command.parameters[1] ?? 8) * 25
        });
        i += 1;
        break;
      case 225:
        // Screen Shake: [power 1-9, speed, durationFrames] — the earthquake.
        nodes.push({
          kind: "screen",
          effect: "shake",
          power: Number(command.parameters[0] ?? 5),
          durationMs: Number(command.parameters[2] ?? 8) * 25
        });
        i += 1;
        break;
      default:
        i += 1; // skip unsupported (move routes, comments, gold, etc.)
        break;
    }
  }

  return { nodes, next: i };
}

function parseCondition(parameters: unknown[]): ConditionTest {
  const type = Number(parameters[0] ?? -1);
  switch (type) {
    case 0:
      return { kind: "switch", id: Number(parameters[1] ?? 0), on: parameters[2] === 0 };
    case 1: {
      // [type, varId, operandType(0 const/1 var), value, operator]
      return {
        kind: "variable",
        id: Number(parameters[1] ?? 0),
        constant: parameters[2] === 0,
        value: Number(parameters[3] ?? 0),
        op: Number(parameters[4] ?? 0)
      };
    }
    case 2:
      return {
        kind: "selfSwitch",
        ch: typeof parameters[1] === "string" ? parameters[1] : "A",
        on: parameters[2] === 0
      };
    case 6:
      // Character facing check: cosmetic (turn-to-face puzzles); allowing the
      // branch cannot skip progression, so it passes.
      return { kind: "always", value: true };
    case 7:
      // Gold check (vending machines): [7, amount, operator(0 >=, 1 <=)].
      return { kind: "gold", amount: Number(parameters[1] ?? 0), gte: parameters[2] === 0 };
    case 8:
      // Item in inventory: [8, rmxpItemId]. Key-item gates use this in some
      // Essentials projects; resolved against the bag at evaluation time.
      return { kind: "item", legacyId: Number(parameters[1] ?? 0) };
    case 12: {
      // Script condition — trainer battles live here in Essentials events:
      // `pbTrainerBattle(PBTrainers::TYPE, "Name", ...)` is the test itself.
      const text = typeof parameters[1] === "string" ? parameters[1] : "";
      return text ? { kind: "script", text } : { kind: "always", value: true };
    }
    default:
      // Unsupported condition types (actor/timer/enemy/...): FAIL CLOSED and
      // log — passing an unknown gate is how sequence breaks slip in.
      return { kind: "unsupported", branchType: type };
  }
}
