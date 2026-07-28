/**
 * Redis persistence for trading.
 *
 * Live session state is authoritative in memory (TradeManager); this store
 * exists for the things that must outlive a socket, a process, or the trade
 * itself:
 *
 *   - `trade:active:user:{id}`   one-trade-per-player constraint, taken with
 *                                SET NX so two concurrent requests cannot both
 *                                win. This is the database-level uniqueness
 *                                rule the application logic leans on.
 *   - `trade:session:{id}`       last known state, for reconnect + boot sweep.
 *   - `trade:chat:{id}`          bounded, TTL'd chat log for moderation.
 *   - `trade:audit:{id}`         permanent audit record for completed/failed
 *                                trades. Never expires.
 *   - `trade:history:{userId}`   capped list of trade ids for the player-facing
 *                                history view.
 *   - `trade:index:*`            sorted sets powering moderation search and
 *                                repeated-partner / volume detection.
 *
 * Nothing here ever returns raw internal keys to a client — the manager
 * projects everything into the public payload shapes first.
 */

import type { RedisClientType } from "redis";
import type {
  TradeAuditRecord,
  TradeChatMessage,
  TradeConfig,
  TradeSideKey,
  TradeSnapshot,
  TradeState
} from "./tradeTypes";

const ACTIVE_INDEX_KEY = "trade:active:index";
const COMPLETED_INDEX_KEY = "trade:index:completed";
const REPORTS_INDEX_KEY = "trade:reports:index";

/** What we persist about a live session so a restart can clean up after it. */
export interface PersistedTradeSession {
  tradeId: string;
  playerAId: number;
  playerBId: number;
  state: TradeState;
  version: number;
  snapshotHash: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface TradeReport {
  tradeId: string;
  reporterUserId: number;
  reportedUserId: number;
  reason: string;
  explanation: string;
  createdAt: string;
}

export interface ModerationTradeRow {
  tradeId: string;
  completedAt: string;
  result: TradeAuditRecord["result"];
  playerAId: number;
  playerBId: number;
  playerAUsername: string;
  playerBUsername: string;
  moderationFlags: string[];
  currency: Record<TradeSideKey, number>;
  itemCount: Record<TradeSideKey, number>;
  venomonCount: Record<TradeSideKey, number>;
}

export default class TradeStore {
  constructor(
    private readonly redis: RedisClientType,
    private readonly config: TradeConfig
  ) {}

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  private sessionKey(tradeId: string) {
    return `trade:session:${tradeId}`;
  }

  private activeKey(userId: number) {
    return `trade:active:user:${userId}`;
  }

  private chatKey(tradeId: string) {
    return `trade:chat:${tradeId}`;
  }

  private auditKey(tradeId: string) {
    return `trade:audit:${tradeId}`;
  }

  private historyKey(userId: number) {
    return `trade:history:${userId}`;
  }

  private userIndexKey(userId: number) {
    return `trade:index:user:${userId}`;
  }

  private pairIndexKey(userIdA: number, userIdB: number) {
    const [low, high] = userIdA <= userIdB ? [userIdA, userIdB] : [userIdB, userIdA];
    return `trade:index:pair:${low}:${high}`;
  }

  private notesKey(tradeId: string) {
    return `trade:notes:${tradeId}`;
  }

  private tradingDisabledKey(userId: number) {
    return `trade:disabled:user:${userId}`;
  }

  private idempotencyKey(tradeId: string, key: string) {
    return `trade:idem:${tradeId}:${key}`;
  }

  // -------------------------------------------------------------------------
  // One-trade-per-player constraint
  // -------------------------------------------------------------------------

  /**
   * Claims one player for a trade.
   *
   * SET NX is the uniqueness constraint behind one-trade-per-player: two
   * concurrent requests cannot both win it. Re-claiming for the *same* trade
   * id succeeds (the requester already holds the claim from `trade:request`
   * when they reach `trade:request:accept`), and refreshes the TTL.
   */
  public async claimParticipant(tradeId: string, userId: number): Promise<boolean> {
    const ttlSeconds = Math.ceil(this.config.sessionTtlMs / 1000);

    const claimed = await this.redis.set(this.activeKey(userId), tradeId, {
      condition: "NX",
      expiration: { type: "EX", value: ttlSeconds }
    });

    if (claimed === null) {
      const current = await this.redis.get(this.activeKey(userId));
      if (current !== tradeId) {
        return false;
      }
      await this.redis.expire(this.activeKey(userId), ttlSeconds);
    }

    await this.redis.sAdd(ACTIVE_INDEX_KEY, String(userId));
    return true;
  }

  /** Releases a claim, but only if it still belongs to `tradeId`. */
  public async releaseParticipant(userId: number, tradeId: string): Promise<void> {
    const current = await this.redis.get(this.activeKey(userId));
    if (current === tradeId || current === null) {
      await this.redis.del(this.activeKey(userId));
      await this.redis.sRem(ACTIVE_INDEX_KEY, String(userId));
    }
  }

