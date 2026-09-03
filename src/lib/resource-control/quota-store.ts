import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import type { TenantScope } from '@/lib/tenancy';
import { scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  guardQuotaCharges,
  guardQuotaCounters,
} from '@/storage/database/shared/schema';
import type { GuardQuotaLimit } from './admission-config';
import type { QuotaClaim, QuotaWindow } from './quota-plan';

export class QuotaLimitExceededError extends Error {
  constructor(
    readonly claim: QuotaClaim,
    readonly limit: number,
    readonly used: number,
  ) {
    super('GUARD_QUOTA_EXCEEDED');
    this.name = 'QuotaLimitExceededError';
  }
}

export class QuotaRequestReplayError extends Error {
  constructor() {
    super('GUARD_QUOTA_REQUEST_REPLAYED');
    this.name = 'QuotaRequestReplayError';
  }
}

export interface QuotaReservation {
  readonly releaseChargeIds: readonly string[];
}

export interface GuardQuotaStore {
  reserve(input: {
    readonly scope: TenantScope;
    readonly policyBundleId: string;
    readonly requestId: string;
    readonly claims: readonly QuotaClaim[];
    readonly limits: readonly GuardQuotaLimit[];
    readonly concurrencyLeaseMs: number;
    readonly now?: Date;
  }): Promise<QuotaReservation>;
  release(scope: TenantScope, chargeIds: readonly string[], now?: Date): Promise<void>;
}

function windowRange(window: QuotaWindow, now: Date): { start: Date; end: Date } {
  if (window === 'INSTANT') {
    return { start: new Date('2000-01-01T00:00:00.000Z'), end: new Date('3000-01-01T00:00:00.000Z') };
  }
  if (window === 'MINUTE') {
    const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    return { start, end: new Date(start.getTime() + 60_000) };
  }
  if (window === 'DAY') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1_000) };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    start,
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function limitKey(input: Pick<QuotaClaim, 'scopeType' | 'metric' | 'window'>): string {
  return [input.scopeType, input.metric, input.window].join(':');
}

function sortedClaims(claims: readonly QuotaClaim[]): readonly QuotaClaim[] {
  return [...claims].sort((left, right) =>
    [
      left.scopeType, left.scopeId, left.metric, left.window,
    ].join(':').localeCompare([
      right.scopeType, right.scopeId, right.metric, right.window,
    ].join(':')));
}

export class PostgresGuardQuotaStore implements GuardQuotaStore {
  async recoverExpiredLeases(now = new Date()): Promise<number> {
    return db.transaction(async (transaction) => {
      const expired = await transaction.select().from(guardQuotaCharges).where(and(
        eq(guardQuotaCharges.releaseRequired, true),
        isNull(guardQuotaCharges.releasedAt),
        lt(guardQuotaCharges.expiresAt, now),
      )).orderBy(asc(guardQuotaCharges.expiresAt)).limit(200).for('update', { skipLocked: true });
      for (const charge of expired) {
        const [counter] = await transaction.select().from(guardQuotaCounters).where(
          eq(guardQuotaCounters.id, charge.counterId),
        ).limit(1).for('update');
        if (counter) {
          await transaction.update(guardQuotaCounters).set({
            used: Math.max(0, counter.used - charge.amount),
            updatedAt: now,
          }).where(eq(guardQuotaCounters.id, counter.id));
        }
        await transaction.update(guardQuotaCharges).set({ releasedAt: now }).where(and(
          eq(guardQuotaCharges.id, charge.id),
          isNull(guardQuotaCharges.releasedAt),
        ));
      }
      return expired.length;
    });
  }

