/**
 * Thin server-side client for the pokecraft-api (Quarkus) authoritative data
 * store. server-poke.io is a trusted sidecar: it holds a single admin-scoped
 * API key (POKECRAFT_API_ADMIN_KEY) and uses it to manage keys on behalf of
 * authenticated admins in the client-poke.io admin UI. The browser never talks
 * to pokecraft-api directly, so the admin key stays server-side only.
 */

export type ApiKeyScope = "read" | "write" | "admin";

export interface ApiKeySummary {
    id: number;
    name: string;
    keyPrefix: string;
    scopes: ApiKeyScope[];
    createdBy: string | null;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    enabled: boolean;
    status: "active" | "revoked" | "disabled" | "expired";
}

export interface CreatedApiKey {
    key: string;
    meta: ApiKeySummary;
}

export interface CreateApiKeyInput {
    name: string;
    scopes: ApiKeyScope[];
    createdBy?: string;
    expiresInDays?: number;
}

export class PokecraftApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = "PokecraftApiError";
    }
}

export default class PokecraftApiClient {
    private readonly baseUrl: string;
    private readonly adminKey: string;

    constructor(
        baseUrl = process.env.POKECRAFT_API_URL || "http://localhost:8080",
        adminKey = process.env.POKECRAFT_API_ADMIN_KEY || ""
    ) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.adminKey = adminKey;
    }

    /** True when an admin key is configured; handlers should fail gracefully otherwise. */
    public isConfigured(): boolean {
        return this.adminKey.length > 0;
    }

    public async listApiKeys(): Promise<ApiKeySummary[]> {
        return this.request<ApiKeySummary[]>("GET", "/api/admin/api-keys");
    }

    public async createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
        return this.request<CreatedApiKey>("POST", "/api/admin/api-keys", {
            name: input.name,
            scopes: input.scopes,
            createdBy: input.createdBy,
            expiresInDays: input.expiresInDays
        });
    }

    public async revokeApiKey(id: number): Promise<void> {
        await this.request<void>("DELETE", `/api/admin/api-keys/${id}`);
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        if (!this.isConfigured()) {
            throw new PokecraftApiError(
                "pokecraft-api admin key is not configured (set POKECRAFT_API_ADMIN_KEY).",
                503
            );
        }

        let response: Response;
        try {
            response = await fetch(this.baseUrl + path, {
                method,
                headers: {
                    Authorization: `Bearer ${this.adminKey}`,
                    ...(body !== undefined ? { "Content-Type": "application/json" } : {})
                },
                body: body !== undefined ? JSON.stringify(body) : undefined
            });
        } catch (cause) {
            throw new PokecraftApiError(
                `Unable to reach pokecraft-api at ${this.baseUrl}.`,
                502
            );
        }

        if (!response.ok) {
            let message = `pokecraft-api returned ${response.status}.`;
            try {
                const payload = await response.json() as { error?: string };
                if (payload?.error) {
                    message = payload.error;
                }
            } catch {
                // non-JSON error body — keep the generic message
            }
            throw new PokecraftApiError(message, response.status);
        }

        if (response.status === 204) {
            return undefined as T;
        }
        return await response.json() as T;
    }
}
