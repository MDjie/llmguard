import { settleGatewayResources } from './resources';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { gatewayExecutionEvents, gatewayNodeAcks, gatewayRequests, gatewayRuntimeSnapshots, gatewaySteps, securityIncidents, incidentTransitions } from '@/storage/database/shared/schema';
import { scopePredicate } from '@/lib/tenancy';
import type { GuardDecision, GuardRequest } from '@guardllm/contracts';
import { appendSecureMemoryEvaluation, readSecureMemorySnapshot } from '@/lib/secure-memory';
import { gatewayDecisionSchema } from '@/contracts/http/gateway-v2';
import type { ContentSegment, ExecutionEvent, GatewayEvents, GatewayNodeAck, WindowInspection } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { canonicalJson, GatewayError } from './protocol';
import { evidenceHmac, openReceipt, verifyAuthContext, verifyPayload } from './security';
import { buildIncidentPersistenceRecords } from '@/lib/incidents/service';
import { gatewayReviewId } from './review';
import { validateExecutionProof, type ExecutionApproval } from './execution-proof';
import { assertWindowPolicy } from './window-policy';
import { windowRiskObservations } from './window-risk';
import { windowReleaseSegments } from './window-proof';
import { readRuntimeSnapshot, validateActiveContext } from './authorization';

interface StoredDecision { decision: unknown; legacy: GuardDecision; request: GuardRequest; segments: ContentSegment[]; window?: WindowInspection }
const terminals = new Set(['COMPLETED','TERMINATED','REVIEW_REQUIRED','UPSTREAM_OUTCOME_UNKNOWN']);

export function nextExecutionState(state: string, kind: ExecutionEvent['kind'], reason?: string): string {
  if (terminals.has(state)) throw new GatewayError('REQUEST_ALREADY_TERMINAL', 409);
  if (kind === 'TERMINATED') return reason === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : reason === 'UPSTREAM_OUTCOME_UNKNOWN' ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'TERMINATED';
  const transitions: Record<string, readonly [string[], string]> = {
    UPSTREAM_SEND_INTENT: [['AUTHORIZED'], 'SEND_INTENT'], UPSTREAM_SEND_STARTED: [['SEND_INTENT'], 'UPSTREAM_STARTED'],
    RELEASE_INTENT: [['UPSTREAM_STARTED','AUTHORIZED','WRITTEN'], 'RELEASING'], WRITE_ACCEPTED: [['RELEASING'], 'WRITTEN'], COMPLETED: [['WRITTEN'], 'COMPLETED'],
  };
  const transition = transitions[kind];
  if (!transition || !transition[0].includes(state)) throw new GatewayError('EXECUTION_EVENT_ORDER_INVALID', 409);
  return transition[1];
}

