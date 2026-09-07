import { readProcessingContext } from './processing-context';
export { readProcessingContext } from './processing-context';
import { queueGatewayShadow } from './shadow';
import { measureGatewayInspection } from './resources';
import { and, eq, sql } from 'drizzle-orm';
import type { GuardDecision as LegacyDecision } from '@guardllm/contracts';
import { db } from '@/storage/database/shared/db';
import { gatewayExecutionEvents, gatewayRequests, gatewaySteps } from '@/storage/database/shared/schema';
import { scopePredicate } from '@/lib/tenancy';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle/runtime';
import { createEngineForPolicyBundle, createProtectedContextFingerprint, evaluateWithSessionContext } from '@/lib/guard-engine-v2';
import { transformDlpText, type DlpTransformEntity } from '@/lib/dlp';
import { gatewayDecisionSchema } from '@/contracts/http/gateway-v2';
import type { ContentSegment, GatewayDecision, GatewayRequest, TransformPatch } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { canonicalJson, GatewayError, sha256 } from './protocol';
import { evidenceHmac, openReceipt, sealReceipt } from './security';
import { validateActiveContext } from './authorization';
import { prepareInputAction } from './input-action';
import { legacyRequest } from './legacy-projection';
import { validateRecheck } from './recheck';
import { retainWindowRisk } from './window-risk';
import { assertWindowPolicy } from './window-policy';
import { validateWindowContinuation, validateWindowInspection } from './window-proof';
import type { WindowInspection } from '../../../packages/contracts/generated/typescript/gateway-v2';

export function mapDecision(body: GatewayRequest, legacy: LegacyDecision, spans: ReturnType<typeof legacyRequest>['spans'], inputAction: { patches: TransformPatch[]; safeResponse?: string } = { patches: [] }): GatewayDecision {
  let transformed = inputAction.safeResponse ?? legacy.transformedText;
  let ranges = legacy.transform?.ranges ?? [];
  if (body.stage === 'INPUT' && legacy.action === 'MASK' && transformed === undefined) {
    const entities: DlpTransformEntity[] = legacy.observations.filter((o) => o.status === 'MATCH' && (o.detectorId === 'structured-dlp' || Boolean(o.category && o.detectorId.includes('dlp'))))
      .flatMap((o) => o.evidence.flatMap((e) => e.start === undefined || e.end === undefined ? [] : [{ entityType: o.category ?? o.riskType, start: e.start, end: e.end, confidence: o.confidence ?? o.score, contentHmac: e.contentHmac }]));
    if (!entities.length) throw new GatewayError('INPUT_TRANSFORM_EVIDENCE_MISSING', 503);
    const result = transformDlpText(spans.map(({ segment }) => segment.text).join('\n'), entities, { evidenceHmacKey: process.env.CONTENT_HASH_KEY ?? '', tokenizationHmacKey: process.env.DLP_TOKENIZATION_HMAC_KEY });
    if (result.blocked) throw new GatewayError('INPUT_TRANSFORM_BLOCKED', 403);
    transformed = result.transformedText; ranges = result.ranges;
  }
  const patches: TransformPatch[] = [...inputAction.patches];
  if (['MASK','REWRITE'].includes(legacy.action) && !patches.length) {
    if (transformed === undefined) throw new GatewayError('TRANSFORM_OUTPUT_MISSING', 503);
    if (ranges.length) for (const range of ranges) {
      const span = spans.find((item) => range.start >= item.start && range.end <= item.end);
      if (!span) throw new GatewayError('TRANSFORM_CROSSES_MESSAGE_BOUNDARY');
      if (span.segment.sourceType === 'TOOL') throw new GatewayError('TOOL_REWRITE_REQUIRES_NEW_INTENT');
      patches.push({ segmentId: span.segment.segmentId, contentPath: span.segment.contentPath, sourceDigest: span.segment.sourceDigest,
        start: range.start - span.start, end: range.end - span.start, replacement: transformed.slice(range.outputStart, range.outputEnd) });
    } else {
      if (spans.length !== 1 || spans[0].segment.sourceType === 'TOOL') throw new GatewayError('STRUCTURED_REWRITE_MAPPING_UNAVAILABLE');
      const segment = spans[0].segment;
      patches.push({ segmentId: segment.segmentId, contentPath: segment.contentPath, sourceDigest: segment.sourceDigest, start: 0, end: segment.text.length, replacement: transformed });
    }
  }
  const complete = !legacy.degraded && legacy.degradationReasons.length === 0 && legacy.evidenceComplete !== false;
  return gatewayDecisionSchema.parse({ contractVersion: '2.0', businessRequestId: body.businessRequestId, stepId: body.stepId, decisionId: legacy.decisionId, snapshotId: body.snapshotId,
    action: legacy.action, coverage: complete ? 'COMPLETE' : 'UNKNOWN', status: complete ? 'SUCCEEDED' : 'FAILED', riskLevel: legacy.riskLevel,
    reasonCodes: legacy.reasonCodes ?? [], modelVersions: legacy.modelVersions ?? [], transformPatches: patches, latencyMs: legacy.latencyMs,
    ...(legacy.action === 'SAFE_RESPONSE' && transformed !== undefined ? { safeResponse: transformed } : {}) });
}

