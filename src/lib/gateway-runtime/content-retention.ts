import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { dataDeletionProofs, gatewayRequests, gatewaySteps } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { appendAuditEventInTransaction } from '@/lib/audit/repository';
import { buildDeletionProof, lineageObjectIdDigest } from '@/lib/data-protection/lineage';
import { rawContentRetentionDays } from '@/lib/data-protection/retention';
import { canonicalJson, GatewayError } from './protocol';
import { evidenceHmac } from './security';

export const gatewayContentHoldSchema = z.object({ requestId: z.string().regex(/^[-_a-zA-Z0-9]{1,128}$/u),
  expectedVersion: z.number().int().nonnegative(), holdUntil: z.iso.datetime().nullable(), reason: z.string().trim().min(1).max(1000),
}).strict();
export async function setGatewayContentHold(scope: TenantScope, actorId: string, raw: unknown, now = new Date()) {
  const input = gatewayContentHoldSchema.parse(raw), until = input.holdUntil ? new Date(input.holdUntil) : null;
  if (until && (until <= now || until.getTime() > now.getTime() + 3650 * 86400000)) throw new GatewayError('CONTENT_HOLD_EXPIRY_INVALID', 400);
  return db.transaction(async transaction => {
    const [request] = await transaction.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.id, input.requestId))).for('update');
    if (!request) throw new GatewayError('REQUEST_NOT_FOUND', 404);
    if (request.contentPurgedAt) throw new GatewayError('CONTENT_ALREADY_PURGED', 409);
    if (request.retentionVersion !== input.expectedVersion) throw new GatewayError('CONTENT_HOLD_VERSION_CONFLICT', 409);
    await transaction.update(gatewayRequests).set({ contentHoldUntil: until, contentHoldReasonHmac: evidenceHmac(input.reason), retentionVersion: request.retentionVersion + 1 })
      .where(and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.id, request.id)));
    await appendAuditEventInTransaction(transaction, { ...scope, principalId: actorId, event: until ? 'gateway.content.hold' : 'gateway.content.hold-release',
      outcome: 'ALLOWED', status: 200, requestId: randomUUID(), traceId: request.id, method: 'POST', path: '/api/gateway/content-retention', latencyMs: 0,
      queryString: 'sha256=' + evidenceHmac(canonicalJson({ requestId: request.id, until: input.holdUntil, reason: input.reason, version: request.retentionVersion + 1 })) });
    return { requestId: request.id, holdUntil: until?.toISOString() ?? null, version: request.retentionVersion + 1 };
  });
}

