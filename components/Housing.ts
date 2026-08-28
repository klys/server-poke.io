// Player housing — apartments, house instances, furniture.
//
// The designer marks a map as a HOUSE template (`playableMapConfig.isHouse`)
// and places HOUSE DOOR cells on overworld maps (`editorData.houseDoors`). A
// door owns N apartments; each apartment is one purchasable house whose room
// is an INSTANCE of a template map. Instances are ordinary world maps with a
// synthetic id — `${templateMapId}--house-${apartmentId}` — so every
// map-scoped system (presence, movement broadcasts, map chat, followers) keeps
// working unchanged; only the geometry lookups (collision, bounds, editor
// data) resolve the instance back to its template through
// `templateMapIdFor`. What differs per instance lives here: the owner, the
// key code, the sale listing and the furniture.
//
// Persistence: one JSON blob in Redis (`world:houses`), keyed by apartment id.
// Apartment ids derive from the editor door id + index, so a door that is
// moved keeps its apartments and a door that is deleted orphans them (their
// state stays in Redis, harmless, until the door reappears).

import type { RedisClientType } from "redis";
import type World from "./world";
import type Player from "./player";
import type { MapEditorHouseDoor, PlayableMapsStateSnapshot } from "./PlayableMapsState";

export const HOUSE_INSTANCE_MARKER = "--house-";
const REDIS_KEY = "world:houses";
const KEY_CODE_PATTERN = /^\d{4,8}$/;
export const MAX_FURNITURE_PER_HOUSE = 200;
export const MAX_SALE_PRICE = 999_999_999;

export function isHouseInstanceMapId(mapId: string | null | undefined): boolean {
    return typeof mapId === "string" && mapId.includes(HOUSE_INSTANCE_MARKER);
}

/** `${templateMapId}--house-${apartmentId}` → its two halves, or null. */
export function parseHouseInstanceMapId(
    mapId: string | null | undefined
): { templateMapId: string; apartmentId: string } | null {
    if (typeof mapId !== "string") return null;
    const at = mapId.indexOf(HOUSE_INSTANCE_MARKER);
    if (at <= 0) return null;
    const templateMapId = mapId.slice(0, at);
    const apartmentId = mapId.slice(at + HOUSE_INSTANCE_MARKER.length);
    if (!templateMapId || !apartmentId) return null;
    return { templateMapId, apartmentId };
}

/** The map whose geometry/tiles/events an id renders with (identity for
 * ordinary maps, the template for a house instance). */
export function templateMapIdFor(mapId: string): string {
    return parseHouseInstanceMapId(mapId)?.templateMapId ?? mapId;
}

export function houseInstanceMapId(templateMapId: string, apartmentId: string): string {
    return `${templateMapId}${HOUSE_INSTANCE_MARKER}${apartmentId}`;
}

export function apartmentIdFor(doorId: string, index: number): string {
    return `${doorId}-${index}`;
}

/** Persisted per-apartment state (what players did with it). */
export type ApartmentState = {
    id: string;
    ownerCharacterId: number | null;
    ownerName: string | null;
    /** 4-8 digit code required from non-owners; null = free entrance. */
    keyCode: string | null;
    /** Listed sale price (any player may buy); null = not for sale. */
    salePrice: number | null;
    purchasedAt: number | null;
    furniture: FurnitureState[];
};

export type FurnitureState = {
    id: string;
    itemId: string;
    itemName: string;
    iconSrc: string;
    x: number;
    y: number;
    placedAt: number;
};

/** Authored door (from the map editor) with its resolved apartments. */
type HouseDoorSite = {
    id: string;
    mapId: string;
    x: number;
    y: number;
    name: string | null;
    apartments: Array<{ id: string; index: number; price: number; templateMapId: string; valid: boolean }>;
};

type ApartmentSite = {
    id: string;
    index: number;
    door: HouseDoorSite;
    price: number;
    templateMapId: string;
    /** False when the room map is missing or not a HOUSE template. */
    valid: boolean;
};