  public async getActiveTradeId(userId: number): Promise<string | null> {
    return this.redis.get(this.activeKey(userId));
  }

  // -------------------------------------------------------------------------
  // Session mirror
  // -------------------------------------------------------------------------

  public async saveSession(session: PersistedTradeSession): Promise<void> {
    await this.redis.set(this.sessionKey(session.tradeId), JSON.stringify(session), {
      expiration: { type: "EX", value: Math.ceil((this.config.sessionTtlMs * 2) / 1000) }
    });
  }

  public async readSession(tradeId: string): Promise<PersistedTradeSession | null> {
    const raw = await this.redis.get(this.sessionKey(tradeId));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as PersistedTradeSession;
    } catch {
      return null;
    }
  }

  /**
   * Boot sweep. Live sessions never survive a restart, so any claim still
   * present belongs to a trade that can no longer be completed: drop the
   * claims and mark the mirrored sessions FAILED so a restart can never
   * accidentally finish an unfinished trade.
   */
  public async recoverAfterRestart(): Promise<{ releasedUsers: number; failedSessions: number }> {
    let releasedUsers = 0;
    let failedSessions = 0;
    const seenTradeIds = new Set<string>();

    try {
      const userIds = await this.redis.sMembers(ACTIVE_INDEX_KEY);
      for (const rawUserId of userIds) {
        const userId = Number(rawUserId);
        if (!Number.isFinite(userId)) {
          continue;
        }
        const tradeId = await this.redis.get(this.activeKey(userId));
        if (tradeId) {
          seenTradeIds.add(tradeId);
        }
        await this.redis.del(this.activeKey(userId));
        releasedUsers += 1;
      }
      await this.redis.del(ACTIVE_INDEX_KEY);

      for (const tradeId of seenTradeIds) {
        const session = await this.readSession(tradeId);
        if (!session) {
          continue;
        }
        // PROCESSING is the only ambiguous state: the commit script may or may
        // not have run. The completion marker (checked by the executor) is the
        // tiebreaker, and it is never cleared here.
        session.state = "FAILED";
        session.updatedAt = new Date().toISOString();
        await this.saveSession(session);
        failedSessions += 1;
      }
    } catch (error) {
      console.error("trade: restart recovery failed:", error);
    }

    return { releasedUsers, failedSessions };
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  public async appendChatMessage(message: TradeChatMessage): Promise<void> {
    const key = this.chatKey(message.tradeId);
    await this.redis.rPush(key, JSON.stringify(message));
    // Bounded retention: a trade chat can never grow without limit.
    await this.redis.lTrim(key, -500, -1);
    await this.redis.expire(key, this.config.chatRetentionSeconds);
  }

  public async readChat(tradeId: string, limit = 200): Promise<TradeChatMessage[]> {
    const raw = await this.redis.lRange(this.chatKey(tradeId), -limit, -1);
    return raw
      .map((entry) => {
        try {
          return JSON.parse(entry) as TradeChatMessage;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is TradeChatMessage => entry !== null);
  }

  // -------------------------------------------------------------------------
  // Audit + history
  // -------------------------------------------------------------------------

  /** Writes the permanent audit record and every index that points at it. */
  public async writeAudit(record: TradeAuditRecord): Promise<void> {
    const completedAtMs = Date.parse(record.completedAt) || Date.now();

    await this.redis.set(this.auditKey(record.tradeId), JSON.stringify(record));
    await this.redis.zAdd(COMPLETED_INDEX_KEY, {
      score: completedAtMs,
      value: record.tradeId
    });
    await this.redis.zAdd(this.userIndexKey(record.playerAId), {
      score: completedAtMs,
      value: record.tradeId
    });
    await this.redis.zAdd(this.userIndexKey(record.playerBId), {
      score: completedAtMs,
      value: record.tradeId
    });
    await this.redis.zAdd(this.pairIndexKey(record.playerAId, record.playerBId), {
      score: completedAtMs,
      value: record.tradeId
    });

    if (record.result === "COMPLETED") {
      for (const userId of [record.playerAId, record.playerBId]) {
        await this.redis.lPush(this.historyKey(userId), record.tradeId);
        await this.redis.lTrim(this.historyKey(userId), 0, this.config.historyLimit - 1);
      }
    }
  }

  public async readAudit(tradeId: string): Promise<TradeAuditRecord | null> {
    const raw = await this.redis.get(this.auditKey(tradeId));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as TradeAuditRecord;
    } catch {
      return null;
    }
  }

  public async readHistoryIds(userId: number, offset: number, limit: number): Promise<string[]> {
    return this.redis.lRange(this.historyKey(userId), offset, offset + limit - 1);
  }

  public async countHistory(userId: number): Promise<number> {
    return this.redis.lLen(this.historyKey(userId));
  }

  // -------------------------------------------------------------------------
  // Moderation
  // -------------------------------------------------------------------------

  /** Newest-first page of completed/failed trades, optionally for one player. */
  public async searchTrades(options: {
    userId?: number;
    page: number;
    pageSize: number;
  }): Promise<{ rows: TradeAuditRecord[]; total: number }> {
    const key = typeof options.userId === "number"
      ? this.userIndexKey(options.userId)
      : COMPLETED_INDEX_KEY;

    const total = await this.redis.zCard(key);
    const start = Math.max(0, (options.page - 1) * options.pageSize);
    const stop = start + options.pageSize - 1;
    const ids = await this.redis.zRange(key, start, stop, { REV: true });

    const rows: TradeAuditRecord[] = [];
    for (const tradeId of ids) {
      const record = await this.readAudit(tradeId);
      if (record) {
        rows.push(record);
      }
    }
    return { rows, total };
  }

  /** How many trades this pair has completed since `sinceMs` (repeat partners). */
  public async countPairTrades(userIdA: number, userIdB: number, sinceMs: number): Promise<number> {
    return this.redis.zCount(this.pairIndexKey(userIdA, userIdB), sinceMs, "+inf");
  }

  /** How many trades this player completed since `sinceMs` (volume detection). */
  public async countUserTrades(userId: number, sinceMs: number): Promise<number> {
    return this.redis.zCount(this.userIndexKey(userId), sinceMs, "+inf");
  }

  public async saveReport(report: TradeReport): Promise<void> {
    await this.redis.set(
      `trade:report:${report.tradeId}:${report.reporterUserId}`,
      JSON.stringify(report)
    );
    await this.redis.zAdd(REPORTS_INDEX_KEY, {
      score: Date.parse(report.createdAt) || Date.now(),
      value: `${report.tradeId}:${report.reporterUserId}`
    });
  }

  public async listReports(page: number, pageSize: number): Promise<{ rows: TradeReport[]; total: number }> {
    const total = await this.redis.zCard(REPORTS_INDEX_KEY);
    const start = Math.max(0, (page - 1) * pageSize);
    const ids = await this.redis.zRange(REPORTS_INDEX_KEY, start, start + pageSize - 1, { REV: true });
    const rows: TradeReport[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(`trade:report:${id}`);
      if (!raw) {
        continue;
      }
      try {
        rows.push(JSON.parse(raw) as TradeReport);
      } catch {
        // Skip unreadable records rather than failing the whole page.
      }
    }
    return { rows, total };
  }

  public async addModerationNote(tradeId: string, note: {
    moderatorUserId: number;
    text: string;
    createdAt: string;
  }): Promise<void> {
    await this.redis.rPush(this.notesKey(tradeId), JSON.stringify(note));
  }

  public async readModerationNotes(tradeId: string) {
    const raw = await this.redis.lRange(this.notesKey(tradeId), 0, -1);
    return raw
      .map((entry) => {
        try {
          return JSON.parse(entry) as { moderatorUserId: number; text: string; createdAt: string };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { moderatorUserId: number; text: string; createdAt: string } => entry !== null);
  }

  /** Moderation switch: turns trading off for one account. */
  public async setTradingDisabled(userId: number, disabled: boolean, reason?: string): Promise<void> {
    if (disabled) {
      await this.redis.set(this.tradingDisabledKey(userId), reason ?? "restricted");
      return;
    }
    await this.redis.del(this.tradingDisabledKey(userId));
  }

  public async isTradingDisabled(userId: number): Promise<boolean> {
    return Boolean(await this.redis.get(this.tradingDisabledKey(userId)));
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  /**
   * Records a client-supplied idempotency key for a trade action.
   * Returns false when the key was already used, so the caller can drop the
   * repeat instead of applying it twice (double-click, socket retry, replay).
   */
  public async claimIdempotencyKey(tradeId: string, key: string): Promise<boolean> {
    const claimed = await this.redis.set(this.idempotencyKey(tradeId, key), "1", {
      condition: "NX",
      expiration: { type: "EX", value: Math.ceil((this.config.sessionTtlMs * 2) / 1000) }
    });
    return claimed !== null;
  }

  /** Removes every live artifact of a trade once it reaches a terminal state. */
  public async disposeSession(tradeId: string, playerAId: number, playerBId: number): Promise<void> {
    await Promise.all([
      this.releaseParticipant(playerAId, tradeId),
      this.releaseParticipant(playerBId, tradeId)
    ]);
  }

  /** Fetches the raw snapshot stored on an audit record (moderation view). */
  public async readAuditSnapshot(tradeId: string): Promise<TradeSnapshot | null> {
    const record = await this.readAudit(tradeId);
    return record?.finalSnapshot ?? null;
  }
}
