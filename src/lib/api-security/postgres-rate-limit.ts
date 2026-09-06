import { createHash } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { MemoryRateLimiter } from './rate-limit';
import type { ApiRateLimiter, RateLimitPolicy, RateLimitResult } from './types';

/** 执行原生 SQL 的最小接口，便于测试注入 */
export type SqlExecutor = (query: SQL) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

/** 过期窗口的清理间隔：限流本身就是高频路径，清理必须节流 */
const CLEANUP_INTERVAL_MS = 10 * 60_000;
/** 保留时长：取常见窗口（≤10 分钟）的冗余，超窗行直接删除 */
const RETENTION_MS = 2 * 60 * 60_000;

/**
 * Postgres 固定窗口限流器：多副本共享计数（INSERT ON CONFLICT 原子自增），
 * 替代进程内 MemoryRateLimiter 在 N 副本下限额 ×N 的问题。
 * DB 不可用时降级到进程内限流——可用性优先，语义等同单机部署。
 */
export class PostgresRateLimiter implements ApiRateLimiter {
  private lastCleanupAt = 0;

  constructor(
    private readonly executeSql: SqlExecutor,
    private readonly now: () => number = Date.now,
    private readonly fallback: ApiRateLimiter = new MemoryRateLimiter(),
    private readonly onFallback?: (error: unknown) => void,
  ) {}

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const now = this.now();
    // 窗口对齐墙钟：所有副本对同一键落入同一窗口行
    const windowStart = new Date(Math.floor(now / policy.windowMs) * policy.windowMs);
    const resetAt = windowStart.getTime() + policy.windowMs;
    // 键做 sha256：定长、避免共享表中泄漏主体标识符
    const bucketKey = createHash('sha256').update(`${policy.id}:${key}`).digest('hex');

    try {
      const result = await this.executeSql(sql`
        INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
        VALUES (${bucketKey}, ${windowStart}, 1)
        ON CONFLICT (bucket_key, window_start)
        DO UPDATE SET count = rate_limit_buckets.count + 1
        RETURNING count
      `);
      const count = Number(result.rows[0]?.count ?? 0);
      if (count > 1) await this.cleanupExpired(now);
      return {
        allowed: count <= policy.maxRequests,
        limit: policy.maxRequests,
        remaining: Math.max(0, policy.maxRequests - count),
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1_000)),
      };
    } catch (error) {
      this.onFallback?.(error);
      return this.fallback.consume(key, policy);
    }
  }

  private async cleanupExpired(now: number): Promise<void> {
    if (now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    this.lastCleanupAt = now;
    try {
      await this.executeSql(sql`
        DELETE FROM rate_limit_buckets
        WHERE window_start < ${new Date(now - RETENTION_MS)}
      `);
    } catch {
      // 清理失败不影响限流主路径，下个周期重试
    }
  }
}

export function databaseRateLimitConfigured(): boolean {
  return Boolean(
    process.env.PGDATABASE_URL || process.env.COZE_SUPABASE_DB_URL || process.env.DATABASE_URL,
  );
}