export async function recordGatewayEvents(body: GatewayEvents): Promise<{ acceptedThrough: number; state: string }> {
  if (body.terminalReconciliation && (body.events.length !== 1 || body.events[0].kind !== 'TERMINATED' || Object.keys(body.events[0]).some(key => !['eventSeq','kind','snapshotId','reasonCode'].includes(key)))) throw new GatewayError('TERMINAL_RECONCILIATION_ONLY', 403);
  const privileged = body.events.some((event) => event.kind === 'UPSTREAM_SEND_INTENT' || event.kind === 'RELEASE_INTENT' || event.kind === 'UPSTREAM_SEND_STARTED');
  const active = privileged ? await validateActiveContext(body.auth) : undefined;
  const auth = active?.auth ?? body.auth;
  if (!privileged) {
    // Completion/termination acknowledgements may arrive after expiration or revocation.
    // They can record an outcome, but cannot authorize another send or release.
    verifyPayload('gateway-auth-v2', auth.context, auth.context.keyId, auth.signature);
    verifyAuthContext(auth, Math.min(Date.now(), auth.context.expiresAt - 1));
  }
  const context = auth.context;
  const result = await db.transaction(async (tx) => {
    const [request] = await tx.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, context), eq(gatewayRequests.id, context.businessRequestId))).for('update');
    if (!request || request.authContext.signature !== auth.signature) throw new GatewayError('EXECUTION_CONTEXT_MISMATCH', 403);
    let state = request.state; let sequence = request.lastEventSeq;
    if (body.terminalReconciliation && body.events[0].snapshotId !== request.snapshotId) throw new GatewayError('EVENT_SNAPSHOT_MISMATCH', 403);
    if (body.terminalReconciliation && terminals.has(state)) return { acceptedThrough: sequence, state };
    // A cancelled response can lose an ACK after the database committed it. Only
    // termination may resolve that uncertain sequence under the request lock.
    const events = body.terminalReconciliation ? [{ ...body.events[0], eventSeq: sequence + 1 }] : body.events;
    for (const event of events) {
      if (event.snapshotId !== request.snapshotId) throw new GatewayError('EVENT_SNAPSHOT_MISMATCH', 403);
      const eventHmac = evidenceHmac(canonicalJson(event));
      if (event.eventSeq <= sequence) {
        const [existing] = await tx.select().from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, context), eq(gatewayExecutionEvents.requestId, request.id), eq(gatewayExecutionEvents.eventSeq, event.eventSeq))).limit(1);
        if (!existing || existing.eventHmac !== eventHmac) throw new GatewayError('EVENT_CONTENT_CONFLICT', 409);
        continue;
      }
      if (event.eventSeq !== sequence + 1) throw new GatewayError('EVENT_SEQUENCE_GAP', 409);
      if (event.eventSeq > 4096) throw new GatewayError('EXECUTION_EVENT_BUDGET_EXCEEDED', 429);
      if (event.kind === 'UPSTREAM_SEND_INTENT' || event.kind === 'RELEASE_INTENT' || event.kind === 'WRITE_ACCEPTED') {
        if (!event.stepId || !event.decisionId || !event.payloadDigest) throw new GatewayError('EXECUTION_APPROVAL_REQUIRED', 403);
        const [step] = await tx.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, context), eq(gatewaySteps.requestId, request.id), eq(gatewaySteps.id, event.stepId))).limit(1);
        if (!step?.decisionEnvelope || step.decisionId !== (event.recheckDecisionId ?? event.decisionId) || step.status !== 'SUCCEEDED' || step.coverage !== 'COMPLETE') throw new GatewayError('EXECUTION_APPROVAL_INVALID', 403);
        const stored = openReceipt(step.decisionEnvelope, step.id) as StoredDecision;
        const decision = gatewayDecisionSchema.parse(stored.decision);
        if (event.kind === 'UPSTREAM_SEND_INTENT' && !['INPUT','INPUT_RECHECK'].includes(step.stage)) throw new GatewayError('INPUT_APPROVAL_REQUIRED', 403);
        if (event.kind !== 'UPSTREAM_SEND_INTENT' && !['OUTPUT_COMPLETE','OUTPUT_RECHECK','OUTPUT_CHUNK'].includes(step.stage)) throw new GatewayError('OUTPUT_APPROVAL_REQUIRED', 403);
        let original: ExecutionApproval | undefined;
        if (step.stage.endsWith('RECHECK')) {
          const [initial] = await tx.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, context), eq(gatewaySteps.requestId, request.id), eq(gatewaySteps.decisionId, event.decisionId))).limit(1);
          const expectedStage = step.stage === 'INPUT_RECHECK' ? ['INPUT'] : ['INPUT','OUTPUT_COMPLETE'];
          if (!initial?.decisionEnvelope || !expectedStage.includes(initial.stage) || initial.status !== 'SUCCEEDED') throw new GatewayError('EXECUTION_SOURCE_DECISION_INVALID', 403);
          const receipt = openReceipt(initial.decisionEnvelope, initial.id) as StoredDecision;
          original = { decision: gatewayDecisionSchema.parse(receipt.decision), segments: receipt.segments };
          if (initial.stage === 'INPUT' && step.stage === 'OUTPUT_RECHECK' && original.decision.action !== 'SAFE_RESPONSE') throw new GatewayError('EXECUTION_SAFE_RESPONSE_REQUIRED', 403);
        }
        if (step.stage === 'OUTPUT_CHUNK') {
          if (!stored.window) throw new GatewayError('WINDOW_METADATA_REQUIRED', 403);
          if (event.kind === 'RELEASE_INTENT') {
            if (!active) throw new GatewayError('STREAM_WINDOW_NOT_QUALIFIED', 503);
            assertWindowPolicy(active.snapshot.manifest);
            const [priorWrite] = await tx.select().from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, context), eq(gatewayExecutionEvents.requestId, request.id), eq(gatewayExecutionEvents.kind, 'WRITE_ACCEPTED'))).orderBy(sql`${gatewayExecutionEvents.eventSeq} DESC`).limit(1);
            if ((priorWrite?.rangeEnd ?? 0) !== event.rangeStart) throw new GatewayError('WINDOW_RELEASE_NOT_CONTIGUOUS', 409);
          }
        } else if (event.kind === 'RELEASE_INTENT' && state === 'WRITTEN') throw new GatewayError('FULL_BUFFER_ALREADY_RELEASED', 409);
        validateExecutionProof(event, { decision, segments: stored.segments, ...(stored.window ? { window: stored.window } : {}) }, original);
        if (event.kind === 'WRITE_ACCEPTED') {
          const [intent] = await tx.select().from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, context), eq(gatewayExecutionEvents.requestId, request.id), eq(gatewayExecutionEvents.eventSeq, sequence))).limit(1);
          if (!intent || intent.kind !== 'RELEASE_INTENT' || intent.stepId !== event.stepId || intent.decisionId !== event.decisionId
            || intent.recheckDecisionId !== (event.recheckDecisionId ?? null) || intent.actualAction !== event.actualAction
            || intent.payloadHmac !== evidenceHmac(event.payloadDigest) || intent.rangeStart !== event.rangeStart || intent.rangeEnd !== event.rangeEnd) throw new GatewayError('WRITE_INTENT_BINDING_INVALID', 403);
        }
      }
      if (event.kind === 'COMPLETED') {
        const [lastWrite] = await tx.select().from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, context), eq(gatewayExecutionEvents.requestId, request.id), eq(gatewayExecutionEvents.eventSeq, sequence))).limit(1);
        if (lastWrite?.stepId) {
          const [lastStep] = await tx.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, context), eq(gatewaySteps.id, lastWrite.stepId))).limit(1);
          if (lastStep?.stage === 'OUTPUT_CHUNK' && (!lastStep.decisionEnvelope || !(openReceipt(lastStep.decisionEnvelope, lastStep.id) as StoredDecision).window?.final)) throw new GatewayError('WINDOW_FINAL_WRITE_REQUIRED', 409);
        }
      }
      if (event.kind === 'TERMINATED' && event.reasonCode === 'REVIEW_REQUIRED') {
        const [reviewStep] = await tx.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, context), eq(gatewaySteps.requestId, request.id), eq(gatewaySteps.action, 'REQUIRE_REVIEW'), eq(gatewaySteps.status, 'SUCCEEDED'))).limit(1);
        if (!reviewStep?.decisionId) throw new GatewayError('REVIEW_DECISION_REQUIRED', 403);
        const records = buildIncidentPersistenceRecords({ tenantId: context.tenantId, applicationId: context.applicationId, principalId: context.subjectId }, {
          title: '网关内容待人工审核', severity: 'MEDIUM', traceId: context.traceId, sessionId: context.sessionId, riskType: 'gateway.content_review',
          eventAnalysis: '网关已暂停本次请求的发送或输出，人工审核不自动恢复原请求。', attackTechnique: '策略要求人工审核',
          impact: '业务请求 ' + request.id, answerEvidence: JSON.stringify({ requestId: request.id, snapshotId: request.snapshotId, decisionId: reviewStep.decisionId, contentHmac: reviewStep.inputHmac }), slaMinutes: 240,
        }, new Date(), gatewayReviewId(context));
        const inserted = await tx.insert(securityIncidents).values(records.incident).onConflictDoNothing().returning({ id: securityIncidents.id });
        if (inserted.length) await tx.insert(incidentTransitions).values(records.transition);
      }
      state = nextExecutionState(state, event.kind, event.reasonCode);
      await tx.insert(gatewayExecutionEvents).values({ id: randomUUID(), tenantId: context.tenantId, applicationId: context.applicationId, requestId: request.id,
        stepId: event.stepId, eventSeq: event.eventSeq, kind: event.kind, rangeStart: event.rangeStart, rangeEnd: event.rangeEnd,
        payloadHmac: event.payloadDigest ? evidenceHmac(event.payloadDigest) : null, snapshotId: event.snapshotId, eventHmac,
        actualAction: event.actualAction, reasonCode: event.reasonCode, decisionId: event.decisionId, recheckDecisionId: event.recheckDecisionId });
      sequence = event.eventSeq;
    }
    await tx.update(gatewayRequests).set({ state, lastEventSeq: sequence }).where(and(scopePredicate(gatewayRequests, context), eq(gatewayRequests.id, request.id)));
    await settleGatewayResources(tx, context, request.id, state);
    return { acceptedThrough: sequence, state };
  });
  if (terminals.has(result.state)) await commitSession(body).catch(() => {
    // The durable terminal event is the reconciliation source; never erase an accepted write.
    console.error('GATEWAY_SESSION_COMMIT_PENDING');
  });
  return result;
}

