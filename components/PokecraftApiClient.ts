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

/**
 * Species summary/detail payloads proxied for the client's CanaimaDex tab.
 * Shapes mirror pokecraft-api's SpeciesResource records; fields the game
 * doesn't render are passed through untyped.
 */
export interface SpeciesSummary {
    id: number;
    projectId: number;
    pokemonId: string;
    dexNumber: number;
    name: string;
    internalName: string | null;
    [key: string]: unknown;
}

export interface SpeciesDetail extends SpeciesSummary {
    category: string;
    growthRate: string;
    // Pokedex entry text; absent when prod runs a pokecraft-api build that
    // predates the description field.
    description?: string | null;
    types: string[];
    stats: Record<string, unknown> | null;
    abilities: unknown[];
    learnset: unknown[];
    evolutions: unknown[];
    sprites: Record<string, string | null>;
    foundOn: Array<{
        mapId: number;
        mapName: string | null;
        method: string;
        levelMin: number;
        levelMax: number;
    }>;
}

interface PagedResult<T> {
    items: T[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
}

export class PokecraftApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = "PokecraftApiError";
    }
}

const SPECIES_CACHE_TTL_MS = 10 * 60 * 1000;
const SPECIES_LIST_PAGE_SIZE = 30; // pokecraft-api caps `n` at 30

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

    // internalName (upper-cased) -> pokemonId. Depending on the migrated dump,
    // species pokemonId is either the legacy InternalName itself (v21 PBS) or
    // the numeric dex string with InternalName tucked in raw_properties (the
    // Venova BW dump), so lookups by the client's essentialsId need this index.
    private speciesIndex: { builtAt: number; byInternalName: Map<string, string> } | null = null;
    private speciesDetailCache = new Map<string, { fetchedAt: number; detail: SpeciesDetail }>();

    /**
     * Species detail for the client CanaimaDex tab, looked up by the designer
     * catalog's essentialsId (the legacy Essentials InternalName). Returns
     * null when the species is unknown; throws PokecraftApiError on transport
     * or auth problems.
     */
    public async getSpeciesDetailByEssentialsId(essentialsId: string): Promise<SpeciesDetail | null> {
        const key = essentialsId.trim().toUpperCase();
        if (!key) {
            return null;
        }

        const cached = this.speciesDetailCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < SPECIES_CACHE_TTL_MS) {
            return cached.detail;
        }

        // Fast path: pokemonId IS the InternalName in v21-style dumps.
        let detail = await this.fetchSpeciesDetail(key);

        if (!detail) {
            const index = await this.getSpeciesIndex();
            const pokemonId = index.get(key);
            detail = pokemonId ? await this.fetchSpeciesDetail(pokemonId) : null;
        }

        if (detail) {
            this.speciesDetailCache.set(key, { fetchedAt: Date.now(), detail });
        }
        return detail;
    }

    private async fetchSpeciesDetail(pokemonId: string): Promise<SpeciesDetail | null> {
        try {
            return await this.request<SpeciesDetail>(
                "GET",
                `/api/species/${encodeURIComponent(pokemonId)}`
            );
        } catch (error) {
            if (error instanceof PokecraftApiError && error.status === 404) {
                return null;
            }
            throw error;
        }
    }

    private async getSpeciesIndex(): Promise<Map<string, string>> {
        if (this.speciesIndex && Date.now() - this.speciesIndex.builtAt < SPECIES_CACHE_TTL_MS) {
            return this.speciesIndex.byInternalName;
        }

        const byInternalName = new Map<string, string>();
        let page = 1;
        let totalPages = 1;

        do {
            const result = await this.request<PagedResult<SpeciesSummary>>(
                "GET",
                `/api/species?page=${page}&n=${SPECIES_LIST_PAGE_SIZE}`
            );
            for (const summary of result.items) {
                if (summary.internalName) {
                    byInternalName.set(summary.internalName.toUpperCase(), summary.pokemonId);
                }
            }
            totalPages = Math.max(1, result.totalPages ?? 1);
            page += 1;
        } while (page <= totalPages);

        this.speciesIndex = { builtAt: Date.now(), byInternalName };
        return byInternalName;
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
