// House pets — venomons left living inside a house (Housing.ts).
//
// A player standing in a house (their own or someone else's) can leave a
// party venomon there. The venomon LEAVES THE PARTY (it no longer shows in
// the party window and cannot battle) and becomes a pet of that house: it
// walks the rooms (HouseRoamers.ts), gets hungry, bored and lonely on the
// wall clock, occasionally throws up on the floor, chats and plays with the
// other pets and with a beach ball, courts a pet of the opposite gender and
// — if female — lays an egg on the floor that its owner can collect.
//
// The LIFE of a pet runs on wall-clock timestamps (`lastFedAt`…) evaluated by
// a slow tick that covers every house, populated or not, so a pet keeps
// living while its owner is away or offline. Only the WALKING (the actor
// simulation) needs someone in the room to watch it.
//
// Owners are alerted through the notification center (persisted on the
// character until dismissed, so offline owners see them on login) and — only
// when they are not at home — by email (MailService, rate-limited).
//
// Persistence: one JSON blob in Redis (`world:house-pets`) holding the pets
// (full PokemonSummary each, since they left the party) and the things lying
// on the floor (eggs, messes).

import crypto from "crypto";
import type { RedisClientType } from "redis";
import type World from "./world";
import type Player from "./player";
import type Auth from "./Auth";
import type { InventoryItem, PetNotificationRecord, PokemonSummary } from "./Auth";
import type MailService from "./MailService";
import { houseInstanceMapId, isHouseInstanceMapId, parseHouseInstanceMapId } from "./Housing";
import { speciesCharsetName } from "./generated/speciesDex";
import { isPokemonGender, type PokemonGender } from "./pokemonGender";

const REDIS_KEY = "world:house-pets";
export const MAX_PETS_PER_HOUSE = 12;
/** Eggs waiting on the floor per house; messes are capped at one per pet. */
const MAX_EGGS_PER_HOUSE = 6;

const MAX_PARTY = 6;

const HOUR = 3_600_000;
/** Test knob: how much faster than real time pets live (E2E uses thousands). */
export const PET_TIME_SCALE = Number(process.env.PET_TIME_SCALE) > 0 ? Number(process.env.PET_TIME_SCALE) : 1;
const SLOW_TICK_MS = Number(process.env.PET_SLOW_TICK_MS) > 0 ? Number(process.env.PET_SLOW_TICK_MS) : 30_000;
/** Scaled wall-clock for a need to go from 0 to 100. */
const HUNGER_FULL_MS = 8 * HOUR;
const BOREDOM_FULL_MS = 10 * HOUR;
const LONELY_FULL_MS = 12 * HOUR;
const HUNGRY_AT = 60;
const STARVING_AT = 95;
const BORED_AT = 70;
const LONELY_AT = 70;
/** Mating: cooldown per pet, and how long the courtship dance lasts (real ms). */
const MATE_COOLDOWN_MS = 6 * HOUR;
const COURTING_MS = 25_000;
const GESTATION_MS = 1 * HOUR;
/** Scaled wall-clock between two pukes of the same pet. */
const PUKE_COOLDOWN_MS = 1 * HOUR;
/** Bred eggs hatch after at most this many steps. */
const BRED_EGG_MAX_STEPS = 1500;
/** Minimum real time between two alert emails to the same owner. */
const EMAIL_THROTTLE_MS = 30 * 60_000;
const CARESS_COOLDOWN_MS = 20_000;

export type PetKind = "egg" | "mess";

export type HousePetState = {
    /** The venomon's own id (it is unique per individual). */
    id: string;
    apartmentId: string;
    ownerCharacterId: number;
    ownerName: string;
    /** The full summary that left the owner's party. */
    pokemon: PokemonSummary;
    internalName: string;
    charset: string;
    gender: PokemonGender;
    leftAt: number;
    lastFedAt: number;
    lastPlayedAt: number;
    lastCaredAt: number;
    lastPukeAt: number;
    lastMatedAt: number;
    /** Threw up and has not eaten since. */
    sick: boolean;
    courtingWith: string | null;
    courtingUntil: number;
    /** Females only: when the egg is laid. */
    eggDueAt: number | null;
    /** Which need alerts fired since the last time it was satisfied. */
    alerted: { hungry?: boolean; starving?: boolean; bored?: boolean; lonely?: boolean };
    /** Last cell it stood on (restored when the room is watched again). */
    cellX: number | null;
    cellY: number | null;
};

export type HouseGroundThing = {
    id: string;
    apartmentId: string;
    kind: PetKind;
    x: number;
    y: number;
    createdAt: number;
    /** Egg: the mother's owner (only they may collect it). Mess: who made it. */
    ownerCharacterId: number;
    byPetId: string;
    byPetName: string;
    egg?: PokemonSummary;
    speciesName?: string;
};

/** What clients render/list for one pet (`pet:sync` / `pet:update`). */
export type PetView = {
    id: string;
    /** Follower-channel owner id: `roam:<char>:<petId>`. */
    ownerId: string;
    apartmentId: string;
    mapId: string;
    ownerCharacterId: number;
    ownerName: string;
    name: string;
    species: string;
    level: number;
    gender: PokemonGender;
    charset: string;
    iconImageSrc?: string;
    hunger: number;
    boredom: number;
    loneliness: number;
    mood: number;
    sick: boolean;
    courting: boolean;
    eggDueAt: number | null;
    leftAt: number;
};

