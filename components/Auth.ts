import crypto from "crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { RedisClientType } from "redis";
import {
    createEmptyPokemonStatBonuses,
    getExperienceForNextLevel,
    readLevelingCurveConfigFromRedis,
    sanitizePokemonStatBonuses,
    type PokemonStatBonuses
} from "./LevelingCurve";
import MailService from "./MailService";

export const ROLE_PERMISSIONS = [
    "game.access",
    "designer.access",
    "moderator.access",
    "admin.access"
] as const;

export type RolePermission = typeof ROLE_PERMISSIONS[number];

export const USER_ROLE_KEYS = [
    "admin",
    "designer",
    "moderator",
    "user"
] as const;

export type UserRoleKey = typeof USER_ROLE_KEYS[number];

export interface RoleDefinition {
    key: UserRoleKey;
    name: string;
    description: string;
    permissions: RolePermission[];
}

/**
 * Public summary of one character an account owns. Character names are display
 * values only — every authorization decision uses the immutable characterId.
 */
export interface CharacterSummary {
    characterId:number;
    characterName:string;
    characterSkinId:string;
    trainerGender:string;
    badges:number[];
    money:number;
    partyCount:number;
    lastMapId:string | null;
    createdAt:string;
    lastPlayedAt:string;
    /** Set while the character is soft-deleted (restorable until purged). */
    deletedAt:string | null;
}

/**
 * Account-box currency aggregated per owning character. Ownership stays with
 * the depositing character until another eligible character withdraws (partial
 * withdrawals transfer only the withdrawn amount).
 */
export interface SharedCurrencyDeposit {
    accountId:number;
    ownerCharacterId:number;
    /** Display name snapshot of the owning character (resolved on read). */
    ownerCharacterName:string;
    amount:number;
    depositedByCharacterId:number;
    depositedAt:string;
    updatedAt:string;
}

/** Public row of the account-level block list. */
export interface BlockedAccountEntry {
    accountId:number;
    accountName:string;
}

export interface AuthenticatedUser {
    id:number;
    name:string;
    username:string;
    email:string;
    emailVerified:boolean;
    profileImage:string;
    description:string;
    /** Immutable account id (same value as `id`; explicit for the contract). */
    accountId:number;
    /** Permanent account handle (same value as `username`). */
    accountName:string;
    /** Immutable id of the currently selected character. */
    characterId:number;
    /** Display name of the currently selected character (same as `name`). */
    characterName:string;
    /** Every character the account owns, including soft-deleted ones. */
    characters:CharacterSummary[];
    /** Account-box currency deposits, one aggregate per owning character. */
    sharedMoneyDeposits:SharedCurrencyDeposit[];
    inventory:InventoryItem[];
    pokemonParty:PokemonSummary[];
    pokemonStorage:PokemonStorageBox[];
    itemStorage:ItemStorageBox[];
    /** Sum of the ACTIVE character's own shared-box deposits (legacy alias). */
    pcMoney:number;
    trainerGender:string;
    characterSkinId:string;
    money:number;
    /** 0-based gym badge indices earned (see $Trainer.badges[N]). */
    badges:number[];
    /** Map ids of fly-able towns the player has physically entered — gates
     * Volar (Fly) destinations, classic town-map behavior. */
    visitedTowns:string[];
    /** Palette key chosen for the Trainer Card background (client owns the palette). */
    trainerCardColor:string;
    battleHistory:BattleHistoryEntry[];
    role:UserRoleKey;
    permissions:RolePermission[];
}

export interface AuthSessionState {
    authenticated:boolean;
    user:AuthenticatedUser | null;
    token?:string;
}

export interface SavedPlayerLocation {
    mapId:string;
    x:number;
    y:number;
    /** True when the player was surfing at this location (restored on join
     * only when the saved cell is still surfable water). */
    surfing?:boolean;
}

/**
 * Minimal public projection of an account (plus its active character) for
 * friends/chat features. `userId`/`username` are the account identity;
 * `name`/`characterSkinId` describe the currently active character. The
 * explicit accountX/characterX fields restate the same values so every
 * consumer can distinguish the two identities without guessing.
 */
export interface SocialUserSummary {
    userId:number;
    username:string;
    name:string;
    characterSkinId:string;
    accountId:number;
    accountName:string;
    characterId:number;
    characterName:string;
}

/**
 * A pending friend request as stored on both sides (incoming/outgoing). The
 * friendship itself is account-to-account; the character ids are optional
 * context recording which characters were in use when the request was sent.
 */
export interface FriendRequestRecord extends SocialUserSummary {
    createdAt:string;
    requesterCharacterId?:number;
    recipientCharacterId?:number;
}

/** Per-account social configuration (Friends window config tab). */
export interface SocialPrefs {
    allowFriendRequests:boolean;
    allowTeleportRequests:boolean;
    allowChatInvites:boolean;
    /** Whether friends may see this account online at all. */
    showOnlineStatus:boolean;
    /** Whether friends may see which character is being played. */
    showActiveCharacter:boolean;
    /** Whether friends may see the current map. */
    showCurrentMap:boolean;
    /** Whether friends may see last-seen information while offline. */
    showLastSeen:boolean;
}

export const DEFAULT_SOCIAL_PREFS:SocialPrefs = {
    allowFriendRequests: true,
    allowTeleportRequests: true,
    allowChatInvites: true,
    showOnlineStatus: true,
    showActiveCharacter: true,
    showCurrentMap: true,
    showLastSeen: true
};

interface AuthSuccessResult {
    session: AuthSessionState & {
        authenticated:true;
        user:AuthenticatedUser;
        token:string;
    };
}

interface AuthErrorResult {
    error:string;
}

interface AuthInfoResult {
    message:string;
}

interface StoredUser extends AuthenticatedUser {
    password_hash:string;
    password_salt:string;
    created_at:string;
}

/** Minimal projection of a stored user for admin search/count scans. */
interface UserSearchRow {
    id:number;
    name:string;
    username:string;
    email:string;
    role:UserRoleKey;
}

export interface AdminUserSummary {
    id:number;
    name:string;
    username:string;
    email:string;
    emailVerified:boolean;
    role:UserRoleKey;
    permissions:RolePermission[];
    profileImage:string;
    description:string;
    trainerGender:string;
    characterSkinId:string;
    money:number;
    pokemonCount:number;
    inventoryItemCount:number;
    inventoryQuantity:number;
    battleHistoryCount:number;
    createdAt:string;
    savedLocation:SavedPlayerLocation | null;
}

export interface AdminUserDetails extends AuthenticatedUser {
    createdAt:string;
    savedLocation:SavedPlayerLocation | null;
}

export interface AdminUserListPayload {
    users: AdminUserSummary[];
    search: string;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
}

export interface AdminUserUpdatePayload {
    name?: string;
    profileImage?: string;
    description?: string;
    trainerGender?: string;
    characterSkinId?: string;
    money?: number;
    emailVerified?: boolean;
    role?: UserRoleKey;
    inventory?: InventoryItem[];
    pokemonParty?: PokemonSummary[];
    battleHistory?: BattleHistoryEntry[];
    savedLocation?: SavedPlayerLocation | null;
}

/**
 * Wire form of an admin savedLocation update: either concrete coordinates or
 * an "automatic" request where the server picks a non-stuck spot on the map.
 * The socket handler resolves the automatic form to concrete coordinates
 * before it reaches updateUserByAdmin.
 */
export type AdminSavedLocationInput =
    | { mapId: string; x: number; y: number; automatic?: false }
    | { mapId: string; automatic: true };

export interface AdminUserUpdateInput extends Omit<AdminUserUpdatePayload, "savedLocation"> {
    savedLocation?: AdminSavedLocationInput | null;
}

export interface RoleDefinitionWithCount extends RoleDefinition {
    userCount: number;
}

export interface InventoryItem {
    id:string;
    name:string;
    category:"usable" | "berries" | "moves" | "quest";
    quantity:number;
    description:string;
    // Read-only enrichment for admin/UX surfaces. Never persisted (the storage
    // sanitizers drop unknown fields), resolved on read from the designer item
    // catalog so the client can render an icon instead of a raw id.
    iconSrc?:string;
    /**
     * Shared-box ownership metadata, present ONLY while the stack sits in an
     * account item box. The owning character keeps the asset until another
     * character (meeting the gym-medal requirement) withdraws it; withdrawal
     * strips these fields (ownership transfers to the holder).
     */
    ownerCharacterId?:number;
    storedByCharacterId?:number;
    storedAt?:string;
}

export interface PokemonSummary {
    id:string;
    sourcePokemonId?:string;
    name:string;
    nickname?:string;
    level:number;
    types:string[];
    hp:number;
    maxHp:number;
    moves:string[];
    movePp?:Record<string, number>;
    /** PP-Up stages per move (0-3, +20% max PP each); set by PP Up / PP Max. */
    movePpUps?:Record<string, number>;
    experience:number;
    experienceCurve:"fast" | "medium" | "slow";
    nextLevelExperience:number;
    statBonuses:PokemonStatBonuses;
    ivs?:Record<string, number>;
    evs?:Record<string, number>;
    status?:{ id:string; counter:number } | null;
    heldItemId?:string;
    heldItemName?:string;
    pendingMoveLearns?:string[];
    /**
     * Egg state. An egg is a real (already-rolled) level-1 Pokemon that the
     * player cannot use in battle and that is hidden as a "Huevo" in the UI
     * until it hatches. `eggStepsToHatch` counts down as the player walks; when
     * it reaches 0 the egg hatches in place (isEgg cleared) into the species it
     * was created for. Absent/false = an ordinary Pokemon.
     */
    isEgg?:boolean;
    eggStepsToHatch?:number;
    /**
     * Original trainer of a venomon received in an in-game NPC trade
     * (pbStartTrade). Present = "foreign": the name rater refuses to rename
     * it, exactly like the original games.
     */
    foreignOt?:string;
    // Read-only enrichment for admin/UX surfaces (see InventoryItem.iconSrc).
    iconImageSrc?:string;
    frontImageSrc?:string;
    /** Shared-box ownership metadata (see InventoryItem.ownerCharacterId). */
    ownerCharacterId?:number;
    storedByCharacterId?:number;
    storedAt?:string;
}

/** Cosmetic per-box styling the player can customize at the PC. */
export interface StorageBoxStyle {
    /** CSS color for the box grid background (hex). */
    bgColor?:string;
    /** Asset path/URL of a background image chosen from the game's assets. */
    bgImage?:string;
    /** CSS color for the box border (hex). */
    borderColor?:string;
}

/**
 * One PC storage box. Players can have up to MAX_STORAGE_BOXES boxes (auto-
 * created on overflow, or added manually), each holding up to
 * POKEMON_BOX_CAPACITY Pokemon. Box ids are positional (`box-1`, `box-2`, ...)
 * and derived on parse, so they are stable across reads without being stored.
 */
export interface PokemonStorageBox extends StorageBoxStyle {
    id:string;
    name:string;
    capacity:number;
    pokemon:PokemonSummary[];
}

/**
 * One PC item box. Mirrors PokemonStorageBox but holds inventory stacks; its
 * `capacity` is the max number of distinct item stacks (quantities stack).
 */
export interface ItemStorageBox extends StorageBoxStyle {
    id:string;
    name:string;
    capacity:number;
    items:InventoryItem[];
}

export interface AdminItemCatalogEntry {
    id:string;
    name:string;
    category:InventoryItem["category"];
    description:string;
    iconSrc:string;
}

export interface AdminPokemonCatalogEntry {
    id:string;
    name:string;
    types:string[];
    iconImageSrc:string;
    hp:number;
}

export interface AdminCatalogPayload {
    items:AdminItemCatalogEntry[];
    pokemons:AdminPokemonCatalogEntry[];
    maps:AdminMapCatalogEntry[];
}

export interface AdminMapCatalogEntry {
    mapId:string;
    name:string;
    category:string;
}

export interface BattleHistoryEntry {
    id:string;
    battleId:string;
    kind:"wild" | "trainer";
    opponentName:string;
    winnerName:string | null;
    loserName:string | null;
    result:string;
    startedAt:string;
    endedAt:string;
    log:string[];
}

interface SessionTokenPayload extends JwtPayload {
    sid:string;
    sub:string;
}

interface RegisterPayload {
    name:string;
    username:string;
    email:string;
    password:string;
}

interface LoginPayload {
    username:string;
    password:string;
}

interface RecoverPasswordPayload {
    identifier:string;
}

interface RecoverUsernamePayload {
    email:string;
}

interface VerifyEmailPayload {
    token:string;
}

interface ResetPasswordPayload {
    token:string;
    password:string;
}

interface ChangePasswordPayload {
    currentPassword:string;
    newPassword:string;
}

interface ConfirmAccountDeletionPayload {
    code:string;
}

interface UpdateProfilePayload {
    profileImage?:string;
    description?:string;
    characterSkinId?:string;
    trainerCardColor?:string;
}

interface ChooseStarterPayload {
    nickname:string;
}

interface StarterPokemonDefinition {
    id:string;
    name:string;
    elements:string[];
    hp:number;
    skills:Array<{
        skillId:string;
        skillName:string;
        level:number;
    }>;
    iconImageSrc:string;
}

// Ids/names must match the migrated designer:section:items records so the
// battle engine can resolve their definitions.
const DEFAULT_INVENTORY:InventoryItem[] = [
    {
        id: "item-potion",
        name: "Arepa de diablito",
        category: "usable",
        quantity: 3,
        description: "Restores a small amount of HP."
    },
    {
        id: "item-oranberry",
        name: "Baya Aranja",
        category: "berries",
        quantity: 2,
        description: "A bright berry used by Pokemon in a pinch."
    },
    {
        id: "item-pokeball",
        name: "Nación Ball",
        category: "quest",
        quantity: 10,
        description: "A ball for catching wild Pokemon."
    }
];

const DEFAULT_POKEMON_PARTY:PokemonSummary[] = [];
export const MAX_POKEMON_PARTY_SIZE = 6;
export const POKEMON_BOX_CAPACITY = 30;
/** Max boxes per storage kind (venomon and item each). */
export const MAX_STORAGE_BOXES = 15;
/** Max distinct item stacks per item box. */
export const ITEM_BOX_CAPACITY = 40;
/**
 * How many walked tiles a freshly received egg takes to hatch when the species
 * carries no `hatchSteps` metadata. Tuned for our engine (a few minutes of
 * walking) rather than the very high vanilla-Essentials counts. A species'
 * own `hatchSteps` (when present) overrides this, clamped to a sane range.
 */
export const DEFAULT_EGG_HATCH_STEPS = 500;
const MIN_EGG_HATCH_STEPS = 50;
const MAX_EGG_HATCH_STEPS = 10000;
const DEFAULT_BATTLE_HISTORY:BattleHistoryEntry[] = [];
const DEFAULT_MONEY = 1000;
const MAX_BATTLE_HISTORY_ITEMS = 50;
/** Hard cap on any single money balance (wallet or one shared deposit). */
export const MAX_MONEY_BALANCE = 999_999_999;
/**
 * Gym medals (badges) the ACTIVE character needs before it may access
 * shared-box assets owned by ANOTHER character of the same account. A
 * character can always access its own assets regardless of medal count.
 */
export const CROSS_CHARACTER_STORAGE_MIN_MEDALS = Math.max(
    0,
    Math.round(Number(process.env.CROSS_CHARACTER_STORAGE_MIN_MEDALS ?? 1))
);
export const MAX_CHARACTERS_PER_ACCOUNT = Math.max(
    1,
    Math.round(Number(process.env.MAX_CHARACTERS_PER_ACCOUNT ?? 6))
);
/** Soft-deleted characters stay restorable this long before being purged. */
const CHARACTER_RECOVERY_DAYS_DEFAULT = Math.max(0, Number(process.env.CHARACTER_RECOVERY_DAYS ?? 30));
const SKIN_CHANGE_PRICE_DEFAULT = Math.max(0, Math.round(Number(process.env.SKIN_CHANGE_PRICE ?? 300)));

/**
 * Operator-tunable global game settings, editable from the admin panel and
 * stored in Redis (`settings:global`). The env-derived constants above are
 * only the DEFAULTS for fresh databases; runtime reads go through
 * getGlobalSettings so changes apply without a redeploy.
 */
export interface GlobalGameSettings {
    /** Max non-deleted characters one account may have. */
    maxCharactersPerAccount:number;
    /** Gym medals the active character needs to use siblings' shared-box assets. */
    crossCharacterStorageMinMedals:number;
    /** Days a soft-deleted character stays restorable before it is purged. */
    characterRecoveryDays:number;
    /** Price of a paid character-skin change. */
    skinChangePrice:number;
    /** Wallet money a brand-new account/character starts with. */
    startingMoney:number;
}

export const DEFAULT_GLOBAL_SETTINGS:GlobalGameSettings = {
    maxCharactersPerAccount: MAX_CHARACTERS_PER_ACCOUNT,
    crossCharacterStorageMinMedals: CROSS_CHARACTER_STORAGE_MIN_MEDALS,
    characterRecoveryDays: CHARACTER_RECOVERY_DAYS_DEFAULT,
    skinChangePrice: SKIN_CHANGE_PRICE_DEFAULT,
    startingMoney: DEFAULT_MONEY
};
/** Same rule as account registration names (intro rename allows more). */
const CHARACTER_NAME_PATTERN = /^[A-Za-z]{2,30}$/;
/**
 * Every per-character gameplay field. These live on `auth:character:{id}`
 * hashes; the migration moves them off legacy `auth:user:{id}` hashes.
 * Account-owned data (credentials, profile, friends, blocks, shared boxes,
 * shared money deposits) is deliberately NOT in this list.
 */
const CHARACTER_GAMEPLAY_FIELDS = [
    "name",
    "trainer_gender",
    "character_skin_id",
    "trainer_card_color",
    "money",
    "inventory",
    "pokemon_party",
    "battle_history",
    "badges",
    "visited_towns",
    "last_map_id",
    "last_x",
    "last_y",
    "last_surfing",
    "respawn_point",
    "event_switches",
    "event_variables",
    "event_self_switches",
    "egg_cooldowns"
] as const;
const DEFAULT_ROLE_DEFINITIONS:RoleDefinition[] = [
    {
        key: "admin",
        name: "Admin",
        description: "Full access to every admin, moderator, designer, and gameplay capability.",
        permissions: [...ROLE_PERMISSIONS]
    },
    {
        key: "designer",
        name: "Designer",
        description: "Gameplay access plus the collaborative designer workspace.",
        permissions: ["game.access", "designer.access"]
    },
    {
        key: "moderator",
        name: "Moderator",
        description: "Gameplay access plus moderator oversight tools.",
        permissions: ["game.access", "moderator.access"]
    },
    {
        key: "user",
        name: "User",
        description: "Standard player access to the game world.",
        permissions: ["game.access"]
    }
];
const LEGACY_DEMO_POKEMON_PARTY_IDS = new Set(["starter-001"]);
const POKEMON_NICKNAME_PATTERN = /^[A-Za-z]{1,10}$/;
const BLOCKED_POKEMON_NICKNAMES = new Set([
    "ass",
    "bastard",
    "bitch",
    "bollocks",
    "crap",
    "cunt",
    "damn",
    "dick",
    "fag",
    "fuck",
    "hoe",
    "nazi",
    "piss",
    "prick",
    "pussy",
    "shit",
    "slut",
    "twat",
    "whore"
]);

export default class Auth {
    private readonly redis:RedisClientType;
    private readonly mailService:MailService;
    private readonly jwtSecret:string;
    private readonly sessionTtlSeconds:number;
    private readonly passwordPepper:string;
    private readonly emailValidationTtlSeconds:number;
    private readonly passwordResetTtlSeconds:number;
    private readonly accountDeletionTtlSeconds:number;
    private roleDefinitionsCache:{ roles:RoleDefinition[]; expiresAt:number } | null = null;
    /**
     * Per-user "does the party currently hold at least one egg" hint, so the
     * per-tile hatch ticker can skip a Redis read for the overwhelming majority
     * of players who carry no egg. `false` = confirmed no egg (fast-skip);
     * `true` = has an egg (tick it); absent = unknown (resolve once from Redis).
     * Any write that could change egg membership calls markPartyChanged() to
     * invalidate the entry.
     */
    private readonly eggPresenceByUserId = new Map<number, boolean>();

    constructor(redis:RedisClientType, mailService:MailService) {
        this.redis = redis;
        this.mailService = mailService;
        this.jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";
        this.sessionTtlSeconds = Number(process.env.AUTH_SESSION_TTL_SECONDS || 60 * 60 * 24 * 7);
        this.passwordPepper = process.env.AUTH_PEPPER || "";
        this.emailValidationTtlSeconds = Number(process.env.AUTH_EMAIL_VALIDATION_TTL_SECONDS || 60 * 60 * 24);
        this.passwordResetTtlSeconds = Number(process.env.AUTH_PASSWORD_RESET_TTL_SECONDS || 60 * 60);
        this.accountDeletionTtlSeconds = Number(process.env.AUTH_ACCOUNT_DELETION_TTL_SECONDS || 60 * 15);
    }

    public async initialize() {
        if (!process.env.JWT_SECRET) {
            console.warn("JWT_SECRET is not set. Using a development fallback secret.");
        }

        if (!this.redis.isOpen) {
            throw new Error("Redis client must be initialized before Auth.");
        }

        await this.ensureRoleDefinitions();
    }

    public async register(payload:RegisterPayload):Promise<AuthSuccessResult | AuthErrorResult> {
        const name = typeof payload.name === "string" ? payload.name.trim() : "";
        const username = typeof payload.username === "string" ? payload.username.trim() : "";
        const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
        const password = typeof payload.password === "string" ? payload.password : "";

        const validationMessage = this.validateRegistration(name, username, email, password);
        if (validationMessage) {
            return { error: validationMessage };
        }

        const user = await this.createUser(name, username, email, password);
        if (!user) {
            return { error: "Username or email already exists." };
        }

        const token = await this.createSession(user);
        await this.sendPostRegistrationEmails(user);

        return {
            session: {
                authenticated: true,
                user,
                token
            } satisfies AuthSessionState
        };
    }

    public async login(payload:LoginPayload):Promise<AuthSuccessResult | AuthErrorResult> {
        const username = typeof payload.username === "string" ? payload.username.trim() : "";
        const password = typeof payload.password === "string" ? payload.password : "";

        if (!username || !password) {
            return { error: "Username and password are required." };
        }

        const user = await this.getUserByUsername(username);
        if (!user || !this.verifyPassword(password, user.password_salt, user.password_hash)) {
            return { error: "Invalid credentials." };
        }

        const authenticatedUser = this.toAuthenticatedUser(user);
        const token = await this.createSession(authenticatedUser);
        return {
            session: {
                authenticated: true,
                user: authenticatedUser,
                token
            } satisfies AuthSessionState
        };
    }

    public async logout(token?:string) {
        await this.destroySession(token);
        return this.unauthenticatedSession();
    }

    public async resolveSession(token?:string) {
        const user = await this.getAuthenticatedUserFromToken(token);
        return user
            ? { authenticated: true, user }
            : this.unauthenticatedSession();
    }

    // ================= Account / character split =================
    // An account (`auth:user:{id}`) owns credentials, profile, friends,
    // blocks, and the shared PC storage. Gameplay state lives on character
    // hashes (`auth:character:{id}`). Every gameplay method below resolves
    // the account's ACTIVE character internally, so gameplay callers keep
    // passing the account id (`userId`) they already have. Character ids are
    // allocated from the SAME global sequence as account ids, which lets a
    // migrated account's default character reuse the account id with no
    // collision risk.