export async function evaluateGateway(body: GatewayRequest, signal: AbortSignal): Promise<GatewayDecision> {
  const { snapshot, row } = await validateActiveContext(body.auth);
  const context = body.auth.context;
  if (body.businessRequestId !== context.businessRequestId || body.snapshotId !== context.policy.snapshotId || body.deadline !== context.deadline || body.traceId !== context.traceId) throw new GatewayError('STEP_AUTHORIZATION_MISMATCH', 403);
  const windowPolicy = body.stage === 'OUTPUT_CHUNK' ? assertWindowPolicy(snapshot.manifest) : undefined;
  if ((body.stage === 'OUTPUT_CHUNK') !== Boolean(body.window)) throw new GatewayError('WINDOW_METADATA_REQUIRED', 400);
  if (windowPolicy && body.window) {
    validateWindowInspection(body.segments, body.window, windowPolicy);
    if (body.window.contextStart + body.segments[0].text.length > snapshot.manifest.budgets.maxOutputChars) throw new GatewayError('CONTENT_BUDGET_EXCEEDED', 413);
  }
  const allowedStates = windowPolicy ? ['UPSTREAM_STARTED','WRITTEN'] : ['AUTHORIZED','UPSTREAM_STARTED'];
  if (!allowedStates.includes(row.state)) throw new GatewayError('REQUEST_ALREADY_TERMINAL', 409);
  if (body.stage === 'OUTPUT_CHUNK' && (snapshot.manifest.streamMode !== 'WINDOW' || !snapshot.manifest.windowQualified)) throw new GatewayError('STREAM_WINDOW_NOT_QUALIFIED');
  if ((body.stage.endsWith('RECHECK') ? 'RECHECK' : 'INITIAL') !== body.attemptKind) throw new GatewayError('STEP_ATTEMPT_INVALID', 400);
  const inputHmac = evidenceHmac(canonicalJson({ stage: body.stage, segments: body.segments, snapshotId: body.snapshotId, ...(body.window ? { window: body.window } : {}) }));
  const processing = readProcessingContext(row);
  if (body.stage === 'INPUT' && canonicalJson(body.segments) !== canonicalJson(processing.inputSegments)) throw new GatewayError('AUTHORIZED_INPUT_CHANGED', 403);
  if (body.stage.endsWith('RECHECK')) {
    const initialStage = body.stage === 'INPUT_RECHECK' ? 'INPUT' : row.state === 'AUTHORIZED' ? 'INPUT' : 'OUTPUT_COMPLETE';
    const [previous] = await db.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, context), eq(gatewaySteps.requestId, row.id), eq(gatewaySteps.stage, initialStage), eq(gatewaySteps.streamSeq, body.streamSeq))).limit(1);
    if (!previous?.decisionEnvelope || previous.status !== 'SUCCEEDED') throw new GatewayError('RECHECK_SOURCE_MISSING', 403);
    const stored = openReceipt(previous.decisionEnvelope, previous.id) as { decision: unknown; segments: ContentSegment[] };
    validateRecheck(stored.segments, gatewayDecisionSchema.parse(stored.decision), body.segments);
  }
  if (!['INPUT','INPUT_RECHECK','OUTPUT_COMPLETE','OUTPUT_RECHECK','OUTPUT_CHUNK'].includes(body.stage)) throw new GatewayError('STAGE_REQUIRES_TRUSTED_ADAPTER', 422);
  if (body.stage !== 'OUTPUT_CHUNK' && body.streamSeq !== 0) throw new GatewayError('STEP_SEQUENCE_INVALID', 400);
  let previousWindowDecision: LegacyDecision | undefined;
  const claimed = await db.transaction(async (tx) => {
    const [business] = await tx.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, context), eq(gatewayRequests.id, row.id))).for('update');
    if (!business || !allowedStates.includes(business.state)) throw new GatewayError('REQUEST_ALREADY_TERMINAL', 409);
    const [existing] = await tx.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, context), eq(gatewaySteps.requestId, row.id), eq(gatewaySteps.stage, body.stage), eq(gatewaySteps.streamSeq, body.streamSeq), eq(gatewaySteps.attemptKind, body.attemptKind))).limit(1);
    if (existing) {
      if (existing.inputHmac !== inputHmac || existing.id !== body.stepId) throw new GatewayError('STEP_CONTENT_CONFLICT', 409);
      if (!existing.decisionEnvelope) throw new GatewayError('STEP_' + existing.status, 409);
      const replay = openReceipt(existing.decisionEnvelope, body.stepId) as { decision: unknown };
      return gatewayDecisionSchema.parse(replay.decision);
    }
    if (body.window) {
      const previous = body.streamSeq > 0 ? (await tx.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, context), eq(gatewaySteps.requestId, row.id), eq(gatewaySteps.stage, 'OUTPUT_CHUNK'), eq(gatewaySteps.streamSeq, body.streamSeq - 1))).limit(1))[0] : undefined;
      if (body.streamSeq > 0 && !previous?.decisionEnvelope) throw new GatewayError('WINDOW_SEQUENCE_GAP', 409);
      const receipt = previous?.decisionEnvelope ? openReceipt(previous.decisionEnvelope, previous.id) as { segments: ContentSegment[]; window: WindowInspection; legacy: LegacyDecision } : undefined;
      previousWindowDecision = receipt?.legacy;
      validateWindowContinuation(receipt, body.segments, body.window);
      if (previous) {
        const [last] = await tx.select().from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, context), eq(gatewayExecutionEvents.requestId, row.id), eq(gatewayExecutionEvents.eventSeq, business.lastEventSeq))).limit(1);
        if (last?.kind !== 'WRITE_ACCEPTED' || last.stepId !== previous.id) throw new GatewayError('WINDOW_PREVIOUS_WRITE_REQUIRED', 409);
      } else if (business.state !== 'UPSTREAM_STARTED') throw new GatewayError('WINDOW_SEQUENCE_GAP', 409);
    }
    if (business.stepCount >= snapshot.manifest.budgets.maxSteps) throw new GatewayError('INTERNAL_STEP_BUDGET_EXCEEDED', 429);
    if (body.stage.startsWith('OUTPUT') && business.state !== 'UPSTREAM_STARTED' && body.stage !== 'OUTPUT_RECHECK' && !body.window) throw new GatewayError('OUTPUT_BEFORE_UPSTREAM', 409);
    await measureGatewayInspection(tx, context, row.id, body.segments.reduce((sum, segment) => sum + segment.text.length, 0));
    await tx.insert(gatewaySteps).values({ id: body.stepId, tenantId: context.tenantId, applicationId: context.applicationId, requestId: row.id, stage: body.stage, streamSeq: body.streamSeq, attemptKind: body.attemptKind, inputHmac });
    await tx.update(gatewayRequests).set({ stepCount: sql`${gatewayRequests.stepCount} + 1` }).where(and(scopePredicate(gatewayRequests, context), eq(gatewayRequests.id, row.id)));
    return null;
  });
  if (claimed) return claimed;
  try {
    if (signal.aborted) throw new GatewayError('REQUEST_CANCELLED', 499);
    const { request, spans } = legacyRequest(body);
    const limit = body.stage.startsWith('INPUT') ? snapshot.manifest.budgets.maxInputChars : snapshot.manifest.budgets.maxOutputChars;
    if ((request.content.text?.length ?? 0) > limit) throw new GatewayError('CONTENT_BUDGET_EXCEEDED', 413);
    const bundle = await loadVerifiedPolicyBundle(context, context.policy.bundleId);
    if (sha256(canonicalJson(bundle.payload)) !== snapshot.manifest.bundleDigest) throw new GatewayError('BUNDLE_DIGEST_CHANGED', 503);
    const protectedContext = processing.inputSegments.filter((s) => s.role === 'system' || s.role === 'developer').map((s) => createProtectedContextFingerprint({ id: s.segmentId, kind: s.role === 'system' ? 'SYSTEM_PROMPT' : 'DEVELOPER_PROMPT', text: s.text }, process.env.CONTENT_HASH_KEY ?? ''));
    const engine = createEngineForPolicyBundle(bundle, process.env.CONTENT_HASH_KEY ?? '', protectedContext, { deferOutputRecheck: true });
    const memory = processing.memory && processing.inputSegments.some((s) => s.role === 'assistant') ? { ...processing.memory, hotWindow: '', hasHistory: false } : processing.memory;
    const inspected = await evaluateWithSessionContext(engine, request, context, { readOnly: true, signal, ...(memory ? { snapshot: memory } : {}) });
    const legacy = body.window ? retainWindowRisk(inspected, previousWindowDecision) : inspected;
    if (signal.aborted) throw new GatewayError('REQUEST_CANCELLED', 499);
    const decision = mapDecision(body, legacy, spans, prepareInputAction(body, legacy, { request, spans }, bundle));
    const outputHmac = evidenceHmac(canonicalJson({ decision, inputHmac }));
    await db.transaction(async tx => {
    await tx.update(gatewaySteps).set({ decisionId: decision.decisionId, outputHmac, action: decision.action, coverage: decision.coverage, status: decision.status, latencyMs: decision.latencyMs,
      modelVersions: [...decision.modelVersions], decisionEnvelope: sealReceipt({ decision, legacy, request, segments: body.segments, ...(body.window ? { window: body.window } : {}) }, body.stepId) }).where(and(scopePredicate(gatewaySteps, context), eq(gatewaySteps.id, body.stepId)));
    await queueGatewayShadow(tx, context, row.id, body.stepId, body.stage, row.shadowSnapshotId);
    });
    return decision;
  } catch (error) {
    await db.update(gatewaySteps).set({ status: signal.aborted ? 'CANCELLED' : 'FAILED' }).where(and(scopePredicate(gatewaySteps, context), eq(gatewaySteps.id, body.stepId)));
    throw error;
  }
}