export type PetGroundView = {
    id: string;
    apartmentId: string;
    mapId: string;
    kind: PetKind;
    x: number;
    y: number;
    ownerCharacterId: number;
    byPetName: string;
    speciesName?: string;
    createdAt: number;
};

export type PetActionResult = { ok: true; messageKey: string; params?: Record<string, string> } | { ok: false; messageKey: string; params?: Record<string, string> };

export function petOwnerId(ownerCharacterId: number, petId: string): string {
    return `roam:${ownerCharacterId}:${petId}`;
}

function clamp100(value: number) {
    return Math.max(0, Math.min(100, Math.round(value)));
}

function needOf(sinceAt: number, fullMs: number, now: number) {
    return clamp100(((now - sinceAt) * PET_TIME_SCALE * 100) / fullMs);
}

function displayName(pokemon: PokemonSummary) {
    return pokemon.nickname || pokemon.name;
}

function sanitizeGender(value: unknown): PokemonGender {
    return isPokemonGender(value) ? value : "genderless";
}

function sanitizePet(value: unknown): HousePetState | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Partial<HousePetState>;
    if (typeof raw.id !== "string" || !raw.id || typeof raw.apartmentId !== "string" || !raw.apartmentId) return null;
    if (!raw.pokemon || typeof raw.pokemon !== "object" || typeof raw.ownerCharacterId !== "number") return null;
    const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
    const now = Date.now();
    return {
        id: raw.id,
        apartmentId: raw.apartmentId,
        ownerCharacterId: Math.round(raw.ownerCharacterId),
        ownerName: typeof raw.ownerName === "string" ? raw.ownerName : "Trainer",
        pokemon: { ...(raw.pokemon as PokemonSummary), id: raw.id },
        internalName: typeof raw.internalName === "string" ? raw.internalName : "",
        charset: typeof raw.charset === "string" ? raw.charset : "",
        gender: sanitizeGender(raw.gender),
        leftAt: num(raw.leftAt, now),
        lastFedAt: num(raw.lastFedAt, now),
        lastPlayedAt: num(raw.lastPlayedAt, now),
        lastCaredAt: num(raw.lastCaredAt, now),
        lastPukeAt: num(raw.lastPukeAt, 0),
        lastMatedAt: num(raw.lastMatedAt, 0),
        sick: raw.sick === true,
        courtingWith: typeof raw.courtingWith === "string" ? raw.courtingWith : null,
        courtingUntil: num(raw.courtingUntil, 0),
        eggDueAt: typeof raw.eggDueAt === "number" && Number.isFinite(raw.eggDueAt) ? raw.eggDueAt : null,
        alerted: raw.alerted && typeof raw.alerted === "object" ? { ...raw.alerted } : {},
        cellX: typeof raw.cellX === "number" && Number.isFinite(raw.cellX) ? Math.round(raw.cellX) : null,
        cellY: typeof raw.cellY === "number" && Number.isFinite(raw.cellY) ? Math.round(raw.cellY) : null
    };
}

function sanitizeGround(value: unknown): HouseGroundThing | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Partial<HouseGroundThing>;
    if (typeof raw.id !== "string" || !raw.id || typeof raw.apartmentId !== "string") return null;
    if (raw.kind !== "egg" && raw.kind !== "mess") return null;
    if (typeof raw.x !== "number" || typeof raw.y !== "number") return null;
    if (raw.kind === "egg" && (!raw.egg || typeof raw.egg !== "object")) return null;
    return {
        id: raw.id,
        apartmentId: raw.apartmentId,
        kind: raw.kind,
        x: Math.round(raw.x),
        y: Math.round(raw.y),
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
        ownerCharacterId: typeof raw.ownerCharacterId === "number" ? raw.ownerCharacterId : 0,
        byPetId: typeof raw.byPetId === "string" ? raw.byPetId : "",
        byPetName: typeof raw.byPetName === "string" ? raw.byPetName : "",
        ...(raw.kind === "egg" ? { egg: raw.egg as PokemonSummary, speciesName: typeof raw.speciesName === "string" ? raw.speciesName : undefined } : {})
    };
}

export class HousePetStore {
    constructor(private readonly redis: RedisClientType) {}

    async read(): Promise<{ pets: HousePetState[]; ground: HouseGroundThing[] }> {
        const raw = await this.redis.get(REDIS_KEY);
        if (!raw) return { pets: [], ground: [] };
        try {
            const parsed = JSON.parse(raw);
            return {
                pets: (Array.isArray(parsed?.pets) ? parsed.pets : []).map(sanitizePet).filter(Boolean) as HousePetState[],
                ground: (Array.isArray(parsed?.ground) ? parsed.ground : []).map(sanitizeGround).filter(Boolean) as HouseGroundThing[]
            };
        } catch (error) {
            console.error("Unable to parse house pet state:", error);
            return { pets: [], ground: [] };
        }
    }

    async save(state: { pets: HousePetState[]; ground: HouseGroundThing[] }) {
        await this.redis.set(REDIS_KEY, JSON.stringify(state));
    }
}

