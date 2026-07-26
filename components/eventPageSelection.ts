/**
 * RPG Maker XP event page selection, shared by the event runtime (dialog /
 * autorun execution) and the world (NPC collision): the active page is the
 * highest-index page whose switch/variable/self-switch conditions are met for
 * the given player state.
 *
 * Pokemon Essentials extends plain RMXP switches with *script switches*: a
 * switch whose System name starts with "s:" is not a stored flag but a Ruby
 * expression evaluated at refresh time (Game_Event#switchIsOn?). Venova gates
 * ~750 pages on these (day/night NPCs, per-event temp switches on doors and
 * daily events), so page selection accepts an optional script-switch table
 * (switch id -> expression) plus the environment needed to evaluate the
 * expressions the projects actually use.
 */

export type EventPlayerState = {
  switches: Record<string, boolean>;
  variables: Record<string, number>;
  selfSwitches: Record<string, boolean>;
  /**
   * Essentials per-event temp switches (tsOn?/tsOff?/setTempSwitchOn), keyed
   * like self switches (`essMapId:eventId:CH`). They live on Game_Event
   * instances in the original engine, so they are session-scoped: never
   * persisted, and reset when the player leaves the map.
   */
  tempSwitches?: Record<string, boolean>;
};

export type EventPageConditions = {
  switch1?: number;
  switch2?: number;
  selfSwitch?: string;
  variable?: { id: number; value: number };
};

export type EssentialsEventPage = {
  conditions: EventPageConditions;
  graphic: { characterName: string; direction: number; pattern: number };
  trigger: number;
  commands: Array<{ code: number; indent: number; parameters: unknown[] }>;
  move?: { through?: boolean };
};

export type EssentialsEventRecord = {
  eventId: number;
  essentialsMapId: number;
  pages: EssentialsEventPage[];
};

/** Switch id -> the "s:" expression from System.rxdata (without the prefix). */
export type ScriptSwitchTable = Record<string, string>;

/** Real-world context script switches read (server clock; mirrored to clients). */
export type EventEnv = {
  /** Local hour 0-23. */
  hour: number;
  /** Local weekday 0 (Sunday) - 6 (Saturday). */
  weekday: number;
};

export type PageSelectionOptions = {
  scriptSwitches?: ScriptSwitchTable;
  env?: EventEnv;
  /** Called once per unsupported script-switch expression (diagnostics). */
  onUnknownScriptSwitch?: (switchId: number, expression: string) => void;
};

export const EMPTY_EVENT_PLAYER_STATE: EventPlayerState = {
  switches: {},
  variables: {},
  selfSwitches: {}
};

export function currentEventEnv(date: Date = new Date()): EventEnv {
  return { hour: date.getHours(), weekday: date.getDay() };
}

/**
 * Reserved self-switch set by `pbEraseThisEvent` (Cut trees, Rock Smash rocks).
 * An erased event has no active page for that player: it stops blocking and
 * renders nothing, persisting per-player like any self-switch.
 */
export const ERASED_SELF_SWITCH = "ERASED";

/** Key for the erased marker of an event, matching the self-switch key scheme. */
export function erasedSelfSwitchKey(essentials: { essentialsMapId: number; eventId: number }): string {
  return `${essentials.essentialsMapId}:${essentials.eventId}:${ERASED_SELF_SWITCH}`;
}

/** Temp-switch key of an event channel, matching the self-switch key scheme. */
export function tempSwitchKey(
  essentials: { essentialsMapId: number; eventId: number },
  channel: string
): string {
  return `${essentials.essentialsMapId}:${essentials.eventId}:${channel}`;
}

/** True when the player has erased this event (e.g. cut the tree / smashed the rock). */
export function isEventErased(
  essentials: { essentialsMapId: number; eventId: number },
  state: EventPlayerState
): boolean {
  return Boolean(state.selfSwitches[erasedSelfSwitchKey(essentials)]);
}

// -- Essentials script switches ("s:" System switch names) -------------------

const RE_TS_ON = /^(?:Kernel\.)?(?:tsOn\?|isTempSwitchOn\?)\(\s*"(\w+)"\s*\)$/;
const RE_TS_OFF = /^(?:Kernel\.)?(?:tsOff\?|isTempSwitchOff\?)\(\s*"(\w+)"\s*\)$/;
const RE_DAY_NIGHT = /^PBDayNight\.is(Day|Night|Morning|Afternoon|Evening)\?$/;
const RE_WEEKDAY = /^(?:Kernel\.)?pbIsWeekday\(\s*-?\d+\s*((?:,\s*\d+\s*)+)\)$/;
const RE_COOLDOWN = /^(?:Kernel\.)?(?:cooledDown\?|cooledDownDays\?)\(\s*\d+\s*\)$/;
// Feature checks for systems the online engine intentionally does not run;
// evaluating them false keeps their pages hidden, exactly like the original
// when outside those modes.
const RE_ALWAYS_FALSE = /^(?:Kernel\.)?(?:pbInSafari\?|pbInBugContest\?|pbBugContestUndecided\?|pbContest\?)$/;