/** Purges encrypted content only; execution digests and idempotency tombstones remain addressable. */
export async function purgeGatewayContent(scope?: TenantScope, now = new Date(), maximumRequests = 100) {
  if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1 || maximumRequests > 100) throw new Error('GATEWAY_CONTENT_PURGE_LIMIT_INVALID');
  const hours = Number(process.env.GATEWAY_CONTENT_RETENTION_HOURS ?? 1);
  if (!Number.isInteger(hours) || hours < 1 || hours > 87600) throw new Error('GATEWAY_CONTENT_RETENTION_HOURS_INVALID');
  const cutoff = new Date(now.getTime() - Math.min(hours, rawContentRetentionDays() * 24) * 3600000);
  const eligible = and(isNull(gatewayRequests.contentPurgedAt), eq(gatewayRequests.sessionFinalized, true), lte(gatewayRequests.expiresAt, cutoff),
    inArray(gatewayRequests.state, ['COMPLETED', 'TERMINATED', 'REVIEW_REQUIRED', 'UPSTREAM_OUTCOME_UNKNOWN']),
    or(isNull(gatewayRequests.contentHoldUntil), lte(gatewayRequests.contentHoldUntil, now)),
    sql`NOT EXISTS(SELECT 1 FROM gateway_steps st WHERE st.tenant_id=${gatewayRequests.tenantId} AND st.application_id=${gatewayRequests.applicationId} AND st.request_id=${gatewayRequests.id} AND st.status='RUNNING')`);
  return db.transaction(async transaction => {
    const [candidate] = scope ? [{ tenantId: scope.tenantId, applicationId: scope.applicationId }] : await transaction.select({ tenantId: gatewayRequests.tenantId, applicationId: gatewayRequests.applicationId })
      .from(gatewayRequests).where(eligible).orderBy(asc(gatewayRequests.expiresAt)).limit(1);
    if (!candidate) return null;
    const requests = await transaction.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, candidate), eligible))
      .orderBy(asc(gatewayRequests.expiresAt), asc(gatewayRequests.id)).limit(maximumRequests).for('update', { skipLocked: true });
    if (!requests.length) return null;
    const ids = requests.map(request => request.id);
    const steps = await transaction.update(gatewaySteps).set({ decisionEnvelope: null }).where(and(scopePredicate(gatewaySteps, candidate), inArray(gatewaySteps.requestId, ids), sql`${gatewaySteps.decisionEnvelope} IS NOT NULL`)).returning({ id: gatewaySteps.id });
    const proof = buildDeletionProof({ cutoff, completedAt: now,
      manifest: [{ objectType: 'GATEWAY_REQUEST_CONTENT', count: requests.length, idDigest: lineageObjectIdDigest(ids) },
        { objectType: 'GATEWAY_STEP_CONTENT', count: steps.length, idDigest: lineageObjectIdDigest(steps.map(step => step.id)) }],
      phases: { database: { state: 'COMPLETE', evidence: canonicalJson({ ...candidate, requestCount: requests.length, stepCount: steps.length, tombstonesRetained: true }) },
        objectStore: { state: requests.some(request => request.responseRef !== null) ? 'PENDING_EXTERNAL' : 'NOT_APPLICABLE', evidence: 'Referenced source artifacts follow their own owner retention; this task purges gateway database content only.' },
        searchIndex: { state: 'NOT_APPLICABLE' }, backup: { state: 'PENDING_EXTERNAL', evidence: 'Encrypted backup expiry and legal holds are governed by the deployment backup policy.' } } });
    await transaction.insert(dataDeletionProofs).values({ proofId: proof.proofId, version: proof.version, cutoff: new Date(proof.cutoff), manifest: [...proof.manifest],
      phases: proof.phases, completedAt: new Date(proof.completedAt), keyId: proof.keyId, signature: proof.signature });
    await transaction.update(gatewayRequests).set({ sessionSnapshot: null, contentPurgedAt: now, deletionProofId: proof.proofId, retentionVersion: sql`${gatewayRequests.retentionVersion} + 1` })
      .where(and(scopePredicate(gatewayRequests, candidate), inArray(gatewayRequests.id, ids)));
    await appendAuditEventInTransaction(transaction, { ...candidate, event: 'gateway.content.purged', outcome: 'ALLOWED', status: 200,
      requestId: proof.proofId, traceId: proof.proofId, method: 'INTERNAL', path: '/api/gateway/content-retention', latencyMs: 0 });
    return { requests: requests.length, steps: steps.length, deletionProofId: proof.proofId, backupStatus: 'PENDING_EXTERNAL' as const };
  });
}

export async function readGatewayContentRetention(scope: TenantScope, requestId: string) {
  const [request] = await db.select({ requestId: gatewayRequests.id, holdUntil: gatewayRequests.contentHoldUntil, version: gatewayRequests.retentionVersion,
    contentPurgedAt: gatewayRequests.contentPurgedAt, deletionProofId: gatewayRequests.deletionProofId }).from(gatewayRequests)
    .where(and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.id, requestId))).limit(1);
  if (!request) return null;
  const proof = request.deletionProofId ? (await db.select({ proofId: dataDeletionProofs.proofId, version: dataDeletionProofs.version,
    cutoff: dataDeletionProofs.cutoff, manifest: dataDeletionProofs.manifest, phases: dataDeletionProofs.phases, completedAt: dataDeletionProofs.completedAt,
    keyId: dataDeletionProofs.keyId, signature: dataDeletionProofs.signature }).from(dataDeletionProofs).where(eq(dataDeletionProofs.proofId, request.deletionProofId)).limit(1))[0] : null;
  return { ...request, proof: proof ?? null };
}
