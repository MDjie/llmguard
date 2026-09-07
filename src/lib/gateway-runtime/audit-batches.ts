import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { gatewayAuditBatches, gatewayExecutionEvents, securityAuditEvents } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { appendAuditEventInTransaction } from '@/lib/audit/repository';
import { canonicalJson, sha256 } from './protocol';
import { signPayload, verifyPayload } from './security';

const manifestSchema = z.object({ version: z.literal('1.0'), batchId: z.string().uuid(), tenantId: z.string(), applicationId: z.string(),
  events: z.array(z.object({ id: z.string(), requestId: z.string(), eventSeq: z.number().int(), recordDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(1000),
}).strict();
function recordDigest(event: typeof gatewayExecutionEvents.$inferSelect): string {
  const rest: Partial<typeof event> = { ...event }; delete rest.auditBatchId;
  return sha256(canonicalJson({ ...rest, createdAt: event.createdAt.toISOString() }));
}

/** Row locks claim a bounded batch; the anchor, export outbox and membership commit together. */
export async function anchorGatewayAuditBatch(scope?: TenantScope, maximumEvents = 500): Promise<{ id: string; count: number } | null> {
  if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 1000) throw new Error('GATEWAY_AUDIT_BATCH_LIMIT_INVALID');
  return db.transaction(async transaction => {
    const [candidate] = scope ? [scope] : await transaction.select({ tenantId: gatewayExecutionEvents.tenantId, applicationId: gatewayExecutionEvents.applicationId })
      .from(gatewayExecutionEvents).where(isNull(gatewayExecutionEvents.auditBatchId)).orderBy(asc(gatewayExecutionEvents.createdAt)).limit(1);
    if (!candidate) return null;
    const events = await transaction.select().from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, candidate), isNull(gatewayExecutionEvents.auditBatchId)))
      .orderBy(asc(gatewayExecutionEvents.createdAt), asc(gatewayExecutionEvents.id)).limit(maximumEvents).for('update', { skipLocked: true });
    if (!events.length) return null;
    const id = randomUUID(), manifest = { version: '1.0' as const, batchId: id, ...candidate,
      events: events.map(event => ({ id: event.id, requestId: event.requestId, eventSeq: event.eventSeq, recordDigest: recordDigest(event) })) };
    const digest = sha256(canonicalJson(manifest)), signature = signPayload('gateway-audit-batch-v1', manifest);
    const audit = await appendAuditEventInTransaction(transaction, { ...candidate, event: 'gateway.execution.batch', outcome: 'ALLOWED', status: 200, requestId: id, traceId: id,
      method: 'INTERNAL', path: '/api/gateway/audit-batches', queryString: 'sha256=' + digest, latencyMs: 0 });
    await transaction.insert(gatewayAuditBatches).values({ ...candidate, id, auditEventId: audit.id, manifest, digest, keyId: signature.keyId, signature: signature.signature, eventCount: events.length });
    await transaction.update(gatewayExecutionEvents).set({ auditBatchId: id }).where(and(scopePredicate(gatewayExecutionEvents, candidate), inArray(gatewayExecutionEvents.id, events.map(event => event.id)), isNull(gatewayExecutionEvents.auditBatchId)));
    return { id, count: events.length };
  });
}

export async function verifyGatewayAuditBatch(scope: TenantScope, id: string) {
  const [batch] = await db.select().from(gatewayAuditBatches).where(and(scopePredicate(gatewayAuditBatches, scope), eq(gatewayAuditBatches.id, id))).limit(1);
  if (!batch) return null;
  const m = manifestSchema.parse(batch.manifest);
  if (m.batchId !== batch.id || m.tenantId !== scope.tenantId || m.applicationId !== scope.applicationId || m.events.length !== batch.eventCount || new Set(m.events.map(e => e.id)).size !== m.events.length || sha256(canonicalJson(m)) !== batch.digest) throw new Error('GATEWAY_AUDIT_MANIFEST_INVALID');
  verifyPayload('gateway-audit-batch-v1', m, batch.keyId, batch.signature);
  const [anchor] = await db.select().from(securityAuditEvents).where(and(eq(securityAuditEvents.id, batch.auditEventId), eq(securityAuditEvents.tenantId, scope.tenantId), eq(securityAuditEvents.applicationId, scope.applicationId))).limit(1);
  if (!anchor || anchor.event !== 'gateway.execution.batch' || anchor.queryString !== 'sha256=' + batch.digest || anchor.requestId !== id) throw new Error('GATEWAY_AUDIT_ANCHOR_MISSING');
  const rows = await db.select().from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, scope), eq(gatewayExecutionEvents.auditBatchId, id)));
  if (rows.length !== m.events.length || m.events.some(entry => { const row = rows.find(r => r.id === entry.id); return !row || row.requestId !== entry.requestId || row.eventSeq !== entry.eventSeq || recordDigest(row) !== entry.recordDigest; })) throw new Error('GATEWAY_AUDIT_EVIDENCE_CHANGED');
  return { id, eventCount: batch.eventCount, digest: batch.digest, manifest: m, keyId: batch.keyId, signature: batch.signature,
    auditEventId: anchor.id, auditEventHash: anchor.eventHash, chainSequence: anchor.chainSequence, evidenceIntegrity: 'VERIFIED' as const, historicalAuditChainVerification: 'SEPARATE_AUDIT_CHAIN_CHECK' as const };
}
export async function gatewayAuditBacklog() {
  const [row] = await db.select({ events: sql<number>`least(count(*),9007199254740991)::float8`, oldestAgeSeconds: sql<number>`coalesce(extract(epoch from now()-min(${gatewayExecutionEvents.createdAt})),0)::float` })
    .from(gatewayExecutionEvents).where(isNull(gatewayExecutionEvents.auditBatchId));
  return row ?? { events: 0, oldestAgeSeconds: 0 };
}
