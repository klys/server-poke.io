import type { BattleStatusId } from "./events";

/**
 * Non-volatile status conditions with classic (Gen III era, matching the
 * source Essentials project) semantics. The `counter` carries sleep turns
 * remaining or the toxic damage multiplier.
 */
export type StatusState = {
  id: BattleStatusId;
  counter: number;
};

export const STATUS_DISPLAY_NAMES: Record<BattleStatusId, string> = {
  poison: "poisoned",
  toxic: "badly poisoned",
  burn: "burned",
  paralysis: "paralyzed",
  sleep: "asleep",
  freeze: "frozen"
};

const STATUS_TYPE_IMMUNITIES: Record<BattleStatusId, string[]> = {
  poison: ["POISON", "STEEL"],
  toxic: ["POISON", "STEEL"],
  burn: ["FIRE"],
  paralysis: ["ELECTRIC"],
  sleep: [],
  freeze: ["ICE"]
};

export function createStatusState(id: BattleStatusId): StatusState {
  if (id === "sleep") {
    // 2-5 turns of sleep, decremented before each action attempt.
    return { id, counter: 2 + Math.floor(Math.random() * 4) };
  }
  if (id === "toxic") {
    return { id, counter: 1 };
  }
  return { id, counter: 0 };
}

export function isImmuneToStatus(id: BattleStatusId, defenderTypeIds: string[]): boolean {
  const immuneTypes = STATUS_TYPE_IMMUNITIES[id];
  return defenderTypeIds.some((typeId) => immuneTypes.includes(typeId.toUpperCase()));
}

export function sanitizeStatusState(value: unknown): StatusState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as { id?: unknown; counter?: unknown };
  const id = candidate.id;
  if (
    id !== "poison" &&
    id !== "toxic" &&
    id !== "burn" &&
    id !== "paralysis" &&
    id !== "sleep" &&
    id !== "freeze"
  ) {
    return null;
  }

  const counter =
    typeof candidate.counter === "number" && Number.isFinite(candidate.counter)
      ? Math.max(0, Math.round(candidate.counter))
      : 0;

  return { id, counter };
}

export type StatusActionCheck = {
  canMove: boolean;
  cured: boolean;
  message: string | null;
};

/**
 * Run before a pokemon attempts its move. Mutates the status counter for
 * sleep and rolls thaw/full-paralysis chances.
 */
export function checkStatusBeforeMove(status: StatusState | null, displayName: string): StatusActionCheck {
  if (!status) {
    return { canMove: true, cured: false, message: null };
  }

  if (status.id === "sleep") {
    if (status.counter <= 0) {
      return { canMove: true, cured: true, message: `${displayName} woke up!` };
    }
    status.counter -= 1;
    return { canMove: false, cured: false, message: `${displayName} is fast asleep.` };
  }

  if (status.id === "freeze") {
    if (Math.random() < 0.2) {
      return { canMove: true, cured: true, message: `${displayName} thawed out!` };
    }
    return { canMove: false, cured: false, message: `${displayName} is frozen solid!` };
  }

  if (status.id === "paralysis" && Math.random() < 0.25) {
    return { canMove: false, cured: false, message: `${displayName} is paralyzed! It can't move!` };
  }

  return { canMove: true, cured: false, message: null };
}

export type StatusEndOfTurnResult = {
  damage: number;
  message: string | null;
};

/** End-of-turn residual damage. Mutates the toxic counter. */
export function applyStatusEndOfTurn(
  status: StatusState | null,
  maxHp: number,
  displayName: string
): StatusEndOfTurnResult {
  if (!status) {
    return { damage: 0, message: null };
  }

  if (status.id === "poison") {
    return {
      damage: Math.max(1, Math.floor(maxHp / 8)),
      message: `${displayName} is hurt by poison!`
    };
  }

  if (status.id === "toxic") {
    const damage = Math.max(1, Math.floor((maxHp * Math.min(15, status.counter)) / 16));
    status.counter += 1;
    return { damage, message: `${displayName} is hurt by poison!` };
  }

  if (status.id === "burn") {
    return {
      damage: Math.max(1, Math.floor(maxHp / 16)),
      message: `${displayName} is hurt by its burn!`
    };
  }

  return { damage: 0, message: null };
}

/** Burn halves physical attack; paralysis quarters speed (classic rules). */
export function getStatusStatMultiplier(
  status: StatusState | null,
  stat: "attack" | "speed"
): number {
  if (!status) {
    return 1;
  }

  if (stat === "attack" && status.id === "burn") {
    return 0.5;
  }

  if (stat === "speed" && status.id === "paralysis") {
    return 0.25;
  }

  return 1;
}

/** Catch-rate bonus used by the capture formula. */
export function getStatusCatchBonus(status: StatusState | null): number {
  if (!status) {
    return 1;
  }

  if (status.id === "sleep" || status.id === "freeze") {
    return 2;
  }

  return 1.5;
}
