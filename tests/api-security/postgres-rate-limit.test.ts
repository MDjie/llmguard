import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { MemoryRateLimiter } from '../../src/lib/api-security/rate-limit';
import {
  PostgresRateLimiter,
  type SqlExecutor,
} from '../../src/lib/api-security/postgres-rate-limit';
import type { RateLimitPolicy } from '../../src/lib/api-security/types';

const policy: RateLimitPolicy = {
  id: 'test-policy',
  windowMs: 60_000,
  maxRequests: 3,
  scope: 'principal',
};

// 时钟取值使 now - 0 < CLEANUP_INTERVAL_MS(10 分钟)，避免触发过期清理
//（清理的 DELETE 也会打到执行器，与计数语义无关）
const T = 300_000;

/** 模拟共享计数：所有副本（实例）对同一键落到同一计数器 */
function sharedCounterDb(): SqlExecutor {
  const store = new Map<string, number>();
  return async () => {
    const count = (store.get('bucket') ?? 0) + 1;
    store.set('bucket', count);
    return { rows: [{ count }] };
  };
}

describe('PostgresRateLimiter', () => {
  it('shares one counter across limiter instances and denies past the limit', async () => {
    // 两个“副本”共用同一个数据库计数器
    const executor = sharedCounterDb();
    const replicaA = new PostgresRateLimiter(executor, () => T);
    const replicaB = new PostgresRateLimiter(executor, () => T);
    const results = [
      await replicaA.consume('principal-1', policy),
      await replicaB.consume('principal-1', policy),
      await replicaA.consume('principal-1', policy),
      await replicaB.consume('principal-1', policy),
    ];
    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false]);
    expect(results[3].remaining).toBe(0);
    expect(results[3].retryAfterSeconds).toBeGreaterThan(0);
  });

  it('aligns windows to wall-clock boundaries so all replicas share the row', async () => {
    const executor: SqlExecutor = async () => ({ rows: [{ count: 1 }] });
    const limiter = new PostgresRateLimiter(executor, () => 1_000_000);
    const result = await limiter.consume('principal-1', policy);
    expect(result.allowed).toBe(true);
    // now=1_000_000ms、窗口 60s → 边界 960_000，resetAt = 1_020_000
    expect(result.resetAt).toBe(1_020_000);
    expect(result.remaining).toBe(policy.maxRequests - 1);
  });

  it('falls back to the in-process limiter when the database errors', async () => {
    const fallback = new MemoryRateLimiter(() => T);
    let fallbackErrors = 0;
    const limiter = new PostgresRateLimiter(
      async () => { throw new Error('connection refused'); },
      () => T,
      fallback,
      () => { fallbackErrors += 1; },
    );
    // 每次失败都降级且计数在内存限流器中累积
    const attempts = [];
    for (let i = 0; i < 4; i += 1) attempts.push(await limiter.consume('principal-1', policy));
    expect(attempts.map((attempt) => attempt.allowed)).toEqual([true, true, true, false]);
    expect(fallbackErrors).toBe(4);
  });

  it('recovers to the database counter after a transient outage', async () => {
    const executor = sharedCounterDb();
    let outage = true;
    const limiter = new PostgresRateLimiter(
      async (query: SQL) => {
        if (outage) throw new Error('transient');
        return executor(query);
      },
      () => T,
      new MemoryRateLimiter(() => T),
    );
    expect((await limiter.consume('principal-1', policy)).allowed).toBe(true); // 走降级
    outage = false;
    const recovered = await limiter.consume('principal-1', policy); // 走数据库，count=1
    expect(recovered.allowed).toBe(true);
    expect(recovered.remaining).toBe(policy.maxRequests - 1);
  });
});