/** What a door menu shows for one apartment. */
export type ApartmentSummary = {
    id: string;
    index: number;
    name: string;
    templateMapId: string;
    /** Catalog price (unowned) or the listed sale price (for sale). */
    price: number;
    owned: boolean;
    ownerName: string | null;
    isOwner: boolean;
    /** Non-owners need a key code to enter. */
    locked: boolean;
    /** Owner view: whether a key code is currently set. */
    keyCodeSet: boolean;
    forSale: boolean;
    available: boolean;
};

export type DoorSummary = {
    doorId: string;
    mapId: string;
    x: number;
    y: number;
    name: string;
    apartments: ApartmentSummary[];
};

/** What a client needs while standing inside an instance (`house:sync`). */
export type HouseInstanceInfo = {
    mapId: string;
    apartmentId: string;
    doorId: string;
    templateMapId: string;
    name: string;
    ownerCharacterId: number | null;
    ownerName: string | null;
    isOwner: boolean;
    keyCodeSet: boolean;
    salePrice: number | null;
    furniture: FurnitureState[];
};

function sanitizeFurniture(value: unknown): FurnitureState | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Partial<FurnitureState>;
    if (typeof raw.id !== "string" || !raw.id || typeof raw.itemId !== "string" || !raw.itemId) return null;
    if (typeof raw.x !== "number" || !Number.isFinite(raw.x) || typeof raw.y !== "number" || !Number.isFinite(raw.y)) {
        return null;
    }
    return {
        id: raw.id,
        itemId: raw.itemId,
        itemName: typeof raw.itemName === "string" ? raw.itemName : raw.itemId,
        iconSrc: typeof raw.iconSrc === "string" ? raw.iconSrc : "",
        x: Math.max(0, Math.round(raw.x)),
        y: Math.max(0, Math.round(raw.y)),
        placedAt: typeof raw.placedAt === "number" && Number.isFinite(raw.placedAt) ? raw.placedAt : 0
    };
}

export function sanitizeApartmentState(value: unknown): ApartmentState | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Partial<ApartmentState>;
    if (typeof raw.id !== "string" || !raw.id) return null;
    const ownerCharacterId =
        typeof raw.ownerCharacterId === "number" && Number.isFinite(raw.ownerCharacterId)
            ? Math.round(raw.ownerCharacterId)
            : null;
    const keyCode = typeof raw.keyCode === "string" && KEY_CODE_PATTERN.test(raw.keyCode) ? raw.keyCode : null;
    const salePrice =
        typeof raw.salePrice === "number" && Number.isFinite(raw.salePrice) && raw.salePrice > 0
            ? Math.min(MAX_SALE_PRICE, Math.round(raw.salePrice))
            : null;
    return {
        id: raw.id,
        ownerCharacterId,
        ownerName: ownerCharacterId !== null && typeof raw.ownerName === "string" ? raw.ownerName : null,
        keyCode: ownerCharacterId !== null ? keyCode : null,
        salePrice: ownerCharacterId !== null ? salePrice : null,
        purchasedAt:
            ownerCharacterId !== null && typeof raw.purchasedAt === "number" && Number.isFinite(raw.purchasedAt)
                ? raw.purchasedAt
                : null,
        furniture: Array.isArray(raw.furniture)
            ? raw.furniture.map(sanitizeFurniture).filter((item): item is FurnitureState => Boolean(item))
            : []
    };
}

export function isValidKeyCode(value: unknown): value is string {
    return typeof value === "string" && KEY_CODE_PATTERN.test(value);
}

export class HouseStore {
    constructor(private readonly redis: RedisClientType) {}

    async readAll(): Promise<ApartmentState[]> {
        const raw = await this.redis.get(REDIS_KEY);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
            return list.map(sanitizeApartmentState).filter((item): item is ApartmentState => Boolean(item));
        } catch (error) {
            console.error("Unable to parse house state:", error);
            return [];
        }
    }

    async saveAll(apartments: ApartmentState[]) {
        await this.redis.set(
            REDIS_KEY,
            JSON.stringify(apartments.map(sanitizeApartmentState).filter(Boolean))
        );
    }
}