export default class HousePets {
    private readonly pets = new Map<string, HousePetState>();
    private readonly ground = new Map<string, HouseGroundThing>();
    private store: HousePetStore | null = null;
    private auth: Auth | null = null;
    private mail: MailService | null = null;
    private timer: NodeJS.Timeout | null = null;
    private lastSlowTickAt = Date.now();
    private dirty = false;
    private persisting = false;
    private readonly lastEmailByOwner = new Map<number, number>();
    private readonly caressCooldown = new Map<string, number>();
    private ready = false;

    constructor(private readonly world: World) {}

    async initialize(store: HousePetStore) {
        this.store = store;
        const state = await store.read();
        state.pets.forEach((pet) => this.pets.set(pet.id, pet));
        state.ground.forEach((thing) => this.ground.set(thing.id, thing));
        this.ready = true;
        if (!this.timer) {
            this.timer = setInterval(() => {
                void this.slowTick().catch((error) => console.error("[house-pets] tick failed", error));
            }, SLOW_TICK_MS);
        }
    }

    setServices(services: { auth: Auth; mail: MailService | null }) {
        this.auth = services.auth;
        this.mail = services.mail;
    }

    private markDirty() {
        this.dirty = true;
        this.persist();
    }

    private persist() {
        if (!this.ready || !this.store || this.persisting) return;
        this.persisting = true;
        this.dirty = false;
        void this.store
            .save({ pets: Array.from(this.pets.values()), ground: Array.from(this.ground.values()) })
            .catch((error) => console.error("[house-pets] persist failed:", error))
            .finally(() => {
                this.persisting = false;
                if (this.dirty) this.persist();
            });
    }

    // ── Queries ──────────────────────────────────────────────────────────

    private apartmentOf(mapId: string): string | null {
        return this.world.housing.apartmentOfInstance(mapId);
    }

    /** Instance map id a pet lives on (null when its apartment vanished). */
    mapIdOfPet(pet: HousePetState): string | null {
        const site = this.world.housing.templateOfApartment(pet.apartmentId);
        return site ? houseInstanceMapId(site, pet.apartmentId) : null;
    }

    petsInApartment(apartmentId: string): HousePetState[] {
        return Array.from(this.pets.values()).filter((pet) => pet.apartmentId === apartmentId);
    }

    petsOnMap(mapId: string): HousePetState[] {
        const apartmentId = this.apartmentOf(mapId);
        return apartmentId ? this.petsInApartment(apartmentId) : [];
    }

    groundOnMap(mapId: string): HouseGroundThing[] {
        const apartmentId = this.apartmentOf(mapId);
        return apartmentId ? Array.from(this.ground.values()).filter((thing) => thing.apartmentId === apartmentId) : [];
    }

    getPet(petId: string): HousePetState | null {
        return this.pets.get(petId) ?? null;
    }

    /** Pets of a character anywhere in the world. */
    petsOfCharacter(characterId: number): HousePetState[] {
        return Array.from(this.pets.values()).filter((pet) => pet.ownerCharacterId === characterId);
    }

    hasPetsOnMap(mapId: string, characterId: number): boolean {
        return this.petsOnMap(mapId).some((pet) => pet.ownerCharacterId === characterId);
    }

    needs(pet: HousePetState, now = Date.now()) {
        const hunger = needOf(pet.lastFedAt, HUNGER_FULL_MS, now);
        const boredom = needOf(pet.lastPlayedAt, BOREDOM_FULL_MS, now);
        const loneliness = needOf(pet.lastCaredAt, LONELY_FULL_MS, now);
        const mood = clamp100(100 - (hunger * 0.5 + boredom * 0.25 + loneliness * 0.25) - (pet.sick ? 20 : 0));
        return { hunger, boredom, loneliness, mood };
    }

    /** True while the pet is doing its courtship dance (actor sim walks them together). */
    isCourting(pet: HousePetState, now = Date.now()) {
        return Boolean(pet.courtingWith) && now < pet.courtingUntil;
    }

    view(pet: HousePetState, now = Date.now()): PetView {
        const needs = this.needs(pet, now);
        return {
            id: pet.id,
            ownerId: petOwnerId(pet.ownerCharacterId, pet.id),
            apartmentId: pet.apartmentId,
            mapId: this.mapIdOfPet(pet) ?? "",
            ownerCharacterId: pet.ownerCharacterId,
            ownerName: pet.ownerName,
            name: displayName(pet.pokemon),
            species: pet.pokemon.name,
            level: pet.pokemon.level,
            gender: pet.gender,
            charset: pet.charset,
            iconImageSrc: pet.pokemon.iconImageSrc,
            hunger: needs.hunger,
            boredom: needs.boredom,
            loneliness: needs.loneliness,
            mood: needs.mood,
            sick: pet.sick,
            courting: this.isCourting(pet, now),
            eggDueAt: pet.eggDueAt,
            leftAt: pet.leftAt
        };
    }

    groundView(thing: HouseGroundThing): PetGroundView {
        const template = this.world.housing.templateOfApartment(thing.apartmentId);
        return {
            id: thing.id,
            apartmentId: thing.apartmentId,
            mapId: template ? houseInstanceMapId(template, thing.apartmentId) : "",
            kind: thing.kind,
            x: thing.x,
            y: thing.y,
            ownerCharacterId: thing.ownerCharacterId,
            byPetName: thing.byPetName,
            speciesName: thing.speciesName,
            createdAt: thing.createdAt
        };
    }

