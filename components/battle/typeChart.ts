import type { DesignerSectionItem } from "../DesignerSectionStore";

/**
 * Type effectiveness resolved from the designer `types` section when
 * available (weaknesses/resistances/immunities are defensive relations keyed
 * by Essentials internal type ids), falling back to the standard 18-type
 * chart for types the designer data does not cover.
 */
export type TypeChart = {
  /** attackerTypeId -> defenderTypeId -> multiplier (only non-1 entries) */
  matchups: Map<string, Map<string, number>>;
  /** alias (lowercased display name, internal id, english name) -> internal id */
  aliases: Map<string, string>;
};

const ENGLISH_TYPE_IDS: Record<string, string> = {
  normal: "NORMAL",
  fire: "FIRE",
  water: "WATER",
  electric: "ELECTRIC",
  electricity: "ELECTRIC",
  grass: "GRASS",
  ice: "ICE",
  fighting: "FIGHTING",
  fight: "FIGHTING",
  poison: "POISON",
  ground: "GROUND",
  flying: "FLYING",
  psychic: "PSYCHIC",
  bug: "BUG",
  rock: "ROCK",
  ghost: "GHOST",
  dragon: "DRAGON",
  dark: "DARK",
  steel: "STEEL",
  fairy: "FAIRY",
  shadow: "SHADOW"
};

const FALLBACK_DEFENSIVE: Record<string, { weak: string[]; resist: string[]; immune: string[] }> = {
  NORMAL: { weak: ["FIGHTING"], resist: [], immune: ["GHOST"] },
  FIRE: { weak: ["WATER", "GROUND", "ROCK"], resist: ["FIRE", "GRASS", "ICE", "BUG", "STEEL", "FAIRY"], immune: [] },
  WATER: { weak: ["ELECTRIC", "GRASS"], resist: ["FIRE", "WATER", "ICE", "STEEL"], immune: [] },
  ELECTRIC: { weak: ["GROUND"], resist: ["ELECTRIC", "FLYING", "STEEL"], immune: [] },
  GRASS: { weak: ["FIRE", "ICE", "POISON", "FLYING", "BUG"], resist: ["WATER", "ELECTRIC", "GRASS", "GROUND"], immune: [] },
  ICE: { weak: ["FIRE", "FIGHTING", "ROCK", "STEEL"], resist: ["ICE"], immune: [] },
  FIGHTING: { weak: ["FLYING", "PSYCHIC", "FAIRY"], resist: ["BUG", "ROCK", "DARK"], immune: [] },
  POISON: { weak: ["GROUND", "PSYCHIC"], resist: ["GRASS", "FIGHTING", "POISON", "BUG", "FAIRY"], immune: [] },
  GROUND: { weak: ["WATER", "GRASS", "ICE"], resist: ["POISON", "ROCK"], immune: ["ELECTRIC"] },
  FLYING: { weak: ["ELECTRIC", "ICE", "ROCK"], resist: ["GRASS", "FIGHTING", "BUG"], immune: ["GROUND"] },
  PSYCHIC: { weak: ["BUG", "GHOST", "DARK"], resist: ["FIGHTING", "PSYCHIC"], immune: [] },
  BUG: { weak: ["FIRE", "FLYING", "ROCK"], resist: ["GRASS", "FIGHTING", "GROUND"], immune: [] },
  ROCK: { weak: ["WATER", "GRASS", "FIGHTING", "GROUND", "STEEL"], resist: ["NORMAL", "FIRE", "POISON", "FLYING"], immune: [] },
  GHOST: { weak: ["GHOST", "DARK"], resist: ["POISON", "BUG"], immune: ["NORMAL", "FIGHTING"] },
  DRAGON: { weak: ["ICE", "DRAGON", "FAIRY"], resist: ["FIRE", "WATER", "ELECTRIC", "GRASS"], immune: [] },
  DARK: { weak: ["FIGHTING", "BUG", "FAIRY"], resist: ["GHOST", "DARK"], immune: ["PSYCHIC"] },
  STEEL: { weak: ["FIRE", "FIGHTING", "GROUND"], resist: ["NORMAL", "GRASS", "ICE", "FLYING", "PSYCHIC", "BUG", "ROCK", "DRAGON", "STEEL", "FAIRY"], immune: ["POISON"] },
  FAIRY: { weak: ["POISON", "STEEL"], resist: ["FIGHTING", "BUG", "DARK"], immune: ["DRAGON"] }
};

function normalizeTypeToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function setMatchup(chart: TypeChart, attackerId: string, defenderId: string, multiplier: number) {
  if (!attackerId || !defenderId) {
    return;
  }

  let row = chart.matchups.get(attackerId);
  if (!row) {
    row = new Map<string, number>();
    chart.matchups.set(attackerId, row);
  }
  row.set(defenderId, multiplier);
}

function addAlias(chart: TypeChart, alias: string, typeId: string) {
  const normalized = alias.trim().toLowerCase();
  if (normalized && !chart.aliases.has(normalized)) {
    chart.aliases.set(normalized, typeId);
  }
}

function addDefensiveRelations(
  chart: TypeChart,
  defenderId: string,
  relations: { weak: string[]; resist: string[]; immune: string[] }
) {
  relations.weak.forEach((attacker) => setMatchup(chart, normalizeTypeToken(attacker), defenderId, 2));
  relations.resist.forEach((attacker) => setMatchup(chart, normalizeTypeToken(attacker), defenderId, 0.5));
  relations.immune.forEach((attacker) => setMatchup(chart, normalizeTypeToken(attacker), defenderId, 0));
}

export function buildTypeChart(typeItems: DesignerSectionItem[]): TypeChart {
  const chart: TypeChart = { matchups: new Map(), aliases: new Map() };
  const coveredDefenders = new Set<string>();

  for (const item of typeItems) {
    const profile = item.typeProfile as {
      essentialsId?: unknown;
      name?: unknown;
      weaknesses?: unknown;
      resistances?: unknown;
      immunities?: unknown;
    } | undefined;

    if (!profile) {
      continue;
    }

    const typeId = normalizeTypeToken(profile.essentialsId) || normalizeTypeToken(item.name);
    if (!typeId) {
      continue;
    }

    coveredDefenders.add(typeId);
    addAlias(chart, typeId, typeId);
    addAlias(chart, item.name, typeId);
    if (typeof profile.name === "string") {
      addAlias(chart, profile.name, typeId);
    }
    addAlias(chart, item.id, typeId);

    const toList = (value: unknown) =>
      Array.isArray(value) ? value.map(normalizeTypeToken).filter(Boolean) : [];

    addDefensiveRelations(chart, typeId, {
      weak: toList(profile.weaknesses),
      resist: toList(profile.resistances),
      immune: toList(profile.immunities)
    });
  }

  Object.entries(FALLBACK_DEFENSIVE).forEach(([defenderId, relations]) => {
    if (!coveredDefenders.has(defenderId)) {
      addDefensiveRelations(chart, defenderId, relations);
    }
  });

  Object.entries(ENGLISH_TYPE_IDS).forEach(([english, typeId]) => {
    addAlias(chart, english, typeId);
  });

  return chart;
}

export function resolveTypeId(chart: TypeChart, rawType: string): string {
  const alias = chart.aliases.get(rawType.trim().toLowerCase());
  return alias ?? normalizeTypeToken(rawType);
}

export function getTypeEffectiveness(
  chart: TypeChart,
  moveType: string,
  defenderTypes: string[]
): number {
  const attackerId = resolveTypeId(chart, moveType);

  return defenderTypes.reduce((multiplier, defenderType) => {
    const defenderId = resolveTypeId(chart, defenderType);
    return multiplier * (chart.matchups.get(attackerId)?.get(defenderId) ?? 1);
  }, 1);
}

export function isSameType(chart: TypeChart, left: string, right: string): boolean {
  return resolveTypeId(chart, left) === resolveTypeId(chart, right);
}
