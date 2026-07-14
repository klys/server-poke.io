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

export interface AuthenticatedUser {
    id:number;
    name:string;
    username:string;
    email:string;
    emailVerified:boolean;
    profileImage:string;
    description:string;
    inventory:InventoryItem[];
    pokemonParty:PokemonSummary[];
    trainerGender:string;
    characterSkinId:string;
    money:number;
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
}

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

export interface RoleDefinitionWithCount extends RoleDefinition {
    userCount: number;
}

export interface InventoryItem {
    id:string;
    name:string;
    category:"usable" | "berries" | "moves" | "quest";
    quantity:number;
    description:string;
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

interface UpdateProfilePayload {
    profileImage?:string;
    description?:string;
    characterSkinId?:string;
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
const DEFAULT_BATTLE_HISTORY:BattleHistoryEntry[] = [];
const DEFAULT_MONEY = 1000;
const MAX_BATTLE_HISTORY_ITEMS = 50;
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

    constructor(redis:RedisClientType, mailService:MailService) {
        this.redis = redis;
        this.mailService = mailService;
        this.jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";
        this.sessionTtlSeconds = Number(process.env.AUTH_SESSION_TTL_SECONDS || 60 * 60 * 24 * 7);
        this.passwordPepper = process.env.AUTH_PEPPER || "";
        this.emailValidationTtlSeconds = Number(process.env.AUTH_EMAIL_VALIDATION_TTL_SECONDS || 60 * 60 * 24);
        this.passwordResetTtlSeconds = Number(process.env.AUTH_PASSWORD_RESET_TTL_SECONDS || 60 * 60);
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

    public async getSavedPlayerLocation(userId:number) {
        const storedLocation = await this.redis.hmGet(this.userKey(userId), [
            "last_map_id",
            "last_x",
            "last_y"
        ]);
        const [mapId, x, y] = storedLocation;
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
            y: Math.round(parsedY)
        } satisfies SavedPlayerLocation;
    }