    // ── Presentation ─────────────────────────────────────────────────────

    /** Full pet state of a house instance to one socket (map arrival). */
    presentTo(socketId: string, mapId: string, _viewerCharacterId: number | null) {
        if (!isHouseInstanceMapId(mapId)) return;
        const now = Date.now();
        (this.world.constructor as typeof World).socketServer.in(socketId).emit("pet:sync", {
            mapId,
            t: now,
            pets: this.petsOnMap(mapId).map((pet) => this.view(pet, now)),
            ground: this.groundOnMap(mapId).map((thing) => this.groundView(thing))
        });
    }

    private broadcastPet(pet: HousePetState) {
        const mapId = this.mapIdOfPet(pet);
        if (!mapId) return;
        this.world.emitToMap(mapId, "pet:update", { mapId, t: Date.now(), pet: this.view(pet) });
    }

    private broadcastPetRemoved(mapId: string, petId: string) {
        this.world.emitToMap(mapId, "pet:update", { mapId, t: Date.now(), removedPetId: petId });
    }

    private broadcastGround(thing: HouseGroundThing) {
        const view = this.groundView(thing);
        if (!view.mapId) return;
        this.world.emitToMap(view.mapId, "pet:update", { mapId: view.mapId, t: Date.now(), ground: view });
    }

    private broadcastGroundRemoved(mapId: string, groundId: string) {
        this.world.emitToMap(mapId, "pet:update", { mapId, t: Date.now(), removedGroundId: groundId });
    }

    private emote(pet: HousePetState, emoji: string, ms = 2000) {
        this.world.houseRoamers.emote(pet.id, emoji, ms);
    }

    // ── Alerts ───────────────────────────────────────────────────────────

    private houseName(apartmentId: string): string {
        return this.world.housing.apartmentDisplayName(apartmentId) ?? "su casa";
    }

    /** True when a player of that character stands inside the pet's house. */
    private ownerAtHome(pet: HousePetState): boolean {
        const mapId = this.mapIdOfPet(pet);
        if (!mapId) return false;
        for (const player of this.world.players.values()) {
            if (player.characterId === pet.ownerCharacterId && player.currentMapId === mapId) return true;
        }
        return false;
    }

    /**
     * Files an alert for the pet's owner: persisted on the character (so it
     * survives being offline), pushed live to the owner's sockets, and — when
     * the owner is not in that house — emailed (throttled per owner).
     */
    private async notifyOwner(pet: HousePetState, kind: string, text: string, options: { email: boolean }) {
        if (!this.auth) return;
        const mapId = this.mapIdOfPet(pet) ?? "";
        const record: PetNotificationRecord = {
            id: `pet-${kind}-${pet.id}-${Date.now().toString(36)}`,
            kind,
            petId: pet.id,
            petName: displayName(pet.pokemon),
            apartmentId: pet.apartmentId,
            houseName: this.houseName(pet.apartmentId),
            mapId,
            text,
            at: Date.now()
        };
        try {
            await this.auth.pushPetNotification(pet.ownerCharacterId, record);
        } catch (error) {
            console.error("[house-pets] unable to persist alert:", error);
        }
        for (const player of this.world.players.values()) {
            if (player.characterId !== pet.ownerCharacterId) continue;
            player.socketConnections.forEach((socketId) => {
                (this.world.constructor as typeof World).socketServer.in(socketId).emit("pet:notification", { notification: record });
            });
        }
        if (!options.email || this.ownerAtHome(pet) || !this.mail?.isEnabled()) return;
        const now = Date.now();
        const lastEmail = this.lastEmailByOwner.get(pet.ownerCharacterId) ?? 0;
        if (now - lastEmail < EMAIL_THROTTLE_MS) return;
        try {
            const owner = await this.auth.getCharacterOwnerInfo(pet.ownerCharacterId);
            if (!owner?.email) return;
            this.lastEmailByOwner.set(pet.ownerCharacterId, now);
            await this.mail.sendPetAlertEmail({
                to: owner.email,
                name: owner.name,
                petName: record.petName,
                houseName: record.houseName,
                message: text
            });
        } catch (error) {
            console.error("[house-pets] alert email failed:", error);
        }
    }

    /** Pending alerts of a character, pushed on login. */
    async sendPendingNotifications(characterId: number, socketId: string) {
        if (!this.auth) return;
        const notifications = await this.auth.getPetNotifications(characterId);
        (this.world.constructor as typeof World).socketServer.in(socketId).emit("pet:notifications", { notifications });
    }

    async dismissNotification(characterId: number, id: string) {
        await this.auth?.dismissPetNotification(characterId, id);
    }

    // ── Life (slow tick, every house, populated or not) ──────────────────

