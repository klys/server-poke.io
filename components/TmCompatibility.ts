/**
 * TM/HM (MT/MO) move-compatibility lookup.
 *
 * Backed by the committed, auto-generated `generated/tmCompatibility.ts` table
 * (from Essentials PBS tm.txt). Answers "may this species learn this move from a
 * machine?" — the gate applied when teaching an MO or MT item, and reused by the
 * field-skill checks.
 *
 * Keys are Essentials internal names, upper-cased: the move internal (CUT, SURF,
 * HONECLAWS, ...) and the species essentialsId (BULBASAUR, NIDORANFE, ...).
 */
import { TM_COMPATIBILITY } from "./generated/tmCompatibility";

let cachedTable: Map<string, Set<string>> | null = null;

function loadTable(): Map<string, Set<string>> {
  if (cachedTable) {
    return cachedTable;
  }
  const table = new Map<string, Set<string>>();
  for (const [move, species] of Object.entries(TM_COMPATIBILITY)) {
    table.set(move.toUpperCase(), new Set(species.map((name) => name.toUpperCase())));
  }
  cachedTable = table;
  return table;
}

/** True when tm.txt defines a compatibility list for this move (i.e. it is a
 * real TM/HM move we can gate). Custom moves with no list are ungated. */
export function hasCompatibilityList(moveInternal: string): boolean {
  return loadTable().has(String(moveInternal ?? "").toUpperCase());
}

/** True when `speciesEssentialsId` may learn `moveInternal` from a machine.
 * Returns false when the move has a list but the species is absent (fail-closed);
 * callers should first consult `hasCompatibilityList` to distinguish "not
 * allowed" from "no data to enforce". */
export function isSpeciesCompatible(moveInternal: string, speciesEssentialsId: string): boolean {
  const set = loadTable().get(String(moveInternal ?? "").toUpperCase());
  if (!set) {
    return false;
  }
  return set.has(String(speciesEssentialsId ?? "").toUpperCase());
}

/**
 * Convenience gate for teaching: allows the teach when there is no list to
 * enforce (custom move), otherwise requires the species to be in the list.
 */
export function canSpeciesLearnMachineMove(
  moveInternal: string,
  speciesEssentialsId: string
): boolean {
  if (!hasCompatibilityList(moveInternal)) {
    return true;
  }
  return isSpeciesCompatible(moveInternal, speciesEssentialsId);
}