export type HouseEntryResult =
    | { ok: true; mapId: string; x: number; y: number }
    | { ok: false; error: string };

export default class Housing {
    private readonly doors = new Map<string, HouseDoorSite>();
    private readonly apartments = new Map<string, ApartmentSite>();
    private readonly states = new Map<string, ApartmentState>();
    private store: HouseStore | null = null;
    private ready = false;

    constructor(private readonly world: World) {}

    async initialize(store: HouseStore) {
        this.store = store;
        for (const state of await store.readAll()) {
            this.states.set(state.id, state);
        }
        this.ready = true;
        this.rescan();
    }

    /** Rebuilds door/apartment sites from the current maps payload. */
    rescan() {
        const snapshot = this.world.getPlayableMapsState();
        if (!snapshot) return;
        this.doors.clear();
        this.apartments.clear();
        const houseTemplates = new Set(
            snapshot.items
                .filter((item) => item.playableMapConfig?.isHouse === true)
                .map((item) => item.id)
        );
        for (const [mapId, editorData] of Object.entries(snapshot.editorDataByMapId ?? {})) {
            for (const door of (editorData?.houseDoors ?? []) as MapEditorHouseDoor[]) {
                const site: HouseDoorSite = {
                    id: door.id,
                    mapId,
                    x: door.x,
                    y: door.y,
                    name: door.name ?? null,
                    apartments: []
                };
                door.apartments.forEach((apartment, index) => {
                    const id = apartmentIdFor(door.id, index);
                    const valid = Boolean(apartment.mapId) && houseTemplates.has(apartment.mapId);
                    site.apartments.push({ id, index, price: apartment.price, templateMapId: apartment.mapId, valid });
                    this.apartments.set(id, {
                        id,
                        index,
                        door: site,
                        price: apartment.price,
                        templateMapId: apartment.mapId,
                        valid
                    });
                });
                this.doors.set(door.id, site);
            }
        }
    }

    private persist() {
        if (!this.ready) return;
        void this.store?.saveAll(Array.from(this.states.values())).catch((error) => {
            console.error("[housing] persist failed:", error);
        });
    }

    private stateOf(apartmentId: string): ApartmentState {
        let state = this.states.get(apartmentId);
        if (!state) {
            state = {
                id: apartmentId,
                ownerCharacterId: null,
                ownerName: null,
                keyCode: null,
                salePrice: null,
                purchasedAt: null,
                furniture: []
            };
            this.states.set(apartmentId, state);
        }
        return state;
    }

    // ── Doors ────────────────────────────────────────────────────────────

    getDoor(doorId: string): { id: string; mapId: string; x: number; y: number } | null {
        const door = this.doors.get(doorId);
        return door ? { id: door.id, mapId: door.mapId, x: door.x, y: door.y } : null;
    }

    doorAt(mapId: string, x: number, y: number): { id: string; mapId: string; x: number; y: number } | null {
        for (const door of Array.from(this.doors.values())) {
            if (door.mapId === mapId && door.x === x && door.y === y) {
                return { id: door.id, mapId: door.mapId, x: door.x, y: door.y };
            }
        }
        return null;
    }

    doorOfApartment(apartmentId: string): { id: string; mapId: string; x: number; y: number } | null {
        const site = this.apartments.get(apartmentId);
        return site ? { id: site.door.id, mapId: site.door.mapId, x: site.door.x, y: site.door.y } : null;
    }

    doorsForMap(mapId: string): Array<{ id: string; x: number; y: number; name: string | null }> {
        return Array.from(this.doors.values())
            .filter((door) => door.mapId === mapId)
            .map((door) => ({ id: door.id, x: door.x, y: door.y, name: door.name }));
    }

    private apartmentName(site: ApartmentSite, snapshot: PlayableMapsStateSnapshot | null): string {
        const template = snapshot?.items.find((item) => item.id === site.templateMapId);
        const base = site.door.name ?? template?.name ?? "Apartamento";
        return site.door.apartments.length > 1 ? `${base} ${site.index + 1}` : base;
    }

