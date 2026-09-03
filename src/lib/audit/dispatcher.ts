import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { logger } from '@/lib/observability/logger';
import { observeAuditDelivery } from '@/lib/observability/metrics';
import { db } from '@/storage/database/shared/db';
import { auditExportOutbox } from '@/storage/database/shared/schema';
import { resolveAuditExportTargets } from './export-config';
import { sendAuditExport, type AuditExportPayload } from './exporters';

export function auditExportRetryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

function maxAttempts(environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const parsed = Number(environment.AUDIT_EXPORT_MAX_ATTEMPTS ?? '10');
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('AUDIT_EXPORT_MAX_ATTEMPTS must be between 1 and 100');
  }
  return parsed;
}

async function claimAuditExport() {
  const now = new Date();
  const staleAt = new Date(now.getTime() - 5 * 60_000);
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction.select().from(auditExportOutbox).where(or(
      and(
        inArray(auditExportOutbox.state, ['pending', 'failed']),
        lte(auditExportOutbox.nextAttemptAt, now),
      ),
      and(
        eq(auditExportOutbox.state, 'sending'),
        or(isNull(auditExportOutbox.claimedAt), lte(auditExportOutbox.claimedAt, staleAt)),
      ),
    )).orderBy(asc(auditExportOutbox.nextAttemptAt), asc(auditExportOutbox.createdAt))
      .limit(1).for('update', { skipLocked: true });
    if (!candidate || candidate.attempts >= maxAttempts()) return null;
    const [claimed] = await transaction.update(auditExportOutbox).set({
      state: 'sending',
      attempts: candidate.attempts + 1,
      claimedAt: now,
    }).where(eq(auditExportOutbox.id, candidate.id)).returning();
    return claimed ?? null;
  });
}

export async function dispatchNextAuditExport() {
  const item = await claimAuditExport();
  if (!item) return null;
  const target = resolveAuditExportTargets().find((candidate) =>
    candidate.type === item.destinationType && candidate.destination === item.destination,
  );
  try {
    if (!target) throw new Error('Configured audit export destination is no longer available');
    await sendAuditExport(target, item.payload as unknown as AuditExportPayload);
    await db.update(auditExportOutbox).set({
      state: 'delivered', deliveredAt: new Date(), claimedAt: null, lastError: null,
    }).where(and(eq(auditExportOutbox.id, item.id), eq(auditExportOutbox.state, 'sending')));
    observeAuditDelivery({ destinationType: item.destinationType, state: 'delivered' });
    return { id: item.id, state: 'delivered' as const };
  } catch (error) {
    const terminal = item.attempts >= maxAttempts();
    const message = (error instanceof Error ? error.message : 'Unknown audit export failure').slice(0, 500);
    await db.update(auditExportOutbox).set({
      state: terminal ? 'terminal_failed' : 'failed',
      nextAttemptAt: new Date(Date.now() + auditExportRetryDelayMs(item.attempts)),
      claimedAt: null,
      lastError: message,
    }).where(and(eq(auditExportOutbox.id, item.id), eq(auditExportOutbox.state, 'sending')));
    const result = { id: item.id, state: terminal ? 'terminal_failed' as const : 'failed' as const };
    observeAuditDelivery({
      destinationType: item.destinationType,
      state: terminal ? 'terminal_failed' : 'failed',
    });
    if (terminal) logger.error('audit.export.terminal_failed', { id: item.id, destination: item.destination, attempts: item.attempts, error });
    else logger.warn('audit.export.failed', { id: item.id, destination: item.destination, attempts: item.attempts, error });
    return result;
  }
}