    private characterKey(characterId:number | string) {
        return `auth:character:${characterId}`;
    }

    // ---- global game settings (admin-tunable, Redis-backed) ----

    private globalSettingsKey() {
        return "settings:global";
    }

    private globalSettingsCache:{ settings:GlobalGameSettings; expiresAt:number } | null = null;

    private sanitizeGlobalSettings(raw:unknown):GlobalGameSettings {
        const source = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof GlobalGameSettings, unknown>>;
        const int = (value:unknown, fallback:number, min:number, max:number) => {
            const parsed = Math.round(Number(value));
            return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
        };
        return {
            maxCharactersPerAccount: int(source.maxCharactersPerAccount, DEFAULT_GLOBAL_SETTINGS.maxCharactersPerAccount, 1, 20),
            crossCharacterStorageMinMedals: int(source.crossCharacterStorageMinMedals, DEFAULT_GLOBAL_SETTINGS.crossCharacterStorageMinMedals, 0, 64),
            characterRecoveryDays: int(source.characterRecoveryDays, DEFAULT_GLOBAL_SETTINGS.characterRecoveryDays, 0, 365),
            skinChangePrice: int(source.skinChangePrice, DEFAULT_GLOBAL_SETTINGS.skinChangePrice, 0, MAX_MONEY_BALANCE),
            startingMoney: int(source.startingMoney, DEFAULT_GLOBAL_SETTINGS.startingMoney, 0, MAX_MONEY_BALANCE)
        };
    }

    public async getGlobalSettings():Promise<GlobalGameSettings> {
        if (this.globalSettingsCache && Date.now() < this.globalSettingsCache.expiresAt) {
            return this.globalSettingsCache.settings;
        }
        let settings = { ...DEFAULT_GLOBAL_SETTINGS };
        try {
            const raw = await this.redis.get(this.globalSettingsKey());
            if (raw) {
                settings = this.sanitizeGlobalSettings(JSON.parse(raw));
            }
        } catch {
            // Malformed stored settings: fall back to defaults.
        }
        this.globalSettingsCache = { settings, expiresAt: Date.now() + 15_000 };
        return settings;
    }

    public async updateGlobalSettings(updates:Partial<GlobalGameSettings>):Promise<GlobalGameSettings> {
        const current = await this.getGlobalSettings();
        const next = this.sanitizeGlobalSettings({ ...current, ...updates });
        await this.redis.set(this.globalSettingsKey(), JSON.stringify(next));
        this.globalSettingsCache = { settings: next, expiresAt: Date.now() + 15_000 };
        return next;
    }

    /** accountId -> active characterId (write-through cache; see selectCharacter). */
    private readonly activeCharacterByAccount = new Map<number, number>();

    public async getActiveCharacterId(accountId:number):Promise<number> {
        const cached = this.activeCharacterByAccount.get(accountId);
        if (cached) {
            return cached;
        }
        await this.ensureAccountMigrated(accountId);
        const raw = await this.redis.hGet(this.userKey(accountId), "active_character_id");
        const parsed = Number(raw);
        let resolved = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
        if (!resolved) {
            const ids = await this.getCharacterIds(accountId);
            resolved = ids[0] ?? accountId;
        }
        this.activeCharacterByAccount.set(accountId, resolved);
        return resolved;
    }

    /** Redis key of the account's active character hash. */
    private async activeCharacterKey(accountId:number):Promise<string> {
        return this.characterKey(await this.getActiveCharacterId(accountId));
    }

    public async getCharacterIds(accountId:number):Promise<number[]> {
        const raw = await this.redis.hGet(this.userKey(accountId), "characters");
        return this.parseUserIdArray(raw);
    }

    private async ensureAccountMigrated(accountId:number) {
        const key = this.userKey(accountId);
        const [id, characters] = await this.redis.hmGet(key, ["id", "characters"]);
        if (!id || characters) {
            return;
        }
        await this.migrateAccountHash(accountId, await this.redis.hGetAll(key));
    }

    /**
     * One-time, in-place migration of a legacy single-character account: the
     * gameplay fields move onto a default character hash that reuses the
     * account id, shared-box assets are stamped with that character as their
     * owner, and the legacy `pc_money` balance becomes a shared deposit owned
     * by it. Account-level social data (friends, requests, prefs) stays put —
     * it was already keyed by account id. Idempotent: guarded by the
     * `characters` account field; concurrent runs write identical data.
     */
    public async migrateAccountHash(accountId:number, account:Record<string, string>) {
        if (!account.id || account.characters) {
            return;
        }
        const characterId = accountId;
        const nowIso = new Date().toISOString();

        const characterFields:Record<string, string> = {
            id: String(characterId),
            account_id: String(accountId),
            created_at: account.created_at ?? nowIso,
            last_played_at: nowIso
        };
        for (const field of CHARACTER_GAMEPLAY_FIELDS) {
            if (typeof account[field] === "string") {
                characterFields[field] = account[field];
            }
        }
        characterFields.name = characterFields.name ?? account.username ?? "Trainer";
        characterFields.money = characterFields.money ?? String(DEFAULT_MONEY);
        characterFields.inventory = characterFields.inventory ?? JSON.stringify(DEFAULT_INVENTORY);
        characterFields.pokemon_party = characterFields.pokemon_party ?? JSON.stringify(DEFAULT_POKEMON_PARTY);

        const accountUpdates:Record<string, string> = {
            characters: JSON.stringify([characterId]),
            active_character_id: String(characterId)
        };

        // Every legacy shared-box asset belongs to the default character.
        if (typeof account.pokemon_box === "string") {
            const boxes = this.parsePokemonStorage(account.pokemon_box);
            for (const box of boxes) {
                for (const mon of box.pokemon) {
                    mon.ownerCharacterId = mon.ownerCharacterId ?? characterId;
                    mon.storedByCharacterId = mon.storedByCharacterId ?? characterId;
                    mon.storedAt = mon.storedAt ?? nowIso;
                }
            }
            accountUpdates.pokemon_box = this.serializePokemonStorage(boxes);
        }
        if (typeof account.item_box === "string") {
            const boxes = this.parseItemStorage(account.item_box);
            for (const box of boxes) {
                for (const stack of box.items) {
                    stack.ownerCharacterId = stack.ownerCharacterId ?? characterId;
                    stack.storedByCharacterId = stack.storedByCharacterId ?? characterId;
                    stack.storedAt = stack.storedAt ?? nowIso;
                }
            }
            accountUpdates.item_box = this.serializeItemStorage(boxes);
        }
        const legacyPcMoney = this.parseMoney(account.pc_money, 0);
        if (legacyPcMoney > 0) {
            accountUpdates.pc_money_deposits = this.serializeMoneyDeposits([{
                ownerCharacterId: characterId,
                amount: legacyPcMoney,
                depositedByCharacterId: characterId,
                depositedAt: nowIso,
                updatedAt: nowIso
            }]);
        }
        // Friends hygiene: dedupe and drop self-references (multiple legacy
        // characters of one account can never have produced them here, but a
        // corrupt list must not survive into the account-level model).
        if (typeof account.friends === "string") {
            const friends = [...new Set(this.parseUserIdArray(account.friends))]
                .filter((friendId) => friendId !== accountId);
            accountUpdates.friends = JSON.stringify(friends);
        }

        // The account keeps its `name` copy (account display name); every
        // other gameplay field now lives exclusively on the character hash.
        const fieldsToClear = CHARACTER_GAMEPLAY_FIELDS
            .filter((field) => field !== "name" && typeof account[field] === "string");

        const transaction = this.redis.multi()
            .hSet(this.characterKey(characterId), characterFields)
            .hSet(this.userKey(accountId), accountUpdates);
        if (fieldsToClear.length > 0 || typeof account.pc_money === "string") {
            transaction.hDel(this.userKey(accountId), [...fieldsToClear, "pc_money"]);
        }
        await transaction.exec();
    }

    // ---- character management ----

    /** Lightweight character summaries (no purge sweep — see listCharacters). */
    private async getCharacterSummariesRaw(characterIds:number[]):Promise<CharacterSummary[]> {
        const summaries:CharacterSummary[] = [];
        for (const characterId of characterIds) {
            const summary = await this.getCharacterSummary(characterId);
            if (summary) {
                summaries.push(summary);
            }
        }
        return summaries;
    }

    private async getCharacterSummary(characterId:number):Promise<CharacterSummary | null> {
        const raw = await this.redis.hmGet(this.characterKey(characterId), [
            "id", "name", "character_skin_id", "trainer_gender", "badges", "money",
            "pokemon_party", "last_map_id", "created_at", "last_played_at", "deleted_at"
        ]);
        if (!raw[0]) {
            return null;
        }
        return {
            characterId: Number(raw[0]),
            characterName: raw[1] ?? "",
            characterSkinId: raw[2] ?? "",
            trainerGender: raw[3] ?? "",
            badges: this.parseBadges(raw[4]),
            money: this.parseMoney(raw[5] ?? undefined, 0),
            partyCount: raw[6] ? this.parsePokemonParty(raw[6]).length : 0,
            lastMapId: raw[7] || null,
            createdAt: raw[8] ?? "",
            lastPlayedAt: raw[9] ?? "",
            deletedAt: raw[10] || null
        };
    }

    /** Full character list for the account UI; runs the lazy purge sweep. */
    public async listCharacters(accountId:number):Promise<CharacterSummary[]> {
        await this.ensureAccountMigrated(accountId);
        await this.finalizeExpiredCharacterDeletions(accountId);
        return this.getCharacterSummariesRaw(await this.getCharacterIds(accountId));
    }

    public async createCharacter(
        accountId:number,
        requestedName:string
    ):Promise<{ ok:true; character:CharacterSummary } | { ok:false; message:string }> {
        await this.ensureAccountMigrated(accountId);
        const name = String(requestedName ?? "").trim();
        if (!CHARACTER_NAME_PATTERN.test(name)) {
            return { ok: false, message: "Character names use letters only (2-30 characters)." };
        }
        const settings = await this.getGlobalSettings();
        const existing = await this.getCharacterSummariesRaw(await this.getCharacterIds(accountId));
        if (existing.filter((character) => !character.deletedAt).length >= settings.maxCharactersPerAccount) {
            return { ok: false, message: `You can have up to ${settings.maxCharactersPerAccount} characters.` };
        }
        const characterId = await this.redis.incr(this.userIdSequenceKey());
        const nowIso = new Date().toISOString();
        await this.redis.hSet(this.characterKey(characterId), {
            id: String(characterId),
            account_id: String(accountId),
            name,
            trainer_gender: "",
            character_skin_id: "",
            trainer_card_color: "",
            money: String(settings.startingMoney),
            inventory: JSON.stringify(DEFAULT_INVENTORY),
            pokemon_party: JSON.stringify(DEFAULT_POKEMON_PARTY),
            battle_history: JSON.stringify(DEFAULT_BATTLE_HISTORY),
            badges: "[]",
            created_at: nowIso,
            last_played_at: nowIso
        });
        const ids = await this.getCharacterIds(accountId);
        if (!ids.includes(characterId)) {
            ids.push(characterId);
            await this.redis.hSet(this.userKey(accountId), { characters: JSON.stringify(ids) });
        }
        const character = await this.getCharacterSummary(characterId);
        if (!character) {
            return { ok: false, message: "Unable to create the character." };
        }
        return { ok: true, character };
    }

    public async selectCharacter(
        accountId:number,
        characterId:number
    ):Promise<{ ok:true } | { ok:false; message:string }> {
        await this.ensureAccountMigrated(accountId);
        const ids = await this.getCharacterIds(accountId);
        if (!ids.includes(characterId)) {
            return { ok: false, message: "That character does not belong to this account." };
        }
        const [deletedAt, purgedAt] = await this.redis.hmGet(
            this.characterKey(characterId),
            ["deleted_at", "purged_at"]
        );
        if (deletedAt || purgedAt) {
            return { ok: false, message: "That character is deleted. Restore it first." };
        }
        await this.redis.hSet(this.userKey(accountId), { active_character_id: String(characterId) });
        await this.redis.hSet(this.characterKey(characterId), { last_played_at: new Date().toISOString() });
        this.activeCharacterByAccount.set(accountId, characterId);
        this.markPartyChanged(accountId);
        return { ok: true };
    }

    /**
     * Soft-deletes a character: it disappears from selection but everything it
     * owns (personal currency, party, shared-box assets it deposited) stays
     * frozen with it during the recovery window. The account, its friendships,
     * blocks, shared boxes, and other characters are untouched.
     */
    public async softDeleteCharacter(
        accountId:number,
        characterId:number
    ):Promise<{ ok:true } | { ok:false; message:string }> {
        await this.ensureAccountMigrated(accountId);
        const ids = await this.getCharacterIds(accountId);
        if (!ids.includes(characterId)) {
            return { ok: false, message: "That character does not belong to this account." };
        }
        const activeId = await this.getActiveCharacterId(accountId);
        if (characterId === activeId) {
            return { ok: false, message: "Switch to another character before deleting this one." };
        }
        const summaries = await this.getCharacterSummariesRaw(ids);
        const target = summaries.find((character) => character.characterId === characterId);
        if (!target) {
            return { ok: false, message: "Character not found." };
        }
        if (target.deletedAt) {
            return { ok: false, message: "That character is already deleted." };
        }
        const remaining = summaries.filter(
            (character) => !character.deletedAt && character.characterId !== characterId
        );
        if (remaining.length === 0) {
            return { ok: false, message: "An account must keep at least one character." };
        }
        await this.redis.hSet(this.characterKey(characterId), { deleted_at: new Date().toISOString() });
        return { ok: true };
    }

    public async restoreCharacter(
        accountId:number,
        characterId:number
    ):Promise<{ ok:true } | { ok:false; message:string }> {
        await this.ensureAccountMigrated(accountId);
        const ids = await this.getCharacterIds(accountId);
        if (!ids.includes(characterId)) {
            return { ok: false, message: "That character does not belong to this account." };
        }
        const [deletedAt, purgedAt] = await this.redis.hmGet(
            this.characterKey(characterId),
            ["deleted_at", "purged_at"]
        );
        if (purgedAt) {
            return { ok: false, message: "That character was permanently deleted and cannot be restored." };
        }
        if (!deletedAt) {
            return { ok: false, message: "That character is not deleted." };
        }
        await this.redis.hDel(this.characterKey(characterId), ["deleted_at"]);
        return { ok: true };
    }

    /**
     * Purges characters whose recovery window elapsed. Frozen personal
     * currency becomes an unclaimed shared-box deposit still OWNED by the
     * deleted character (a remaining character meeting the medal requirement
     * can claim it). Achievements/badges stay on the archival stub — they
     * never transfer to another character.
     */
    private async finalizeExpiredCharacterDeletions(accountId:number) {
        const recoveryMs =
            (await this.getGlobalSettings()).characterRecoveryDays * 24 * 60 * 60 * 1000;
        const ids = await this.getCharacterIds(accountId);
        for (const characterId of ids) {
            const [deletedAt, purgedAt, moneyRaw] = await this.redis.hmGet(
                this.characterKey(characterId),
                ["deleted_at", "purged_at", "money"]
            );
            if (!deletedAt || purgedAt) {
                continue;
            }
            const deletedMs = Date.parse(deletedAt);
            if (!Number.isFinite(deletedMs) || Date.now() - deletedMs < recoveryMs) {
                continue;
            }
            const frozenMoney = this.parseMoney(moneyRaw ?? undefined, 0);
            if (frozenMoney > 0) {
                await this.adjustMoneyDeposit(accountId, characterId, characterId, frozenMoney);
            }
            await this.redis.hDel(this.characterKey(characterId), [
                "inventory", "pokemon_party", "battle_history", "visited_towns",
                "last_map_id", "last_x", "last_y", "last_surfing", "respawn_point",
                "event_switches", "event_variables", "event_self_switches",
                "egg_cooldowns", "money"
            ]);
            await this.redis.hSet(this.characterKey(characterId), {
                purged_at: new Date().toISOString()
            });
        }
    }

    // ---- account-level blocking ----
    // Blocks are account-to-account: blocking an account silences every
    // character it owns, and creating/switching characters cannot bypass it.

    public async getBlockedAccountIds(accountId:number):Promise<number[]> {
        const raw = await this.redis.hGet(this.userKey(accountId), "blocked_accounts");
        return this.parseUserIdArray(raw);
    }

    public async hasBlocked(accountId:number, targetAccountId:number):Promise<boolean> {
        return (await this.getBlockedAccountIds(accountId)).includes(targetAccountId);
    }

    public async isBlockedEitherWay(accountIdA:number, accountIdB:number):Promise<boolean> {
        const [byA, byB] = await Promise.all([
            this.getBlockedAccountIds(accountIdA),
            this.getBlockedAccountIds(accountIdB)
        ]);
        return byA.includes(accountIdB) || byB.includes(accountIdA);
    }

    public async blockAccount(
        accountId:number,
        targetAccountId:number
    ):Promise<{ ok:true } | { ok:false; message:string }> {
        if (!Number.isInteger(targetAccountId) || targetAccountId <= 0) {
            return { ok: false, message: "Account not found." };
        }
        if (accountId === targetAccountId) {
            return { ok: false, message: "You cannot block your own account." };
        }
        const target = await this.getSocialUserSummary(targetAccountId);
        if (!target) {
            return { ok: false, message: "Account not found." };
        }
        const blocked = await this.getBlockedAccountIds(accountId);
        if (!blocked.includes(targetAccountId)) {
            blocked.push(targetAccountId);
            await this.redis.hSet(this.userKey(accountId), {
                blocked_accounts: JSON.stringify(blocked)
            });
        }
        // A block severs the relationship in both directions: pending
        // requests and the friendship itself are removed.
        await Promise.all([
            this.removeFriendRequest(accountId, targetAccountId),
            this.removeFriendRequest(targetAccountId, accountId),
            this.removeFriendPair(accountId, targetAccountId)
        ]);
        return { ok: true };
    }

    public async unblockAccount(accountId:number, targetAccountId:number):Promise<boolean> {
        const blocked = await this.getBlockedAccountIds(accountId);
        const next = blocked.filter((id) => id !== targetAccountId);
        if (next.length === blocked.length) {
            return false;
        }
        await this.redis.hSet(this.userKey(accountId), { blocked_accounts: JSON.stringify(next) });
        return true;
    }

    /** Stamps account last-seen + active character last-played (on logout). */
    public async touchLastSeen(accountId:number) {
        const nowIso = new Date().toISOString();
        await this.redis.hSet(this.userKey(accountId), { last_seen_at: nowIso });
        const characterId = this.activeCharacterByAccount.get(accountId);
        if (characterId) {
            await this.redis.hSet(this.characterKey(characterId), { last_played_at: nowIso });
        }
    }

    public async getLastSeenAt(accountId:number):Promise<string | null> {
        return (await this.redis.hGet(this.userKey(accountId), "last_seen_at")) ?? null;
    }

    public async getBlockedAccountEntries(accountId:number):Promise<BlockedAccountEntry[]> {
        const ids = await this.getBlockedAccountIds(accountId);
        const entries:BlockedAccountEntry[] = [];
        for (const blockedId of ids) {
            const username = await this.redis.hGet(this.userKey(blockedId), "username");
            entries.push({ accountId: blockedId, accountName: username ?? `#${blockedId}` });
        }
        return entries;
    }

    public async getSavedPlayerLocation(userId:number) {
        const storedLocation = await this.redis.hmGet(await this.activeCharacterKey(userId), [
            "last_map_id",
            "last_x",
            "last_y",
            "last_surfing"
        ]);
        const [mapId, x, y, surfing] = storedLocation;
        const parsedX = x === null ? Number.NaN : Number.parseInt(x, 10);
        const parsedY = y === null ? Number.NaN : Number.parseInt(y, 10);

        if (
            typeof mapId !== "string" ||
            mapId.length === 0 ||
            !Number.isFinite(parsedX) ||
            !Number.isFinite(parsedY)
        ) {
            return null;
        }

        return {
            mapId,
            x: Math.round(parsedX),
            y: Math.round(parsedY),
            surfing: surfing === "1"
        } satisfies SavedPlayerLocation;
    }

    public async savePlayerLocation(userId:number, location:SavedPlayerLocation) {
        await this.redis.hSet(await this.activeCharacterKey(userId), {
            last_map_id: location.mapId,
            last_x: String(Math.round(location.x)),
            last_y: String(Math.round(location.y)),
            last_surfing: location.surfing ? "1" : "0"
        });
    }

    public async getUserForBattle(userId:number) {
        return this.getUserById(String(userId));
    }

    public async saveBattleState(
        userId:number,
        state:{
            pokemonParty?:PokemonSummary[];
            inventory?:InventoryItem[];
            money?:number;
        }
    ) {
        const fields:Record<string, string> = {};

        if (state.pokemonParty) {
            fields.pokemon_party = JSON.stringify(this.sanitizePokemonPartyForStorage(state.pokemonParty));
            this.markPartyChanged(userId);
        }

        if (state.inventory) {
            fields.inventory = JSON.stringify(this.sanitizeInventoryForStorage(state.inventory));
        }

        if (typeof state.money === "number" && Number.isFinite(state.money)) {
            fields.money = String(Math.max(0, Math.round(state.money)));
        }

        if (Object.keys(fields).length > 0) {
            await this.redis.hSet(await this.activeCharacterKey(userId), fields);
        }

        return this.getUserById(String(userId));
    }

    public async saveInventory(userId:number, inventory:InventoryItem[]) {
        return this.saveBattleState(userId, { inventory });
    }

    public async savePokemonParty(userId:number, pokemonParty:PokemonSummary[]) {
        return this.saveBattleState(userId, { pokemonParty });
    }

    public async namePokemon(
        token:string | undefined,
        pokemonId:string,
        nickname:string
    ):Promise<AuthSuccessResult | AuthErrorResult> {
        const authenticatedUser = await this.getAuthenticatedUserFromToken(token);
        if (!authenticatedUser) {
            return { error: "You must be authenticated to name a Pokemon." };
        }

        const safeNickname = this.normalizePokemonNickname(nickname);
        const validationMessage = this.validatePokemonNickname(safeNickname);
        if (validationMessage) {
            return { error: validationMessage };
        }

        const nextParty = authenticatedUser.pokemonParty.map((pokemon) => ({ ...pokemon }));
        const targetPokemon = nextParty.find((pokemon) => pokemon.id === pokemonId);
        if (!targetPokemon) {
            return { error: "Choose a Pokemon to name." };
        }

        if (targetPokemon.nickname) {
            return { error: "This Pokemon already has a selected name." };
        }

        targetPokemon.nickname = safeNickname;

        await this.redis.hSet(await this.activeCharacterKey(authenticatedUser.id), {
            pokemon_party: JSON.stringify(this.sanitizePokemonPartyForStorage(nextParty))
        });

        const user = await this.getUserById(String(authenticatedUser.id));
        if (!user) {
            return { error: "Unable to refresh account details." };
        }

        return {
            session: {
                authenticated: true,
                user,
                token: token ?? await this.createSession(user)
            }
        };
    }

    public async appendBattleHistory(userId:number, entry:BattleHistoryEntry) {
        const user = await this.getUserById(String(userId));
        const battleHistory = this.sanitizeBattleHistoryForStorage([
            entry,
            ...(user?.battleHistory ?? [])
        ]);

        await this.redis.hSet(await this.activeCharacterKey(userId), {
            battle_history: JSON.stringify(battleHistory)
        });

        return this.getUserById(String(userId));
    }

