/**
 * Dive surface<->underwater pairing lookup, backed by the generated
 * `generated/diveMaps.ts` table (from Essentials metadata DiveMap=).
 */
import { DIVE_MAP_PAIRS } from "./generated/diveMaps";

export type DivePair = {
  /** Whether the queried map is the surface or the underwater side. */
  role: "surface" | "underwater";
  /** The map on the other side of the dive. */
  pairedMapId: string;
};

let cache: Map<string, DivePair> | null = null;

function load(): Map<string, DivePair> {
  if (cache) {
    return cache;
  }
  const map = new Map<string, DivePair>();
  for (const [surface, underwater] of DIVE_MAP_PAIRS) {
    map.set(surface, { role: "surface", pairedMapId: underwater });
    map.set(underwater, { role: "underwater", pairedMapId: surface });
  }
  cache = map;
  return map;
}

/** The dive pairing for a map, or null when the map has no dive counterpart. */
export function resolveDivePair(mapId: string): DivePair | null {
  return load().get(mapId) ?? null;
}