    apartmentSummary(apartmentId: string, viewerCharacterId: number | null): ApartmentSummary | null {
        const site = this.apartments.get(apartmentId);
        if (!site) return null;
        const state = this.stateOf(apartmentId);
        const owned = state.ownerCharacterId !== null;
        const isOwner = owned && viewerCharacterId !== null && state.ownerCharacterId === viewerCharacterId;
        const forSale = owned && state.salePrice !== null;
        return {
            id: site.id,
            index: site.index,
            name: this.apartmentName(site, this.world.getPlayableMapsState()),
            templateMapId: site.templateMapId,
            price: forSale ? (state.salePrice as number) : site.price,
            owned,
            ownerName: state.ownerName,
            isOwner,
            locked: owned && !isOwner && state.keyCode !== null,
            keyCodeSet: isOwner && state.keyCode !== null,
            forSale,
            available: site.valid
        };
    }

    doorSummary(doorId: string, viewerCharacterId: number | null): DoorSummary | null {
        const door = this.doors.get(doorId);
        if (!door) return null;
        const snapshot = this.world.getPlayableMapsState();
        const firstTemplate = door.apartments[0]
            ? snapshot?.items.find((item) => item.id === door.apartments[0].templateMapId)?.name
            : undefined;
        return {
            doorId: door.id,
            mapId: door.mapId,
            x: door.x,
            y: door.y,
            name: door.name ?? firstTemplate ?? "Edificio",
            apartments: door.apartments
                .map((apartment) => this.apartmentSummary(apartment.id, viewerCharacterId))
                .filter((apartment): apartment is ApartmentSummary => Boolean(apartment))
        };
    }

    // ── Instances ────────────────────────────────────────────────────────

    /** True when the id names an instance of an apartment that still exists. */
    isValidInstance(mapId: string): boolean {
        const parsed = parseHouseInstanceMapId(mapId);
        if (!parsed) return false;
        const site = this.apartments.get(parsed.apartmentId);
        return Boolean(site && site.valid && site.templateMapId === parsed.templateMapId);
    }

    apartmentOfInstance(mapId: string): string | null {
        const parsed = parseHouseInstanceMapId(mapId);
        if (!parsed || !this.apartments.has(parsed.apartmentId)) return null;
        return parsed.apartmentId;
    }

    instanceInfo(mapId: string, viewerCharacterId: number | null): HouseInstanceInfo | null {
        const parsed = parseHouseInstanceMapId(mapId);
        if (!parsed) return null;
        const site = this.apartments.get(parsed.apartmentId);
        if (!site) return null;
        const state = this.stateOf(site.id);
        const isOwner = viewerCharacterId !== null && state.ownerCharacterId === viewerCharacterId;
        return {
            mapId,
            apartmentId: site.id,
            doorId: site.door.id,
            templateMapId: site.templateMapId,
            name: this.apartmentName(site, this.world.getPlayableMapsState()),
            ownerCharacterId: state.ownerCharacterId,
            ownerName: state.ownerName,
            isOwner,
            keyCodeSet: state.keyCode !== null,
            salePrice: state.salePrice,
            furniture: state.furniture.map((item) => ({ ...item }))
        };
    }

    isOwnerOf(apartmentId: string, characterId: number | null): boolean {
        if (characterId === null) return false;
        return this.states.get(apartmentId)?.ownerCharacterId === characterId;
    }

    /**
     * Where a player entering `apartmentId` lands: the template's authored
     * initial position (or an automatic placement), expressed on the INSTANCE
     * map id. Checks the key code for non-owners.
     */
    resolveEntry(apartmentId: string, characterId: number | null, keyCode: unknown): HouseEntryResult {
        const site = this.apartments.get(apartmentId);
        if (!site || !site.valid) {
            return { ok: false, error: "house.reason.unavailable" };
        }
        const state = this.stateOf(apartmentId);
        const isOwner = characterId !== null && state.ownerCharacterId === characterId;
        if (state.ownerCharacterId !== null && !isOwner && state.keyCode !== null) {
            if (typeof keyCode !== "string" || keyCode.length === 0) {
                return { ok: false, error: "house.reason.keyRequired" };
            }
            if (keyCode !== state.keyCode) {
                return { ok: false, error: "house.reason.wrongKey" };
            }
        }
        const placement = this.world.resolveAutomaticPlacement(site.templateMapId, 32, 32);
        return {
            ok: true,
            mapId: houseInstanceMapId(site.templateMapId, apartmentId),
            x: placement.x,
            y: placement.y
        };
    }