    private async slowTick() {
        if (!this.ready) return;
        const now = Date.now();
        const elapsedScaledHours = ((now - this.lastSlowTickAt) * PET_TIME_SCALE) / HOUR;
        this.lastSlowTickAt = now;
        const byApartment = new Map<string, HousePetState[]>();

        for (const pet of Array.from(this.pets.values())) {
            const needs = this.needs(pet, now);
            const name = displayName(pet.pokemon);
            const house = this.houseName(pet.apartmentId);

            if (needs.hunger >= HUNGRY_AT && !pet.alerted.hungry) {
                pet.alerted.hungry = true;
                this.markDirty();
                this.emote(pet, "🍽️");
                await this.notifyOwner(pet, "hungry", `${name} tiene hambre en ${house}.`, { email: true });
            }
            if (needs.hunger >= STARVING_AT && !pet.alerted.starving) {
                pet.alerted.starving = true;
                this.markDirty();
                this.emote(pet, "💔");
                await this.notifyOwner(pet, "starving", `¡${name} se muere de hambre en ${house}! Dale de comer.`, { email: true });
            }
            if (needs.boredom >= BORED_AT && !pet.alerted.bored) {
                pet.alerted.bored = true;
                this.markDirty();
                this.emote(pet, "😴");
                await this.notifyOwner(pet, "bored", `${name} está aburrido en ${house}. Juega con él.`, { email: true });
            }
            if (needs.loneliness >= LONELY_AT && !pet.alerted.lonely) {
                pet.alerted.lonely = true;
                this.markDirty();
                this.emote(pet, "💔");
                await this.notifyOwner(pet, "lonely", `${name} se siente solo en ${house}. Necesita cariño.`, { email: true });
            }

            // Throwing up: likely when starving, rare otherwise; never while its
            // last mess is still on the floor, and at most once per (scaled) hour.
            const pukeRate = needs.hunger >= 85 ? 0.6 : 0.03;
            if (
                Math.random() < elapsedScaledHours * pukeRate &&
                (now - pet.lastPukeAt) * PET_TIME_SCALE >= PUKE_COOLDOWN_MS &&
                !this.hasMessOf(pet)
            ) {
                await this.puke(pet, now);
            }

            // Egg due (mother lays it where she stands).
            if (pet.eggDueAt !== null && now >= pet.eggDueAt) {
                await this.layEgg(pet, now);
            }

            const bucket = byApartment.get(pet.apartmentId) ?? [];
            bucket.push(pet);
            byApartment.set(pet.apartmentId, bucket);
        }

        // Courtship: one pair per house per tick.
        for (const pets of byApartment.values()) {
            const eligible = pets.filter((pet) => this.canMate(pet, now));
            const females = eligible.filter((pet) => pet.gender === "female");
            const males = eligible.filter((pet) => pet.gender === "male");
            if (females.length === 0 || males.length === 0) continue;
            if (Math.random() >= elapsedScaledHours * 0.5) continue;
            const female = females[Math.floor(Math.random() * females.length)];
            const male = males[Math.floor(Math.random() * males.length)];
            await this.mate(female, male, now);
        }

        // Needs drift on the wall clock: refresh the bars of whoever is watching.
        const watched = new Set<string>();
        this.world.players.forEach((player) => {
            if (isHouseInstanceMapId(player.currentMapId)) watched.add(player.currentMapId);
        });
        watched.forEach((mapId) => {
            const pets = this.petsOnMap(mapId);
            if (pets.length === 0) return;
            this.world.emitToMap(mapId, "pet:sync", {
                mapId,
                t: now,
                pets: pets.map((pet) => this.view(pet, now)),
                ground: this.groundOnMap(mapId).map((thing) => this.groundView(thing))
            });
        });

        if (this.dirty) this.persist();
    }

    private eggsOnFloor(apartmentId: string) {
        let count = 0;
        this.ground.forEach((thing) => {
            if (thing.apartmentId === apartmentId && thing.kind === "egg") count += 1;
        });
        return count;
    }

    private hasMessOf(pet: HousePetState) {
        for (const thing of this.ground.values()) {
            if (thing.kind === "mess" && thing.byPetId === pet.id) return true;
        }
        return false;
    }

    private canMate(pet: HousePetState, now: number) {
        if (pet.gender === "genderless" || pet.sick || pet.eggDueAt !== null) return false;
        if (this.isCourting(pet, now)) return false;
        if ((now - pet.lastMatedAt) * PET_TIME_SCALE < MATE_COOLDOWN_MS) return false;
        return this.needs(pet, now).hunger < 70;
    }

    private async mate(female: HousePetState, male: HousePetState, now: number) {
        female.courtingWith = male.id;
        male.courtingWith = female.id;
        female.courtingUntil = now + COURTING_MS;
        male.courtingUntil = now + COURTING_MS;
        female.lastMatedAt = now;
        male.lastMatedAt = now;
        female.eggDueAt = now + GESTATION_MS / PET_TIME_SCALE;
        // Courting is a shared happy moment: it also eases loneliness a bit.
        female.lastCaredAt = Math.max(female.lastCaredAt, now - LONELY_FULL_MS / PET_TIME_SCALE / 2);
        male.lastCaredAt = Math.max(male.lastCaredAt, now - LONELY_FULL_MS / PET_TIME_SCALE / 2);
        this.markDirty();
        this.emote(female, "❤️", 4000);
        this.emote(male, "❤️", 4000);
        this.broadcastPet(female);
        this.broadcastPet(male);
        const text = `${displayName(female.pokemon)} y ${displayName(male.pokemon)} se llevan muy bien... 💕`;
        await this.notifyOwner(female, "mated", text, { email: false });
        if (male.ownerCharacterId !== female.ownerCharacterId) {
            await this.notifyOwner(male, "mated", text, { email: false });
        }
    }