    public async savePlayerLocation(userId:number, location:SavedPlayerLocation) {
        await this.redis.hSet(this.userKey(userId), {
            last_map_id: location.mapId,
            last_x: String(Math.round(location.x)),
            last_y: String(Math.round(location.y))
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
        }

        if (state.inventory) {
            fields.inventory = JSON.stringify(this.sanitizeInventoryForStorage(state.inventory));
        }

        if (typeof state.money === "number" && Number.isFinite(state.money)) {
            fields.money = String(Math.max(0, Math.round(state.money)));
        }

        if (Object.keys(fields).length > 0) {
            await this.redis.hSet(this.userKey(userId), fields);
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

        await this.redis.hSet(this.userKey(authenticatedUser.id), {
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

        await this.redis.hSet(this.userKey(userId), {
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

    public async updateProfile(token:string | undefined, payload:UpdateProfilePayload):Promise<AuthSuccessResult | AuthErrorResult> {
        const authenticatedUser = await this.getAuthenticatedUserFromToken(token);
        if (!authenticatedUser) {
            return { error: "You must be authenticated to update your profile." };
        }

        const profileImage = typeof payload.profileImage === "string" ? payload.profileImage.trim() : authenticatedUser.profileImage;
        const description = typeof payload.description === "string" ? payload.description.trim() : authenticatedUser.description;
        const characterSkinId =
            typeof payload.characterSkinId === "string"
                ? payload.characterSkinId.trim().slice(0, 120)
                : authenticatedUser.characterSkinId;

        if (description.length > 50) {
            return { error: "Description must be 50 characters or less." };
        }

        if (profileImage.length > 2000) {
            return { error: "Profile image URL is too long." };
        }

        await this.redis.hSet(this.userKey(authenticatedUser.id), {
            profile_image: profileImage,
            description,
            character_skin_id: characterSkinId
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

        await this.redis.hSet(this.userKey(authenticatedUser.id), {
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
            this.getAllStoredUsers()
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
        const users = await this.getAllStoredUsers();
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
        const pagedUsers = filteredUsers.slice(startIndex, startIndex + pageSize);
        const summaries = await Promise.all(pagedUsers.map((user) => this.toAdminUserSummary(user)));

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

    public async updateUserByAdmin(
        userId:number,
        updates:AdminUserUpdatePayload
    ):Promise<{ user:AdminUserDetails } | { error:string }> {
        const storedUser = await this.getStoredUserById(String(userId));
        if (!storedUser) {
            return { error: "User not found." };
        }

        const fields:Record<string, string> = {};

        if (typeof updates.name === "string") {
            const name = updates.name.trim();
            if (name.length < 2 || name.length > 30) {
                return { error: "Name must be between 2 and 30 characters." };
            }

            if (!/^[A-Za-z]+$/.test(name)) {
                return { error: "Name may contain letters only." };
            }

            fields.name = name;
        }

        if (typeof updates.profileImage === "string") {
            const profileImage = updates.profileImage.trim();
            if (profileImage.length > 2000) {
                return { error: "Profile image URL is too long." };
            }

            fields.profile_image = profileImage;
        }

        if (typeof updates.description === "string") {
            const description = updates.description.trim();
            if (description.length > 50) {
                return { error: "Description must be 50 characters or less." };
            }

            fields.description = description;
        }

        if (typeof updates.trainerGender === "string") {
            fields.trainer_gender = updates.trainerGender.trim().slice(0, 40);
        }

        if (typeof updates.characterSkinId === "string") {
            fields.character_skin_id = updates.characterSkinId.trim().slice(0, 120);
        }

        if (typeof updates.money === "number") {
            if (!Number.isFinite(updates.money)) {
                return { error: "Money must be a valid number." };
            }

            fields.money = String(Math.max(0, Math.round(updates.money)));
        }

        if (typeof updates.emailVerified === "boolean") {
            fields.email_verified = updates.emailVerified ? "1" : "0";
        }

        if (typeof updates.role === "string") {
            const roles = await this.readRoleDefinitions();
            if (!roles.some((role) => role.key === updates.role)) {
                return { error: "Unknown role." };
            }

            fields.role = updates.role;
        }

        if (updates.inventory) {
            fields.inventory = JSON.stringify(this.sanitizeInventoryForStorage(updates.inventory));
        }

        if (updates.pokemonParty) {
            fields.pokemon_party = JSON.stringify(this.sanitizePokemonPartyForStorage(updates.pokemonParty));
        }

        if (updates.battleHistory) {
            fields.battle_history = JSON.stringify(this.sanitizeBattleHistoryForStorage(updates.battleHistory));
        }

        if (Object.keys(fields).length > 0) {
            await this.redis.hSet(this.userKey(userId), fields);
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

        await this.redis.hSet(this.userKey(userId), {
            pokemon_party: JSON.stringify(DEFAULT_POKEMON_PARTY),
            inventory: JSON.stringify(DEFAULT_INVENTORY),
            money: String(DEFAULT_MONEY),
            battle_history: JSON.stringify(DEFAULT_BATTLE_HISTORY),
            // Clear RPG Maker event progression so scripted events (e.g. the lab
            // starter) can be replayed from the beginning after a reset.
            event_switches: JSON.stringify({}),
            event_variables: JSON.stringify({}),
            event_self_switches: JSON.stringify({})
        });
        await this.redis.hDel(this.userKey(userId), ["last_map_id", "last_x", "last_y", "respawn_point"]);

        const updatedUser = await this.getUserAdminDetails(userId);
        if (!updatedUser) {
            return { error: "Unable to refresh the reset user." };
        }

        return {
            user: updatedUser
        };
    }


    // ---- RPG Maker event state: switches / variables / self-switches ----
    // Persisted per user so multi-page events (page conditions) and progression
    // gating (e.g. "professor gave permission") survive across sessions.
    public async getEventState(userId:number):Promise<{
        switches:Record<string, boolean>;
        variables:Record<string, number>;
        selfSwitches:Record<string, boolean>;
    }> {
        const raw = await this.redis.hmGet(this.userKey(userId), [
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
        return {
            switches: parse(raw[0]) as Record<string, boolean>,
            variables: parse(raw[1]) as Record<string, number>,
            selfSwitches: parse(raw[2]) as Record<string, boolean>
        };
    }

    public async setEventSwitches(userId:number, startId:number, endId:number, on:boolean) {
        const state = await this.getEventState(userId);
        const lo = Math.min(startId, endId);
        const hi = Math.max(startId, endId);
        for (let id = lo; id <= hi; id += 1) {
            if (on) {
                state.switches[String(id)] = true;
            } else {
                delete state.switches[String(id)];
            }
        }
        await this.redis.hSet(this.userKey(userId), {
            event_switches: JSON.stringify(state.switches)
        });
    }

    public async setEventVariable(userId:number, id:number, value:number) {
        const state = await this.getEventState(userId);
        state.variables[String(id)] = value;
        await this.redis.hSet(this.userKey(userId), {
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
        await this.redis.hSet(this.userKey(userId), {
            event_self_switches: JSON.stringify(state.selfSwitches)
        });
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

        await this.redis.hSet(this.userKey(userId), {
            pokemon_party: JSON.stringify(healed)
        });
        return true;
    }

    /** Renames the player (pbTrainerName from the intro event). */
    public async setUserName(userId:number, name:string):Promise<boolean> {
        const trimmed = String(name ?? "").trim().slice(0, 30);
        if (!trimmed) {
            return false;
        }
        await this.redis.hSet(this.userKey(userId), { name: trimmed });
        return true;
    }

    /** Sets the character skin (pbChangePlayer gender pick from the intro). */
    public async setCharacterSkin(userId:number, characterSkinId:string):Promise<boolean> {
        const trimmed = String(characterSkinId ?? "").trim().slice(0, 120);
        if (!trimmed) {
            return false;
        }
        await this.redis.hSet(this.userKey(userId), { character_skin_id: trimmed });
        return true;
    }

    // ---- Pokemon Center respawn point (Kernel.pbSetPokemonCenter) ----
    // Where a blacked-out player is returned to; falls back to the initial
    // spawn when no center has been visited yet.
    public async setRespawnPoint(userId:number, point:{ mapId:string; x:number; y:number }) {
        await this.redis.hSet(this.userKey(userId), {
            respawn_point: JSON.stringify(point)
        });
    }

    public async getRespawnPoint(userId:number):Promise<{ mapId:string; x:number; y:number } | null> {
        const raw = await this.redis.hGet(this.userKey(userId), "respawn_point");
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
    public async givePokemonBySpecies(
        userId:number,
        internalName:string,
        level:number
    ):Promise<{ ok:true; pokemonName:string; boxed:boolean } | { ok:false; message:string }> {
        const pokemonId = `pokemon-${String(internalName).toUpperCase()}`;
        const resolved = await this.readPokemonProfileById(pokemonId);
        if (!resolved) {
            return { ok: false, message: `Unknown species ${internalName}.` };
        }

        const profile = resolved.profile as {
            hp?:unknown;
            elements?:unknown;
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

        const user = await this.getUserById(String(userId));
        if (!user) {
            return { ok: false, message: "Account not found." };
        }

        const party = Array.isArray(user.pokemonParty) ? [...user.pokemonParty] : [];
        if (party.length < 6) {
            party.push(summary);
            await this.redis.hSet(this.userKey(userId), {
                pokemon_party: JSON.stringify(party)
            });
            return { ok: true, pokemonName: resolved.name, boxed: false };
        }

        // Party full: stash in a simple overflow box so nothing is lost.
        const boxRaw = await this.redis.hGet(this.userKey(userId), "pokemon_box");
        let box:PokemonSummary[] = [];
        try {
            const parsed = boxRaw ? JSON.parse(boxRaw) : [];
            box = Array.isArray(parsed) ? parsed : [];
        } catch {
            box = [];
        }
        box.push(summary);
        await this.redis.hSet(this.userKey(userId), {
            pokemon_box: JSON.stringify(box)
        });
        return { ok: true, pokemonName: resolved.name, boxed: true };
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
    }

    private async readRoleDefinitions() {
        const parsed = this.sanitizeRoleDefinitions(
            await this.redis.get(this.roleDefinitionsKey())
        );

        return USER_ROLE_KEYS.map((roleKey) => (
            parsed.find((role) => role.key === roleKey) ?? DEFAULT_ROLE_DEFINITIONS.find((role) => role.key === roleKey)!
        ));
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

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await this.redis.watch([usernameKey, emailKey]);

            const [existingUsernameId, existingEmailId] = await this.redis.mGet([usernameKey, emailKey]);
            if (existingUsernameId || existingEmailId) {
                await this.redis.unwatch();
                return null;
            }

            const userId = await this.redis.incr(this.userIdSequenceKey());
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
                    inventory: JSON.stringify(DEFAULT_INVENTORY),
                    pokemon_party: JSON.stringify(DEFAULT_POKEMON_PARTY),
                    trainer_gender: "",
                    character_skin_id: "",
                    money: String(DEFAULT_MONEY),
                    battle_history: JSON.stringify(DEFAULT_BATTLE_HISTORY),
                    role,
                    created_at: createdAt
                })
                .set(usernameKey, String(userId))
                .set(emailKey, String(userId))
                .exec();

            if (transaction) {
                return {
                    id: userId,
                    name,
                    username,
                    email: normalizedEmail,
                    emailVerified: false,
                    profileImage: "",
                    description: "",
                    inventory: DEFAULT_INVENTORY,
                    pokemonParty: DEFAULT_POKEMON_PARTY,
                    trainerGender: "",
                    characterSkinId: "",
                    money: DEFAULT_MONEY,
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

    private async getAllStoredUsers() {
        const highestUserId = Number.parseInt(await this.redis.get(this.userIdSequenceKey()) ?? "0", 10);
        if (!Number.isFinite(highestUserId) || highestUserId <= 0) {
            return [];
        }

        const users = await Promise.all(
            Array.from({ length: highestUserId }, (_, index) => this.getStoredUserById(String(index + 1)))
        );

        return users.filter((user): user is StoredUser => Boolean(user));
    }

    private async getStoredUserById(userId:string) {
        const user = await this.redis.hGetAll(this.userKey(userId));
        if (!user.id) {
            return null;
        }

        const defaultFields:Record<string, string> = {};
        if (typeof user.profile_image !== "string") {
            defaultFields.profile_image = "";
        }
        if (typeof user.description !== "string") {
            defaultFields.description = "";
        }
        if (typeof user.inventory !== "string") {
            defaultFields.inventory = JSON.stringify(DEFAULT_INVENTORY);
        }
        if (typeof user.pokemon_party !== "string") {
            defaultFields.pokemon_party = JSON.stringify(DEFAULT_POKEMON_PARTY);
        } else if (this.isLegacyDemoPokemonPartyJson(user.pokemon_party)) {
            defaultFields.pokemon_party = JSON.stringify(DEFAULT_POKEMON_PARTY);
        }
        if (typeof user.trainer_gender !== "string") {
            defaultFields.trainer_gender = "";
        }
        if (typeof user.character_skin_id !== "string") {
            defaultFields.character_skin_id = "";
        }
        if (typeof user.money !== "string") {
            defaultFields.money = String(DEFAULT_MONEY);
        }
        if (typeof user.battle_history !== "string") {
            defaultFields.battle_history = JSON.stringify(DEFAULT_BATTLE_HISTORY);
        }
        if (!this.isUserRoleKey(user.role)) {
            defaultFields.role = "user";
        }

        if (Object.keys(defaultFields).length > 0) {
            await this.redis.hSet(this.userKey(userId), defaultFields);
        }

        const roles = await this.readRoleDefinitions();
        const resolvedRole = this.resolvePermissionsForRole(user.role ?? defaultFields.role, roles);

        return {
            id: Number(user.id),
            name: user.name,
            username: user.username,
            email: user.email,
            emailVerified: user.email_verified === "1",
            password_hash: user.password_hash,
            password_salt: user.password_salt,
            profileImage: user.profile_image ?? "",
            description: (user.description ?? "").slice(0, 50),
            inventory: this.parseInventory(user.inventory),
            pokemonParty: this.parsePokemonParty(user.pokemon_party),
            trainerGender: user.trainer_gender ?? "",
            characterSkinId: user.character_skin_id ?? "",
            money: this.parseMoney(user.money),
            battleHistory: this.parseBattleHistory(user.battle_history),
            role: resolvedRole.role,
            permissions: resolvedRole.permissions,
            created_at: user.created_at
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
            inventory: user.inventory,
            pokemonParty: user.pokemonParty,
            trainerGender: user.trainerGender,
            characterSkinId: user.characterSkinId,
            money: user.money,
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
        return {
            ...this.toAuthenticatedUser(user),
            createdAt: user.created_at,
            savedLocation: await this.getSavedPlayerLocation(user.id)
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
        return party
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
            .slice(0, 6)
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
                    statBonuses: sanitizePokemonStatBonuses(pokemon.statBonuses)
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

    private parseMoney(value:string | undefined) {
        if (typeof value !== "string") {
            return DEFAULT_MONEY;
        }

        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : DEFAULT_MONEY;
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

    private async createPasswordResetToken(userId:number) {
        return this.createOneTimeToken(
            this.passwordResetTokenPrefix(),
            userId,
            this.passwordResetTtlSeconds
        );
    }
}