    /** Where leaving an instance lands: the door cell it belongs to. */
    exitDestination(mapId: string): { mapId: string; x: number; y: number } | null {
        const apartmentId = this.apartmentOfInstance(mapId);
        const site = apartmentId ? this.apartments.get(apartmentId) : null;
        if (!site) return null;
        const cellSize = this.world.getMapCellSize(site.door.mapId);
        return { mapId: site.door.mapId, x: site.door.x * cellSize, y: site.door.y * cellSize };
    }

    // ── Ownership ────────────────────────────────────────────────────────

    /** Price to pay right now, or null when the apartment cannot be bought. */
    purchasePrice(apartmentId: string, buyerCharacterId: number): { price: number; sellerCharacterId: number | null } | null {
        const site = this.apartments.get(apartmentId);
        if (!site || !site.valid) return null;
        const state = this.stateOf(apartmentId);
        if (state.ownerCharacterId === null) {
            return { price: site.price, sellerCharacterId: null };
        }
        if (state.ownerCharacterId === buyerCharacterId || state.salePrice === null) {
            return null;
        }
        return { price: state.salePrice, sellerCharacterId: state.ownerCharacterId };
    }

    /** Hands the apartment to a new owner (after the caller moved the money). */
    assignOwner(apartmentId: string, characterId: number, ownerName: string, keepFurniture: boolean) {
        const state = this.stateOf(apartmentId);
        state.ownerCharacterId = characterId;
        state.ownerName = ownerName;
        state.keyCode = null;
        state.salePrice = null;
        state.purchasedAt = Date.now();
        if (!keepFurniture) state.furniture = [];
        this.persist();
        this.broadcastInfo(apartmentId);
    }

    setKeyCode(apartmentId: string, keyCode: string | null): boolean {
        const state = this.stateOf(apartmentId);
        if (state.ownerCharacterId === null) return false;
        if (keyCode !== null && !isValidKeyCode(keyCode)) return false;
        state.keyCode = keyCode;
        this.persist();
        this.broadcastInfo(apartmentId);
        return true;
    }

    setSalePrice(apartmentId: string, price: number | null): boolean {
        const state = this.stateOf(apartmentId);
        if (state.ownerCharacterId === null) return false;
        if (price !== null && (!Number.isFinite(price) || price <= 0)) return false;
        state.salePrice = price === null ? null : Math.min(MAX_SALE_PRICE, Math.round(price));
        this.persist();
        this.broadcastInfo(apartmentId);
        return true;
    }

    ownedApartmentIds(characterId: number): string[] {
        return Array.from(this.states.values())
            .filter((state) => state.ownerCharacterId === characterId && this.apartments.has(state.id))
            .map((state) => state.id);
    }

    // ── Furniture ────────────────────────────────────────────────────────

    furnitureAt(mapId: string, x: number, y: number): FurnitureState | null {
        const apartmentId = this.apartmentOfInstance(mapId);
        if (!apartmentId) return null;
        return this.stateOf(apartmentId).furniture.find((item) => item.x === x && item.y === y) ?? null;
    }