    public async transferMoney(loserUserId:number, winnerUserId:number, amount:number) {
        const loser = await this.getUserForBattle(loserUserId);
        const winner = await this.getUserForBattle(winnerUserId);

        if (!loser || !winner) {
            return null;
        }

        const transferAmount = Math.max(0, Math.min(Math.round(amount), loser.money));

        await Promise.all([
            this.saveBattleState(loserUserId, { money: loser.money - transferAmount }),
            this.saveBattleState(winnerUserId, { money: winner.money + transferAmount })
        ]);

        return {
            transferAmount,
            loser: await this.getUserForBattle(loserUserId),
            winner: await this.getUserForBattle(winnerUserId)
        };
    }

    public async requestPasswordRecovery(payload:RecoverPasswordPayload):Promise<AuthInfoResult | AuthErrorResult> {
        const identifier = typeof payload.identifier === "string" ? payload.identifier.trim() : "";
        if (!identifier) {
            return { error: "Username or email is required." };
        }

        const user = identifier.includes("@")
            ? await this.getUserByEmail(identifier)
            : await this.getUserByUsername(identifier);

        if (user) {
            const recoveryToken = await this.createPasswordResetToken(user.id);
            await this.mailService.sendPasswordRecoveryEmail(this.toAuthenticatedUser(user), recoveryToken);
        }

        return {
            message: "If the account exists, a password recovery email has been sent."
        };
    }

    public async requestUsernameRecovery(payload:RecoverUsernamePayload):Promise<AuthInfoResult | AuthErrorResult> {
        const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
        if (!email || !this.isValidEmail(email)) {
            return { error: "A valid email address is required." };
        }

        const user = await this.getUserByEmail(email);
        if (user) {
            await this.mailService.sendUsernameRecoveryEmail(this.toAuthenticatedUser(user));
        }

        return {
            message: "If the account exists, a username recovery email has been sent."
        };
    }

    public async requestEmailValidation(token?:string):Promise<AuthInfoResult | AuthErrorResult> {
        const user = await this.getAuthenticatedUserFromToken(token);
        if (!user) {
            return { error: "You must be authenticated to request an email validation message." };
        }

        if (user.emailVerified) {
            return { message: "This email address has already been verified." };
        }

        await this.sendEmailValidationRequest(user);
        return {
            message: "A validation email has been sent."
        };
    }

    public async verifyEmail(payload:VerifyEmailPayload):Promise<AuthInfoResult | AuthErrorResult> {
        const token = typeof payload.token === "string" ? payload.token.trim() : "";
        if (!token) {
            return { error: "Email validation token is required." };
        }

        const userId = await this.consumeOneTimeToken(this.emailValidationTokenKey(token));
        if (!userId) {
            return { error: "The email validation token is invalid or expired." };
        }

        await this.redis.hSet(this.userKey(userId), {
            email_verified: "1"
        });

        return {
            message: "Email address verified successfully."
        };
    }

    public async resetPassword(payload:ResetPasswordPayload):Promise<AuthInfoResult | AuthErrorResult> {
        const token = typeof payload.token === "string" ? payload.token.trim() : "";
        const password = typeof payload.password === "string" ? payload.password : "";

        if (!token) {
            return { error: "Password reset token is required." };
        }

        const passwordValidation = this.validatePassword(password);
        if (passwordValidation) {
            return { error: passwordValidation };
        }

        const userId = await this.consumeOneTimeToken(this.passwordResetTokenKey(token));
        if (!userId) {
            return { error: "The password reset token is invalid or expired." };
        }

        const passwordSalt = crypto.randomBytes(16).toString("hex");
        const passwordHash = this.hashPassword(password, passwordSalt);
        await this.redis.hSet(this.userKey(userId), {
            password_hash: passwordHash,
            password_salt: passwordSalt
        });

        return {
            message: "Password updated successfully."
        };
    }

    public async changePassword(token:string | undefined, payload:ChangePasswordPayload):Promise<AuthInfoResult | AuthErrorResult> {
        const authenticatedUser = await this.getAuthenticatedUserFromToken(token);
        if (!authenticatedUser) {
            return { error: "You must be authenticated to change your password." };
        }

        const storedUser = await this.getStoredUserById(String(authenticatedUser.id));
        const currentPassword = typeof payload.currentPassword === "string" ? payload.currentPassword : "";
        const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";

        if (!storedUser || !this.verifyPassword(currentPassword, storedUser.password_salt, storedUser.password_hash)) {
            return { error: "Current password is incorrect." };
        }

        const passwordValidation = this.validatePassword(newPassword);
        if (passwordValidation) {
            return { error: passwordValidation };
        }

        const passwordSalt = crypto.randomBytes(16).toString("hex");
        const passwordHash = this.hashPassword(newPassword, passwordSalt);

        await this.redis.hSet(this.userKey(authenticatedUser.id), {
            password_hash: passwordHash,
            password_salt: passwordSalt
        });

        return { message: "Password updated successfully." };
    }

    /**
     * Starts the self-service account deletion flow: generates a short numeric
     * confirmation code, stores it (keyed by user id, so a new request replaces
     * any pending one) with a short TTL, and emails it to the account address.
     * The code — not a link — is what the user types back to confirm.
     */
    public async requestAccountDeletion(token:string | undefined):Promise<AuthInfoResult | AuthErrorResult> {
        const authenticatedUser = await this.getAuthenticatedUserFromToken(token);
        if (!authenticatedUser) {
            return { error: "You must be authenticated to delete your account." };
        }

        const code = this.generateNumericCode(6);
        await this.redis.set(this.accountDeletionCodeKey(authenticatedUser.id), code, {
            EX: this.accountDeletionTtlSeconds
        });

        await this.mailService.sendAccountDeletionCodeEmail(authenticatedUser, code);

        return {
            message: "A confirmation code has been sent to your email address."
        };
    }

    /**
     * Confirms self-service deletion: verifies the emailed code, then wipes the
     * account and every trace of its data via {@link deleteUser}. The code is
     * single-use — it is cleared whether or not it matched a valid attempt only
     * on success (a mismatch keeps it so the user can retry until it expires).
     */
    public async confirmAccountDeletion(
        token:string | undefined,
        payload:ConfirmAccountDeletionPayload
    ):Promise<{ username:string } | AuthErrorResult> {
        const authenticatedUser = await this.getAuthenticatedUserFromToken(token);
        if (!authenticatedUser) {
            return { error: "You must be authenticated to delete your account." };
        }

        const submittedCode = typeof payload.code === "string" ? payload.code.trim() : "";
        if (!submittedCode) {
            return { error: "Enter the confirmation code sent to your email." };
        }

        const codeKey = this.accountDeletionCodeKey(authenticatedUser.id);
        const storedCode = await this.redis.get(codeKey);
        if (!storedCode) {
            return { error: "The confirmation code is invalid or has expired. Request a new one." };
        }

        if (!this.constantTimeEquals(storedCode, submittedCode)) {
            return { error: "The confirmation code is incorrect." };
        }

        await this.redis.del(codeKey);

        return this.deleteUser(authenticatedUser.id);
    }

    public async updateProfile(token:string | undefined, payload:UpdateProfilePayload):Promise<AuthSuccessResult | AuthErrorResult> {
        const authenticatedUser = await this.getAuthenticatedUserFromToken(token);
        if (!authenticatedUser) {
            return { error: "You must be authenticated to update your profile." };
        }

        const profileImage = typeof payload.profileImage === "string" ? payload.profileImage.trim() : authenticatedUser.profileImage;
        const description = typeof payload.description === "string" ? payload.description.trim() : authenticatedUser.description;
        // The free profile update only sets the skin on the FIRST pick (empty
        // current skin — the startup/onboarding selection). Later skin changes
        // must go through the paid `player:set-skin` handler ($300), so a
        // characterSkinId here is ignored once a skin is already assigned.
        const characterSkinId =
            typeof payload.characterSkinId === "string" && !authenticatedUser.characterSkinId.trim()
                ? payload.characterSkinId.trim().slice(0, 120)
                : authenticatedUser.characterSkinId;
        const trainerCardColor =
            typeof payload.trainerCardColor === "string"
                ? payload.trainerCardColor.trim().slice(0, 40)
                : authenticatedUser.trainerCardColor;

        if (description.length > 50) {
            return { error: "Description must be 50 characters or less." };
        }

        if (profileImage.length > 2000) {
            return { error: "Profile image URL is too long." };
        }

        // Profile image/description are account identity; the skin and card
        // color belong to the active character.
        await this.redis.hSet(this.userKey(authenticatedUser.id), {
            profile_image: profileImage,
            description
        });
        await this.redis.hSet(await this.activeCharacterKey(authenticatedUser.id), {
            character_skin_id: characterSkinId,
            trainer_card_color: trainerCardColor
        });

        const user = await this.getUserById(String(authenticatedUser.id));
        if (!user) {
            return { error: "Unable to refresh account details." };
        }

        const tokenValue = token ?? await this.createSession(user);
        return {
            session: {
                authenticated: true,
                user,
                token: tokenValue
            }
        };
    }

    public async chooseStarter(
        token:string | undefined,
        payload:ChooseStarterPayload,
        starterPokemon:StarterPokemonDefinition
    ):Promise<AuthSuccessResult | AuthErrorResult> {
        const authenticatedUser = await this.getAuthenticatedUserFromToken(token);
        if (!authenticatedUser) {
            return { error: "You must be authenticated to choose a starter Pokemon." };
        }

        if (authenticatedUser.pokemonParty.length > 0) {
            return { error: "You already have Pokemon in hand." };
        }

        const nickname = this.normalizePokemonNickname(payload.nickname);
        const nicknameValidationMessage = nickname ? this.validatePokemonNickname(nickname) : null;
        if (nicknameValidationMessage) {
            return { error: nicknameValidationMessage };
        }

        const levelingCurveConfig = await readLevelingCurveConfigFromRedis(this.redis);
        const rollIv = () => Math.floor(Math.random() * 32);
        const ivs = {
            hp: rollIv(),
            attack: rollIv(),
            defense: rollIv(),
            specialAttack: rollIv(),
            specialDefense: rollIv(),
            speed: rollIv()
        };
        // Level-1 HP stat from the species base HP (same formula as the battle engine).
        const baseHp = Math.max(1, Math.round(starterPokemon.hp));
        const hpStat = Math.max(1, Math.floor((2 * baseHp + ivs.hp) / 100) + 1 + 10);
        const starter:PokemonSummary = {
            id: crypto.randomUUID(),
            sourcePokemonId: starterPokemon.id,
            name: starterPokemon.name,
            nickname,
            level: 1,
            types: starterPokemon.elements,
            hp: hpStat,
            maxHp: hpStat,
            ivs,
            moves: starterPokemon.skills
                .filter((skill) => skill.level <= 1)
                .slice(0, 4)
                .map((skill) => skill.skillName)
                .filter(Boolean),
            movePp: {},
            experience: 0,
            experienceCurve: "medium",
            nextLevelExperience: getExperienceForNextLevel(1, levelingCurveConfig),
            statBonuses: createEmptyPokemonStatBonuses()
        };

        await this.redis.hSet(await this.activeCharacterKey(authenticatedUser.id), {
            pokemon_party: JSON.stringify([starter])
        });

        const user = await this.getUserById(String(authenticatedUser.id));
        if (!user) {
            return { error: "Unable to refresh account details." };
        }

        return {
            session: {
                authenticated: true,
                user,
                token: token ?? await this.createSession(user)
            }
        };
    }

    public async getRoleDefinitions() {
        return this.readRoleDefinitions();
    }

    public async getRoleDefinitionsWithCounts():Promise<RoleDefinitionWithCount[]> {
        const [roles, users] = await Promise.all([
            this.readRoleDefinitions(),
            this.getUserSearchRows()
        ]);
        const counts = users.reduce<Record<UserRoleKey, number>>((accumulator, user) => {
            accumulator[user.role] += 1;
            return accumulator;
        }, {
            admin: 0,
            designer: 0,
            moderator: 0,
            user: 0
        });

        return roles.map((role) => ({
            ...role,
            userCount: counts[role.key] ?? 0
        }));
    }

    public async updateRoleDefinition(
        roleKey:UserRoleKey,
        updates:{
            description?:string;
            permissions?:RolePermission[];
        }
    ):Promise<{ role:RoleDefinition } | { error:string }> {
        const roles = await this.readRoleDefinitions();
        const roleIndex = roles.findIndex((role) => role.key === roleKey);
        if (roleIndex === -1) {
            return { error: "Unknown role." };
        }

        const currentRole = roles[roleIndex];
        const nextDescription =
            typeof updates.description === "string"
                ? updates.description.trim().slice(0, 240)
                : currentRole.description;

        if (!nextDescription) {
            return { error: "Role description is required." };
        }

        const nextPermissions =
            roleKey === "admin"
                ? [...ROLE_PERMISSIONS]
                : this.sanitizeRolePermissions(updates.permissions ?? currentRole.permissions);

        roles[roleIndex] = {
            ...currentRole,
            description: nextDescription,
            permissions: nextPermissions
        };

        await this.redis.set(this.roleDefinitionsKey(), JSON.stringify(roles));
        this.roleDefinitionsCache = null;

        return {
            role: roles[roleIndex]
        };
    }

    public async listUsers(
        payload?:{
            search?:string;
            page?:number;
            pageSize?:number;
        }
    ):Promise<AdminUserListPayload> {
        const search = typeof payload?.search === "string" ? payload.search.trim().toLowerCase() : "";
        const requestedPage = typeof payload?.page === "number" && Number.isFinite(payload.page)
            ? Math.max(1, Math.round(payload.page))
            : 1;
        const pageSize = typeof payload?.pageSize === "number" && Number.isFinite(payload.pageSize)
            ? Math.max(5, Math.min(50, Math.round(payload.pageSize)))
            : 10;
        const users = await this.getUserSearchRows();
        const filteredUsers = users
            .filter((user) => {
                if (!search) {
                    return true;
                }

                const haystack = [
                    user.name,
                    user.username,
                    user.email,
                    user.role
                ].join(" ").toLowerCase();

                return haystack.includes(search);
            })
            .sort((left, right) => right.id - left.id);
        const total = filteredUsers.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(requestedPage, totalPages);
        const startIndex = (page - 1) * pageSize;
        const pagedRows = filteredUsers.slice(startIndex, startIndex + pageSize);
        // Only the visible page pays the cost of full record hydration.
        const pagedUsers = await Promise.all(
            pagedRows.map((row) => this.getStoredUserById(String(row.id)))
        );
        const summaries = await Promise.all(
            pagedUsers
                .filter((user): user is StoredUser => Boolean(user))
                .map((user) => this.toAdminUserSummary(user))
        );

        return {
            users: summaries,
            search,
            page,
            pageSize,
            total,
            totalPages
        };
    }

    public async getUserAdminDetails(userId:number):Promise<AdminUserDetails | null> {
        const user = await this.getStoredUserById(String(userId));
        if (!user) {
            return null;
        }

        return this.toAdminUserDetails(user);
    }

    /**
     * Read-only PC box storage + public trainer profile for the admin panel.
     * Box venomons are enriched with catalog icons the same way the party is.
     */
    public async getUserStorageForAdmin(userId:number):Promise<{
        boxes:PokemonStorageBox[];
        profile:{
            name:string;
            username:string;
            description:string;
            profileImage:string;
            characterSkinId:string;
            trainerCardColor:string;
            badges:number[];
            money:number;
            createdAt:string;
        };
    } | null> {
        const storedUser = await this.getStoredUserById(String(userId));
        if (!storedUser) {
            return null;
        }

        const base = this.toAuthenticatedUser(storedUser);
        const [pokemonIcons, boxes] = await Promise.all([
            this.readPokemonIconIndex(),
            this.getPokemonStorage(userId)
        ]);

        return {
            boxes: boxes.map((box) => ({
                ...box,
                pokemon: box.pokemon.map((pokemon) => {
                    const icons =
                        pokemonIcons.get(pokemon.sourcePokemonId ?? "") ??
                        pokemonIcons.get(pokemon.id);
                    return icons
                        ? { ...pokemon, iconImageSrc: icons.iconImageSrc || pokemon.iconImageSrc }
                        : pokemon;
                })
            })),
            profile: {
                name: base.name,
                username: base.username,
                description: base.description,
                profileImage: base.profileImage,
                characterSkinId: base.characterSkinId,
                trainerCardColor: base.trainerCardColor,
                badges: base.badges,
                money: base.money,
                createdAt: storedUser.created_at
            }
        };
    }

    /**
     * Admin replacement of a user's event switches/variables. Self-switches
     * are intentionally untouched — they are per-event internals; clearing
     * them belongs to targeted recovery tools, not a bulk editor.
     */
    public async setEventStateByAdmin(userId:number, next:{
        switches:Record<string, boolean>;
        variables:Record<string, number>;
    }) {
        const switches:Record<string, boolean> = {};
        for (const [id, on] of Object.entries(next.switches)) {
            if (on === true && id.trim().length > 0) {
                switches[id.trim()] = true;
            }
        }

        const variables:Record<string, number> = {};
        for (const [id, value] of Object.entries(next.variables)) {
            if (id.trim().length > 0 && typeof value === "number" && Number.isFinite(value)) {
                variables[id.trim()] = Math.round(value);
            }
        }

        await this.redis.hSet(await this.activeCharacterKey(userId), {
            event_switches: JSON.stringify(switches),
            event_variables: JSON.stringify(variables)
        });
    }

    public async updateUserByAdmin(
        userId:number,
        updates:AdminUserUpdatePayload
    ):Promise<{ user:AdminUserDetails } | { error:string }> {
        const storedUser = await this.getStoredUserById(String(userId));
        if (!storedUser) {
            return { error: "User not found." };
        }

        const accountFields:Record<string, string> = {};
        const characterFields:Record<string, string> = {};

        if (typeof updates.name === "string") {
            const name = updates.name.trim();
            if (name.length < 2 || name.length > 30) {
                return { error: "Name must be between 2 and 30 characters." };
            }

            if (!/^[A-Za-z]+$/.test(name)) {
                return { error: "Name may contain letters only." };
            }

            // The admin edits the visible identity: the active character name.
            characterFields.name = name;
        }

        if (typeof updates.profileImage === "string") {
            const profileImage = updates.profileImage.trim();
            if (profileImage.length > 2000) {
                return { error: "Profile image URL is too long." };
            }

            accountFields.profile_image = profileImage;
        }

        if (typeof updates.description === "string") {
            const description = updates.description.trim();
            if (description.length > 50) {
                return { error: "Description must be 50 characters or less." };
            }

            accountFields.description = description;
        }

        if (typeof updates.trainerGender === "string") {
            characterFields.trainer_gender = updates.trainerGender.trim().slice(0, 40);
        }

        if (typeof updates.characterSkinId === "string") {
            characterFields.character_skin_id = updates.characterSkinId.trim().slice(0, 120);
        }

        if (typeof updates.money === "number") {
            if (!Number.isFinite(updates.money)) {
                return { error: "Money must be a valid number." };
            }

            characterFields.money = String(Math.max(0, Math.round(updates.money)));
        }

        if (typeof updates.emailVerified === "boolean") {
            accountFields.email_verified = updates.emailVerified ? "1" : "0";
        }

        if (typeof updates.role === "string") {
            const roles = await this.readRoleDefinitions();
            if (!roles.some((role) => role.key === updates.role)) {
                return { error: "Unknown role." };
            }

            accountFields.role = updates.role;
        }

        if (updates.inventory) {
            characterFields.inventory = JSON.stringify(this.sanitizeInventoryForStorage(updates.inventory));
        }

        if (updates.pokemonParty) {
            characterFields.pokemon_party = JSON.stringify(this.sanitizePokemonPartyForStorage(updates.pokemonParty));
        }

        if (updates.battleHistory) {
            characterFields.battle_history = JSON.stringify(this.sanitizeBattleHistoryForStorage(updates.battleHistory));
        }

        if (Object.keys(accountFields).length > 0) {
            await this.redis.hSet(this.userKey(userId), accountFields);
        }
        if (Object.keys(characterFields).length > 0) {
            await this.redis.hSet(await this.activeCharacterKey(userId), characterFields);
            this.markPartyChanged(userId);
        }

        if (updates.savedLocation) {
            if (
                typeof updates.savedLocation.mapId !== "string" ||
                updates.savedLocation.mapId.trim().length === 0 ||
                typeof updates.savedLocation.x !== "number" ||
                !Number.isFinite(updates.savedLocation.x) ||
                typeof updates.savedLocation.y !== "number" ||
                !Number.isFinite(updates.savedLocation.y)
            ) {
                return { error: "Saved location must include a map and valid coordinates." };
            }

            await this.savePlayerLocation(userId, {
                mapId: updates.savedLocation.mapId.trim(),
                x: updates.savedLocation.x,
                y: updates.savedLocation.y
            });
        }

        const updatedUser = await this.getUserAdminDetails(userId);
        if (!updatedUser) {
            return { error: "Unable to refresh the updated user." };
        }

        return {
            user: updatedUser
        };
    }

    /**
     * Sends an account back to the start of the adventure: empty party (so the
     * starter selection runs again), default inventory/money, cleared battle
     * history, and no saved location (next world join uses the initial map
     * spawn). Profile, credentials, and character skin are kept.
     */
    public async resetUserProgress(
        userId:number
    ):Promise<{ user:AdminUserDetails } | { error:string }> {
        const storedUser = await this.getStoredUserById(String(userId));
        if (!storedUser) {
            return { error: "User not found." };
        }

        await this.applyProgressReset(userId);

        const updatedUser = await this.getUserAdminDetails(userId);
        if (!updatedUser) {
            return { error: "Unable to refresh the reset user." };
        }

        return {
            user: updatedUser
        };
    }

    /** The reset itself, shared by the per-user admin action and the bulk maintenance reset. */
    private async applyProgressReset(userId:number):Promise<void> {
        const characterKey = await this.activeCharacterKey(userId);
        await this.redis.hSet(characterKey, {
            pokemon_party: JSON.stringify(DEFAULT_POKEMON_PARTY),
            inventory: JSON.stringify(DEFAULT_INVENTORY),
            money: String(DEFAULT_MONEY),
            battle_history: JSON.stringify(DEFAULT_BATTLE_HISTORY),
            // Clear RPG Maker event progression so scripted events (e.g. the lab
            // starter) can be replayed from the beginning after a reset.
            event_switches: JSON.stringify({}),
            event_variables: JSON.stringify({}),
            event_self_switches: JSON.stringify({}),
            // Badges are progression too: a reset player replaying the story
            // must not sail through numbadges gates with pre-reset medals.
            badges: JSON.stringify([])
        });
        await this.redis.hDel(characterKey, [
            "last_map_id", "last_x", "last_y", "respawn_point", "egg_cooldowns"
        ]);
        // The shared PC storage is account-owned and may hold assets belonging
        // to OTHER characters, so a progress reset only strips what this
        // character owns from it (boxes, stacks, and its money deposits).
        await this.removeCharacterAssetsFromSharedStorage(
            userId,
            await this.getActiveCharacterId(userId)
        );
        this.markPartyChanged(userId);
    }