/**
 * Evaluates one Essentials script-switch expression for a page condition.
 * Only the constructs present in the supported projects are implemented; an
 * unknown expression evaluates false (the page stays hidden) and is reported,
 * mirroring how an eval error would behave rather than silently unlocking
 * content.
 */
export function evaluateScriptSwitchExpression(
  expression: string,
  essentials: { essentialsMapId: number; eventId: number },
  state: EventPlayerState,
  env: EventEnv
): boolean | null {
  const trimmed = expression.trim();
  if (trimmed.startsWith("!")) {
    const inner = evaluateScriptSwitchExpression(trimmed.slice(1), essentials, state, env);
    return inner === null ? null : !inner;
  }

  const tsOn = trimmed.match(RE_TS_ON);
  if (tsOn) {
    return state.tempSwitches?.[tempSwitchKey(essentials, tsOn[1])] === true;
  }
  const tsOff = trimmed.match(RE_TS_OFF);
  if (tsOff) {
    return state.tempSwitches?.[tempSwitchKey(essentials, tsOff[1])] !== true;
  }

  const dayNight = trimmed.match(RE_DAY_NIGHT);
  if (dayNight) {
    const hour = env.hour;
    switch (dayNight[1]) {
      case "Day": return hour >= 6 && hour < 20;
      case "Night": return hour >= 20 || hour < 6;
      case "Morning": return hour >= 6 && hour < 12;
      case "Afternoon": return hour >= 12 && hour < 17;
      case "Evening": return hour >= 17 && hour < 20;
    }
  }

  const weekday = trimmed.match(RE_WEEKDAY);
  if (weekday) {
    const days = weekday[1]
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((day) => Number.isFinite(day));
    return days.includes(env.weekday);
  }

  // Daily/timed events (berry trees, once-a-day gifts): the original stores a
  // per-event timestamp in the save file and requires temp switch A off. The
  // online engine does not persist those timestamps, so this approximates to
  // "available once per map visit" via the temp switch — permissive for
  // repeatable freebies, never for story progression.
  if (RE_COOLDOWN.test(trimmed)) {
    return state.tempSwitches?.[tempSwitchKey(essentials, "A")] !== true;
  }

  if (RE_ALWAYS_FALSE.test(trimmed)) {
    return false;
  }

  return null; // unknown expression
}

function switchConditionMet(
  switchId: number,
  state: EventPlayerState,
  essentials: { essentialsMapId: number; eventId: number },
  options?: PageSelectionOptions
): boolean {
  const expression = options?.scriptSwitches?.[String(switchId)];
  if (typeof expression === "string" && expression.length > 0) {
    const env = options?.env ?? currentEventEnv();
    const result = evaluateScriptSwitchExpression(expression, essentials, state, env);
    if (result === null) {
      options?.onUnknownScriptSwitch?.(switchId, expression);
      return false;
    }
    return result;
  }
  return Boolean(state.switches[String(switchId)]);
}

export function eventPageConditionsMet(
  conditions: EventPageConditions,
  state: EventPlayerState,
  essentials: EssentialsEventRecord,
  options?: PageSelectionOptions
): boolean {
  if (conditions.switch1 && !switchConditionMet(conditions.switch1, state, essentials, options)) {
    return false;
  }
  if (conditions.switch2 && !switchConditionMet(conditions.switch2, state, essentials, options)) {
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

/** The condition-satisfied page regardless of contents (collision cares about
 * the graphic, not whether the page has commands to run). */
export function selectConditionMetPage(
  essentials: EssentialsEventRecord,
  state: EventPlayerState,
  options?: PageSelectionOptions
): EssentialsEventPage | null {
  if (isEventErased(essentials, state)) {
    return null;
  }
  const pages = essentials.pages ?? [];
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    if (eventPageConditionsMet(pages[index].conditions ?? {}, state, essentials, options)) {
      return pages[index];
    }
  }
  return null;
}

export function selectActiveEventPage(
  essentials: EssentialsEventRecord,
  state: EventPlayerState,
  options?: PageSelectionOptions
): EssentialsEventPage | null {
  const page = selectConditionMetPage(essentials, state, options);
  if (!page) {
    return null;
  }
  // A page with no runnable commands (an emptied one-off) shows nothing.
  return (page.commands ?? []).some((command) => command.code !== 0) ? page : null;
}