    /** Furniture is solid: used by the world's collision checks. */
    isFurnitureBlocked(mapId: string, rect: { x: number; y: number; width: number; height: number }): boolean {
        if (!isHouseInstanceMapId(mapId)) return false;
        const apartmentId = this.apartmentOfInstance(mapId);
        if (!apartmentId) return false;
        const state = this.states.get(apartmentId);
        if (!state || state.furniture.length === 0) return false;
        const cellSize = this.world.getMapCellSize(mapId);
        // Same hitbox inset the collision grid uses, so corridors stay walkable.
        const inset = Math.min(cellSize / 4, rect.width / 2 - 1, rect.height / 2 - 1);
        const left = rect.x + inset;
        const top = rect.y + inset;
        const right = rect.x + rect.width - inset;
        const bottom = rect.y + rect.height - inset;
        for (const item of state.furniture) {
            const fx = item.x * cellSize;
            const fy = item.y * cellSize;
            if (left < fx + cellSize && right > fx && top < fy + cellSize && bottom > fy) {
                return true;
            }
        }
        return false;
    }

    placeFurniture(
        mapId: string,
        item: { itemId: string; itemName: string; iconSrc: string },
        x: number,
        y: number
    ): { ok: true; furniture: FurnitureState } | { ok: false; error: string } {
        const apartmentId = this.apartmentOfInstance(mapId);
        if (!apartmentId) return { ok: false, error: "house.reason.notInHouse" };
        const state = this.stateOf(apartmentId);
        if (state.furniture.length >= MAX_FURNITURE_PER_HOUSE) {
            return { ok: false, error: "house.reason.tooMuchFurniture" };
        }
        const cellSize = this.world.getMapCellSize(mapId);
        const bounds = this.world.getMapBounds(mapId);
        if (x < 0 || y < 0 || (x + 1) * cellSize > bounds.width || (y + 1) * cellSize > bounds.height) {
            return { ok: false, error: "house.reason.outOfBounds" };
        }
        if (state.furniture.some((existing) => existing.x === x && existing.y === y)) {
            return { ok: false, error: "house.reason.cellTaken" };
        }
        // The cell must be walkable floor (walls/objects) and empty of bodies.
        if (this.world.isRectBlocked(mapId, x * cellSize, y * cellSize, cellSize, cellSize)) {
            return { ok: false, error: "house.reason.cellBlocked" };
        }
        if (this.world.isCellOccupiedByBody(mapId, x, y, null)) {
            return { ok: false, error: "house.reason.cellOccupied" };
        }
        const furniture: FurnitureState = {
            id: `furniture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            itemId: item.itemId,
            itemName: item.itemName,
            iconSrc: item.iconSrc,
            x,
            y,
            placedAt: Date.now()
        };
        state.furniture.push(furniture);
        this.persist();
        this.world.emitToMap(mapId, "house:furniture-update", {
            mapId,
            t: Date.now(),
            placed: furniture,
            removedId: null
        });
        return { ok: true, furniture };
    }

    pickFurniture(mapId: string, furnitureId: string): FurnitureState | null {
        const apartmentId = this.apartmentOfInstance(mapId);
        if (!apartmentId) return null;
        const state = this.stateOf(apartmentId);
        const index = state.furniture.findIndex((item) => item.id === furnitureId);
        if (index < 0) return null;
        const [removed] = state.furniture.splice(index, 1);
        this.persist();
        this.world.emitToMap(mapId, "house:furniture-update", {
            mapId,
            t: Date.now(),
            placed: null,
            removedId: removed.id
        });
        return removed;
    }

    // ── Presentation ─────────────────────────────────────────────────────

    /** Sends the instance state to one socket (map arrival). */
    presentTo(socketId: string, mapId: string, viewerCharacterId: number | null) {
        if (!isHouseInstanceMapId(mapId)) return;
        const info = this.instanceInfo(mapId, viewerCharacterId);
        if (!info) return;
        (this.world.constructor as typeof World).socketServer
            .in(socketId)
            .emit("house:sync", { t: Date.now(), house: info });
    }

    /** Re-sends the instance info to everyone inside (owner/lock/sale changed). */
    private broadcastInfo(apartmentId: string) {
        const site = this.apartments.get(apartmentId);
        if (!site) return;
        const mapId = houseInstanceMapId(site.templateMapId, apartmentId);
        this.world.players.forEach((player: Player) => {
            if (player.currentMapId !== mapId) return;
            player.socketConnections.forEach((socketId) => {
                this.presentTo(socketId, mapId, player.characterId);
            });
        });
    }
}
