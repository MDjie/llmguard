import { randomUUID } from 'node:crypto';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { guardRequestSchema } from '@/contracts/http/guard-v1';
import { db } from '@/storage/database/shared/db';
import { gatewayRequests, gatewayShadowEvaluations, gatewaySteps } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { appendAuditEventInTransaction } from '@/lib/audit/repository';
import { createEngineForPolicyBundle, createProtectedContextFingerprint, evaluateWithSessionContext } from '@/lib/guard-engine-v2';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle/runtime';
import { contentSegmentSchema } from '@/contracts/http/gateway-v2';
import { readRuntimeSnapshot, validateActiveContext } from './authorization';
import { readProcessingContext } from './processing-context';
import { canonicalJson, GatewayError, sha256 } from './protocol';
import { evidenceHmac, openReceipt } from './security';
import type { GatewayTransaction } from './snapshot-factory';

const receiptSchema = z.object({ request: guardRequestSchema, segments: z.array(contentSegmentSchema) });
export async function queueGatewayShadow(tx: GatewayTransaction, scope: TenantScope, requestId: string, stepId: string, stage: string, snapshotId: string | null): Promise<void> {
  if (!snapshotId || !['INPUT', 'OUTPUT_COMPLETE'].includes(stage)) return;
  // At most two rows per request. No independent original-text copy or model/tool dispatch is queued.
  await tx.insert(gatewayShadowEvaluations).values({ id: randomUUID(), tenantId: scope.tenantId, applicationId: scope.applicationId, requestId, stepId, snapshotId }).onConflictDoNothing();
}

/** Dedicated bounded detector worker: it has no business-model or tool-executor call path. */
export async function runGatewayShadow(scope?: TenantScope): Promise<{ id: string; state: string } | null> {
  const job = await db.transaction(async tx => {
    const [row] = await tx.select().from(gatewayShadowEvaluations).where(and(scope ? scopePredicate(gatewayShadowEvaluations, scope) : undefined,
      or(eq(gatewayShadowEvaluations.state, 'PENDING'), and(eq(gatewayShadowEvaluations.state, 'RUNNING'), sql`${gatewayShadowEvaluations.claimedAt} < now() - interval '30 seconds'`))))
      .orderBy(asc(gatewayShadowEvaluations.createdAt)).limit(1).for('update', { skipLocked: true });
    if (!row) return null;
    if (row.state === 'PENDING') await tx.update(gatewayShadowEvaluations).set({ state: 'RUNNING', claimedAt: new Date() }).where(eq(gatewayShadowEvaluations.id, row.id));
    return row;
  });
  if (!job) return null;
  let state: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' = 'FAILED', reason = 'SHADOW_DETECTOR_FAILED', action: string | null = null, coverage = 'UNKNOWN', decisionId: string | null = null;
  const started = Date.now();
  try {
    // Ambiguous interrupted detector work is terminalized rather than silently invoked again.
    if (job.state === 'RUNNING') throw new GatewayError('SHADOW_PREVIOUS_OUTCOME_UNKNOWN', 503);
    const [request] = await db.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, job), eq(gatewayRequests.id, job.requestId)));
    const [step] = await db.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, job), eq(gatewaySteps.id, job.stepId), eq(gatewaySteps.requestId, job.requestId)));
    if (!request || request.shadowSnapshotId !== job.snapshotId || !step?.decisionEnvelope || !request.sessionSnapshot || !['INPUT', 'OUTPUT_COMPLETE'].includes(step.stage)) throw new GatewayError('SHADOW_SOURCE_UNAVAILABLE', 409);
    if (request.expiresAt.getTime() <= Date.now()) { state = 'SKIPPED'; throw new GatewayError('SHADOW_AUTHORIZATION_EXPIRED', 409); }
    await validateActiveContext(request.authContext);
    const snapshot = await readRuntimeSnapshot(job, job.snapshotId), bundle = await loadVerifiedPolicyBundle(job, snapshot.manifest.bundleId);
    if (sha256(canonicalJson(bundle.payload)) !== snapshot.manifest.bundleDigest) throw new GatewayError('SHADOW_BUNDLE_CHANGED', 503);
    const receipt = receiptSchema.parse(openReceipt(step.decisionEnvelope, step.id)), processing = readProcessingContext(request);
    const protectedContext = processing.inputSegments.filter(segment => segment.role === 'system' || segment.role === 'developer').map(segment => createProtectedContextFingerprint({ id: segment.segmentId,
      kind: segment.role === 'system' ? 'SYSTEM_PROMPT' : 'DEVELOPER_PROMPT', text: segment.text }, process.env.CONTENT_HASH_KEY ?? ''));
    const engine = createEngineForPolicyBundle(bundle, process.env.CONTENT_HASH_KEY ?? '', protectedContext, { deferOutputRecheck: true });
    const deadline = Math.min(Date.now() + 3000, request.expiresAt.getTime()), signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const candidate = { ...receipt.request, context: { ...receipt.request.context, requestId: 'shadow_' + job.id, policyBundleId: bundle.id, absoluteDeadlineEpochMs: deadline } };
    const memory = processing.memory && processing.inputSegments.some(segment => segment.role === 'assistant') ? { ...processing.memory, hotWindow: '', hasHistory: false } : processing.memory;
    const decision = await evaluateWithSessionContext(engine, candidate, job, { readOnly: true, signal, ...(memory ? { snapshot: memory } : {}) });
    signal.throwIfAborted();
    action = decision.action; decisionId = decision.decisionId;
    coverage = !decision.degraded && decision.degradationReasons.length === 0 && decision.evidenceComplete !== false ? 'COMPLETE' : 'UNKNOWN';
    state = coverage === 'COMPLETE' ? 'SUCCEEDED' : 'FAILED'; reason = coverage === 'COMPLETE' ? 'SHADOW_COMPARISON_RECORDED' : 'SHADOW_COVERAGE_UNKNOWN';
  } catch (error) { if (error instanceof GatewayError) reason = error.code; }
  const evidence = { version: '1.0', requestId: job.requestId, stepId: job.stepId, snapshotId: job.snapshotId, decisionId, state, action, coverage, reason,
    businessModelCalls: 0, toolExecutions: 0, sessionWrites: 0, primaryDecisionChanged: false, latencyMs: Date.now() - started };
  await db.transaction(async tx => {
    const [current] = await tx.select().from(gatewayShadowEvaluations).where(eq(gatewayShadowEvaluations.id, job.id)).for('update');
    if (current.state !== 'RUNNING') throw new GatewayError('SHADOW_LEASE_LOST', 409);
    const audit = await appendAuditEventInTransaction(tx, { tenantId: job.tenantId, applicationId: job.applicationId, principalId: 'gateway-shadow-worker',
      event: 'gateway.shadow.evaluated', outcome: state === 'SUCCEEDED' ? 'ALLOWED' : 'DENIED', status: state === 'SUCCEEDED' ? 200 : 503, method: 'INTERNAL',
      path: '/internal/gateway/shadow', requestId: job.id, traceId: job.requestId, queryString: 'evidence=' + evidenceHmac(canonicalJson(evidence)), latencyMs: evidence.latencyMs });
    await tx.update(gatewayShadowEvaluations).set({ state, action, coverage, reasonCode: reason, latencyMs: evidence.latencyMs, evidence, evidenceHmac: evidenceHmac(canonicalJson(evidence)), auditEventId: audit.id, completedAt: new Date() }).where(eq(gatewayShadowEvaluations.id, job.id));
  });
  return { id: job.id, state };
}
