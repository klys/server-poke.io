import type { Server } from "socket.io";
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
import { ERASED_SELF_SWITCH } from "./eventPageSelection";

type TypedSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

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
  | { kind: "script"; text: string }
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
  | { kind: "screen"; effect: "fadeout" | "fadein"; durationMs?: number }
  | { kind: "transfer"; mapId: number; x: number; y: number }
  | { kind: "recoverAll" }
  | { kind: "exit" };

/** Thrown by a Jump to Label (119); caught by the nearest scope holding the label. */
class JumpToLabel {
  constructor(public readonly name: string) {}
}

// RMXP script effects the runtime understands (pbAddPokemon etc.).
// Accepts both the legacy `PBSpecies::NAME` and the modern `:NAME` symbol
// forms, with an optional `Kernel.` prefix (gift events are often authored as
// `Kernel.pbAddPokemon(:ARIADOS,35)`) — mirrors RE_WILD_BATTLE below.
const RE_ADD_POKEMON = /(?:Kernel\.)?pbAddPokemon\(\s*(?:PBSpecies::|:)(\w+)\s*,\s*(\d+)/i;
// pbGenerateEgg(:EEVEE, _I("Encargada")) — the "REGALA HUEVO" day-care NPC and
// any egg-giving item. Like pbAddPokemon it is authored as a conditional-branch
// script whose then-branch sets the Self Switch, but it hands over an EGG that
// hatches after walking. Only the species matters here; the obtain text arg is
// flavour and ignored.
const RE_GENERATE_EGG = /(?:Kernel\.)?pbGenerateEgg\(\s*(?:PBSpecies::|:)(\w+)/i;
// Day Care egg pickup ("Criador"): `Kernel.pbEggGenerated?` gates whether an
// egg is waiting, and `pbDayCareGenerateEgg` hands it over. We model these with
// the same weekly egg cooldown as pbGenerateEgg; the handed-over egg is bred
// from the player's lead species (the full breeding sim is not modelled).
const RE_EGG_GENERATED = /pbEggGenerated\??/i;
const RE_DAYCARE_GENERATE_EGG = /pbDayCareGenerateEgg/i;
// Day-care party-space gates. `$Trainer.party.length` counts every slot (eggs
// included, since an egg occupies a slot); `$Trainer.pokemonCount` counts only
// battle-ready (non-egg) members. Previously these unknown script conditions
// hit the permissive `return true`, so the Day Care always thought the party
// was full ("no space") regardless of the real party.
const RE_PARTY_LENGTH = /\$Trainer\.party\.length\s*(>=|<=|==|!=|>|<)\s*(\d+)/i;
const RE_POKEMON_COUNT = /\$Trainer\.(?:pokemonCount|partyCount)\s*(>=|<=|==|!=|>|<)\s*(\d+)/i;
// A player can receive a fresh egg from the same egg NPC once per week.
const EGG_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const RE_RECEIVE_ITEM = /pbReceive(?:Item)?\(\s*(?:PBItems::|:)(\w+)/i;
// pbItemBall(:POTION) — visible item balls; also used by hidden items.
const RE_ITEM_BALL = /pbItemBall\(\s*(?:PBItems::|:)(\w+)/i;
// pbItemBall(pbGet(1)) — the item's legacy numeric id sits in an event
// variable (apricorn trees roll 21+rand(7) into variable 1 first).
const RE_ITEM_BALL_VAR = /pbItemBall\(\s*pbGet\(\s*(\d+)\s*\)/i;
// $PokemonBag.pbStoreItem(PBItems::X) — silent grants (vending machines);
// the event's own Show Text announces the item, so no info step here.
const RE_STORE_ITEM = /pbStoreItem\(\s*(?:PBItems::|:)(\w+)/i;
const RE_POKEDEX = /\$Trainer\.pokedex\s*=\s*true/i;
// Gym badges. Award forms (RPG-Maker Script cmd 355): `$Trainer.badges[N]=true`
// or `pbReceiveBadge(N)`. Condition forms (Script conditional branch): the
// badge count `$Trainer.numbadges >=|>|... N`, or a plain `$Trainer.badges[N]`
// truthy test. Awarding is honoured in applyScript; conditions in evaluate().
const RE_AWARD_BADGE = /\$Trainer\.badges\[\s*(\d+)\s*\]\s*=\s*true/i;
const RE_RECEIVE_BADGE = /pbReceiveBadge\(\s*(\d+)\s*\)/i;
const RE_NUMBADGES = /\$Trainer\.numbadges\s*(>=|<=|==|!=|>|<)\s*(\d+)/i;
const RE_HAS_BADGE = /\$Trainer\.badges\[\s*(\d+)\s*\]/i;
const RE_HEAL = /pbHealAll|pbHealParty|Recover All/i;
const RE_CHANGE_PLAYER = /pbChangePlayer\(\s*(\d)\s*\)/i;
const RE_TRAINER_BATTLE = /pbTrainerBattle\(\s*PBTrainers::(\w+)\s*,\s*"([^"]+)"/i;
// pbWildBattle(:CYNDAQUIL,30) / pbWildBattle(PBSpecies::MUK,25,1,false,true) —
// hidden/static overworld venomons the player battles (and can catch) by
// talking to them.
const RE_WILD_BATTLE = /pbWildBattle\(\s*(?:PBSpecies::|:)(\w+)\s*,\s*(\d+)/i;
const RE_TRAINER_NAME = /pbTrainerName/i;
const RE_TONE_CHANGE = /pbToneChangeAll\(\s*Tone\.new\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)[^)]*\)\s*,\s*(\d+)/i;
const RE_SET_POKECENTER = /pbSetPokemonCenter/i;
const RE_POKEMON_MART = /pbPokemonMart\(\s*\[([^\]]*)\]/i;
// Pokemon Center / bedroom computers: both Essentials entry points open the
// same server-authoritative PC box storage overlay on the client.
const RE_POKEMON_PC = /pbPokeCenterPC|pbTrainerPC/i;
const RE_SE_PLAY = /pbSEPlay\(\s*"([^"]+)"/i;
const RE_PB_WAIT = /pbWait\(\s*(\d+)\s*\)/i;
const RE_BUTTON_SCREEN = /pbEventScreen\(\s*ButtonEventScene\s*\)/i;

// Field-skill (MO/HM) obstacle events. Cut trees + Rock Smash rocks are authored
// as a conditional branch gated by pbCut / pbRockSmash whose body erases the
// event (pbEraseThisEvent) and, for rocks, rolls a wild encounter.
const RE_CUT = /pbCut\b/i;
const RE_ROCKSMASH_COND = /pbRockSmash(?!Random)/i;
const RE_ERASE_EVENT = /pbEraseThisEvent/i;
const RE_ROCKSMASH_ENCOUNTER = /pbRockSmashRandomEncounter/i;

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
  | { type: "screen"; effect: "fadeout" | "fadein" | "tone"; durationMs?: number; darken?: number }
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
  placementId: string; // map placement that hosts this event ("" for resumes)
  isTouch: boolean; // started by walking into/onto the event (doors, mats)
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
  public async startEvent(userId: number, npcPlacementId?: string, options?: { touch?: boolean }) {
    if (typeof npcPlacementId !== "string" || !npcPlacementId) {
      return { ok: false as const, message: "Choose someone to talk to." };
    }
    const player = this.world.getPlayerByUserId(userId);
    if (!player) {
      return { ok: false as const, message: "Enter the world before talking to NPCs." };
    }
    const snapshot = this.world.getPlayableMapsState();
    const placement = snapshot?.editorDataByMapId[player.currentMapId]?.npcs.find(
      (candidate) => candidate.id === npcPlacementId
    ) as (Record<string, unknown> & { name?: string; previewImageSrc?: string; essentialsEvent?: EssentialsEvent }) | undefined;

    if (!placement || !placement.essentialsEvent) {
      return { ok: false as const, message: "There is nothing to interact with here." };
    }

    const essentials = placement.essentialsEvent;
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
    const page = this.selectActivePage(essentials.pages, state, essentials);
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
      npcPlacementId
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

  private compareNumbers(op: string, left: number, right: number): boolean {
    switch (op) {
      case ">=": return left >= right;
      case "<=": return left <= right;
      case ">": return left > right;
      case "<": return left < right;
      case "==": return left === right;
      case "!=": return left !== right;
      default: return false;
    }
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
    for (let guard = 0; guard < 16; guard += 1) {
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
      const placements = (snapshot.editorDataByMapId[player.currentMapId]?.npcs ?? []) as Array<
        Record<string, unknown> & { name?: string; previewImageSrc?: string; essentialsEvent?: EssentialsEvent }
      >;
      const eventPlacements = placements.filter((placement) => placement.essentialsEvent);
      const state = await this.auth.getEventState(userId);
      let ran = false;
      for (const placement of eventPlacements) {
        const essentials = placement.essentialsEvent as EssentialsEvent;
        const page = this.selectActivePage(essentials.pages, state, essentials);
        if (page && page.trigger === 3) {
          const outcome = await this.executeSession(
            userId,
            player,
            placement.name ?? "NPC",
            placement.previewImageSrc ?? "",
            essentials,
            page,
            true,
            false,
            typeof placement.id === "string" ? placement.id : ""
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
      }
      if (!ran) {
        break;
      }
    }
    // Autorun may have flipped switches (e.g. the lab intro's permission switch);
    // refresh the client's copy so conditional NPCs update.
    await this.emitEventState(userId);
    return { ready: true, ran: ranAny };
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
      const activePage = this.selectActivePage(essentials.pages, state, essentials);
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
      const strippedPage = this.selectActivePage(essentials.pages, strippedState, essentials);
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
    placementId = ""
  ) {
    const token = ++this.tokenCounter;
    const session: Session = {
      userId,
      token,
      player,
      npcName: this.resolveSpeaker(page, placementName),
      npcPortraitSrc: portraitSrc,
      selfSwitchPrefix: `${essentials.essentialsMapId}:${essentials.eventId}:`,
      placementId,
      isTouch,
      nodesRun: 0,
      pendingWrites: emptyEventStateWrites(),
      lastStep: null
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

  public abort(userId: number) {
    const session = this.sessions.get(userId);
    if (session) {
      session.token = -1; // invalidate the running interpreter
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
    player.socketConnections.forEach((socketId) => {
      this.io.to(socketId).emit("event:state", state);
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
          this.emitStep(session, { type: "text", npcName: session.npcName, text: node.text });
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
            text: node.prompt,
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
            durationMs: node.durationMs
          });
          break;
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
    announce: "found" | "received" | null
  ): Promise<boolean> {
    if (!this.battleManager) {
      return false;
    }
    const grant = await this.battleManager.grantEventItem(session.userId, ref);
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
        const right = test.value;
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
      case "gold": {
        const user = await this.auth.getUserForBattle(session.userId);
        const money = user?.money ?? 0;
        return test.gte ? money >= test.amount : money <= test.amount;
      }
      case "script": {
        const trainerBattle = test.text.match(RE_TRAINER_BATTLE);
        if (trainerBattle) {
          // The battle IS the condition: its outcome selects the branch
          // (win -> self switch A = trainer defeated, like Essentials).
          return this.runScriptedTrainerBattle(session, trainerBattle[1], trainerBattle[2]);
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
          return this.compareNumbers(partyLength[1], count, Number(partyLength[2]));
        }
        const pokemonCount = test.text.match(RE_POKEMON_COUNT);
        if (pokemonCount) {
          const user = await this.auth.getUserForBattle(session.userId);
          const count = (user?.pokemonParty ?? []).filter((pokemon) => !pokemon.isEgg).length;
          return this.compareNumbers(pokemonCount[1], count, Number(pokemonCount[2]));
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
        // Unknown script tests keep the old permissive behavior.
        return true;
      }
      case "always":
        return test.value;
    }
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
        ?.editorDataByMapId[session.player.currentMapId]?.npcs.find(
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
        ?.editorDataByMapId[session.player.currentMapId]?.npcs.find(
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

    const trainerBattle = text.match(RE_TRAINER_BATTLE);
    if (trainerBattle) {
      // Some events call pbTrainerBattle as a plain script (no branch).
      await this.runScriptedTrainerBattle(session, trainerBattle[1], trainerBattle[2]);
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
  }

  // -- page selection ------------------------------------------------------
  private selectActivePage(
    pages: EventPage[],
    state: { switches: Record<string, boolean>; variables: Record<string, number>; selfSwitches: Record<string, boolean> },
    essentials: EssentialsEvent
  ): EventPage | null {
    // RMXP uses the highest-index page whose conditions are all satisfied.
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      if (this.pageConditionsMet(pages[index].conditions, state, essentials)) {
        const page = pages[index];
        // A page with no runnable commands (an emptied one-off) shows nothing.
        return page.commands.some((command) => command.code !== 0) ? page : null;
      }
    }
    return null;
  }

  private pageConditionsMet(
    conditions: PageConditions,
    state: { switches: Record<string, boolean>; variables: Record<string, number>; selfSwitches: Record<string, boolean> },
    essentials: EssentialsEvent
  ): boolean {
    if (conditions.switch1 && !state.switches[String(conditions.switch1)]) {
      return false;
    }
    if (conditions.switch2 && !state.switches[String(conditions.switch2)]) {
      return false;
    }
    if (conditions.selfSwitch) {
      const key = `${essentials.essentialsMapId}:${essentials.eventId}:${conditions.selfSwitch}`;
      if (!state.selfSwitches[key]) {
        return false;
      }
    }
    if (conditions.variable) {
      const current = Number(state.variables[String(conditions.variable.id)] ?? 0);
      if (current < conditions.variable.value) {
        return false;
      }
    }
    return true;
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
    case 7:
      // Gold check (vending machines): [7, amount, operator(0 >=, 1 <=)].
      return { kind: "gold", amount: Number(parameters[1] ?? 0), gte: parameters[2] === 0 };
    case 12: {
      // Script condition — trainer battles live here in Essentials events:
      // `pbTrainerBattle(PBTrainers::TYPE, "Name", ...)` is the test itself.
      const text = typeof parameters[1] === "string" ? parameters[1] : "";
      return text ? { kind: "script", text } : { kind: "always", value: true };
    }
    default:
      // Unsupported condition types (item/etc.): let the dialog proceed.
      return { kind: "always", value: true };
  }
}