export async function commitSession(body: GatewayEvents): Promise<void> {
  const context = body.auth.context;
  if (!context.sessionId) {
    await db.update(gatewayRequests).set({ sessionFinalized: true }).where(and(scopePredicate(gatewayRequests, context), eq(gatewayRequests.id, context.businessRequestId)));
    return;
  }
  const steps = await db.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, context), eq(gatewaySteps.requestId, context.businessRequestId)));
  for (const direction of ['INPUT','OUTPUT_COMPLETE'] as const) {
    if (direction === 'OUTPUT_COMPLETE') {
      const [write] = await db.select({ id: gatewayExecutionEvents.id }).from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, context), eq(gatewayExecutionEvents.requestId, context.businessRequestId), eq(gatewayExecutionEvents.kind, 'WRITE_ACCEPTED'))).limit(1);
      if (!write) continue;
    }
    let step = steps.find((item) => item.stage === direction);
    if (direction === 'OUTPUT_COMPLETE') step = steps.find((item) => item.stage === 'OUTPUT_RECHECK') ?? step;
    let windowText: string | undefined;
    let windowStored: StoredDecision | undefined;
    if (direction === 'OUTPUT_COMPLETE' && steps.some(item => item.stage === 'OUTPUT_CHUNK')) {
      const writes = await db.select().from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, context), eq(gatewayExecutionEvents.requestId, context.businessRequestId), eq(gatewayExecutionEvents.kind, 'WRITE_ACCEPTED'))).orderBy(asc(gatewayExecutionEvents.eventSeq));
      windowText = ''; let cursor = 0; const receipts: StoredDecision[] = [];
      for (const write of writes) {
        const inspected = steps.find(item => item.id === write.stepId);
        if (!inspected?.decisionEnvelope) throw new GatewayError('WINDOW_MEMORY_EVIDENCE_MISSING', 503);
        const receipt = openReceipt(inspected.decisionEnvelope, inspected.id) as StoredDecision;
        if (!receipt.window || receipt.window.releaseStart !== cursor || write.rangeStart !== cursor || write.rangeEnd !== receipt.window.releaseEnd) throw new GatewayError('WINDOW_MEMORY_RANGE_INVALID', 503);
        windowText += windowReleaseSegments(receipt.segments, receipt.window)[0].text; cursor = receipt.window.releaseEnd; receipts.push(receipt);
      }
      const riskOrder = ['NONE','LOW','MEDIUM','HIGH','CRITICAL'];
      windowStored = receipts.toSorted((a,b) => riskOrder.indexOf(b.legacy.riskLevel) - riskOrder.indexOf(a.legacy.riskLevel))[0];
      if (windowStored) windowStored = { ...windowStored, legacy: { ...windowStored.legacy, observations: windowRiskObservations(receipts.flatMap(item => item.legacy.observations)) } };
    }
    if (!windowStored && !step?.decisionEnvelope) continue;
    const stored = windowStored ?? openReceipt(step!.decisionEnvelope!, step!.id) as StoredDecision;
    const snapshot = await readSecureMemorySnapshot(context, context.sessionId);
    const segments = direction === 'INPUT' ? stored.segments.filter((segment) => segment.role === 'user').slice(-1) : stored.segments;
    const text = windowText ?? segments.map((segment) => segment.text).join('\n');
    const requestForMemory: GuardRequest = { ...stored.request, context: { ...stored.request.context, requestId: context.businessRequestId, direction }, content: { text } };
    // Positional evidence describes the inspected aggregate; retain HMAC references
    // without falsely attributing its positions to the new turn stored in memory.
    const memoryDecision: GuardDecision = { ...stored.legacy, observations: stored.legacy.observations.map((observation) => ({ ...observation, evidence: observation.evidence.map((evidence) => {
      const reference = { ...evidence }; delete reference.start; delete reference.end;
      return reference;
    }) })) };
    await appendSecureMemoryEvaluation({ scope: context, sessionId: context.sessionId, expectedStateVersion: snapshot.stateVersion, request: requestForMemory, decision: memoryDecision });
  }
  await db.update(gatewayRequests).set({ sessionFinalized: true }).where(and(scopePredicate(gatewayRequests, context), eq(gatewayRequests.id, context.businessRequestId)));
}

