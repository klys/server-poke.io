// Global berry plots — the shared, server-timed berry farming system.
//
// Every imported Essentials event with a `pbBerryPlant` page (the "BerryPlant"
// soil patches on Ruta1 / Ruta 3) becomes ONE world-wide plot: anybody can
// plant a berry from their bag, watch it grow, harvest it once ripe, or clear
// the soil. State is global (not per-player self switches like the rest of
// the event runtime) and persisted in Redis (`world:berry-plots`), so a plant
// keeps growing while nobody is around and survives restarts.
//
// Growth is pure wall-clock: `stage = 1 + floor((now - plantedAt) / stageMs)`
// capped at 5 (1 planted, 2 sprouted, 3 taller, 4 flowering, 5 ripe), with
// `stageMs = hoursPerStage * 1h * BERRY_GROWTH_SCALE` (PBS berryplants.txt via
// components/generated/berryPlants.ts). Nothing ticks per plant: clients
// receive `plantedAt` + `stageMs` and animate the stage themselves, so the
// only server traffic is on plant / harvest / clear (`berry:update`) and map
// arrival (`berry:sync`).
//
// Pre-grown authored trees (page 0 `pbPickBerry(:X, n)`) seed their plot ripe
// with berry X the first time the plot is discovered; afterwards the plot is
// whatever players make of it.

import type { RedisClientType } from "redis";
import type World from "./world";
import { BERRY_PLANTS, type BerryPlantProfile } from "./generated/berryPlants";
import { RE_PICK_BERRY } from "./essentialsScriptAdapters";

const REDIS_KEY = "world:berry-plots";
const HOUR_MS = 60 * 60 * 1000;
export const RIPE_STAGE = 5;
const GROWING_STAGES = RIPE_STAGE - 1;
const RE_BERRY_PLANT = /pbBerryPlant/i;

/** Env knob for dev/E2E: 0.001 turns a 3h stage into ~11s. */
function growthScale(): number {
    const raw = Number(process.env.BERRY_GROWTH_SCALE);
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export function stageDurationMs(profile: BerryPlantProfile): number {
    return Math.max(1000, Math.round(profile.hoursPerStage * HOUR_MS * growthScale()));
}

export function berryProfile(berryId: string | null | undefined): BerryPlantProfile | null {
    if (!berryId) return null;
    return BERRY_PLANTS[berryId.toUpperCase()] ?? null;
}

/** Growth stage 1..5 of a plant planted at `plantedAt`, as of `now`. */
export function growthStage(plantedAt: number, stageMs: number, now: number): number {
    const elapsed = Math.max(0, now - plantedAt);
    return Math.min(RIPE_STAGE, 1 + Math.floor(elapsed / stageMs));
}

/** Persisted per-plot state (what players did to it). */
export type BerryPlotState = {
    id: string;
    berryId: string | null;
    plantedAt: number | null;
    plantedBy: string | null;
};

/** Authored plot (where the soil is), from the imported map events. */
type BerryPlotSite = {
    id: string;
    mapId: string;
    x: number;
    y: number;
    /** Berry of the pre-grown authored tree, if the event starts as one. */
    initialBerryId: string | null;
};

/** What clients render / act on. `t` in the packet is the server clock. */
export type BerryPlotSnapshot = {
    id: string;
    mapId: string;
    x: number;
    y: number;
    berryId: string | null;
    itemId: string | null;
    plantedAt: number | null;
    plantedBy: string | null;
    stageMs: number | null;
    ripeAt: number | null;
    stage: number;
};

function sanitizeState(value: unknown): BerryPlotState | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<BerryPlotState>;
    if (typeof candidate.id !== "string" || !candidate.id) return null;
    const berryId =
        typeof candidate.berryId === "string" && candidate.berryId.trim()
            ? candidate.berryId.trim().toUpperCase()
            : null;
    const plantedAt =
        typeof candidate.plantedAt === "number" && Number.isFinite(candidate.plantedAt)
            ? Math.round(candidate.plantedAt)
            : null;
    return {
        id: candidate.id,
        berryId: berryId && plantedAt !== null ? berryId : null,
        plantedAt: berryId && plantedAt !== null ? plantedAt : null,
        plantedBy: typeof candidate.plantedBy === "string" && candidate.plantedBy ? candidate.plantedBy : null
    };
}

