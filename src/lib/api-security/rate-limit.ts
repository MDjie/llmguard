import type { ApiRateLimiter, RateLimitPolicy, RateLimitResult } from './types';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class MemoryRateLimiter implements ApiRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private operations = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {}

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const now = this.now();
    this.operations += 1;

    if (this.operations % 256 === 0 || this.entries.size >= this.maxEntries) {
      this.removeExpired(now);
    }

    const storageKey = `${policy.id}:${key}`;
    let entry = this.entries.get(storageKey);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + policy.windowMs };
      this.entries.set(storageKey, entry);
    }

    if (entry.count >= policy.maxRequests) {
      return this.result(false, entry, policy, now);
    }

    entry.count += 1;
    return this.result(true, entry, policy, now);
  }

  clear(): void {
    this.entries.clear();
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
      }
    }

    if (this.entries.size >= this.maxEntries) {
      const overflow = this.entries.size - this.maxEntries + 1;
      for (const key of this.entries.keys()) {
        this.entries.delete(key);
        if (this.entries.size <= this.maxEntries - overflow) {
          break;
        }
      }
    }
  }

  private result(
    allowed: boolean,
    entry: RateLimitEntry,
    policy: RateLimitPolicy,
    now: number,
  ): RateLimitResult {
    return {
      allowed,
      limit: policy.maxRequests,
      remaining: Math.max(0, policy.maxRequests - entry.count),
      resetAt: entry.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)),
    };
  }
}