export async function acknowledgeRuntime(body: GatewayNodeAck, nodeId: string): Promise<{ acknowledged: boolean }> {
  if (body.nodeId !== nodeId) throw new GatewayError('NODE_IDENTITY_MISMATCH', 403);
  const snapshot = await readRuntimeSnapshot(body, body.snapshotId);
  if (snapshot.digest !== body.digest) throw new GatewayError('NODE_SNAPSHOT_DIGEST_MISMATCH', 409);
  await db.transaction(async (tx) => {
    await tx.insert(gatewayNodeAcks).values({ id: randomUUID(), tenantId: body.tenantId, applicationId: body.applicationId, snapshotId: body.snapshotId,
      nodeId, digest: body.digest, state: body.state, reasonCode: body.reasonCode, loadedAt: body.state === 'LOADED' ? new Date() : null })
      .onConflictDoUpdate({ target: [gatewayNodeAcks.tenantId, gatewayNodeAcks.applicationId, gatewayNodeAcks.snapshotId, gatewayNodeAcks.nodeId],
        set: { digest: body.digest, state: body.state, reasonCode: body.reasonCode, loadedAt: body.state === 'LOADED' ? new Date() : null, lastSeenAt: new Date() } });
    if (body.state === 'LOADED') await tx.update(gatewayRuntimeSnapshots).set({ state: 'LOADED' }).where(and(scopePredicate(gatewayRuntimeSnapshots, body), eq(gatewayRuntimeSnapshots.id, body.snapshotId), eq(gatewayRuntimeSnapshots.state, 'PREPARED')));
  });
  return { acknowledged: body.state === 'LOADED' };
}

export async function reconcileExpiredGatewayRequests(): Promise<number> {
  const candidates = await db.select().from(gatewayRequests).where(and(sql`${gatewayRequests.expiresAt} < now()`, eq(gatewayRequests.sessionFinalized, false))).limit(100);
  for (const request of candidates) {
    if (!terminals.has(request.state)) {
      const event: ExecutionEvent = { eventSeq: request.lastEventSeq + 1, kind: 'TERMINATED', snapshotId: request.snapshotId, reasonCode: request.state === 'AUTHORIZED' ? 'EXPIRED_BEFORE_SEND' : 'UPSTREAM_OUTCOME_UNKNOWN' };
      await recordGatewayEvents({ contractVersion: '2.0', auth: request.authContext, events: [event], terminalReconciliation: true }).catch(() => undefined);
    } else await commitSession({ contractVersion: '2.0', auth: request.authContext, events: [] }).catch(() => undefined);
  }
  // Content expiry is handled by the bounded legal-hold-aware purge worker.
  return candidates.length;
}