export class BerryPlotStore {
    constructor(private readonly redis: RedisClientType) {}

    async readAll(): Promise<BerryPlotState[]> {
        const raw = await this.redis.get(REDIS_KEY);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed)
                ? parsed.map(sanitizeState).filter((plot): plot is BerryPlotState => Boolean(plot))
                : [];
        } catch (error) {
            console.error("Unable to parse berry plot state:", error);
            return [];
        }
    }

    async saveAll(plots: BerryPlotState[]) {
        await this.redis.set(REDIS_KEY, JSON.stringify(plots.map(sanitizeState).filter(Boolean)));
    }
}

type PlacementLike = {
    id?: unknown;
    x?: unknown;
    y?: unknown;
    essentialsEvent?: { pages?: Array<{ commands?: Array<{ code?: number; parameters?: unknown[] }> }> };
};

function scriptTexts(page: { commands?: Array<{ code?: number; parameters?: unknown[] }> }): string[] {
    const texts: string[] = [];
    for (const command of page.commands ?? []) {
        if (command.code !== 355 && command.code !== 655) continue;
        const text = command.parameters?.[0];
        if (typeof text === "string") texts.push(text);
    }
    return texts;
}

/** True when an imported event is a berry plot (has a `pbBerryPlant` page). */
export function isBerryPlotPlacement(placement: unknown): boolean {
    const pages = (placement as PlacementLike | null)?.essentialsEvent?.pages;
    if (!Array.isArray(pages)) return false;
    return pages.some((page) => scriptTexts(page).some((text) => RE_BERRY_PLANT.test(text)));
}

function siteFromPlacement(mapId: string, placement: unknown): BerryPlotSite | null {
    const candidate = placement as PlacementLike | null;
    if (!candidate || typeof candidate.id !== "string" || !isBerryPlotPlacement(candidate)) return null;
    if (typeof candidate.x !== "number" || typeof candidate.y !== "number") return null;

    let initialBerryId: string | null = null;
    for (const page of candidate.essentialsEvent?.pages ?? []) {
        for (const text of scriptTexts(page)) {
            const match = RE_PICK_BERRY.exec(text);
            if (match && berryProfile(match[1])) {
                initialBerryId = match[1].toUpperCase();
                break;
            }
        }
        if (initialBerryId) break;
    }

    return { id: candidate.id, mapId, x: candidate.x, y: candidate.y, initialBerryId };
}

export default class BerryPlots {
    private readonly sites = new Map<string, BerryPlotSite>();
    private readonly states = new Map<string, BerryPlotState>();
    private store: BerryPlotStore | null = null;
    private ready = false;

    constructor(private readonly world: World) {}

    async initialize(store: BerryPlotStore) {
        this.store = store;
        for (const state of await store.readAll()) {
            this.states.set(state.id, state);
        }
        this.ready = true;
        this.rescan();
    }

    /**
     * Rebuilds the plot sites from the current maps payload. Plots seen for
     * the first time seed from their authored tree (ripe, ready to pick).
     * Called on startup and whenever the playable maps state changes.
     */
    rescan() {
        const snapshot = this.world.getPlayableMapsState();
        if (!snapshot || !this.ready) return;

        this.sites.clear();
        let seeded = 0;
        const now = Date.now();
        for (const [mapId, editorData] of Object.entries(snapshot.editorDataByMapId ?? {})) {
            for (const placement of editorData?.npcs ?? []) {
                const site = siteFromPlacement(mapId, placement);
                if (!site) continue;
                this.sites.set(site.id, site);
                if (!this.states.has(site.id)) {
                    const profile = berryProfile(site.initialBerryId);
                    this.states.set(site.id, {
                        id: site.id,
                        berryId: profile ? site.initialBerryId : null,
                        // Authored trees start fully grown: back-date the planting.
                        plantedAt: profile ? now - GROWING_STAGES * stageDurationMs(profile) : null,
                        plantedBy: null
                    });
                    seeded += 1;
                }
            }
        }
        if (seeded > 0) {
            console.log(`[berry-plots] seeded ${seeded} new plot(s); ${this.sites.size} total`);
            this.persist();
        }
    }

    private persist() {
        void this.store?.saveAll(Array.from(this.states.values())).catch((error) => {
            console.error("[berry-plots] persist failed:", error);
        });
    }

