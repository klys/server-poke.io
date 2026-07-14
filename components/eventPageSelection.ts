/**
 * RPG Maker XP event page selection, shared by the event runtime (dialog /
 * autorun execution) and the world (NPC collision): the active page is the
 * highest-index page whose switch/variable/self-switch conditions are met for
 * the given player state.
 */

export type EventPlayerState = {
  switches: Record<string, boolean>;
  variables: Record<string, number>;
  selfSwitches: Record<string, boolean>;
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

export const EMPTY_EVENT_PLAYER_STATE: EventPlayerState = {
  switches: {},
  variables: {},
  selfSwitches: {}
};

export function eventPageConditionsMet(
  conditions: EventPageConditions,
  state: EventPlayerState,
  essentials: EssentialsEventRecord
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

/** The condition-satisfied page regardless of contents (collision cares about
 * the graphic, not whether the page has commands to run). */
export function selectConditionMetPage(
  essentials: EssentialsEventRecord,
  state: EventPlayerState
): EssentialsEventPage | null {
  const pages = essentials.pages ?? [];
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    if (eventPageConditionsMet(pages[index].conditions ?? {}, state, essentials)) {
      return pages[index];
    }
  }
  return null;
}

export function selectActiveEventPage(
  essentials: EssentialsEventRecord,
  state: EventPlayerState
): EssentialsEventPage | null {
  const page = selectConditionMetPage(essentials, state);
  if (!page) {
    return null;
  }
  // A page with no runnable commands (an emptied one-off) shows nothing.
  return (page.commands ?? []).some((command) => command.code !== 0) ? page : null;
}
