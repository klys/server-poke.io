import crypto from "crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { RedisClientType } from "redis";
import MailService from "./MailService";

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

export interface InventoryItem {
    id:string;
    name:string;
    category:"usable" | "berries" | "moves" | "quest";
    quantity:number;
    description:string;
}

export interface PokemonSummary {
    id:string;
    name:string;
    level:number;
    types:string[];
    hp:number;
    maxHp:number;
    moves:string[];
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
}

const DEFAULT_INVENTORY:InventoryItem[] = [
    {
        id: "potion",
        name: "Potion",
        category: "usable",
        quantity: 3,
        description: "Restores a small amount of HP."
    },
    {
        id: "oran-berry",
        name: "Oran Berry",
        category: "berries",
        quantity: 2,
        description: "A bright berry used by Pokemon in a pinch."
    },
    {
        id: "town-map",
        name: "Town Map",
        category: "quest",
        quantity: 1,
        description: "A handy map for tracking discovered regions."
    }
];

const DEFAULT_POKEMON_PARTY:PokemonSummary[] = [
    {
        id: "starter-001",
        name: "Sprigatito",
        level: 5,
        types: ["Grass"],
        hp: 20,
        maxHp: 20,
        moves: ["Scratch", "Leafage"]
    }
];

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

        if (description.length > 50) {
            return { error: "Description must be 50 characters or less." };
        }

        if (profileImage.length > 2000) {
            return { error: "Profile image URL is too long." };
        }

        await this.redis.hSet(this.userKey(authenticatedUser.id), {
            profile_image: profileImage,
            description
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

    private async createUser(name:string, username:string, email:string, password:string) {
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
                    pokemonParty: DEFAULT_POKEMON_PARTY
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
        }

        if (Object.keys(defaultFields).length > 0) {
            await this.redis.hSet(this.userKey(userId), defaultFields);
        }

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
            pokemonParty: user.pokemonParty
        };
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

            return parsed
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
        } catch {
            return DEFAULT_INVENTORY;
        }
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

            return parsed
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
                .map((pokemon) => ({
                    ...pokemon,
                    level: Math.max(1, Math.round(pokemon.level)),
                    hp: Math.max(0, Math.round(pokemon.hp)),
                    maxHp: Math.max(1, Math.round(pokemon.maxHp)),
                    types: pokemon.types.filter((type): type is string => typeof type === "string"),
                    moves: pokemon.moves.filter((move): move is string => typeof move === "string")
                }));
        } catch {
            return DEFAULT_POKEMON_PARTY;
        }
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