    isPlot(plotId: string): boolean {
        return this.sites.has(plotId);
    }

    getSite(plotId: string): { id: string; mapId: string; x: number; y: number } | null {
        return this.sites.get(plotId) ?? null;
    }

    findAt(mapId: string, x: number, y: number): BerryPlotSnapshot | null {
        for (const site of Array.from(this.sites.values())) {
            if (site.mapId === mapId && site.x === x && site.y === y) {
                return this.snapshot(site.id);
            }
        }
        return null;
    }

    snapshot(plotId: string, now = Date.now()): BerryPlotSnapshot | null {
        const site = this.sites.get(plotId);
        if (!site) return null;
        const state = this.states.get(plotId);
        const profile = berryProfile(state?.berryId);
        if (!state || !profile || state.plantedAt === null || !state.berryId) {
            return {
                id: site.id,
                mapId: site.mapId,
                x: site.x,
                y: site.y,
                berryId: null,
                itemId: null,
                plantedAt: null,
                plantedBy: null,
                stageMs: null,
                ripeAt: null,
                stage: 0
            };
        }
        const stageMs = stageDurationMs(profile);
        return {
            id: site.id,
            mapId: site.mapId,
            x: site.x,
            y: site.y,
            berryId: state.berryId,
            itemId: `item-${state.berryId.toLowerCase()}`,
            plantedAt: state.plantedAt,
            plantedBy: state.plantedBy,
            stageMs,
            ripeAt: state.plantedAt + GROWING_STAGES * stageMs,
            stage: growthStage(state.plantedAt, stageMs, now)
        };
    }

    snapshotForMap(mapId: string): BerryPlotSnapshot[] {
        const now = Date.now();
        const plots: BerryPlotSnapshot[] = [];
        for (const site of Array.from(this.sites.values())) {
            if (site.mapId !== mapId) continue;
            const plot = this.snapshot(site.id, now);
            if (plot) plots.push(plot);
        }
        return plots;
    }

    /** Sends every plot of a map to one socket (map arrival). */
    presentTo(socketId: string, mapId: string) {
        const plots = this.snapshotForMap(mapId);
        if (plots.length === 0) return;
        (this.world.constructor as typeof World).socketServer
            .in(socketId)
            .emit("berry:sync", { mapId, t: Date.now(), plots });
    }

    private broadcast(plotId: string) {
        const plot = this.snapshot(plotId);
        if (!plot) return;
        this.world.emitToMap(plot.mapId, "berry:update", { mapId: plot.mapId, t: Date.now(), plot });
    }

    /** Puts a berry in an empty plot. The caller has already taken the item. */
    plant(plotId: string, berryId: string, plantedBy: string | null): BerryPlotSnapshot | null {
        const site = this.sites.get(plotId);
        const profile = berryProfile(berryId);
        if (!site || !profile) return null;
        const current = this.states.get(plotId);
        if (current?.berryId) return null;

        this.states.set(plotId, {
            id: plotId,
            berryId: berryId.toUpperCase(),
            plantedAt: Date.now(),
            plantedBy
        });
        this.persist();
        this.broadcast(plotId);
        return this.snapshot(plotId);
    }

    /**
     * Empties a ripe plot and rolls its yield (uniform in the PBS range). The
     * caller grants the berries; null when the plot is empty or not ripe yet.
     */
    harvest(plotId: string): { berryId: string; quantity: number } | null {
        const plot = this.snapshot(plotId);
        if (!plot || !plot.berryId || plot.stage < RIPE_STAGE) return null;
        const profile = berryProfile(plot.berryId);
        if (!profile) return null;

        const span = profile.maxYield - profile.minYield;
        const quantity = profile.minYield + Math.floor(Math.random() * (span + 1));
        this.clear(plotId);
        return { berryId: plot.berryId, quantity };
    }

    /** Empties a plot without yielding anything. */
    clear(plotId: string): boolean {
        const site = this.sites.get(plotId);
        if (!site) return false;
        const current = this.states.get(plotId);
        if (!current?.berryId) return false;
        this.states.set(plotId, { id: plotId, berryId: null, plantedAt: null, plantedBy: null });
        this.persist();
        this.broadcast(plotId);
        return true;
    }
}