    /**
     * Ids of every stored account. Characters share the same id sequence, so
     * existence of the `auth:user:{id}` hash (not the sequence range alone)
     * decides membership.
     */
    public async listAllUserIds():Promise<number[]> {
        const highestUserId = Number.parseInt(await this.redis.get(this.userIdSequenceKey()) ?? "0", 10);
        if (!Number.isFinite(highestUserId) || highestUserId <= 0) {
            return [];
        }

        const chunkSize = 200;
        const ids:number[] = [];
        for (let start = 1; start <= highestUserId; start += chunkSize) {
            const count = Math.min(chunkSize, highestUserId - start + 1);
            const chunk = await Promise.all(
                Array.from({ length: count }, (_, index) => (
                    this.redis.hGet(this.userKey(start + index), "id")
                ))
            );
            chunk.forEach((id, index) => {
                if (id) {
                    ids.push(start + index);
                }
            });
        }

        return ids;
    }

    /**
     * Applies resetUserProgress semantics to EVERY account (admin "Reset
     * Adventure for Everyone" maintenance action). Failures on individual
     * accounts are reported and skipped, never aborting the sweep.
     */
    public async resetAllUsersProgress(
        onProgress?:(message:string)=>void
    ):Promise<{ total:number; reset:number; failed:number }> {
        const userIds = await this.listAllUserIds();
        let reset = 0;
        let failed = 0;

        for (const userId of userIds) {
            try {
                await this.applyProgressReset(userId);
                reset += 1;
            } catch (error) {
                failed += 1;
                onProgress?.(`user ${userId}: reset failed (${(error as Error).message})`);
            }

            const processed = reset + failed;
            if (processed % 25 === 0 || processed === userIds.length) {
                onProgress?.(`… ${processed}/${userIds.length} accounts processed`);
            }
        }

        return { total: userIds.length, reset, failed };
    }

    /**
     * Permanently removes an account and every trace of its data: the primary
     * `auth:user:{id}` hash (party, inventory, money, battle history, saved
     * location, respawn point, boxed Pokemon, event switches/variables), the
     * username/email lookup indexes, and any active sessions (which logs the
     * user out everywhere). One-time reset/validation tokens are left to expire
     * on their own TTL. This is irreversible.
     */
    public async deleteUser(userId:number):Promise<{ username:string } | { error:string }> {
        const storedUser = await this.getStoredUserById(String(userId));
        if (!storedUser) {
            return { error: "User not found." };
        }

        await this.deleteSessionsForUser(userId);

        const keysToDelete = [this.userKey(userId)];
        // Every character hash the account owns goes with it.
        for (const characterId of await this.getCharacterIds(userId)) {
            keysToDelete.push(this.characterKey(characterId));
        }
        const username = typeof storedUser.username === "string" ? storedUser.username.toLowerCase() : "";
        const email = typeof storedUser.email === "string" ? storedUser.email.toLowerCase() : "";
        if (username) {
            keysToDelete.push(this.usernameIndexKey(username));
        }
        if (email) {
            keysToDelete.push(this.emailIndexKey(email));
        }

        await this.redis.del(keysToDelete);
        this.activeCharacterByAccount.delete(userId);

        return { username: storedUser.username };
    }

    private async deleteSessionsForUser(userId:number) {
        const target = String(userId);
        const pattern = `${this.sessionKey("")}*`;

        for await (const batch of this.redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
            // node-redis may yield a single key or a batch of keys depending on
            // version; normalize to an array either way.
            const keys = Array.isArray(batch) ? batch : [batch];
            for (const key of keys) {
                const value = await this.redis.get(key);
                if (value === target) {
                    await this.redis.del(key);
                }
            }
        }
    }


    // ---- RPG Maker event state: switches / variables / self-switches ----
    // Persisted per user so multi-page events (page conditions) and progression
    // gating (e.g. "professor gave permission") survive across sessions.
    // ------------------------------------------------------------------
    // World-shared event switches (opt-in). Imported story progression is
    // per-player by design; a switch becomes world-wide ONLY when its id is
    // listed in the `world:event-switch-globals` JSON array (curated by the
    // operators for genuinely shared world state, e.g. a server-wide event).
    // Values live in `world:event-switches` and override the player's copy.
    // ------------------------------------------------------------------
    private static GLOBAL_SWITCH_IDS_KEY = "world:event-switch-globals";
    private static GLOBAL_SWITCH_VALUES_KEY = "world:event-switches";
    private globalSwitchIdCache:{ ids:Set<string>; fetchedAt:number } | null = null;