  async reserve(input: {
    readonly scope: TenantScope;
    readonly policyBundleId: string;
    readonly requestId: string;
    readonly claims: readonly QuotaClaim[];
    readonly limits: readonly GuardQuotaLimit[];
    readonly concurrencyLeaseMs: number;
    readonly now?: Date;
  }): Promise<QuotaReservation> {
    const now = input.now ?? new Date();
    await this.recoverExpiredLeases(now);
    const limits = new Map(input.limits.map((limit) => [limitKey(limit), limit.limit]));
    return db.transaction(async (transaction) => {
      const releaseChargeIds: string[] = [];
      for (const claim of sortedClaims(input.claims)) {
        const limit = limits.get(limitKey(claim));
        if (limit === undefined) throw new Error('GUARD_QUOTA_LIMIT_COVERAGE_MISSING');
        const range = windowRange(claim.window, now);
        await transaction.insert(guardQuotaCounters).values({
          ...input.scope,
          policyBundleId: input.policyBundleId,
          scopeType: claim.scopeType,
          scopeId: claim.scopeId,
          metric: claim.metric,
          window: claim.window,
          windowStart: range.start,
          windowEnd: range.end,
          limitValue: limit,
        }).onConflictDoNothing({
          target: [
            guardQuotaCounters.tenantId,
            guardQuotaCounters.applicationId,
            guardQuotaCounters.policyBundleId,
            guardQuotaCounters.scopeType,
            guardQuotaCounters.scopeId,
            guardQuotaCounters.metric,
            guardQuotaCounters.window,
            guardQuotaCounters.windowStart,
          ],
        });
        const [counter] = await transaction.select().from(guardQuotaCounters).where(and(
          scopePredicate(guardQuotaCounters, input.scope),
          eq(guardQuotaCounters.policyBundleId, input.policyBundleId),
          eq(guardQuotaCounters.scopeType, claim.scopeType),
          eq(guardQuotaCounters.scopeId, claim.scopeId),
          eq(guardQuotaCounters.metric, claim.metric),
          eq(guardQuotaCounters.window, claim.window),
          eq(guardQuotaCounters.windowStart, range.start),
        )).limit(1).for('update');
        if (!counter || counter.limitValue !== limit) {
          throw new Error('GUARD_QUOTA_POLICY_COUNTER_MISMATCH');
        }
        const [existing] = await transaction.select().from(guardQuotaCharges).where(and(
          scopePredicate(guardQuotaCharges, input.scope),
          eq(guardQuotaCharges.counterId, counter.id),
          eq(guardQuotaCharges.requestId, input.requestId),
        )).limit(1);
        if (existing) {
          if (existing.releaseRequired) throw new QuotaRequestReplayError();
          continue;
        }
        if (counter.used + claim.amount > limit) {
          throw new QuotaLimitExceededError(claim, limit, counter.used);
        }
        await transaction.update(guardQuotaCounters).set({
          used: counter.used + claim.amount,
          updatedAt: now,
        }).where(eq(guardQuotaCounters.id, counter.id));
        const releaseRequired = claim.metric === 'CONCURRENCY';
        const [charge] = await transaction.insert(guardQuotaCharges).values({
          ...input.scope,
          counterId: counter.id,
          requestId: input.requestId,
          amount: claim.amount,
          releaseRequired,
          expiresAt: releaseRequired
            ? new Date(now.getTime() + input.concurrencyLeaseMs)
            : null,
        }).returning();
        if (releaseRequired && charge) releaseChargeIds.push(charge.id);
      }
      return { releaseChargeIds };
    });
  }

  async release(scope: TenantScope, chargeIds: readonly string[], now = new Date()): Promise<void> {
    if (chargeIds.length === 0) return;
    await db.transaction(async (transaction) => {
      for (const chargeId of [...new Set(chargeIds)].sort()) {
        const [charge] = await transaction.select().from(guardQuotaCharges).where(and(
          eq(guardQuotaCharges.id, chargeId),
          scopePredicate(guardQuotaCharges, scope),
        )).limit(1).for('update');
        if (!charge || charge.releasedAt !== null || !charge.releaseRequired) continue;
        const [counter] = await transaction.select().from(guardQuotaCounters).where(and(
          eq(guardQuotaCounters.id, charge.counterId),
          scopePredicate(guardQuotaCounters, scope),
        )).limit(1).for('update');
        if (counter) {
          await transaction.update(guardQuotaCounters).set({
            used: Math.max(0, counter.used - charge.amount),
            updatedAt: now,
          }).where(eq(guardQuotaCounters.id, counter.id));
        }
        await transaction.update(guardQuotaCharges).set({ releasedAt: now }).where(and(
          eq(guardQuotaCharges.id, charge.id),
          isNull(guardQuotaCharges.releasedAt),
        ));
      }
    });
  }
}
