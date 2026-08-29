// Venomon gender — shared by the battle engine (Attract, Rivalry…), the
// account layer (persisted on every PokemonSummary) and the house pet system
// (mating). A summary created before genders were persisted gets one lazily
// from the same id hash the battle engine always used, so nothing changes
// gender when it is migrated.

export type PokemonGender = "male" | "female" | "genderless";

export function isPokemonGender(value: unknown): value is PokemonGender {
    return value === "male" || value === "female" || value === "genderless";
}

/** Essentials GenderRate names -> female fraction (-1 = genderless). */
export function parseFemaleRatio(raw: unknown): number {
    switch (typeof raw === "string" ? raw.trim().toLowerCase() : "") {
        case "alwaysmale":
            return 0;
        case "alwaysfemale":
            return 1;
        case "genderless":
            return -1;
        case "femaleoneeighth":
            return 1 / 8;
        case "female25percent":
            return 0.25;
        case "female75percent":
            return 0.75;
        case "femaleseveneighths":
            return 7 / 8;
        default:
            return 0.5;
    }
}

/**
 * Stable per-individual gender derived from the venomon's id, so the same
 * individual is always the same gender even before it was persisted.
 */
export function deriveGender(id: string, femaleRatio: number): PokemonGender {
    if (femaleRatio < 0) {
        return "genderless";
    }
    if (femaleRatio <= 0) {
        return "male";
    }
    if (femaleRatio >= 1) {
        return "female";
    }
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
        hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
    }
    return (hash % 1000) / 1000 < femaleRatio ? "female" : "male";
}

/** Freshly rolled gender for a new individual (starters, gifts, eggs). */
export function rollGender(femaleRatio: number): PokemonGender {
    if (femaleRatio < 0) return "genderless";
    return Math.random() < femaleRatio ? "female" : "male";
}

export const GENDER_SYMBOL: Record<PokemonGender, string> = {
    male: "♂",
    female: "♀",
    genderless: ""
};