    private async getGlobalSwitchIds():Promise<Set<string>> {
        if (this.globalSwitchIdCache && Date.now() - this.globalSwitchIdCache.fetchedAt < 30_000) {
            return this.globalSwitchIdCache.ids;
        }
        let ids = new Set<string>();
        try {
            const raw = await this.redis.get(Auth.GLOBAL_SWITCH_IDS_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            if (Array.isArray(parsed)) {
                ids = new Set(parsed.map((id) => String(id)));
            }
        } catch {
            // Malformed config: treat as "nothing shared".
        }
        this.globalSwitchIdCache = { ids, fetchedAt: Date.now() };
        return ids;
    }

    private async readWorldSwitchValues():Promise<Record<string, boolean>> {
        try {
            const raw = await this.redis.get(Auth.GLOBAL_SWITCH_VALUES_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === "object" ? parsed as Record<string, boolean> : {};
        } catch {
            return {};
        }
    }

    private async applyWorldSwitchWrites(writes:Record<string, boolean>) {
        const values = await this.readWorldSwitchValues();
        for (const [id, on] of Object.entries(writes)) {
            if (on) {
                values[id] = true;
            } else {
                delete values[id];
            }
        }
        await this.redis.set(Auth.GLOBAL_SWITCH_VALUES_KEY, JSON.stringify(values));
    }

    public async getEventState(userId:number):Promise<{
        switches:Record<string, boolean>;
        variables:Record<string, number>;
        selfSwitches:Record<string, boolean>;
    }> {
        const raw = await this.redis.hmGet(await this.activeCharacterKey(userId), [
            "event_switches", "event_variables", "event_self_switches"
        ]);
        const parse = (value:string | null | undefined) => {
            try {
                const parsed = value ? JSON.parse(value) : {};
                return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
            } catch {
                return {} as Record<string, unknown>;
            }
        };
        const switches = parse(raw[0]) as Record<string, boolean>;

        // Overlay explicitly-shared world switches (see getGlobalSwitchIds).
        const globalIds = await this.getGlobalSwitchIds();
        if (globalIds.size > 0) {
            const worldValues = await this.readWorldSwitchValues();
            for (const id of globalIds) {
                if (worldValues[id]) {
                    switches[id] = true;
                } else {
                    delete switches[id];
                }
            }
        }

        return {
            switches,
            variables: parse(raw[1]) as Record<string, number>,
            selfSwitches: parse(raw[2]) as Record<string, boolean>
        };
    }

    public async setEventSwitches(userId:number, startId:number, endId:number, on:boolean) {
        const lo = Math.min(startId, endId);
        const hi = Math.max(startId, endId);
        const switches:Record<string, boolean> = {};
        for (let id = lo; id <= hi; id += 1) {
            switches[String(id)] = on;
        }
        await this.applyEventStateWrites(userId, { switches, variables: {}, selfSwitches: {} });
    }

    public async setEventVariable(userId:number, id:number, value:number) {
        const state = await this.getEventState(userId);
        state.variables[String(id)] = value;
        await this.redis.hSet(await this.activeCharacterKey(userId), {
            event_variables: JSON.stringify(state.variables)
        });
    }

    public async setEventSelfSwitch(userId:number, key:string, on:boolean) {
        const state = await this.getEventState(userId);
        if (on) {
            state.selfSwitches[key] = true;
        } else {
            delete state.selfSwitches[key];
        }
        await this.redis.hSet(await this.activeCharacterKey(userId), {
            event_self_switches: JSON.stringify(state.selfSwitches)
        });
    }

    /**
     * Egg re-gift cooldown bookkeeping. Egg-giving NPCs ("Regala huevo", the
     * Day Care "Criador") record when they last handed a player an egg, keyed
     * by NPC placement id, so the same NPC only gives another egg once the
     * weekly cooldown has elapsed. A missing entry means "never given" (0), so
     * first-time and existing players are eligible right away.
     */
    public async getEggGrantTimestamp(userId:number, key:string):Promise<number> {
        const raw = await this.redis.hGet(await this.activeCharacterKey(userId), "egg_cooldowns");
        if (!raw) {
            return 0;
        }
        try {
            const map = JSON.parse(raw);
            const ts = map && typeof map === "object" ? Number(map[key]) : 0;
            return Number.isFinite(ts) ? ts : 0;
        } catch {
            return 0;
        }
    }

    public async setEggGrantTimestamp(userId:number, key:string, timestampMs:number):Promise<void> {
        const raw = await this.redis.hGet(await this.activeCharacterKey(userId), "egg_cooldowns");
        let map:Record<string, number> = {};
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    map = parsed as Record<string, number>;
                }
            } catch {
                map = {};
            }
        }
        map[key] = Math.round(timestampMs);
        await this.redis.hSet(await this.activeCharacterKey(userId), { egg_cooldowns: JSON.stringify(map) });
    }

    /**
     * Applies a batch of buffered event-state writes in one round trip. The
     * event runtime buffers switch/variable/self-switch changes per session
     * and commits them at checkpoints, so a session aborted mid-dialog (app
     * closed during the intro) leaves no half-applied state behind. A `false`
     * switch/self-switch value means "clear it".
     */
    public async applyEventStateWrites(userId:number, writes:{
        switches:Record<string, boolean>;
        variables:Record<string, number>;
        selfSwitches:Record<string, boolean>;
    }) {
        if (
            Object.keys(writes.switches).length === 0 &&
            Object.keys(writes.variables).length === 0 &&
            Object.keys(writes.selfSwitches).length === 0
        ) {
            return;
        }

        // Switch writes whose id is in the shared allowlist go to the world
        // store; everything else stays per-player (the default for imported
        // single-player progression).
        const globalIds = await this.getGlobalSwitchIds();
        const worldWrites:Record<string, boolean> = {};
        const playerSwitchWrites:Record<string, boolean> = {};
        for (const [id, on] of Object.entries(writes.switches)) {
            if (globalIds.has(id)) {
                worldWrites[id] = on;
            } else {
                playerSwitchWrites[id] = on;
            }
        }
        if (Object.keys(worldWrites).length > 0) {
            await this.applyWorldSwitchWrites(worldWrites);
        }

        const state = await this.getEventState(userId);
        for (const [id, on] of Object.entries(playerSwitchWrites)) {
            if (on) {
                state.switches[id] = true;
            } else {
                delete state.switches[id];
            }
        }
        // Never persist overlayed world values into the per-player copy.
        for (const id of globalIds) {
            delete state.switches[id];
        }
        for (const [id, value] of Object.entries(writes.variables)) {
            state.variables[id] = value;
        }
        for (const [key, on] of Object.entries(writes.selfSwitches)) {
            if (on) {
                state.selfSwitches[key] = true;
            } else {
                delete state.selfSwitches[key];
            }
        }
        await this.redis.hSet(await this.activeCharacterKey(userId), {
            event_switches: JSON.stringify(state.switches),
            event_variables: JSON.stringify(state.variables),
            event_self_switches: JSON.stringify(state.selfSwitches)
        });
    }

    /**
     * Clears every self-switch of one event (`<essMapId>:<eventId>:` prefix).
     * Used to un-brick players stranded on the intro map: replaying the
     * event's autorun page requires its self-switches to be reset.
     */
    public async clearEventSelfSwitchesByPrefix(userId:number, prefix:string) {
        const state = await this.getEventState(userId);
        let changed = false;
        for (const key of Object.keys(state.selfSwitches)) {
            if (key.startsWith(prefix)) {
                delete state.selfSwitches[key];
                changed = true;
            }
        }
        if (changed) {
            await this.redis.hSet(await this.activeCharacterKey(userId), {
                event_self_switches: JSON.stringify(state.selfSwitches)
            });
        }
        return changed;
    }

    public async getPublicUserData(userId:number) {
        return this.getUserById(String(userId));
    }

    /**
     * Fully heals the user's party (HP, status, PP) — the RPG Maker
     * "Recover All" event command used by Pokemon Center nurses.
     */
    public async healPokemonParty(userId:number):Promise<boolean> {
        const user = await this.getUserById(String(userId));
        if (!user || !Array.isArray(user.pokemonParty) || user.pokemonParty.length === 0) {
            return false;
        }

        const ppByMoveName = new Map<string, number>();
        try {
            const raw = await this.redis.get("designer:section:skills");
            const items = raw ? JSON.parse(raw)?.state?.items : null;
            if (Array.isArray(items)) {
                for (const item of items) {
                    const name = typeof item?.name === "string" ? item.name.toLowerCase() : null;
                    const pp = Number(item?.pokemonSkillProfile?.powerPoint);
                    if (name && Number.isFinite(pp) && pp > 0) {
                        ppByMoveName.set(name, Math.round(pp));
                    }
                }
            }
        } catch {
            // PP restore falls back to current values below.
        }

        const healed = user.pokemonParty.map((pokemon) => ({
            ...pokemon,
            hp: pokemon.maxHp,
            status: null,
            movePp: (pokemon.moves ?? []).reduce<Record<string, number>>((accumulator, moveName) => {
                const known = ppByMoveName.get(moveName.toLowerCase());
                const current = pokemon.movePp?.[moveName];
                accumulator[moveName] = known ?? (typeof current === "number" ? Math.max(1, current) : 1);
                return accumulator;
            }, {})
        }));

        await this.redis.hSet(await this.activeCharacterKey(userId), {
            pokemon_party: JSON.stringify(healed)
        });
        return true;
    }

    /** Renames the active CHARACTER (pbTrainerName from the intro event). */
    public async setUserName(userId:number, name:string):Promise<boolean> {
        const trimmed = String(name ?? "").trim().slice(0, 30);
        if (!trimmed) {
            return false;
        }
        await this.redis.hSet(await this.activeCharacterKey(userId), { name: trimmed });
        return true;
    }

    /** Sets the character skin (pbChangePlayer gender pick from the intro). */
    public async setCharacterSkin(userId:number, characterSkinId:string):Promise<boolean> {
        const trimmed = String(characterSkinId ?? "").trim().slice(0, 120);
        if (!trimmed) {
            return false;
        }
        await this.redis.hSet(await this.activeCharacterKey(userId), { character_skin_id: trimmed });
        return true;
    }

    // ---- Gym badges (Essentials $Trainer.badges[N]) ----
    // Persisted per user as a JSON array of 0-based badge indices. Gym-leader
    // events award them (EventRuntime honours `$Trainer.badges[N]=true`) and
    // progression gates read them (`$Trainer.numbadges>=N`).
    public async getBadges(userId:number):Promise<number[]> {
        const raw = await this.redis.hGet(await this.activeCharacterKey(userId), "badges");
        return this.parseBadges(raw);
    }

    /** Awards a badge (idempotent). Returns the updated badge list. */
    public async awardBadge(userId:number, index:number):Promise<number[]> {
        if (!Number.isInteger(index) || index < 0 || index > 63) {
            return this.getBadges(userId);
        }
        const badges = await this.getBadges(userId);
        if (!badges.includes(index)) {
            badges.push(index);
            badges.sort((a, b) => a - b);
            await this.redis.hSet(await this.activeCharacterKey(userId), { badges: JSON.stringify(badges) });
        }
        return badges;
    }

    // ---- Visited towns (Volar/Fly destination gating) ----
    // Stored as a JSON array of playable-map ids in the `visited_towns` hash
    // field. Read fresh from Redis on every call (no in-memory cache) so
    // admin/tooling edits to the hash take effect immediately.

    private parseVisitedTowns(value:string | undefined | null):string[] {
        if (typeof value !== "string") {
            return [];
        }
        try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return [...new Set(parsed.filter((entry):entry is string => typeof entry === "string" && entry.length > 0))];
        } catch {
            return [];
        }
    }

    public async getVisitedTowns(userId:number):Promise<string[]> {
        return this.parseVisitedTowns(await this.redis.hGet(await this.activeCharacterKey(userId), "visited_towns"));
    }

    /** Records a town visit; returns true only when the town is new. */
    public async markTownVisited(userId:number, mapId:string):Promise<boolean> {
        if (typeof mapId !== "string" || mapId.length === 0) {
            return false;
        }
        const visited = await this.getVisitedTowns(userId);
        if (visited.includes(mapId)) {
            return false;
        }
        visited.push(mapId);
        await this.redis.hSet(await this.activeCharacterKey(userId), { visited_towns: JSON.stringify(visited) });
        return true;
    }

    // ---- Pokemon Center respawn point (Kernel.pbSetPokemonCenter) ----
    // Where a blacked-out player is returned to; falls back to the initial
    // spawn when no center has been visited yet.
    public async setRespawnPoint(userId:number, point:{ mapId:string; x:number; y:number }) {
        await this.redis.hSet(await this.activeCharacterKey(userId), {
            respawn_point: JSON.stringify(point)
        });
    }

    public async getRespawnPoint(userId:number):Promise<{ mapId:string; x:number; y:number } | null> {
        const raw = await this.redis.hGet(await this.activeCharacterKey(userId), "respawn_point");
        if (!raw) {
            return null;
        }
        try {
            const parsed = JSON.parse(raw);
            if (
                parsed && typeof parsed.mapId === "string" && parsed.mapId.length > 0 &&
                Number.isFinite(parsed.x) && Number.isFinite(parsed.y)
            ) {
                return { mapId: parsed.mapId, x: Number(parsed.x), y: Number(parsed.y) };
            }
        } catch {
            // Treat unreadable respawn data as unset.
        }
        return null;
    }

    // ---- Friends & social ----
    // Friends are stored as a JSON array of user ids in the `friends` hash
    // field; pending requests live on both sides (`friend_requests_in` on the
    // receiver, `friend_requests_out` on the sender) so they survive logouts
    // and both users can see them. Mutual approval turns a request into a
    // symmetric friends-pair entry.

    /**
     * Reads the small public fields used by friends lists and chat: the
     * account identity plus the ACTIVE character's display identity. Only
     * public-safe fields — never email, credentials, or moderation data.
     */
    public async getSocialUserSummary(userId:number):Promise<SocialUserSummary | null> {
        const [id, username] = await this.redis.hmGet(
            this.userKey(userId),
            ["id", "username"]
        );
        if (!id) {
            return null;
        }
        const accountId = Number(id);
        const accountName = username ?? "";
        const characterId = await this.getActiveCharacterId(accountId);
        const [characterName, characterSkinId] = await this.redis.hmGet(
            this.characterKey(characterId),
            ["name", "character_skin_id"]
        );
        return {
            userId: accountId,
            username: accountName,
            name: characterName ?? accountName,
            characterSkinId: characterSkinId ?? "",
            accountId,
            accountName,
            characterId,
            characterName: characterName ?? accountName
        };
    }

    /**
     * Epoch ms of account creation, or 0 when unknown. Used by trading to flag
     * (never block) brand-new accounts on the confirmation screen.
     */
    public async getAccountCreatedAtMs(userId:number):Promise<number> {
        const raw = await this.redis.hGet(this.userKey(userId), "created_at");
        if (typeof raw !== "string" || raw.length === 0) {
            return 0;
        }
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    public async findSocialUserByUsername(username:string):Promise<SocialUserSummary | null> {
        const normalized = String(username ?? "").trim().toLowerCase();
        if (!normalized) {
            return null;
        }
        const userId = await this.redis.get(this.usernameIndexKey(normalized));
        if (!userId) {
            return null;
        }
        return this.getSocialUserSummary(Number(userId));
    }

    public async getFriendIds(userId:number):Promise<number[]> {
        const raw = await this.redis.hGet(this.userKey(userId), "friends");
        return this.parseUserIdArray(raw);
    }

    public async areFriends(userIdA:number, userIdB:number):Promise<boolean> {
        const friends = await this.getFriendIds(userIdA);
        return friends.includes(userIdB);
    }

    /** Makes both users friends of each other (idempotent). */
    public async addFriendPair(userIdA:number, userIdB:number) {
        await Promise.all([
            this.addToFriendList(userIdA, userIdB),
            this.addToFriendList(userIdB, userIdA)
        ]);
    }

    public async removeFriendPair(userIdA:number, userIdB:number) {
        await Promise.all([
            this.removeFromFriendList(userIdA, userIdB),
            this.removeFromFriendList(userIdB, userIdA)
        ]);
    }

    public async getIncomingFriendRequests(userId:number):Promise<FriendRequestRecord[]> {
        return this.readFriendRequests(userId, "friend_requests_in");
    }

    public async getOutgoingFriendRequests(userId:number):Promise<FriendRequestRecord[]> {
        return this.readFriendRequests(userId, "friend_requests_out");
    }

    /**
     * Records a pending request on both sides. The request is account-to-
     * account; the character ids are contextual only (which characters were
     * in use when it was sent). Returns false when an identical request is
     * already pending (dedupe by sender account id) or when it would target
     * the sender's own account.
     */
    public async addFriendRequest(from:SocialUserSummary, to:SocialUserSummary):Promise<boolean> {
        if (from.userId === to.userId) {
            return false;
        }
        const createdAt = new Date().toISOString();
        const incoming = await this.getIncomingFriendRequests(to.userId);
        if (incoming.some((request) => request.userId === from.userId)) {
            return false;
        }
        const context = {
            requesterCharacterId: from.characterId,
            recipientCharacterId: to.characterId
        };
        const outgoing = await this.getOutgoingFriendRequests(from.userId);
        incoming.push({ ...from, ...context, createdAt });
        outgoing.push({ ...to, ...context, createdAt });
        await Promise.all([
            this.writeFriendRequests(to.userId, "friend_requests_in", incoming),
            this.writeFriendRequests(from.userId, "friend_requests_out", outgoing)
        ]);
        return true;
    }

    /** Clears a pending request (accept/decline/cancel) from both sides. */
    public async removeFriendRequest(fromUserId:number, toUserId:number) {
        const [incoming, outgoing] = await Promise.all([
            this.getIncomingFriendRequests(toUserId),
            this.getOutgoingFriendRequests(fromUserId)
        ]);
        await Promise.all([
            this.writeFriendRequests(
                toUserId,
                "friend_requests_in",
                incoming.filter((request) => request.userId !== fromUserId)
            ),
            this.writeFriendRequests(
                fromUserId,
                "friend_requests_out",
                outgoing.filter((request) => request.userId !== toUserId)
            )
        ]);
    }

    public async getSocialPrefs(userId:number):Promise<SocialPrefs> {
        const raw = await this.redis.hGet(this.userKey(userId), "social_prefs");
        if (!raw) {
            return { ...DEFAULT_SOCIAL_PREFS };
        }
        try {
            const parsed = JSON.parse(raw);
            return {
                allowFriendRequests: parsed?.allowFriendRequests !== false,
                allowTeleportRequests: parsed?.allowTeleportRequests !== false,
                allowChatInvites: parsed?.allowChatInvites !== false,
                showOnlineStatus: parsed?.showOnlineStatus !== false,
                showActiveCharacter: parsed?.showActiveCharacter !== false,
                showCurrentMap: parsed?.showCurrentMap !== false,
                showLastSeen: parsed?.showLastSeen !== false
            };
        } catch {
            return { ...DEFAULT_SOCIAL_PREFS };
        }
    }

    public async setSocialPrefs(userId:number, updates:Partial<SocialPrefs>):Promise<SocialPrefs> {
        const current = await this.getSocialPrefs(userId);
        const pick = (value:boolean | undefined, fallback:boolean) =>
            typeof value === "boolean" ? value : fallback;
        const next:SocialPrefs = {
            allowFriendRequests: pick(updates.allowFriendRequests, current.allowFriendRequests),
            allowTeleportRequests: pick(updates.allowTeleportRequests, current.allowTeleportRequests),
            allowChatInvites: pick(updates.allowChatInvites, current.allowChatInvites),
            showOnlineStatus: pick(updates.showOnlineStatus, current.showOnlineStatus),
            showActiveCharacter: pick(updates.showActiveCharacter, current.showActiveCharacter),
            showCurrentMap: pick(updates.showCurrentMap, current.showCurrentMap),
            showLastSeen: pick(updates.showLastSeen, current.showLastSeen)
        };
        await this.redis.hSet(this.userKey(userId), { social_prefs: JSON.stringify(next) });
        return next;
    }

    private async addToFriendList(userId:number, friendUserId:number) {
        const friends = await this.getFriendIds(userId);
        if (!friends.includes(friendUserId)) {
            friends.push(friendUserId);
            await this.redis.hSet(this.userKey(userId), { friends: JSON.stringify(friends) });
        }
    }

    private async removeFromFriendList(userId:number, friendUserId:number) {
        const friends = await this.getFriendIds(userId);
        const next = friends.filter((id) => id !== friendUserId);
        if (next.length !== friends.length) {
            await this.redis.hSet(this.userKey(userId), { friends: JSON.stringify(next) });
        }
    }

    private async readFriendRequests(
        userId:number,
        field:"friend_requests_in" | "friend_requests_out"
    ):Promise<FriendRequestRecord[]> {
        const raw = await this.redis.hGet(this.userKey(userId), field);
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed
                .filter((entry) => entry && Number.isFinite(Number(entry.userId)))
                .map((entry) => {
                    const accountId = Number(entry.userId);
                    const accountName = String(entry.username ?? "");
                    const characterName = String(entry.characterName ?? entry.name ?? accountName);
                    return {
                        userId: accountId,
                        username: accountName,
                        name: String(entry.name ?? accountName),
                        characterSkinId: String(entry.characterSkinId ?? ""),
                        accountId,
                        accountName,
                        characterId: Number.isFinite(Number(entry.characterId))
                            ? Number(entry.characterId)
                            : accountId,
                        characterName,
                        requesterCharacterId: Number.isFinite(Number(entry.requesterCharacterId))
                            ? Number(entry.requesterCharacterId)
                            : undefined,
                        recipientCharacterId: Number.isFinite(Number(entry.recipientCharacterId))
                            ? Number(entry.recipientCharacterId)
                            : undefined,
                        createdAt: String(entry.createdAt ?? "")
                    };
                });
        } catch {
            return [];
        }
    }

    private async writeFriendRequests(
        userId:number,
        field:"friend_requests_in" | "friend_requests_out",
        requests:FriendRequestRecord[]
    ) {
        // Cap the pending list so a spammed account's hash cannot grow unbounded.
        await this.redis.hSet(this.userKey(userId), {
            [field]: JSON.stringify(requests.slice(-50))
        });
    }

    private parseUserIdArray(raw:string | null | undefined):number[] {
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed
                .map((value) => Number(value))
                .filter((value) => Number.isInteger(value) && value > 0);
        } catch {
            return [];
        }
    }

    private async readPokemonProfileById(pokemonId:string) {
        const raw = await this.redis.get("designer:section:pokemons");
        if (!raw) {
            return null;
        }
        try {
            const parsed = JSON.parse(raw);
            const items = parsed?.state?.items;
            if (!Array.isArray(items)) {
                return null;
            }
            const item = items.find((candidate:{ id?:unknown }) => candidate?.id === pokemonId);
            if (!item || typeof item !== "object") {
                return null;
            }
            return {
                id: String((item as { id:string }).id),
                name: String((item as { name?:string }).name ?? pokemonId),
                profile: ((item as { pokemonProfile?:Record<string, unknown> }).pokemonProfile ?? {})
            };
        } catch {
            return null;
        }
    }

    /**
     * Gives a Pokemon of the given Essentials species internal name (e.g.
     * "BULBASAUR") at a level, mirroring chooseStarter's stat rules. Used by the
     * event runtime for `pbAddPokemon`. Species ids follow `pokemon-<NAME>`.
     */
    /**
     * Rolls a fresh {@link PokemonSummary} for a species at a given level
     * (IVs, HP, level-appropriate moves). Shared by the plain gift path and the
     * egg generator so a hatched egg is identical to a normally received mon.
     * Returns the species' `hatchSteps` metadata alongside for egg creation.
     */
    private async buildSpeciesSummary(
        internalName:string,
        level:number
    ):Promise<{ summary:PokemonSummary; hatchSteps:number } | null> {
        const pokemonId = `pokemon-${String(internalName).toUpperCase()}`;
        const resolved = await this.readPokemonProfileById(pokemonId);
        if (!resolved) {
            return null;
        }

        const profile = resolved.profile as {
            hp?:unknown;
            elements?:unknown;
            hatchSteps?:unknown;
            skills?:Array<{ skillName?:unknown; level?:unknown }>;
        };
        const lvl = Math.max(1, Math.min(100, Math.round(level)));
        const levelingCurveConfig = await readLevelingCurveConfigFromRedis(this.redis);
        const rollIv = () => Math.floor(Math.random() * 32);
        const ivs = {
            hp: rollIv(), attack: rollIv(), defense: rollIv(),
            specialAttack: rollIv(), specialDefense: rollIv(), speed: rollIv()
        };
        const baseHp = Math.max(1, Math.round(Number(profile.hp) || 1));
        const hpStat = Math.max(1, Math.floor(((2 * baseHp + ivs.hp) * lvl) / 100) + lvl + 10);
        const elements = Array.isArray(profile.elements)
            ? profile.elements.filter((element):element is string => typeof element === "string")
            : [];
        const moves = (Array.isArray(profile.skills) ? profile.skills : [])
            .filter((skill) =>
                typeof skill?.level === "number" &&
                skill.level <= lvl &&
                typeof skill?.skillName === "string" &&
                skill.skillName.length > 0)
            .sort((left, right) => (left.level as number) - (right.level as number))
            .map((skill) => skill.skillName as string)
            .slice(-4);

        const summary:PokemonSummary = {
            id: crypto.randomUUID(),
            sourcePokemonId: resolved.id,
            name: resolved.name,
            level: lvl,
            types: elements,
            hp: hpStat,
            maxHp: hpStat,
            ivs,
            moves,
            movePp: {},
            experience: 0,
            experienceCurve: "medium",
            nextLevelExperience: getExperienceForNextLevel(lvl, levelingCurveConfig),
            statBonuses: createEmptyPokemonStatBonuses()
        };

        const rawHatchSteps = Number(profile.hatchSteps);
        const hatchSteps = Number.isFinite(rawHatchSteps) && rawHatchSteps > 0
            ? Math.min(MAX_EGG_HATCH_STEPS, Math.max(MIN_EGG_HATCH_STEPS, Math.round(rawHatchSteps)))
            : DEFAULT_EGG_HATCH_STEPS;

        return { summary, hatchSteps };
    }

    public async givePokemonBySpecies(
        userId:number,
        internalName:string,
        level:number,
        options:{ boxWhenFull?:boolean } = {}
    ):Promise<{ ok:true; pokemonName:string; boxed:boolean } | { ok:false; message:string; partyFull?:boolean }> {
        const built = await this.buildSpeciesSummary(internalName, level);
        if (!built) {
            return { ok: false, message: `Unknown species ${internalName}.` };
        }
        const summary = built.summary;
        const resolved = { id: summary.sourcePokemonId!, name: summary.name };

        const user = await this.getUserById(String(userId));
        if (!user) {
            return { ok: false, message: "Account not found." };
        }

        const party = Array.isArray(user.pokemonParty) ? [...user.pokemonParty] : [];
        if (party.length < MAX_POKEMON_PARTY_SIZE) {
            party.push(summary);
            await this.redis.hSet(await this.activeCharacterKey(userId), {
                pokemon_party: JSON.stringify(party)
            });
            this.markPartyChanged(userId);
            return { ok: true, pokemonName: resolved.name, boxed: false };
        }

        // Party full. Gift events (pbAddPokemon authored as a conditional
        // branch) want the player to make room and come back, so the caller
        // can opt out of the box fallback and be told the party is full.
        if (options.boxWhenFull === false) {
            return { ok: false, message: "Party is full.", partyFull: true };
        }

        // Otherwise send to PC storage so nothing is lost.
        const stored = await this.addPokemonToStorage(userId, summary);
        if (!stored.ok) {
            return { ok: false, message: stored.message, partyFull: true };
        }
        return { ok: true, pokemonName: resolved.name, boxed: true };
    }

    /** Display name of a species by Essentials internal name (Venova rename-aware). */
    public async getSpeciesDisplayName(internalName:string):Promise<string | null> {
        const resolved = await this.readPokemonProfileById(`pokemon-${String(internalName).toUpperCase()}`);
        return resolved?.name ?? null;
    }

    /**
     * In-game NPC trade (pbStartTrade): swaps the party member at partyIndex
     * for a freshly generated venomon of the given species at the SAME level,
     * carrying the NPC trainer's nickname and OT — like trading with an NPC in
     * the original games. The traded venomon leaves the game.
     */
    public async tradePartyPokemon(
        userId:number,
        partyIndex:number,
        internalName:string,
        nickname:string | null,
        otName:string | null
    ):Promise<{ ok:true; receivedName:string; tradedName:string } | { ok:false }> {
        const user = await this.getUserById(String(userId));
        const party = Array.isArray(user?.pokemonParty) ? [...user.pokemonParty] : [];
        const outgoing = party[partyIndex];
        if (!outgoing || outgoing.isEgg) {
            return { ok: false };
        }

        const built = await this.buildSpeciesSummary(internalName, outgoing.level);
        if (!built) {
            return { ok: false };
        }
        const incoming:PokemonSummary = {
            ...built.summary,
            foreignOt: otName?.trim() || "?"
        };
        if (nickname && nickname.trim()) {
            incoming.name = nickname.trim();
            incoming.nickname = nickname.trim();
        }

        party[partyIndex] = incoming;
        await this.redis.hSet(await this.activeCharacterKey(userId), {
            pokemon_party: JSON.stringify(this.sanitizePokemonPartyForStorage(party))
        });
        this.markPartyChanged(userId);
        return {
            ok: true,
            receivedName: incoming.name,
            tradedName: outgoing.nickname || outgoing.name
        };
    }

    /**
     * Renames a party member (the name rater). `name` null resets the
     * venomon back to its species name.
     */
    public async renamePartyPokemon(
        userId:number,
        partyIndex:number,
        name:string | null
    ):Promise<string | null> {
        const user = await this.getUserById(String(userId));
        const party = Array.isArray(user?.pokemonParty) ? [...user.pokemonParty] : [];
        const pokemon = party[partyIndex];
        if (!pokemon || pokemon.isEgg) {
            return null;
        }

        let applied:string;
        if (name && name.trim()) {
            applied = name.trim().slice(0, 20);
            party[partyIndex] = { ...pokemon, name: applied, nickname: applied };
        } else {
            const speciesInternal = (pokemon.sourcePokemonId ?? "").replace(/^pokemon-/i, "");
            const speciesName = speciesInternal
                ? await this.getSpeciesDisplayName(speciesInternal)
                : null;
            if (!speciesName) {
                return null;
            }
            applied = speciesName;
            const reset = { ...pokemon, name: speciesName };
            delete reset.nickname;
            party[partyIndex] = reset;
        }

        await this.redis.hSet(await this.activeCharacterKey(userId), {
            pokemon_party: JSON.stringify(this.sanitizePokemonPartyForStorage(party))
        });
        this.markPartyChanged(userId);
        return applied;
    }

    /**
     * Gives the player an egg for a species. Egg-giving events (the "REGALA
     * HUEVO" NPC's `pbGenerateEgg`, and any future egg item) require a free
     * PARTY slot — an egg can only be carried in the team, never boxed by the
     * giver — so when the party is full we refuse with `partyFull` so the
     * event is not consumed and the player is told to make room and return.
     */
    public async giveEggBySpecies(
        userId:number,
        internalName:string
    ):Promise<{ ok:true; speciesName:string } | { ok:false; message:string; partyFull?:boolean }> {
        const built = await this.buildSpeciesSummary(internalName, 1);
        if (!built) {
            return { ok: false, message: `Unknown species ${internalName}.` };
        }

        const user = await this.getUserById(String(userId));
        if (!user) {
            return { ok: false, message: "Account not found." };
        }

        const party = Array.isArray(user.pokemonParty) ? [...user.pokemonParty] : [];
        if (party.length >= MAX_POKEMON_PARTY_SIZE) {
            return { ok: false, message: "Party is full.", partyFull: true };
        }

        const egg:PokemonSummary = {
            ...built.summary,
            level: 1,
            isEgg: true,
            eggStepsToHatch: built.hatchSteps
        };
        party.push(egg);
        await this.redis.hSet(await this.activeCharacterKey(userId), {
            pokemon_party: JSON.stringify(this.sanitizePokemonPartyForStorage(party))
        });
        this.eggPresenceByUserId.set(userId, true);
        return { ok: true, speciesName: built.summary.name };
    }

    /**
     * Advances every egg in the player's party by one walked tile. Returns any
     * eggs that hatched this step so the caller can notify the player and push
     * the refreshed party. Uses an in-memory presence hint to skip a Redis read
     * for players who carry no egg (the common case). Called once per new tile
     * from the movement step handler.
     */
    public async tickEggSteps(
        userId:number
    ):Promise<{ user:AuthenticatedUser | null; hatched:Array<{ name:string }> }> {
        if (this.eggPresenceByUserId.get(userId) === false) {
            return { user: null, hatched: [] };
        }

        const user = await this.getUserById(String(userId));
        const party = Array.isArray(user?.pokemonParty) ? [...(user!.pokemonParty)] : [];
        const eggIndexes = party
            .map((pokemon, index) => (pokemon.isEgg ? index : -1))
            .filter((index) => index >= 0);

        if (eggIndexes.length === 0) {
            this.eggPresenceByUserId.set(userId, false);
            return { user: null, hatched: [] };
        }

        const hatched:Array<{ name:string }> = [];
        let stillHasEgg = false;
        for (const index of eggIndexes) {
            const egg = party[index];
            const remaining = Math.max(0, (Number(egg.eggStepsToHatch) || 0) - 1);
            if (remaining <= 0) {
                // Hatch in place: the egg was a fully-rolled level-1 Pokemon all
                // along, so we just reveal it.
                party[index] = { ...egg, isEgg: undefined, eggStepsToHatch: undefined };
                hatched.push({ name: egg.name });
            } else {
                party[index] = { ...egg, eggStepsToHatch: remaining };
                stillHasEgg = true;
            }
        }

        await this.redis.hSet(await this.activeCharacterKey(userId), {
            pokemon_party: JSON.stringify(this.sanitizePokemonPartyForStorage(party))
        });
        this.eggPresenceByUserId.set(userId, stillHasEgg);

        // Only re-read the authoritative user (for the client push) when
        // something actually hatched; a plain decrement needs no UI refresh.
        return {
            user: hatched.length > 0 ? await this.getUserById(String(userId)) : null,
            hatched
        };
    }

    /**
     * Invalidates the cached egg-presence hint for a user after any write that
     * could change which Pokemon (if any) is an egg in their party.
     */
    private markPartyChanged(userId:number) {
        this.eggPresenceByUserId.delete(userId);
    }

    private async sendPostRegistrationEmails(user:AuthenticatedUser) {
        const results = await Promise.allSettled([
            this.mailService.sendWelcomeEmail(user),
            this.sendEmailValidationRequest(user)
        ]);

        results.forEach((result) => {
            if (result.status === "rejected") {
                console.error("Post-registration email failed:", result.reason);
            }
        });
    }

    private async sendEmailValidationRequest(user:AuthenticatedUser) {
        const token = await this.createOneTimeToken(
            this.emailValidationTokenPrefix(),
            user.id,
            this.emailValidationTtlSeconds
        );

        await this.mailService.sendEmailValidationRequest(user, token);
    }

    private validateRegistration(name:string, username:string, email:string, password:string) {
        if (!name || name.length < 2 || name.length > 30) {
            return "Name must be between 2 and 30 characters.";
        }

        if (!/^[A-Za-z]+$/.test(name)) {
            return "Name may contain letters only.";
        }

        if (!username || username.length < 4 || username.length > 30) {
            return "Username must be between 4 and 30 characters.";
        }

        if (!/^[A-Za-z0-9]+$/.test(username)) {
            return "Username may contain letters and numbers only.";
        }

        if (!this.isValidEmail(email)) {
            return "A valid email address is required.";
        }

        return this.validatePassword(password);
    }

    private validatePassword(password:string) {
        if (password.length < 8 || password.length > 150) {
            return "Password must be between 8 and 150 characters long.";
        }

        if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^a-zA-Z0-9]/.test(password)) {
            return "Password must include upper, lower, number, and symbol characters.";
        }

        return null;
    }

    private isValidEmail(email:string) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    private async ensureRoleDefinitions() {
        const roles = await this.readRoleDefinitions();
        await this.redis.set(this.roleDefinitionsKey(), JSON.stringify(roles));
        this.roleDefinitionsCache = null;
    }

    /**
     * Role definitions are read on nearly every user hydration, so they are
     * memoized briefly. Definitions only change through updateRoleDefinition
     * (which invalidates the cache); the TTL is just a safety net in case the
     * Redis value is edited out-of-band.
     */
    private async readRoleDefinitions() {
        const cached = this.roleDefinitionsCache;
        if (cached && cached.expiresAt > Date.now()) {
            return cached.roles;
        }

        const parsed = this.sanitizeRoleDefinitions(
            await this.redis.get(this.roleDefinitionsKey())
        );

        const roles = USER_ROLE_KEYS.map((roleKey) => (
            parsed.find((role) => role.key === roleKey) ?? DEFAULT_ROLE_DEFINITIONS.find((role) => role.key === roleKey)!
        ));

        this.roleDefinitionsCache = {
            roles,
            expiresAt: Date.now() + 5000
        };

        return roles;
    }

    private sanitizeRoleDefinitions(value:string | null) {
        if (!value) {
            return [...DEFAULT_ROLE_DEFINITIONS];
        }

        try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed)) {
                return [...DEFAULT_ROLE_DEFINITIONS];
            }

            return parsed
                .filter((role): role is RoleDefinition =>
                    role &&
                    typeof role === "object" &&
                    this.isUserRoleKey((role as { key?:unknown }).key) &&
                    typeof (role as { name?:unknown }).name === "string" &&
                    typeof (role as { description?:unknown }).description === "string" &&
                    Array.isArray((role as { permissions?:unknown }).permissions)
                )
                .map((role) => ({
                    key: role.key,
                    name: role.name.trim() || DEFAULT_ROLE_DEFINITIONS.find((defaultRole) => defaultRole.key === role.key)!.name,
                    description: role.description.trim() || DEFAULT_ROLE_DEFINITIONS.find((defaultRole) => defaultRole.key === role.key)!.description,
                    permissions: this.sanitizeRolePermissions(role.permissions)
                }));
        } catch {
            return [...DEFAULT_ROLE_DEFINITIONS];
        }
    }

    private sanitizeRolePermissions(permissions:unknown):RolePermission[] {
        if (!Array.isArray(permissions)) {
            return [];
        }

        const uniquePermissions = new Set<RolePermission>();
        permissions.forEach((permission) => {
            if (this.isRolePermission(permission)) {
                uniquePermissions.add(permission);
            }
        });

        return Array.from(uniquePermissions);
    }

    private resolvePermissionsForRole(role:unknown, roles:RoleDefinition[]) {
        const safeRole = this.isUserRoleKey(role) ? role : "user";
        const matchedRole = roles.find((candidate) => candidate.key === safeRole)
            ?? DEFAULT_ROLE_DEFINITIONS.find((candidate) => candidate.key === safeRole)!;

        return {
            role: matchedRole.key,
            permissions: this.sanitizeRolePermissions(matchedRole.permissions)
        };
    }

    private async createUser(
        name:string,
        username:string,
        email:string,
        password:string
    ):Promise<AuthenticatedUser | null> {
        const normalizedUsername = username.toLowerCase();
        const normalizedEmail = email.toLowerCase();
        const usernameKey = this.usernameIndexKey(normalizedUsername);
        const emailKey = this.emailIndexKey(normalizedEmail);
        const startingMoney = (await this.getGlobalSettings()).startingMoney;

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await this.redis.watch([usernameKey, emailKey]);

            const [existingUsernameId, existingEmailId] = await this.redis.mGet([usernameKey, emailKey]);
            if (existingUsernameId || existingEmailId) {
                await this.redis.unwatch();
                return null;
            }

            const userId = await this.redis.incr(this.userIdSequenceKey());
            // The first character shares the global id sequence with accounts
            // (see the account/character split notes above).
            const characterId = await this.redis.incr(this.userIdSequenceKey());
            const passwordSalt = crypto.randomBytes(16).toString("hex");
            const passwordHash = this.hashPassword(password, passwordSalt);
            const createdAt = new Date().toISOString();
            const userKey = this.userKey(userId);
            const role:UserRoleKey = userId === 1 ? "admin" : "user";

            const transaction = await this.redis.multi()
                .hSet(userKey, {
                    id: String(userId),
                    name,
                    username,
                    email: normalizedEmail,
                    password_hash: passwordHash,
                    password_salt: passwordSalt,
                    email_verified: "0",
                    profile_image: "",
                    description: "",
                    role,
                    created_at: createdAt,
                    characters: JSON.stringify([characterId]),
                    active_character_id: String(characterId)
                })
                .hSet(this.characterKey(characterId), {
                    id: String(characterId),
                    account_id: String(userId),
                    name,
                    trainer_gender: "",
                    character_skin_id: "",
                    trainer_card_color: "",
                    money: String(startingMoney),
                    inventory: JSON.stringify(DEFAULT_INVENTORY),
                    pokemon_party: JSON.stringify(DEFAULT_POKEMON_PARTY),
                    battle_history: JSON.stringify(DEFAULT_BATTLE_HISTORY),
                    badges: "[]",
                    created_at: createdAt,
                    last_played_at: createdAt
                })
                .set(usernameKey, String(userId))
                .set(emailKey, String(userId))
                .exec();

            if (transaction) {
                const characterSummary:CharacterSummary = {
                    characterId,
                    characterName: name,
                    characterSkinId: "",
                    trainerGender: "",
                    badges: [],
                    money: startingMoney,
                    partyCount: 0,
                    lastMapId: null,
                    createdAt,
                    lastPlayedAt: createdAt,
                    deletedAt: null
                };
                return {
                    id: userId,
                    name,
                    username,
                    email: normalizedEmail,
                    emailVerified: false,
                    profileImage: "",
                    description: "",
                    accountId: userId,
                    accountName: username,
                    characterId,
                    characterName: name,
                    characters: [characterSummary],
                    sharedMoneyDeposits: [],
                    inventory: DEFAULT_INVENTORY,
                    pokemonParty: DEFAULT_POKEMON_PARTY,
                    pokemonStorage: this.parsePokemonStorage(undefined),
                    itemStorage: this.parseItemStorage(undefined),
                    pcMoney: 0,
                    trainerGender: "",
                    characterSkinId: "",
                    badges: [],
                    visitedTowns: [],
                    trainerCardColor: "",
                    money: startingMoney,
                    battleHistory: DEFAULT_BATTLE_HISTORY,
                    role,
                    permissions: role === "admin"
                        ? [...ROLE_PERMISSIONS]
                        : ["game.access" as const]
                };
            }
        }

        throw new Error("Unable to create user after multiple Redis transaction retries.");
    }

    private hashPassword(password:string, salt:string) {
        return crypto.scryptSync(password + this.passwordPepper, salt, 64).toString("hex");
    }

    private verifyPassword(password:string, salt:string, storedHash:string) {
        const candidateHash = this.hashPassword(password, salt);
        const storedBuffer = Buffer.from(storedHash, "hex");
        const candidateBuffer = Buffer.from(candidateHash, "hex");

        if (storedBuffer.length !== candidateBuffer.length) {
            return false;
        }

        return crypto.timingSafeEqual(storedBuffer, candidateBuffer);
    }

    private async createSession(user:AuthenticatedUser) {
        const sessionId = crypto.randomUUID();
        const token = jwt.sign(
            { sid: sessionId },
            this.jwtSecret,
            {
                subject: String(user.id),
                expiresIn: this.sessionTtlSeconds
            }
        );

        await this.redis.set(this.sessionKey(sessionId), String(user.id), {
            EX: this.sessionTtlSeconds
        });

        return token;
    }

    private async destroySession(token?:string) {
        const payload = this.decodeSessionToken(token);
        if (!payload) {
            return;
        }

        await this.redis.del(this.sessionKey(payload.sid));
    }

    private async getAuthenticatedUserFromToken(token?:string) {
        const payload = this.decodeSessionToken(token);
        if (!payload) {
            return null;
        }

        const storedUserId = await this.redis.get(this.sessionKey(payload.sid));
        if (!storedUserId || storedUserId !== payload.sub) {
            return null;
        }

        return this.getUserById(payload.sub);
    }

    private decodeSessionToken(token?:string) {
        if (!token) {
            return null;
        }

        try {
            const decoded = jwt.verify(token, this.jwtSecret);

            if (typeof decoded === "string" || !decoded.sid || !decoded.sub) {
                return null;
            }

            return decoded as SessionTokenPayload;
        } catch {
            return null;
        }
    }

    private async getUserByUsername(username:string) {
        const userId = await this.redis.get(this.usernameIndexKey(username.toLowerCase()));
        if (!userId) {
            return null;
        }

        return this.getStoredUserById(userId);
    }

    private async getUserByEmail(email:string) {
        const userId = await this.redis.get(this.emailIndexKey(email.toLowerCase()));
        if (!userId) {
            return null;
        }

        return this.getStoredUserById(userId);
    }

    private async getUserById(userId:string) {
        const user = await this.getStoredUserById(userId);
        return user ? this.toAuthenticatedUser(user) : null;
    }

    /**
     * Lightweight scan over every stored user, reading only the small fields
     * the admin panel filters/sorts/counts on. Full records (with their large
     * inventory/party/battle-history JSON blobs) must be hydrated per-user via
     * getStoredUserById for the rows that are actually displayed — hydrating
     * them for the whole table on every list request stalls the event loop
     * long enough to trip Socket.IO ping timeouts.
     */
    private async getUserSearchRows() {
        const highestUserId = Number.parseInt(await this.redis.get(this.userIdSequenceKey()) ?? "0", 10);
        if (!Number.isFinite(highestUserId) || highestUserId <= 0) {
            return [];
        }

        const chunkSize = 200;
        const rows:UserSearchRow[] = [];

        for (let start = 1; start <= highestUserId; start += chunkSize) {
            const count = Math.min(chunkSize, highestUserId - start + 1);
            const chunk = await Promise.all(
                Array.from({ length: count }, (_, index) => (
                    this.redis.hmGet(this.userKey(start + index), ["id", "name", "username", "email", "role"])
                ))
            );

            for (const [id, name, username, email, role] of chunk) {
                if (!id) {
                    continue;
                }

                rows.push({
                    id: Number(id),
                    name: name ?? "",
                    username: username ?? "",
                    email: email ?? "",
                    role: this.isUserRoleKey(role) ? role : "user"
                });
            }
        }

        return rows;
    }

    private async getStoredUserById(userId:string) {
        let account = await this.redis.hGetAll(this.userKey(userId));
        if (!account.id) {
            return null;
        }
        if (!account.characters) {
            // Lazy migration: first touch of a legacy single-character account
            // splits it into account + default character (same id).
            await this.migrateAccountHash(Number(account.id), account);
            account = await this.redis.hGetAll(this.userKey(userId));
        }

        const accountId = Number(account.id);
        const characterId = await this.getActiveCharacterId(accountId);
        let character = await this.redis.hGetAll(this.characterKey(characterId));
        if (!character.id) {
            // Self-heal a missing active character hash (manual Redis surgery,
            // partial restores): recreate a fresh default character in place.
            const nowIso = new Date().toISOString();
            await this.redis.hSet(this.characterKey(characterId), {
                id: String(characterId),
                account_id: String(accountId),
                name: account.username ?? "Trainer",
                money: String(DEFAULT_MONEY),
                inventory: JSON.stringify(DEFAULT_INVENTORY),
                pokemon_party: JSON.stringify(DEFAULT_POKEMON_PARTY),
                battle_history: JSON.stringify(DEFAULT_BATTLE_HISTORY),
                badges: "[]",
                created_at: nowIso,
                last_played_at: nowIso
            });
            const ids = await this.getCharacterIds(accountId);
            if (!ids.includes(characterId)) {
                ids.push(characterId);
                await this.redis.hSet(this.userKey(accountId), { characters: JSON.stringify(ids) });
            }
            character = await this.redis.hGetAll(this.characterKey(characterId));
        }

        const accountDefaults:Record<string, string> = {};
        if (typeof account.profile_image !== "string") {
            accountDefaults.profile_image = "";
        }
        if (typeof account.description !== "string") {
            accountDefaults.description = "";
        }
        if (!this.isUserRoleKey(account.role)) {
            accountDefaults.role = "user";
        }
        if (Object.keys(accountDefaults).length > 0) {
            await this.redis.hSet(this.userKey(userId), accountDefaults);
        }

        const characterDefaults:Record<string, string> = {};
        if (typeof character.inventory !== "string") {
            characterDefaults.inventory = JSON.stringify(DEFAULT_INVENTORY);
        }
        if (
            typeof character.pokemon_party !== "string" ||
            this.isLegacyDemoPokemonPartyJson(character.pokemon_party)
        ) {
            characterDefaults.pokemon_party = JSON.stringify(DEFAULT_POKEMON_PARTY);
        }
        if (typeof character.trainer_gender !== "string") {
            characterDefaults.trainer_gender = "";
        }
        if (typeof character.character_skin_id !== "string") {
            characterDefaults.character_skin_id = "";
        }
        if (typeof character.badges !== "string") {
            characterDefaults.badges = "[]";
        }
        if (typeof character.trainer_card_color !== "string") {
            characterDefaults.trainer_card_color = "";
        }
        if (typeof character.money !== "string") {
            characterDefaults.money = String(DEFAULT_MONEY);
        }
        if (typeof character.battle_history !== "string") {
            characterDefaults.battle_history = JSON.stringify(DEFAULT_BATTLE_HISTORY);
        }
        if (Object.keys(characterDefaults).length > 0) {
            await this.redis.hSet(this.characterKey(characterId), characterDefaults);
            character = { ...character, ...characterDefaults };
        }

        const roles = await this.readRoleDefinitions();
        const resolvedRole = this.resolvePermissionsForRole(account.role ?? accountDefaults.role, roles);
        const characters = await this.getCharacterSummariesRaw(await this.getCharacterIds(accountId));
        const deposits = this.parseMoneyDeposits(account.pc_money_deposits);
        const characterNameById = new Map(
            characters.map((summary) => [summary.characterId, summary.characterName])
        );
        const characterName = character.name ?? account.username ?? "";

        return {
            id: accountId,
            name: characterName,
            username: account.username,
            email: account.email,
            emailVerified: account.email_verified === "1",
            password_hash: account.password_hash,
            password_salt: account.password_salt,
            profileImage: account.profile_image ?? "",
            description: (account.description ?? "").slice(0, 50),
            accountId,
            accountName: account.username,
            characterId,
            characterName,
            characters,
            sharedMoneyDeposits: deposits.map((deposit) => ({
                accountId,
                ownerCharacterId: deposit.ownerCharacterId,
                ownerCharacterName:
                    characterNameById.get(deposit.ownerCharacterId) ?? `#${deposit.ownerCharacterId}`,
                amount: deposit.amount,
                depositedByCharacterId: deposit.depositedByCharacterId,
                depositedAt: deposit.depositedAt,
                updatedAt: deposit.updatedAt
            })),
            inventory: this.parseInventory(character.inventory),
            pokemonParty: this.parsePokemonParty(character.pokemon_party),
            pokemonStorage: this.parsePokemonStorage(account.pokemon_box),
            itemStorage: this.parseItemStorage(account.item_box),
            pcMoney: deposits
                .filter((deposit) => deposit.ownerCharacterId === characterId)
                .reduce((sum, deposit) => sum + deposit.amount, 0),
            trainerGender: character.trainer_gender ?? "",
            characterSkinId: character.character_skin_id ?? "",
            money: this.parseMoney(character.money),
            badges: this.parseBadges(character.badges),
            visitedTowns: this.parseVisitedTowns(character.visited_towns),
            trainerCardColor: character.trainer_card_color ?? "",
            battleHistory: this.parseBattleHistory(character.battle_history),
            role: resolvedRole.role,
            permissions: resolvedRole.permissions,
            created_at: account.created_at
        } satisfies StoredUser;
    }

    private toAuthenticatedUser(user:StoredUser):AuthenticatedUser {
        return {
            id: user.id,
            name: user.name,
            username: user.username,
            email: user.email,
            emailVerified: user.emailVerified,
            profileImage: user.profileImage,
            description: user.description,
            accountId: user.accountId,
            accountName: user.accountName,
            characterId: user.characterId,
            characterName: user.characterName,
            characters: user.characters,
            sharedMoneyDeposits: user.sharedMoneyDeposits,
            inventory: user.inventory,
            pokemonParty: user.pokemonParty,
            pokemonStorage: user.pokemonStorage,
            itemStorage: user.itemStorage,
            pcMoney: user.pcMoney,
            trainerGender: user.trainerGender,
            characterSkinId: user.characterSkinId,
            money: user.money,
            badges: user.badges,
            visitedTowns: user.visitedTowns,
            trainerCardColor: user.trainerCardColor,
            battleHistory: user.battleHistory,
            role: user.role,
            permissions: user.permissions
        };
    }

    private async toAdminUserSummary(user:StoredUser):Promise<AdminUserSummary> {
        const inventoryQuantity = user.inventory.reduce((sum, item) => sum + item.quantity, 0);

        return {
            id: user.id,
            name: user.name,
            username: user.username,
            email: user.email,
            emailVerified: user.emailVerified,
            role: user.role,
            permissions: user.permissions,
            profileImage: user.profileImage,
            description: user.description,
            trainerGender: user.trainerGender,
            characterSkinId: user.characterSkinId,
            money: user.money,
            pokemonCount: user.pokemonParty.length,
            inventoryItemCount: user.inventory.length,
            inventoryQuantity,
            battleHistoryCount: user.battleHistory.length,
            createdAt: user.created_at,
            savedLocation: await this.getSavedPlayerLocation(user.id)
        };
    }

    private async toAdminUserDetails(user:StoredUser):Promise<AdminUserDetails> {
        const base = this.toAuthenticatedUser(user);
        const [itemIcons, pokemonIcons, savedLocation] = await Promise.all([
            this.readItemIconIndex(),
            this.readPokemonIconIndex(),
            this.getSavedPlayerLocation(user.id)
        ]);

        return {
            ...base,
            inventory: base.inventory.map((item) => {
                const iconSrc = itemIcons.get(item.id);
                return iconSrc ? { ...item, iconSrc } : item;
            }),
            pokemonParty: base.pokemonParty.map((pokemon) => {
                const icons =
                    pokemonIcons.get(pokemon.sourcePokemonId ?? "") ??
                    pokemonIcons.get(pokemon.id);
                return icons
                    ? {
                          ...pokemon,
                          iconImageSrc: icons.iconImageSrc || pokemon.iconImageSrc,
                          frontImageSrc: icons.frontImageSrc || pokemon.frontImageSrc
                      }
                    : pokemon;
            }),
            createdAt: user.created_at,
            savedLocation
        };
    }

    /**
     * Reads a designer catalog section straight from Redis (same source the
     * battle engine reads). Kept dependency-free so Auth can enrich admin
     * payloads without pulling in DesignerSectionStore.
     */
    private async readDesignerSectionItems(sectionKey:string):Promise<Array<Record<string, unknown>>> {
        const raw = await this.redis.get(`designer:section:${sectionKey}`);
        if (!raw) {
            return [];
        }

        try {
            const parsed = JSON.parse(raw);
            const items = parsed?.state?.items;
            return Array.isArray(items) ? items : [];
        } catch {
            return [];
        }
    }

    private async readItemIconIndex():Promise<Map<string, string>> {
        const items = await this.readDesignerSectionItems("items");
        const index = new Map<string, string>();
        for (const item of items) {
            const id = typeof item.id === "string" ? item.id : "";
            const profile = (item.itemProfile ?? {}) as { iconSrc?:unknown };
            if (id && typeof profile.iconSrc === "string" && profile.iconSrc) {
                index.set(id, profile.iconSrc);
            }
        }
        return index;
    }

    private async readPokemonIconIndex():Promise<Map<string, { iconImageSrc:string; frontImageSrc:string }>> {
        const items = await this.readDesignerSectionItems("pokemons");
        const index = new Map<string, { iconImageSrc:string; frontImageSrc:string }>();
        for (const item of items) {
            const id = typeof item.id === "string" ? item.id : "";
            const profile = (item.pokemonProfile ?? {}) as { iconImageSrc?:unknown; frontImageSrc?:unknown };
            if (!id) {
                continue;
            }
            index.set(id, {
                iconImageSrc: typeof profile.iconImageSrc === "string" ? profile.iconImageSrc : "",
                frontImageSrc: typeof profile.frontImageSrc === "string" ? profile.frontImageSrc : ""
            });
        }
        return index;
    }

    private toAdminInventoryCategory(type:string):InventoryItem["category"] {
        switch (type.trim().toLowerCase()) {
            case "berries":
                return "berries";
            case "skill item":
            case "machines":
                return "moves";
            case "quest item":
                return "quest";
            case "usable":
            case "medicine":
            case "battle item":
            case "battle items":
            case "pokeball":
            case "hold items":
                return "usable";
            default:
                return "quest";
        }
    }

    /**
     * Item + Pokemon pickers for the admin panel's "add" controls. Icons are
     * returned as root-relative asset paths; the client resolves them through
     * its asset-storage base URL.
     */
    public async getAdminCatalogSections():Promise<{
        items:AdminItemCatalogEntry[];
        pokemons:AdminPokemonCatalogEntry[];
    }> {
        const [itemRecords, pokemonRecords] = await Promise.all([
            this.readDesignerSectionItems("items"),
            this.readDesignerSectionItems("pokemons")
        ]);

        const items:AdminItemCatalogEntry[] = itemRecords
            .map((record) => {
                const id = typeof record.id === "string" ? record.id : "";
                const profile = (record.itemProfile ?? {}) as {
                    iconSrc?:unknown;
                    description?:unknown;
                    type?:unknown;
                };
                return {
                    id,
                    name: typeof record.name === "string" ? record.name : id,
                    category: this.toAdminInventoryCategory(
                        typeof profile.type === "string" ? profile.type : ""
                    ),
                    description: typeof profile.description === "string" ? profile.description : "",
                    iconSrc: typeof profile.iconSrc === "string" ? profile.iconSrc : ""
                };
            })
            .filter((entry) => entry.id.length > 0)
            .sort((left, right) => left.name.localeCompare(right.name));

        const pokemons:AdminPokemonCatalogEntry[] = pokemonRecords
            .map((record) => {
                const id = typeof record.id === "string" ? record.id : "";
                const profile = (record.pokemonProfile ?? {}) as {
                    elements?:unknown;
                    iconImageSrc?:unknown;
                    hp?:unknown;
                };
                return {
                    id,
                    name: typeof record.name === "string" ? record.name : id,
                    types: Array.isArray(profile.elements)
                        ? profile.elements.filter((element):element is string => typeof element === "string")
                        : [],
                    iconImageSrc: typeof profile.iconImageSrc === "string" ? profile.iconImageSrc : "",
                    hp: typeof profile.hp === "number" && Number.isFinite(profile.hp) ? profile.hp : 0
                };
            })
            .filter((entry) => entry.id.length > 0)
            .sort((left, right) => left.name.localeCompare(right.name));

        return { items, pokemons };
    }

    /**
     * Admin-initiated password reset. Unlike changePassword this does not
     * require the current password; it is gated by admin.access at the socket
     * layer.
     */
    public async setUserPasswordByAdmin(
        userId:number,
        newPassword:string
    ):Promise<AuthInfoResult | AuthErrorResult> {
        const storedUser = await this.getStoredUserById(String(userId));
        if (!storedUser) {
            return { error: "User not found." };
        }

        const passwordValidation = this.validatePassword(
            typeof newPassword === "string" ? newPassword : ""
        );
        if (passwordValidation) {
            return { error: passwordValidation };
        }

        const passwordSalt = crypto.randomBytes(16).toString("hex");
        const passwordHash = this.hashPassword(newPassword, passwordSalt);
        await this.redis.hSet(this.userKey(userId), {
            password_hash: passwordHash,
            password_salt: passwordSalt
        });

        return { message: `Password updated for ${storedUser.username}.` };
    }

    /**
     * Sends the standard password-recovery email to a user chosen by an admin.
     * Returns whether the mail was actually dispatched so the panel can warn
     * when SMTP is disabled.
     */
    public async sendPasswordRecoveryByUserId(
        userId:number
    ):Promise<{ message:string; delivered:boolean } | AuthErrorResult> {
        const storedUser = await this.getStoredUserById(String(userId));
        if (!storedUser) {
            return { error: "User not found." };
        }

        const recoveryToken = await this.createPasswordResetToken(storedUser.id);
        await this.mailService.sendPasswordRecoveryEmail(
            this.toAuthenticatedUser(storedUser),
            recoveryToken
        );

        const delivered = this.mailService.isEnabled();
        return {
            delivered,
            message: delivered
                ? `Password recovery email sent to ${storedUser.email}.`
                : `Recovery link created, but email delivery is disabled on this server.`
        };
    }

    private sanitizeBattleHistoryForStorage(history:BattleHistoryEntry[]) {
        return history
            .filter((entry): entry is BattleHistoryEntry =>
                typeof entry?.id === "string" &&
                typeof entry?.battleId === "string" &&
                (entry?.kind === "wild" || entry?.kind === "trainer") &&
                typeof entry?.opponentName === "string" &&
                typeof entry?.result === "string" &&
                typeof entry?.startedAt === "string" &&
                typeof entry?.endedAt === "string" &&
                Array.isArray(entry?.log)
            )
            .slice(0, MAX_BATTLE_HISTORY_ITEMS)
            .map((entry) => ({
                id: entry.id,
                battleId: entry.battleId,
                kind: entry.kind,
                opponentName: entry.opponentName,
                winnerName: typeof entry.winnerName === "string" ? entry.winnerName : null,
                loserName: typeof entry.loserName === "string" ? entry.loserName : null,
                result: entry.result,
                startedAt: entry.startedAt,
                endedAt: entry.endedAt,
                log: entry.log
                    .filter((line): line is string => typeof line === "string")
                    .slice(-100)
            }));
    }

    private parseBattleHistory(value:string | undefined) {
        if (!value) {
            return DEFAULT_BATTLE_HISTORY;
        }

        try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed)) {
                return DEFAULT_BATTLE_HISTORY;
            }

            return this.sanitizeBattleHistoryForStorage(parsed);
        } catch {
            return DEFAULT_BATTLE_HISTORY;
        }
    }

    private sanitizeInventoryForStorage(inventory:InventoryItem[]) {
        return inventory
            .filter((item): item is InventoryItem =>
                typeof item?.id === "string" &&
                typeof item?.name === "string" &&
                ["usable", "berries", "moves", "quest"].includes(item?.category) &&
                typeof item?.quantity === "number" &&
                Number.isFinite(item.quantity) &&
                typeof item?.description === "string"
            )
            .map((item) => ({
                ...item,
                quantity: Math.max(0, Math.round(item.quantity))
            }));
    }

    private parseInventory(value:string | undefined) {
        if (!value) {
            return DEFAULT_INVENTORY;
        }

        try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed)) {
                return DEFAULT_INVENTORY;
            }

            return this.sanitizeInventoryForStorage(parsed);
        } catch {
            return DEFAULT_INVENTORY;
        }
    }

    private sanitizePokemonPartyForStorage(party:PokemonSummary[]) {
        return this.sanitizePokemonListForStorage(party, MAX_POKEMON_PARTY_SIZE);
    }

    private sanitizePokemonListForStorage(list:PokemonSummary[], maxLength:number) {
        return list
            .filter((pokemon): pokemon is PokemonSummary =>
                typeof pokemon?.id === "string" &&
                typeof pokemon?.name === "string" &&
                typeof pokemon?.level === "number" &&
                Number.isFinite(pokemon.level) &&
                Array.isArray(pokemon?.types) &&
                typeof pokemon?.hp === "number" &&
                Number.isFinite(pokemon.hp) &&
                typeof pokemon?.maxHp === "number" &&
                Number.isFinite(pokemon.maxHp) &&
                Array.isArray(pokemon?.moves)
            )
            .slice(0, maxLength)
            .map((pokemon) => {
                const moves = pokemon.moves
                    .filter((move): move is string => typeof move === "string")
                    .slice(0, 4);
                const movePp =
                    pokemon.movePp && typeof pokemon.movePp === "object"
                        ? moves.reduce<Record<string, number>>((accumulator, move) => {
                            const currentPp = pokemon.movePp?.[move];
                            if (typeof currentPp === "number" && Number.isFinite(currentPp)) {
                                accumulator[move] = Math.max(0, Math.round(currentPp));
                            }
                            return accumulator;
                        }, {})
                        : {};

                return {
                    ...pokemon,
                    sourcePokemonId:
                        typeof pokemon.sourcePokemonId === "string" ? pokemon.sourcePokemonId : undefined,
                    nickname:
                        typeof pokemon.nickname === "string" && this.validatePokemonNickname(this.normalizePokemonNickname(pokemon.nickname)) === null
                            ? this.normalizePokemonNickname(pokemon.nickname)
                            : undefined,
                    level: Math.max(1, Math.round(pokemon.level)),
                    hp: Math.max(0, Math.round(pokemon.hp)),
                    maxHp: Math.max(1, Math.round(pokemon.maxHp)),
                    types: pokemon.types.filter((type): type is string => typeof type === "string"),
                    moves,
                    movePp,
                    experience:
                        typeof pokemon.experience === "number" && Number.isFinite(pokemon.experience)
                            ? Math.max(0, Math.round(pokemon.experience))
                            : 0,
                    experienceCurve:
                        pokemon.experienceCurve === "fast" ||
                        pokemon.experienceCurve === "medium" ||
                        pokemon.experienceCurve === "slow"
                            ? pokemon.experienceCurve
                            : "medium",
                    nextLevelExperience:
                        typeof pokemon.nextLevelExperience === "number" &&
                        Number.isFinite(pokemon.nextLevelExperience)
                            ? Math.max(0, Math.round(pokemon.nextLevelExperience))
                            : 100,
                    statBonuses: sanitizePokemonStatBonuses(pokemon.statBonuses),
                    // Preserve egg state. A non-egg drops both fields so stale
                    // egg data can never linger on a hatched Pokemon.
                    isEgg: pokemon.isEgg === true ? true : undefined,
                    eggStepsToHatch:
                        pokemon.isEgg === true &&
                        typeof pokemon.eggStepsToHatch === "number" &&
                        Number.isFinite(pokemon.eggStepsToHatch)
                            ? Math.max(0, Math.round(pokemon.eggStepsToHatch))
                            : undefined
                };
            });
    }

    private parsePokemonParty(value:string | undefined) {
        if (!value) {
            return DEFAULT_POKEMON_PARTY;
        }

        try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed)) {
                return DEFAULT_POKEMON_PARTY;
            }

            if (this.isLegacyDemoPokemonParty(parsed)) {
                return DEFAULT_POKEMON_PARTY;
            }

            return this.sanitizePokemonPartyForStorage(parsed);
        } catch {
            return DEFAULT_POKEMON_PARTY;
        }
    }

    /** Validates the cosmetic per-box style fields (hex colors, safe image ref). */
    private sanitizeBoxStyle(raw:{ bgColor?:unknown; bgImage?:unknown; borderColor?:unknown }):StorageBoxStyle {
        const color = (value:unknown) =>
            typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : undefined;
        const image = (value:unknown) => {
            if (typeof value !== "string") return undefined;
            const trimmed = value.trim();
            if (trimmed.length === 0 || trimmed.length > 500) return undefined;
            // Keep it usable inside a CSS url() and block script/data URIs.
            if (/["'<>]/.test(trimmed) || /^(javascript|data):/i.test(trimmed)) return undefined;
            return trimmed;
        };
        const style:StorageBoxStyle = {};
        const bgColor = color(raw.bgColor);
        const bgImage = image(raw.bgImage);
        const borderColor = color(raw.borderColor);
        if (bgColor) style.bgColor = bgColor;
        if (bgImage) style.bgImage = bgImage;
        if (borderColor) style.borderColor = borderColor;
        return style;
    }

    private parseItemStorage(value:string | undefined):ItemStorageBox[] {
        let rawBoxes:Array<Record<string, unknown>> = [];

        if (value) {
            try {
                const parsed = JSON.parse(value);
                if (parsed && Array.isArray(parsed.boxes)) {
                    rawBoxes = parsed.boxes.filter(
                        (box:unknown):box is Record<string, unknown> => Boolean(box) && typeof box === "object"
                    );
                }
            } catch {
                rawBoxes = [];
            }
        }

        const boxes = rawBoxes.slice(0, MAX_STORAGE_BOXES).map((box, index) => ({
            id: `box-${index + 1}`,
            name:
                typeof box.name === "string" && box.name.trim().length > 0
                    ? box.name.trim().slice(0, 20)
                    : `Box ${index + 1}`,
            capacity: ITEM_BOX_CAPACITY,
            ...this.sanitizeBoxStyle(box),
            items: this.mergeItemStacks(Array.isArray(box.items) ? (box.items as InventoryItem[]) : []).slice(0, ITEM_BOX_CAPACITY)
        } satisfies ItemStorageBox));

        if (boxes.length === 0) {
            boxes.push({ id: "box-1", name: "Box 1", capacity: ITEM_BOX_CAPACITY, items: [] });
        }

        return boxes;
    }

    /**
     * Parses the `pokemon_box` hash field into storage boxes. Understands both
     * the current `{ boxes: [{ name, style, pokemon }] }` shape and the legacy
     * flat `PokemonSummary[]` overflow array (migrated by chunking into boxes).
     * Always returns at least one (possibly empty) box; capped at
     * MAX_STORAGE_BOXES.
     */
    private parsePokemonStorage(value:string | undefined):PokemonStorageBox[] {
        let rawBoxes:Array<Record<string, unknown>> = [];

        if (value) {
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) {
                    // Legacy flat overflow list: chunk into capacity-sized boxes.
                    const sanitized = this.sanitizePokemonListForStorage(parsed, Number.MAX_SAFE_INTEGER);
                    for (let start = 0; start < sanitized.length; start += POKEMON_BOX_CAPACITY) {
                        rawBoxes.push({ pokemon: sanitized.slice(start, start + POKEMON_BOX_CAPACITY) });
                    }
                } else if (parsed && Array.isArray(parsed.boxes)) {
                    rawBoxes = parsed.boxes.filter(
                        (box:unknown):box is Record<string, unknown> => Boolean(box) && typeof box === "object"
                    );
                }
            } catch {
                rawBoxes = [];
            }
        }

        const boxes = rawBoxes.slice(0, MAX_STORAGE_BOXES).map((box, index) => ({
            id: `box-${index + 1}`,
            name:
                typeof box.name === "string" && box.name.trim().length > 0
                    ? box.name.trim().slice(0, 20)
                    : `Box ${index + 1}`,
            capacity: POKEMON_BOX_CAPACITY,
            ...this.sanitizeBoxStyle(box),
            pokemon: this.sanitizePokemonListForStorage(
                Array.isArray(box.pokemon) ? box.pokemon : [],
                POKEMON_BOX_CAPACITY
            )
        } satisfies PokemonStorageBox));

        if (boxes.length === 0) {
            boxes.push({ id: "box-1", name: "Box 1", capacity: POKEMON_BOX_CAPACITY, pokemon: [] });
        }

        return boxes;
    }

    private serializePokemonStorage(boxes:PokemonStorageBox[]) {
        return JSON.stringify({
            boxes: boxes.slice(0, MAX_STORAGE_BOXES).map((box) => ({
                name: box.name,
                ...this.sanitizeBoxStyle(box),
                pokemon: this.sanitizePokemonListForStorage(box.pokemon, POKEMON_BOX_CAPACITY)
            }))
        });
    }

    // ---- shared-storage ownership & the cross-character medal gate --------
    // The ACCOUNT owns the box containers; every stored asset keeps an owning
    // character. A character always accesses its own assets; assets owned by
    // a sibling character require CROSS_CHARACTER_STORAGE_MIN_MEDALS gym
    // medals on the active character. Non-transferable data (badges, event
    // progression, achievements) has no deposit path by construction — the
    // box APIs only accept party venomons, bag items, and wallet money.

    public async getStorageAccessContext(accountId:number) {
        const [characterId, settings] = await Promise.all([
            this.getActiveCharacterId(accountId),
            this.getGlobalSettings()
        ]);
        const badges = this.parseBadges(await this.redis.hGet(this.characterKey(characterId), "badges"));
        return {
            characterId,
            medalCount: badges.length,
            minMedals: settings.crossCharacterStorageMinMedals,
            canAccessOthersAssets: badges.length >= settings.crossCharacterStorageMinMedals
        };
    }

    /**
     * Owner of a shared-box asset. The migration stamps every legacy asset
     * and deposits stamp everything new, so an unstamped asset only exists
     * after raw/admin writes — treat it as owned by the acting character
     * (it gets a real stamp the next time it is deposited).
     */
    private assetOwnerId(asset:{ ownerCharacterId?:number }, fallbackCharacterId:number):number {
        return Number.isInteger(asset.ownerCharacterId) && (asset.ownerCharacterId as number) > 0
            ? (asset.ownerCharacterId as number)
            : fallbackCharacterId;
    }

    private stampAssetOwnership<T extends { ownerCharacterId?:number; storedByCharacterId?:number; storedAt?:string }>(
        asset:T,
        characterId:number
    ):T {
        asset.ownerCharacterId = characterId;
        asset.storedByCharacterId = characterId;
        asset.storedAt = new Date().toISOString();
        return asset;
    }

    /** Withdrawal transfers ownership to the holder: the stamp comes off. */
    private stripAssetOwnership<T extends { ownerCharacterId?:number; storedByCharacterId?:number; storedAt?:string }>(
        asset:T
    ):T {
        delete asset.ownerCharacterId;
        delete asset.storedByCharacterId;
        delete asset.storedAt;
        return asset;
    }

    private crossCharacterDeniedMessage(minMedals:number = CROSS_CHARACTER_STORAGE_MIN_MEDALS) {
        return `You need ${minMedals} gym medal${minMedals === 1 ? "" : "s"} to use assets stored by your other characters.`;
    }

    public async getPokemonStorage(userId:number):Promise<PokemonStorageBox[]> {
        await this.ensureAccountMigrated(userId);
        const raw = await this.redis.hGet(this.userKey(userId), "pokemon_box");
        return this.parsePokemonStorage(raw ?? undefined);
    }

    /** Free venomon slots across existing boxes plus boxes that could still be created. */
    private freePokemonCapacity(boxes:PokemonStorageBox[]):number {
        const existing = boxes.reduce((sum, box) => sum + (box.capacity - box.pokemon.length), 0);
        return existing + Math.max(0, MAX_STORAGE_BOXES - boxes.length) * POKEMON_BOX_CAPACITY;
    }

    /**
     * Places `mons` into boxes, filling `preferredBoxId` first (when given),
     * then the remaining boxes in order, creating new boxes as needed. The
     * caller must have checked freePokemonCapacity first. Mutates `boxes` and
     * returns the name of the first box a mon landed in.
     */
    private placePokemonInStorage(boxes:PokemonStorageBox[], mons:PokemonSummary[], preferredBoxId?:string):string {
        const order = [...boxes];
        if (preferredBoxId) {
            const idx = order.findIndex((box) => box.id === preferredBoxId);
            if (idx > 0) {
                const [chosen] = order.splice(idx, 1);
                order.unshift(chosen);
            }
        }
        let cursor = 0;
        let firstBoxName = boxes[0]?.name ?? "Box 1";
        mons.forEach((mon, monIndex) => {
            while (cursor < order.length && order[cursor].pokemon.length >= order[cursor].capacity) {
                cursor += 1;
            }
            if (cursor >= order.length) {
                const next:PokemonStorageBox = {
                    id: `box-${boxes.length + 1}`,
                    name: `Box ${boxes.length + 1}`,
                    capacity: POKEMON_BOX_CAPACITY,
                    pokemon: []
                };
                boxes.push(next);
                order.push(next);
            }
            order[cursor].pokemon.push(mon);
            if (monIndex === 0) {
                firstBoxName = order[cursor].name;
            }
        });
        return firstBoxName;
    }

    /**
     * Appends a Pokemon to the first storage box with free space, creating a
     * new box when every existing one is full (up to MAX_STORAGE_BOXES). Used
     * for captures and event grants that arrive while the party is full.
     */
    public async addPokemonToStorage(
        userId:number,
        summary:PokemonSummary
    ):Promise<{ ok:true; boxName:string } | { ok:false; message:string }> {
        const boxes = await this.getPokemonStorage(userId);
        if (this.freePokemonCapacity(boxes) < 1) {
            return { ok: false, message: "Your PC storage is completely full." };
        }
        const context = await this.getStorageAccessContext(userId);
        const boxName = this.placePokemonInStorage(
            boxes,
            [this.stampAssetOwnership({ ...summary }, context.characterId)]
        );
        await this.redis.hSet(this.userKey(userId), {
            pokemon_box: this.serializePokemonStorage(boxes)
        });
        return { ok: true, boxName };
    }

    /** Moves one or more party Pokemon into storage. The party keeps ≥1 member. */
    public async depositPokemonToStorage(
        userId:number,
        pokemonIds:string[],
        boxId?:string
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const user = await this.getUserById(String(userId));
        if (!user) {
            return { ok: false, message: "Account not found." };
        }

        const ids = this.uniqueStrings(pokemonIds);
        if (ids.length === 0) {
            return { ok: false, message: "Select a Pokemon to deposit." };
        }

        const party = [...user.pokemonParty];
        const moving = ids
            .map((id) => party.find((pokemon) => pokemon.id === id))
            .filter((pokemon): pokemon is PokemonSummary => Boolean(pokemon));
        if (moving.length !== ids.length) {
            return { ok: false, message: "Some of those Pokemon are not in your party." };
        }
        if (party.length - moving.length < 1) {
            return { ok: false, message: "You must keep at least one Pokemon with you." };
        }

        const boxes = await this.getPokemonStorage(userId);
        const nextId = `box-${boxes.length + 1}`;
        const targetId = typeof boxId === "string" && boxId.length > 0 ? boxId : undefined;
        if (targetId && targetId !== nextId && !boxes.some((box) => box.id === targetId)) {
            return { ok: false, message: "That storage box does not exist." };
        }
        if (this.freePokemonCapacity(boxes) < moving.length) {
            return { ok: false, message: "Your PC storage does not have enough room." };
        }

        const context = await this.getStorageAccessContext(userId);
        const remaining = party.filter((pokemon) => !ids.includes(pokemon.id));
        const boxName = this.placePokemonInStorage(
            boxes,
            moving.map((pokemon) => this.stampAssetOwnership({ ...pokemon }, context.characterId)),
            targetId
        );

        await this.redis.hSet(await this.activeCharacterKey(userId), {
            pokemon_party: JSON.stringify(this.sanitizePokemonPartyForStorage(remaining))
        });
        await this.redis.hSet(this.userKey(userId), {
            pokemon_box: this.serializePokemonStorage(boxes)
        });
        this.markPartyChanged(userId);

        const message =
            moving.length === 1
                ? `${moving[0].nickname || moving[0].name} was deposited into ${boxName}.`
                : `${moving.length} Pokemon were deposited into storage.`;
        return { ok: true, user: await this.getUserById(String(userId)), message };
    }

    /** Moves one or more stored Pokemon back into the party (max 6 total). */
    public async withdrawPokemonFromStorage(
        userId:number,
        pokemonIds:string[],
        boxId:string
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const user = await this.getUserById(String(userId));
        if (!user) {
            return { ok: false, message: "Account not found." };
        }

        const ids = this.uniqueStrings(pokemonIds);
        if (ids.length === 0) {
            return { ok: false, message: "Select a Pokemon to withdraw." };
        }
        if (user.pokemonParty.length + ids.length > MAX_POKEMON_PARTY_SIZE) {
            return { ok: false, message: "Your party does not have enough room." };
        }

        const boxes = await this.getPokemonStorage(userId);
        const box = boxes.find((candidate) => candidate.id === boxId);
        if (!box) {
            return { ok: false, message: "That storage box does not exist." };
        }

        const context = await this.getStorageAccessContext(userId);
        const withdrawn:PokemonSummary[] = [];
        for (const id of ids) {
            const index = box.pokemon.findIndex((pokemon) => pokemon.id === id);
            if (index === -1) {
                return { ok: false, message: "Some of those Pokemon are not in this box." };
            }
            const stored = box.pokemon[index];
            if (
                this.assetOwnerId(stored, context.characterId) !== context.characterId &&
                !context.canAccessOthersAssets
            ) {
                return { ok: false, message: this.crossCharacterDeniedMessage(context.minMedals) };
            }
            // Ownership transfers to the withdrawing character (it now holds
            // the venomon in its party).
            withdrawn.push(this.stripAssetOwnership({ ...stored }));
            box.pokemon.splice(index, 1);
        }

        const party = [...user.pokemonParty, ...withdrawn];
        await this.redis.hSet(await this.activeCharacterKey(userId), {
            pokemon_party: JSON.stringify(this.sanitizePokemonPartyForStorage(party))
        });
        await this.redis.hSet(this.userKey(userId), {
            pokemon_box: this.serializePokemonStorage(boxes)
        });
        this.markPartyChanged(userId);

        const message =
            withdrawn.length === 1
                ? `${withdrawn[0].nickname || withdrawn[0].name} joined your party.`
                : `${withdrawn.length} Pokemon joined your party.`;
        return { ok: true, user: await this.getUserById(String(userId)), message };
    }

    /** Moves stored Pokemon from wherever they are into another box. */
    public async movePokemonBetweenBoxes(
        userId:number,
        pokemonIds:string[],
        toBoxId:string
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const ids = this.uniqueStrings(pokemonIds);
        if (ids.length === 0) {
            return { ok: false, message: "Select a Pokemon to move." };
        }

        const boxes = await this.getPokemonStorage(userId);
        const nextId = `box-${boxes.length + 1}`;
        let destination = boxes.find((box) => box.id === toBoxId);
        if (!destination) {
            if (toBoxId === nextId && boxes.length < MAX_STORAGE_BOXES) {
                destination = { id: nextId, name: `Box ${boxes.length + 1}`, capacity: POKEMON_BOX_CAPACITY, pokemon: [] };
                boxes.push(destination);
            } else {
                return { ok: false, message: "That storage box does not exist." };
            }
        }

        // Pull the requested mons out of their current boxes (skip the ones
        // already in the destination), preserving order. Moving keeps the
        // original owner — only withdrawal transfers ownership.
        const context = await this.getStorageAccessContext(userId);
        const moving:PokemonSummary[] = [];
        for (const box of boxes) {
            if (box.id === destination.id) continue;
            for (let i = box.pokemon.length - 1; i >= 0; i -= 1) {
                if (ids.includes(box.pokemon[i].id)) {
                    if (
                        this.assetOwnerId(box.pokemon[i], context.characterId) !== context.characterId &&
                        !context.canAccessOthersAssets
                    ) {
                        return { ok: false, message: this.crossCharacterDeniedMessage(context.minMedals) };
                    }
                    moving.unshift(box.pokemon[i]);
                    box.pokemon.splice(i, 1);
                }
            }
        }
        if (moving.length === 0) {
            return { ok: false, message: "Those Pokemon are already in that box." };
        }
        if (destination.capacity - destination.pokemon.length < moving.length) {
            return { ok: false, message: `${destination.name} does not have enough room.` };
        }
        destination.pokemon.push(...moving);

        await this.redis.hSet(this.userKey(userId), {
            pokemon_box: this.serializePokemonStorage(boxes)
        });
        this.markPartyChanged(userId);

        return {
            ok: true,
            user: await this.getUserById(String(userId)),
            message:
                moving.length === 1
                    ? `${moving[0].nickname || moving[0].name} moved to ${destination.name}.`
                    : `${moving.length} Pokemon moved to ${destination.name}.`
        };
    }

    /** Permanently releases ("let go") one or more stored Pokemon. */
    public async releasePokemonFromStorage(
        userId:number,
        pokemonIds:string[]
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const ids = this.uniqueStrings(pokemonIds);
        if (ids.length === 0) {
            return { ok: false, message: "Select a Pokemon to let go." };
        }

        const boxes = await this.getPokemonStorage(userId);
        const context = await this.getStorageAccessContext(userId);
        const released:PokemonSummary[] = [];
        for (const box of boxes) {
            for (let i = box.pokemon.length - 1; i >= 0; i -= 1) {
                if (ids.includes(box.pokemon[i].id)) {
                    if (
                        this.assetOwnerId(box.pokemon[i], context.characterId) !== context.characterId &&
                        !context.canAccessOthersAssets
                    ) {
                        return { ok: false, message: this.crossCharacterDeniedMessage(context.minMedals) };
                    }
                    released.unshift(box.pokemon[i]);
                    box.pokemon.splice(i, 1);
                }
            }
        }
        if (released.length === 0) {
            return { ok: false, message: "Those Pokemon are not in storage." };
        }

        await this.redis.hSet(this.userKey(userId), {
            pokemon_box: this.serializePokemonStorage(boxes)
        });
        this.markPartyChanged(userId);

        return {
            ok: true,
            user: await this.getUserById(String(userId)),
            message:
                released.length === 1
                    ? `${released[0].nickname || released[0].name} was let go. Bye-bye!`
                    : `${released.length} Pokemon were let go.`
        };
    }

    /** Adds an empty venomon box (up to MAX_STORAGE_BOXES). */
    public async createPokemonBox(
        userId:number
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const boxes = await this.getPokemonStorage(userId);
        if (boxes.length >= MAX_STORAGE_BOXES) {
            return { ok: false, message: `You can only have ${MAX_STORAGE_BOXES} boxes.` };
        }
        const box:PokemonStorageBox = {
            id: `box-${boxes.length + 1}`,
            name: `Box ${boxes.length + 1}`,
            capacity: POKEMON_BOX_CAPACITY,
            pokemon: []
        };
        boxes.push(box);
        await this.redis.hSet(this.userKey(userId), { pokemon_box: this.serializePokemonStorage(boxes) });
        return { ok: true, user: await this.getUserById(String(userId)), message: `${box.name} added.` };
    }

    /** Updates a venomon box's name and/or cosmetic style. */
    public async setPokemonBoxStyle(
        userId:number,
        boxId:string,
        patch:{ name?:string } & StorageBoxStyle
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const boxes = await this.getPokemonStorage(userId);
        const box = boxes.find((candidate) => candidate.id === boxId);
        if (!box) {
            return { ok: false, message: "That storage box does not exist." };
        }
        this.applyBoxStylePatch(box, patch);
        await this.redis.hSet(this.userKey(userId), { pokemon_box: this.serializePokemonStorage(boxes) });
        return { ok: true, user: await this.getUserById(String(userId)), message: `${box.name} updated.` };
    }

    // ---- item storage -----------------------------------------------------

    private mergeItemStacks(items:InventoryItem[]):InventoryItem[] {
        // Stacks merge only when the same character owns them — quantities of
        // different owners must stay separate so ownership stays accurate.
        const byIdAndOwner = new Map<string, InventoryItem>();
        for (const item of this.sanitizeInventoryForStorage(items)) {
            if (item.quantity <= 0) continue;
            const key = `${item.id}::${item.ownerCharacterId ?? 0}`;
            const existing = byIdAndOwner.get(key);
            if (existing) {
                existing.quantity += item.quantity;
            } else {
                byIdAndOwner.set(key, { ...item });
            }
        }
        return Array.from(byIdAndOwner.values());
    }

    private serializeItemStorage(boxes:ItemStorageBox[]) {
        return JSON.stringify({
            boxes: boxes.slice(0, MAX_STORAGE_BOXES).map((box) => ({
                name: box.name,
                ...this.sanitizeBoxStyle(box),
                items: this.mergeItemStacks(box.items).slice(0, ITEM_BOX_CAPACITY)
            }))
        });
    }

    public async getItemStorage(userId:number):Promise<ItemStorageBox[]> {
        await this.ensureAccountMigrated(userId);
        const raw = await this.redis.hGet(this.userKey(userId), "item_box");
        return this.parseItemStorage(raw ?? undefined);
    }

    /** Moves a quantity of an inventory item into an item box. */
    public async depositItemToStorage(
        userId:number,
        itemId:string,
        quantity:number,
        boxId?:string
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const user = await this.getUserById(String(userId));
        if (!user) {
            return { ok: false, message: "Account not found." };
        }
        const amount = Math.max(1, Math.round(Number(quantity) || 0));
        const inventory = user.inventory.map((item) => ({ ...item }));
        const source = inventory.find((item) => item.id === itemId);
        if (!source || source.quantity <= 0) {
            return { ok: false, message: "You don't have that item." };
        }
        const moved = Math.min(amount, source.quantity);

        const boxes = await this.getItemStorage(userId);
        const nextId = `box-${boxes.length + 1}`;
        let target = typeof boxId === "string" && boxId.length > 0 ? boxes.find((box) => box.id === boxId) : undefined;
        if (typeof boxId === "string" && boxId.length > 0 && !target) {
            if (boxId === nextId && boxes.length < MAX_STORAGE_BOXES) {
                target = { id: nextId, name: `Box ${boxes.length + 1}`, capacity: ITEM_BOX_CAPACITY, items: [] };
                boxes.push(target);
            } else {
                return { ok: false, message: "That item box does not exist." };
            }
        }
        const context = await this.getStorageAccessContext(userId);
        const ownsStack = (item:InventoryItem) =>
            item.id === itemId && this.assetOwnerId(item, context.characterId) === context.characterId;
        if (!target) {
            target = boxes.find((box) => box.items.some(ownsStack))
                ?? boxes.find((box) => box.items.length < box.capacity);
            if (!target) {
                if (boxes.length >= MAX_STORAGE_BOXES) {
                    return { ok: false, message: "Your item storage is completely full." };
                }
                target = { id: nextId, name: `Box ${boxes.length + 1}`, capacity: ITEM_BOX_CAPACITY, items: [] };
                boxes.push(target);
            }
        }

        // Deposits merge only into the depositing character's own stack; a
        // sibling character's stack of the same item stays untouched.
        const existing = target.items.find(ownsStack);
        if (!existing && target.items.length >= target.capacity) {
            return { ok: false, message: `${target.name} is full.` };
        }

        source.quantity -= moved;
        if (existing) {
            existing.quantity += moved;
        } else {
            target.items.push(
                this.stampAssetOwnership({ ...source, quantity: moved }, context.characterId)
            );
        }

        await this.redis.hSet(await this.activeCharacterKey(userId), {
            inventory: JSON.stringify(this.sanitizeInventoryForStorage(inventory.filter((item) => item.quantity > 0)))
        });
        await this.redis.hSet(this.userKey(userId), {
            item_box: this.serializeItemStorage(boxes)
        });
        return {
            ok: true,
            user: await this.getUserById(String(userId)),
            message: `${moved}x ${source.name} stored in ${target.name}.`
        };
    }

    /** Moves a quantity of an item from a box back into the bag. */
    public async withdrawItemFromStorage(
        userId:number,
        itemId:string,
        quantity:number,
        boxId:string
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const user = await this.getUserById(String(userId));
        if (!user) {
            return { ok: false, message: "Account not found." };
        }
        const amount = Math.max(1, Math.round(Number(quantity) || 0));
        const boxes = await this.getItemStorage(userId);
        const box = boxes.find((candidate) => candidate.id === boxId);
        if (!box) {
            return { ok: false, message: "That item box does not exist." };
        }
        // Prefer the active character's own stack; falling back to a sibling
        // character's stack requires the cross-character medal gate.
        const context = await this.getStorageAccessContext(userId);
        const candidates = box.items.filter((item) => item.id === itemId && item.quantity > 0);
        const stack =
            candidates.find((item) => this.assetOwnerId(item, context.characterId) === context.characterId) ??
            candidates[0];
        if (!stack) {
            return { ok: false, message: "That item is not in this box." };
        }
        if (
            this.assetOwnerId(stack, context.characterId) !== context.characterId &&
            !context.canAccessOthersAssets
        ) {
            return { ok: false, message: this.crossCharacterDeniedMessage(context.minMedals) };
        }
        const moved = Math.min(amount, stack.quantity);
        stack.quantity -= moved;
        box.items = box.items.filter((item) => item.quantity > 0);

        const inventory = user.inventory.map((item) => ({ ...item }));
        const existing = inventory.find((item) => item.id === itemId);
        if (existing) {
            existing.quantity += moved;
        } else {
            // Ownership transfers to the withdrawing character's bag.
            inventory.push(this.stripAssetOwnership({ ...stack, quantity: moved }));
        }

        await this.redis.hSet(await this.activeCharacterKey(userId), {
            inventory: JSON.stringify(this.sanitizeInventoryForStorage(inventory))
        });
        await this.redis.hSet(this.userKey(userId), {
            item_box: this.serializeItemStorage(boxes)
        });
        return {
            ok: true,
            user: await this.getUserById(String(userId)),
            message: `${moved}x ${stack.name} returned to your bag.`
        };
    }

    /** Moves a quantity of an item from one box to another. */
    public async moveItemBetweenBoxes(
        userId:number,
        itemId:string,
        quantity:number,
        fromBoxId:string,
        toBoxId:string
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        if (fromBoxId === toBoxId) {
            return { ok: false, message: "Pick a different box." };
        }
        const amount = Math.max(1, Math.round(Number(quantity) || 0));
        const boxes = await this.getItemStorage(userId);
        const from = boxes.find((box) => box.id === fromBoxId);
        if (!from) {
            return { ok: false, message: "That item box does not exist." };
        }
        const nextId = `box-${boxes.length + 1}`;
        let to = boxes.find((box) => box.id === toBoxId);
        if (!to) {
            if (toBoxId === nextId && boxes.length < MAX_STORAGE_BOXES) {
                to = { id: nextId, name: `Box ${boxes.length + 1}`, capacity: ITEM_BOX_CAPACITY, items: [] };
                boxes.push(to);
            } else {
                return { ok: false, message: "That item box does not exist." };
            }
        }
        const context = await this.getStorageAccessContext(userId);
        const sourceCandidates = from.items.filter((item) => item.id === itemId && item.quantity > 0);
        const stack =
            sourceCandidates.find((item) => this.assetOwnerId(item, context.characterId) === context.characterId) ??
            sourceCandidates[0];
        if (!stack) {
            return { ok: false, message: "That item is not in the source box." };
        }
        const stackOwner = this.assetOwnerId(stack, context.characterId);
        if (stackOwner !== context.characterId && !context.canAccessOthersAssets) {
            return { ok: false, message: this.crossCharacterDeniedMessage(context.minMedals) };
        }
        // Moving between boxes keeps the original owner, so merge only into a
        // stack with the SAME owner.
        const existing = to.items.find(
            (item) => item.id === itemId && this.assetOwnerId(item, context.characterId) === stackOwner
        );
        if (!existing && to.items.length >= to.capacity) {
            return { ok: false, message: `${to.name} is full.` };
        }
        const moved = Math.min(amount, stack.quantity);
        stack.quantity -= moved;
        from.items = from.items.filter((item) => item.quantity > 0);
        if (existing) {
            existing.quantity += moved;
        } else {
            to.items.push({ ...stack, quantity: moved });
        }

        await this.redis.hSet(this.userKey(userId), { item_box: this.serializeItemStorage(boxes) });
        return {
            ok: true,
            user: await this.getUserById(String(userId)),
            message: `${moved}x ${stack.name} moved to ${to.name}.`
        };
    }

    /** Permanently discards ("let go") a quantity of an item from a box. */
    public async releaseItemFromStorage(
        userId:number,
        itemId:string,
        quantity:number,
        boxId:string
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const amount = Math.max(1, Math.round(Number(quantity) || 0));
        const boxes = await this.getItemStorage(userId);
        const box = boxes.find((candidate) => candidate.id === boxId);
        if (!box) {
            return { ok: false, message: "That item box does not exist." };
        }
        const context = await this.getStorageAccessContext(userId);
        const releaseCandidates = box.items.filter((item) => item.id === itemId && item.quantity > 0);
        const stack =
            releaseCandidates.find((item) => this.assetOwnerId(item, context.characterId) === context.characterId) ??
            releaseCandidates[0];
        if (!stack) {
            return { ok: false, message: "That item is not in this box." };
        }
        if (
            this.assetOwnerId(stack, context.characterId) !== context.characterId &&
            !context.canAccessOthersAssets
        ) {
            return { ok: false, message: this.crossCharacterDeniedMessage(context.minMedals) };
        }
        const removed = Math.min(amount, stack.quantity);
        const name = stack.name;
        stack.quantity -= removed;
        box.items = box.items.filter((item) => item.quantity > 0);

        await this.redis.hSet(this.userKey(userId), { item_box: this.serializeItemStorage(boxes) });
        return {
            ok: true,
            user: await this.getUserById(String(userId)),
            message: `Threw away ${removed}x ${name}.`
        };
    }

    /** Adds an empty item box (up to MAX_STORAGE_BOXES). */
    public async createItemBox(
        userId:number
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const boxes = await this.getItemStorage(userId);
        if (boxes.length >= MAX_STORAGE_BOXES) {
            return { ok: false, message: `You can only have ${MAX_STORAGE_BOXES} item boxes.` };
        }
        const box:ItemStorageBox = {
            id: `box-${boxes.length + 1}`,
            name: `Box ${boxes.length + 1}`,
            capacity: ITEM_BOX_CAPACITY,
            items: []
        };
        boxes.push(box);
        await this.redis.hSet(this.userKey(userId), { item_box: this.serializeItemStorage(boxes) });
        return { ok: true, user: await this.getUserById(String(userId)), message: `${box.name} added.` };
    }

    /** Updates an item box's name and/or cosmetic style. */
    public async setItemBoxStyle(
        userId:number,
        boxId:string,
        patch:{ name?:string } & StorageBoxStyle
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const boxes = await this.getItemStorage(userId);
        const box = boxes.find((candidate) => candidate.id === boxId);
        if (!box) {
            return { ok: false, message: "That item box does not exist." };
        }
        this.applyBoxStylePatch(box, patch);
        await this.redis.hSet(this.userKey(userId), { item_box: this.serializeItemStorage(boxes) });
        return { ok: true, user: await this.getUserById(String(userId)), message: `${box.name} updated.` };
    }

    // ---- PC money bank (shared-box currency deposits) ---------------------
    // The account box stores currency as one aggregate per owning character:
    // `pc_money_deposits` on the account hash. A character always withdraws
    // its own deposit; a sibling character's deposit needs the medal gate,
    // and a partial withdrawal transfers ownership of ONLY the withdrawn
    // amount (the remainder stays with the original owner). Both operations
    // are WATCH/MULTI transactions over the wallet + deposits keys so
    // concurrent requests can neither duplicate nor destroy currency, and the
    // server computes every balance itself — client-sent balances are never
    // trusted.

    private parseMoneyDeposits(raw:string | null | undefined):Array<{
        ownerCharacterId:number;
        amount:number;
        depositedByCharacterId:number;
        depositedAt:string;
        updatedAt:string;
    }> {
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed
                .filter((entry) =>
                    entry &&
                    Number.isInteger(Number(entry.ownerCharacterId)) &&
                    Number(entry.ownerCharacterId) > 0 &&
                    Number.isFinite(Number(entry.amount)) &&
                    Number(entry.amount) > 0
                )
                .map((entry) => ({
                    ownerCharacterId: Number(entry.ownerCharacterId),
                    amount: Math.min(MAX_MONEY_BALANCE, Math.max(0, Math.round(Number(entry.amount)))),
                    depositedByCharacterId: Number.isInteger(Number(entry.depositedByCharacterId))
                        ? Number(entry.depositedByCharacterId)
                        : Number(entry.ownerCharacterId),
                    depositedAt: String(entry.depositedAt ?? ""),
                    updatedAt: String(entry.updatedAt ?? "")
                }));
        } catch {
            return [];
        }
    }

    private serializeMoneyDeposits(deposits:Array<{
        ownerCharacterId:number;
        amount:number;
        depositedByCharacterId:number;
        depositedAt:string;
        updatedAt:string;
    }>) {
        return JSON.stringify(deposits.filter((deposit) => deposit.amount > 0));
    }

    /**
     * Non-interactive deposit adjustment (character purge, progress reset).
     * Interactive flows use the WATCH transactions below instead.
     */
    private async adjustMoneyDeposit(
        accountId:number,
        ownerCharacterId:number,
        depositedByCharacterId:number,
        delta:number
    ) {
        const raw = await this.redis.hGet(this.userKey(accountId), "pc_money_deposits");
        const deposits = this.parseMoneyDeposits(raw);
        const nowIso = new Date().toISOString();
        const existing = deposits.find((deposit) => deposit.ownerCharacterId === ownerCharacterId);
        if (existing) {
            existing.amount = Math.min(MAX_MONEY_BALANCE, Math.max(0, existing.amount + delta));
            existing.updatedAt = nowIso;
        } else if (delta > 0) {
            deposits.push({
                ownerCharacterId,
                amount: Math.min(MAX_MONEY_BALANCE, delta),
                depositedByCharacterId,
                depositedAt: nowIso,
                updatedAt: nowIso
            });
        }
        await this.redis.hSet(this.userKey(accountId), {
            pc_money_deposits: this.serializeMoneyDeposits(deposits)
        });
    }

    /** Moves money from the active character's wallet into the account box. */
    public async depositMoneyToPc(
        userId:number,
        amount:number
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const value = Math.round(Number(amount) || 0);
        if (value <= 0) {
            return { ok: false, message: "Enter a positive amount." };
        }
        const characterId = await this.getActiveCharacterId(userId);
        const characterKey = this.characterKey(characterId);
        const accountKey = this.userKey(userId);

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await this.redis.watch([characterKey, accountKey]);
            const [moneyRaw, depositsRaw] = await Promise.all([
                this.redis.hGet(characterKey, "money"),
                this.redis.hGet(accountKey, "pc_money_deposits")
            ]);
            const wallet = this.parseMoney(moneyRaw ?? undefined, 0);
            if (wallet < value) {
                await this.redis.unwatch();
                return { ok: false, message: "You don't have that much money on hand." };
            }
            const deposits = this.parseMoneyDeposits(depositsRaw);
            const own = deposits.find((deposit) => deposit.ownerCharacterId === characterId);
            if ((own?.amount ?? 0) + value > MAX_MONEY_BALANCE) {
                await this.redis.unwatch();
                return { ok: false, message: "That deposit would exceed the storage limit." };
            }
            const nowIso = new Date().toISOString();
            if (own) {
                own.amount += value;
                own.updatedAt = nowIso;
            } else {
                deposits.push({
                    ownerCharacterId: characterId,
                    amount: value,
                    depositedByCharacterId: characterId,
                    depositedAt: nowIso,
                    updatedAt: nowIso
                });
            }
            const result = await this.redis.multi()
                .hSet(characterKey, { money: String(wallet - value) })
                .hSet(accountKey, { pc_money_deposits: this.serializeMoneyDeposits(deposits) })
                .exec();
            if (result) {
                return {
                    ok: true,
                    user: await this.getUserById(String(userId)),
                    message: `Deposited $${value} into the PC.`
                };
            }
        }
        return { ok: false, message: "The PC is busy. Try again." };
    }

    /**
     * Moves money from the account box back into the active character's
     * wallet. `ownerCharacterId` picks whose deposit to draw from (defaults
     * to the active character's own deposit); drawing from a sibling
     * character requires the cross-character medal gate.
     */
    public async withdrawMoneyFromPc(
        userId:number,
        amount:number,
        ownerCharacterId?:number
    ):Promise<{ ok:true; user:AuthenticatedUser | null; message:string } | { ok:false; message:string }> {
        const value = Math.round(Number(amount) || 0);
        if (value <= 0) {
            return { ok: false, message: "Enter a positive amount." };
        }
        const characterId = await this.getActiveCharacterId(userId);
        const owner =
            Number.isInteger(ownerCharacterId) && (ownerCharacterId as number) > 0
                ? (ownerCharacterId as number)
                : characterId;
        if (owner !== characterId) {
            const context = await this.getStorageAccessContext(userId);
            if (!context.canAccessOthersAssets) {
                return { ok: false, message: this.crossCharacterDeniedMessage(context.minMedals) };
            }
            const ids = await this.getCharacterIds(userId);
            if (!ids.includes(owner)) {
                return { ok: false, message: "That deposit does not exist." };
            }
        }
        const characterKey = this.characterKey(characterId);
        const accountKey = this.userKey(userId);

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await this.redis.watch([characterKey, accountKey]);
            const [moneyRaw, depositsRaw] = await Promise.all([
                this.redis.hGet(characterKey, "money"),
                this.redis.hGet(accountKey, "pc_money_deposits")
            ]);
            const deposits = this.parseMoneyDeposits(depositsRaw);
            const record = deposits.find((deposit) => deposit.ownerCharacterId === owner);
            if (!record || record.amount < value) {
                await this.redis.unwatch();
                return { ok: false, message: "The PC doesn't hold that much money." };
            }
            const wallet = this.parseMoney(moneyRaw ?? undefined, 0);
            if (wallet + value > MAX_MONEY_BALANCE) {
                await this.redis.unwatch();
                return { ok: false, message: "Your wallet can't hold that much money." };
            }
            record.amount -= value;
            record.updatedAt = new Date().toISOString();
            const result = await this.redis.multi()
                .hSet(characterKey, { money: String(wallet + value) })
                .hSet(accountKey, { pc_money_deposits: this.serializeMoneyDeposits(deposits) })
                .exec();
            if (result) {
                return {
                    ok: true,
                    user: await this.getUserById(String(userId)),
                    message: `Withdrew $${value} from the PC.`
                };
            }
        }
        return { ok: false, message: "The PC is busy. Try again." };
    }

    /**
     * Strips everything a character owns out of the shared account storage:
     * boxed venomons, item stacks, and its money deposits. Used by the admin
     * progress reset so a wiped character cannot "recover" progress from the
     * box, while other characters' assets stay untouched.
     */
    private async removeCharacterAssetsFromSharedStorage(accountId:number, characterId:number) {
        const pokemonBoxes = await this.getPokemonStorage(accountId);
        for (const box of pokemonBoxes) {
            box.pokemon = box.pokemon.filter(
                (mon) => this.assetOwnerId(mon, characterId) !== characterId
            );
        }
        const itemBoxes = await this.getItemStorage(accountId);
        for (const box of itemBoxes) {
            box.items = box.items.filter(
                (stack) => this.assetOwnerId(stack, characterId) !== characterId
            );
        }
        const depositsRaw = await this.redis.hGet(this.userKey(accountId), "pc_money_deposits");
        const deposits = this.parseMoneyDeposits(depositsRaw)
            .filter((deposit) => deposit.ownerCharacterId !== characterId);
        await this.redis.hSet(this.userKey(accountId), {
            pokemon_box: this.serializePokemonStorage(pokemonBoxes),
            item_box: this.serializeItemStorage(itemBoxes),
            pc_money_deposits: this.serializeMoneyDeposits(deposits)
        });
    }

    // ---- storage helpers --------------------------------------------------

    private uniqueStrings(values:unknown):string[] {
        if (!Array.isArray(values)) {
            return typeof values === "string" && values.length > 0 ? [values] : [];
        }
        const seen = new Set<string>();
        for (const value of values) {
            if (typeof value === "string" && value.length > 0) {
                seen.add(value);
            }
        }
        return Array.from(seen);
    }

    private applyBoxStylePatch(box:{ name:string } & StorageBoxStyle, patch:{ name?:string } & StorageBoxStyle) {
        if (typeof patch.name === "string" && patch.name.trim().length > 0) {
            box.name = patch.name.trim().slice(0, 20);
        }
        const style = this.sanitizeBoxStyle(patch);
        // Each style field is independently set (valid value) or cleared (the
        // key is present in the patch but empty/invalid → reset to default).
        if ("bgColor" in patch) box.bgColor = style.bgColor;
        if ("bgImage" in patch) box.bgImage = style.bgImage;
        if ("borderColor" in patch) box.borderColor = style.borderColor;
    }

    private normalizePokemonNickname(value:unknown) {
        return typeof value === "string" ? value.trim() : "";
    }

    private validatePokemonNickname(value:string) {
        if (!POKEMON_NICKNAME_PATTERN.test(value)) {
            return "Pokemon names must use letters only, with no spaces, up to 10 characters.";
        }

        if (BLOCKED_POKEMON_NICKNAMES.has(value.toLowerCase())) {
            return "Choose a respectful Pokemon name.";
        }

        return null;
    }

    private parseMoney(value:string | undefined, fallback:number = DEFAULT_MONEY) {
        if (typeof value !== "string") {
            return fallback;
        }

        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
    }

    private parseBadges(value:string | undefined | null):number[] {
        if (typeof value !== "string") {
            return [];
        }
        try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed)) {
                return [];
            }
            const seen = new Set<number>();
            for (const entry of parsed) {
                const index = Number(entry);
                if (Number.isInteger(index) && index >= 0 && index <= 63) {
                    seen.add(index);
                }
            }
            return Array.from(seen).sort((a, b) => a - b);
        } catch {
            return [];
        }
    }

    private isLegacyDemoPokemonParty(value:unknown[]) {
        if (value.length !== 1) {
            return false;
        }

        const [pokemon] = value;
        if (!pokemon || typeof pokemon !== "object") {
            return false;
        }

        const candidate = pokemon as {
            id?: unknown;
            sourcePokemonId?: unknown;
            name?: unknown;
            level?: unknown;
            moves?: unknown;
        };

        return (
            typeof candidate.id === "string" &&
            LEGACY_DEMO_POKEMON_PARTY_IDS.has(candidate.id) &&
            typeof candidate.sourcePokemonId === "undefined" &&
            candidate.name === "Sprigatito" &&
            candidate.level === 5 &&
            Array.isArray(candidate.moves)
        );
    }

    private isLegacyDemoPokemonPartyJson(value:string) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) && this.isLegacyDemoPokemonParty(parsed);
        } catch {
            return false;
        }
    }

    private isUserRoleKey(value:unknown):value is UserRoleKey {
        return typeof value === "string" && USER_ROLE_KEYS.includes(value as UserRoleKey);
    }

    private isRolePermission(value:unknown):value is RolePermission {
        return typeof value === "string" && ROLE_PERMISSIONS.includes(value as RolePermission);
    }

    private unauthenticatedSession():AuthSessionState {
        return {
            authenticated: false,
            user: null
        };
    }

    private async createOneTimeToken(prefix:string, userId:number, ttlSeconds:number) {
        const token = crypto.randomUUID();
        await this.redis.set(`${prefix}${token}`, String(userId), {
            EX: ttlSeconds
        });
        return token;
    }

    private async consumeOneTimeToken(key:string) {
        const userId = await this.redis.get(key);
        if (!userId) {
            return null;
        }

        await this.redis.del(key);
        return userId;
    }

    /** Cryptographically random fixed-length numeric string (leading zeros kept). */
    private generateNumericCode(length:number) {
        let code = "";
        while (code.length < length) {
            code += crypto.randomInt(0, 10).toString();
        }
        return code;
    }

    /** Length-safe, timing-safe string comparison for confirmation codes. */
    private constantTimeEquals(expected:string, actual:string) {
        const expectedBuffer = Buffer.from(expected);
        const actualBuffer = Buffer.from(actual);
        if (expectedBuffer.length !== actualBuffer.length) {
            return false;
        }
        return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
    }

    private sessionKey(sessionId:string) {
        return `auth:session:${sessionId}`;
    }

    private userKey(userId:number | string) {
        return `auth:user:${userId}`;
    }

    private userIdSequenceKey() {
        return "auth:user:id:sequence";
    }

    private roleDefinitionsKey() {
        return "auth:roles";
    }

    private usernameIndexKey(username:string) {
        return `auth:index:username:${username}`;
    }

    private emailIndexKey(email:string) {
        return `auth:index:email:${email}`;
    }

    private emailValidationTokenPrefix() {
        return "auth:token:email-validation:";
    }

    private emailValidationTokenKey(token:string) {
        return `${this.emailValidationTokenPrefix()}${token}`;
    }

    private passwordResetTokenPrefix() {
        return "auth:token:password-reset:";
    }

    private passwordResetTokenKey(token:string) {
        return `${this.passwordResetTokenPrefix()}${token}`;
    }

    private accountDeletionCodeKey(userId:number | string) {
        return `auth:token:account-deletion:${userId}`;
    }

    private async createPasswordResetToken(userId:number) {
        return this.createOneTimeToken(
            this.passwordResetTokenPrefix(),
            userId,
            this.passwordResetTtlSeconds
        );
    }
}