    private freeCellNearPet(pet: HousePetState, mapId: string): { x: number; y: number } {
        const origin = this.world.houseRoamers.cellOfPet(pet.id) ?? this.petHomeCell(pet, mapId);
        const cellSize = this.world.getMapCellSize(mapId);
        const taken = new Set(this.groundOnMap(mapId).map((thing) => `${thing.x},${thing.y}`));
        const candidates: Array<{ x: number; y: number }> = [origin];
        for (let radius = 1; radius <= 3; radius += 1) {
            for (let dx = -radius; dx <= radius; dx += 1) {
                for (let dy = -radius; dy <= radius; dy += 1) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) === radius) candidates.push({ x: origin.x + dx, y: origin.y + dy });
                }
            }
        }
        for (const cell of candidates) {
            if (taken.has(`${cell.x},${cell.y}`)) continue;
            if (this.world.isRectBlocked(mapId, cell.x * cellSize, cell.y * cellSize, cellSize, cellSize)) continue;
            return cell;
        }
        return origin;
    }

    /** Where a pet stands when nobody watches: its last cell, else the room's entry. */
    petHomeCell(pet: HousePetState, mapId: string): { x: number; y: number } {
        if (pet.cellX !== null && pet.cellY !== null) return { x: pet.cellX, y: pet.cellY };
        const parsed = parseHouseInstanceMapId(mapId);
        const placement = this.world.resolveAutomaticPlacement(parsed?.templateMapId ?? mapId, 32, 32);
        const cellSize = this.world.getMapCellSize(mapId);
        return { x: Math.floor(placement.x / cellSize), y: Math.floor(placement.y / cellSize) };
    }

    recordPosition(petId: string, x: number, y: number) {
        const pet = this.pets.get(petId);
        if (!pet || (pet.cellX === x && pet.cellY === y)) return;
        pet.cellX = x;
        pet.cellY = y;
        this.dirty = true; // flushed by the slow tick — positions are not worth a write each
    }

    /** The actor sim reports a play session (ball kicked). */
    notePlayed(petId: string) {
        const pet = this.pets.get(petId);
        if (!pet) return;
        pet.lastPlayedAt = Date.now();
        pet.alerted.bored = false;
        this.dirty = true;
    }

    /** Two pets chatted: company eases loneliness a little. */
    noteSocialized(petId: string) {
        const pet = this.pets.get(petId);
        if (!pet) return;
        const now = Date.now();
        pet.lastCaredAt = Math.min(now, pet.lastCaredAt + (LONELY_FULL_MS / PET_TIME_SCALE) * 0.05);
        this.dirty = true;
    }

    private async puke(pet: HousePetState, now: number) {
        const mapId = this.mapIdOfPet(pet);
        if (!mapId) return;
        pet.sick = true;
        pet.lastPukeAt = now;
        const cell = this.freeCellNearPet(pet, mapId);
        const thing: HouseGroundThing = {
            id: `mess-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
            apartmentId: pet.apartmentId,
            kind: "mess",
            x: cell.x,
            y: cell.y,
            createdAt: now,
            ownerCharacterId: pet.ownerCharacterId,
            byPetId: pet.id,
            byPetName: displayName(pet.pokemon)
        };
        this.ground.set(thing.id, thing);
        this.markDirty();
        this.emote(pet, "🤢", 3000);
        this.broadcastGround(thing);
        this.broadcastPet(pet);
        await this.notifyOwner(pet, "sick", `${displayName(pet.pokemon)} vomitó en ${this.houseName(pet.apartmentId)}. Límpialo y dale de comer.`, { email: true });
    }

    private async layEgg(pet: HousePetState, now: number) {
        const mapId = this.mapIdOfPet(pet);
        if (!mapId || !this.auth) return;
        if (this.eggsOnFloor(pet.apartmentId) >= MAX_EGGS_PER_HOUSE) {
            pet.eggDueAt = now + 2 * 60_000; // too many eggs waiting: try again later
            this.dirty = true;
            return;
        }
        const egg = await this.auth.buildEggForSpecies(pet.internalName, BRED_EGG_MAX_STEPS);
        pet.eggDueAt = null;
        pet.courtingWith = null;
        if (!egg) {
            this.markDirty();
            return;
        }
        const cell = this.freeCellNearPet(pet, mapId);
        const thing: HouseGroundThing = {
            id: `egg-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
            apartmentId: pet.apartmentId,
            kind: "egg",
            x: cell.x,
            y: cell.y,
            createdAt: now,
            ownerCharacterId: pet.ownerCharacterId,
            byPetId: pet.id,
            byPetName: displayName(pet.pokemon),
            egg,
            speciesName: egg.name
        };
        this.ground.set(thing.id, thing);
        this.markDirty();
        this.emote(pet, "🥚", 3500);
        this.broadcastGround(thing);
        this.broadcastPet(pet);
        await this.notifyOwner(pet, "egg", `¡${displayName(pet.pokemon)} puso un huevo en ${this.houseName(pet.apartmentId)}! Ve a recogerlo.`, { email: true });
    }

    // ── Player actions ───────────────────────────────────────────────────

    private actorContext(player: Player): { apartmentId: string; mapId: string; characterId: number; userId: number } | null {
        if (player.characterId === null || typeof player.userId !== "number") return null;
        const mapId = player.currentMapId;
        if (!this.world.housing.isValidInstance(mapId)) return null;
        const apartmentId = this.apartmentOf(mapId);
        return apartmentId ? { apartmentId, mapId, characterId: player.characterId, userId: player.userId } : null;
    }

    /** Party venomon → pet of the house the player stands in. */
    async leavePet(player: Player, pokemonId: string): Promise<PetActionResult> {
        const ctx = this.actorContext(player);
        if (!ctx || !this.auth) return { ok: false, messageKey: "house.reason.notInHouse" };
        if (this.petsInApartment(ctx.apartmentId).length >= MAX_PETS_PER_HOUSE) {
            return { ok: false, messageKey: "pet.reason.houseFull" };
        }
        const user = await this.auth.getUserForBattle(ctx.userId);
        const party = user?.pokemonParty ?? [];
        const index = party.findIndex((pokemon) => pokemon.id === pokemonId);
        if (index < 0) return { ok: false, messageKey: "pet.reason.notInParty" };
        const pokemon = party[index];
        if (pokemon.isEgg) return { ok: false, messageKey: "pet.reason.egg" };
        if (party.filter((candidate, at) => at !== index && !candidate.isEgg).length === 0) {
            return { ok: false, messageKey: "pet.reason.lastVenomon" };
        }
        const internalName = (pokemon.sourcePokemonId ?? "").replace(/^pokemon-/i, "").toUpperCase();
        const charset = internalName ? speciesCharsetName(internalName) : null;
        if (!charset) return { ok: false, messageKey: "pet.reason.noSprite" };
        const gender = await this.auth.genderOf(pokemon);
        const now = Date.now();
        const cellSize = this.world.getMapCellSize(ctx.mapId);
        const origin = player.getCurrentCell(cellSize);
        const cell = this.world.houseRoamers.findFreeCellNear(ctx.mapId, origin) ?? origin;
        const pet: HousePetState = {
            id: pokemon.id,
            apartmentId: ctx.apartmentId,
            ownerCharacterId: ctx.characterId,
            ownerName: player.name || player.username || "Trainer",
            pokemon: { ...pokemon, gender },
            internalName,
            charset,
            gender,
            leftAt: now,
            lastFedAt: now,
            lastPlayedAt: now,
            lastCaredAt: now,
            lastPukeAt: 0,
            lastMatedAt: 0,
            sick: false,
            courtingWith: null,
            courtingUntil: 0,
            eggDueAt: null,
            alerted: {},
            cellX: cell.x,
            cellY: cell.y
        };
        // The party write goes first: a pet must never exist in both places.
        await this.auth.saveBattleState(ctx.userId, { pokemonParty: party.filter((_, at) => at !== index) });
        this.pets.set(pet.id, pet);
        this.markDirty();
        this.broadcastPet(pet);
        this.world.houseRoamers.materialize(pet, ctx.mapId, cell);
        this.emote(pet, "😊");
        return { ok: true, messageKey: "pet.msg.left", params: { name: displayName(pokemon) } };
    }

    /** Pet → back to its owner's party. */
    async takePet(player: Player, petId: string): Promise<PetActionResult> {
        const ctx = this.actorContext(player);
        if (!ctx || !this.auth) return { ok: false, messageKey: "house.reason.notInHouse" };
        const pet = this.pets.get(petId);
        if (!pet || pet.apartmentId !== ctx.apartmentId) return { ok: false, messageKey: "pet.reason.noPet" };
        if (pet.ownerCharacterId !== ctx.characterId) return { ok: false, messageKey: "pet.reason.notYours" };
        const user = await this.auth.getUserForBattle(ctx.userId);
        const party = user?.pokemonParty ?? [];
        if (party.length >= MAX_PARTY) return { ok: false, messageKey: "pet.reason.partyFull" };
        const pokemon: PokemonSummary = { ...pet.pokemon, id: pet.id, gender: pet.gender };
        this.pets.delete(pet.id);
        // Its courtship partner is left waiting; the egg (if due) stays with the mother.
        this.pets.forEach((other) => {
            if (other.courtingWith === pet.id) {
                other.courtingWith = null;
                other.courtingUntil = 0;
            }
        });
        this.markDirty();
        this.world.houseRoamers.removePet(pet.id);
        this.broadcastPetRemoved(ctx.mapId, pet.id);
        await this.auth.saveBattleState(ctx.userId, { pokemonParty: [...party, pokemon] });
        return { ok: true, messageKey: "pet.msg.taken", params: { name: displayName(pokemon) } };
    }

    /** Feeds a pet with a berry from the bag (any visitor may feed). */
    async feedPet(player: Player, petId: string, itemId: string): Promise<PetActionResult> {
        const ctx = this.actorContext(player);
        if (!ctx || !this.auth) return { ok: false, messageKey: "house.reason.notInHouse" };
        const pet = this.pets.get(petId);
        if (!pet || pet.apartmentId !== ctx.apartmentId) return { ok: false, messageKey: "pet.reason.noPet" };
        const user = await this.auth.getUserForBattle(ctx.userId);
        const stack = user?.inventory.find((item) => item.id === itemId);
        if (!user || !stack || stack.quantity <= 0) return { ok: false, messageKey: "house.reason.noItem" };
        // Same rule the battle engine uses for "is this a berry".
        const lowerName = stack.name.toLowerCase();
        if (stack.category !== "berries" && !lowerName.includes("baya") && !lowerName.includes("berry")) {
            return { ok: false, messageKey: "pet.reason.notFood" };
        }
        const inventory: InventoryItem[] = user.inventory
            .map((item) => (item.id === itemId ? { ...item, quantity: item.quantity - 1 } : item))
            .filter((item) => item.quantity > 0);
        await this.auth.saveInventory(ctx.userId, inventory);
        const now = Date.now();
        pet.lastFedAt = now;
        pet.sick = false;
        pet.alerted.hungry = false;
        pet.alerted.starving = false;
        this.markDirty();
        this.emote(pet, "🍖", 2500);
        setTimeout(() => this.emote(pet, "❤️"), 2600);
        this.broadcastPet(pet);
        return { ok: true, messageKey: "pet.msg.fed", params: { name: displayName(pet.pokemon), item: stack.name } };
    }

    /** A pat on the head: eases loneliness. */
    caressPet(player: Player, petId: string): PetActionResult {
        const ctx = this.actorContext(player);
        if (!ctx) return { ok: false, messageKey: "house.reason.notInHouse" };
        const pet = this.pets.get(petId);
        if (!pet || pet.apartmentId !== ctx.apartmentId) return { ok: false, messageKey: "pet.reason.noPet" };
        const now = Date.now();
        const key = `${ctx.characterId}:${pet.id}`;
        if (now < (this.caressCooldown.get(key) ?? 0)) return { ok: false, messageKey: "pet.reason.tooSoon" };
        this.caressCooldown.set(key, now + CARESS_COOLDOWN_MS);
        pet.lastCaredAt = now;
        pet.alerted.lonely = false;
        this.markDirty();
        this.emote(pet, "❤️", 2500);
        this.world.houseRoamers.faceToward(pet.id, player.getCurrentCell(this.world.getMapCellSize(ctx.mapId)));
        this.broadcastPet(pet);
        return { ok: true, messageKey: "pet.msg.caressed", params: { name: displayName(pet.pokemon) } };
    }

    /** Playtime: drops a beach ball by the pet (one live ball per map) and sends it playing. */
    async playWithPet(player: Player, petId: string): Promise<PetActionResult> {
        const ctx = this.actorContext(player);
        if (!ctx || !this.auth) return { ok: false, messageKey: "house.reason.notInHouse" };
        const pet = this.pets.get(petId);
        if (!pet || pet.apartmentId !== ctx.apartmentId) return { ok: false, messageKey: "pet.reason.noPet" };
        if (!this.world.beachBalls.hasLiveBall(ctx.mapId)) {
            const settings = await this.auth.getGlobalSettings();
            const origin = this.world.houseRoamers.cellOfPet(pet.id) ?? player.getFacingCell(this.world.getMapCellSize(ctx.mapId));
            const spawned = this.world.beachBalls.spawn(ctx.mapId, origin, settings.allowMultipleBeachBalls);
            if (!spawned) return { ok: false, messageKey: "pet.reason.noRoomForBall" };
        }
        pet.lastPlayedAt = Date.now();
        pet.alerted.bored = false;
        this.markDirty();
        this.emote(pet, "⚽", 2500);
        this.world.houseRoamers.sendToPlay(pet.id);
        this.broadcastPet(pet);
        return { ok: true, messageKey: "pet.msg.playing", params: { name: displayName(pet.pokemon) } };
    }

    /** Cleans a mess (anyone inside the house may). */
    cleanGround(player: Player, groundId: string): PetActionResult {
        const ctx = this.actorContext(player);
        if (!ctx) return { ok: false, messageKey: "house.reason.notInHouse" };
        const thing = this.ground.get(groundId);
        if (!thing || thing.apartmentId !== ctx.apartmentId || thing.kind !== "mess") return { ok: false, messageKey: "pet.reason.noGround" };
        this.ground.delete(thing.id);
        this.markDirty();
        this.broadcastGroundRemoved(ctx.mapId, thing.id);
        return { ok: true, messageKey: "pet.msg.cleaned" };
    }

    /** Puts a laid egg in the mother's owner's party. */
    async collectEgg(player: Player, groundId: string): Promise<PetActionResult> {
        const ctx = this.actorContext(player);
        if (!ctx || !this.auth) return { ok: false, messageKey: "house.reason.notInHouse" };
        const thing = this.ground.get(groundId);
        if (!thing || thing.apartmentId !== ctx.apartmentId || thing.kind !== "egg" || !thing.egg) {
            return { ok: false, messageKey: "pet.reason.noGround" };
        }
        if (thing.ownerCharacterId !== ctx.characterId) return { ok: false, messageKey: "pet.reason.notYourEgg" };
        const user = await this.auth.getUserForBattle(ctx.userId);
        const party = user?.pokemonParty ?? [];
        if (party.length >= MAX_PARTY) return { ok: false, messageKey: "pet.reason.partyFull" };
        this.ground.delete(thing.id);
        this.markDirty();
        this.broadcastGroundRemoved(ctx.mapId, thing.id);
        await this.auth.saveBattleState(ctx.userId, { pokemonParty: [...party, { ...thing.egg, isEgg: true }] });
        return { ok: true, messageKey: "pet.msg.eggCollected", params: { name: thing.byPetName } };
    }
}
