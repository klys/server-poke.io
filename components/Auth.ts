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
}

export interface AuthSessionState {
    authenticated:boolean;
    user:AuthenticatedUser | null;
    token?:string;
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
                    emailVerified: false
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

        return {
            id: Number(user.id),
            name: user.name,
            username: user.username,
            email: user.email,
            emailVerified: user.email_verified === "1",
            password_hash: user.password_hash,
            password_salt: user.password_salt,
            created_at: user.created_at
        } satisfies StoredUser;
    }

    private toAuthenticatedUser(user:StoredUser):AuthenticatedUser {
        return {
            id: user.id,
            name: user.name,
            username: user.username,
            email: user.email,
            emailVerified: user.emailVerified
        };
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
