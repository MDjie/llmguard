import { nativeOutputArchiveCoverage } from './native-output';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { archivedContentObjects, conversationArchives, gatewayRequests, gatewaySteps } from '@/storage/database/shared/schema';
import { scopePredicate } from '@/lib/tenancy';
import { gatewayArchiveWriteSchema, gatewayArchiveCompleteSchema } from '@/contracts/http/conversation-archive';
import { gatewayDecisionSchema } from '@/contracts/http/gateway-v2';
import type { ContentSegment, SignedAuthContext, WindowInspection } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { applyPatches, canonicalJson, extractSegments, GatewayError, sha256, type JsonValue } from '@/lib/gateway-runtime/protocol';
import { openReceipt, verifyAuthContext, verifyPayload } from '@/lib/gateway-runtime/security';
import { mappedModelRequest } from '@/lib/gateway-runtime/model-routing';
import { readRuntimeSnapshot, validateActiveContext } from '@/lib/gateway-runtime/authorization';
import { windowReleaseSegments } from '@/lib/gateway-runtime/window-proof';
import { writeArchiveContent } from './service';
async function archiveContext(auth: SignedAuthContext, requiresActive: boolean) {
  if (requiresActive) return (await validateActiveContext(auth)).row;
  verifyPayload('gateway-auth-v2', auth.context, auth.context.keyId, auth.signature);
  verifyAuthContext(auth, Math.min(Date.now(), auth.context.expiresAt - 1));
  const [row] = await db.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, auth.context), eq(gatewayRequests.id, auth.context.businessRequestId))).limit(1);
  if (!row || row.authContext.signature !== auth.signature) throw new GatewayError('ARCHIVE_CONTEXT_MISMATCH', 403);
  // Outcome recording can finish shortly after a business timeout; it cannot authorize new I/O.
  if (Date.now() > auth.context.expiresAt + 30000) throw new GatewayError('ARCHIVE_OUTCOME_DEADLINE_EXCEEDED', 408);
  return row;
}
interface StoredStep { decision: unknown; segments: ContentSegment[]; window?: WindowInspection }
function textProjection(segments: readonly ContentSegment[]) { return segments.map(segment => ({ contentPath: segment.contentPath, role: segment.role, text: segment.text })); }
export async function recordGatewayArchive(raw: z.infer<typeof gatewayArchiveWriteSchema>, signal?: AbortSignal) {
  const body = gatewayArchiveWriteSchema.parse(raw), auth = body.auth, input = body.purpose === 'MODEL_INPUT', output = body.purpose === 'RELEASED_OUTPUT';
  const request = await archiveContext(auth, input || output);
  if (!auth.context.archiveRequired) throw new GatewayError('ARCHIVE_NOT_ENABLED_FOR_REQUEST', 409);
  let data: JsonValue; try { data = JSON.parse(body.contentJson); } catch { throw new GatewayError('ARCHIVE_JSON_INVALID', 400); }
  canonicalJson(data);
  if (input || output) {
    if (!body.sourceStepId || !body.eventSequence || !body.payloadDigest || body.rangeStart === undefined || body.rangeEnd === undefined || body.representation !== (input ? 'REQUEST_JSON' : 'MODEL_RESPONSE_JSON')) throw new GatewayError('ARCHIVE_EXECUTION_BINDING_REQUIRED', 403);
    const [step] = await db.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, auth.context), eq(gatewaySteps.requestId, request.id), eq(gatewaySteps.id, body.sourceStepId))).limit(1);
    if (!step?.decisionEnvelope || step.status !== 'SUCCEEDED' || step.coverage !== 'COMPLETE' || !(input ? ['INPUT','INPUT_RECHECK'] : ['OUTPUT_COMPLETE','OUTPUT_RECHECK','OUTPUT_CHUNK']).includes(step.stage)) throw new GatewayError('ARCHIVE_EXECUTION_APPROVAL_REQUIRED', 403);
    const stored = openReceipt(step.decisionEnvelope, step.id) as StoredStep, decision = gatewayDecisionSchema.parse(stored.decision);
    if (!['ALLOW','WARN'].includes(decision.action)) throw new GatewayError('ARCHIVE_EXECUTION_RECHECK_REQUIRED', 403);
    const approved = stored.window ? windowReleaseSegments(stored.segments, stored.window) : stored.segments;
    if (sha256(canonicalJson(approved)) !== body.payloadDigest || body.rangeStart !== (stored.window?.releaseStart ?? 0) || body.rangeEnd !== (stored.window?.releaseEnd ?? approved.reduce((sum, segment) => sum + segment.text.length, 0))) throw new GatewayError('ARCHIVE_EXECUTION_CONTENT_MISMATCH', 403);
    if (canonicalJson(textProjection(extractSegments(data, input ? 'INPUT' : 'OUTPUT', input ? 131072 : 262144, input))) !== canonicalJson(textProjection(approved))) throw new GatewayError('ARCHIVE_BODY_TEXT_MISMATCH', 403);
    if (input) {
      if (!request.sessionSnapshot) throw new GatewayError('ARCHIVE_PREPARED_BODY_MISSING', 409);
      const processing = openReceipt(request.sessionSnapshot, request.id + ':memory') as { preparedRequest: JsonValue; inputSegments: ContentSegment[] };
      let expected = processing.preparedRequest;
      if (step.stage === 'INPUT_RECHECK') {
        const [initial] = await db.select().from(gatewaySteps).where(and(scopePredicate(gatewaySteps, auth.context), eq(gatewaySteps.requestId, request.id), eq(gatewaySteps.stage, 'INPUT'))).limit(1);
        if (!initial?.decisionEnvelope) throw new GatewayError('ARCHIVE_ORIGINAL_INPUT_MISSING', 409);
        const original = openReceipt(initial.decisionEnvelope, initial.id) as StoredStep;
        expected = applyPatches(expected, processing.inputSegments, gatewayDecisionSchema.parse(original.decision).transformPatches ?? []);
      }
      const snapshot = await readRuntimeSnapshot(auth.context, request.snapshotId);
      if (!snapshot.manifest.modelRouting) throw new GatewayError('ARCHIVE_MODEL_ROUTING_REQUIRED', 503);
      expected = mappedModelRequest(expected, snapshot.manifest.modelRouting.configurationJson, auth.context);
      if (canonicalJson(expected) !== canonicalJson(data)) throw new GatewayError('ARCHIVE_MODEL_BODY_MISMATCH', 403);
    }
  } else if (!['SSE_EVENT','MODEL_RESPONSE_JSON'].includes(body.representation) || body.sourceStepId || body.eventSequence || body.payloadDigest || body.rangeStart !== undefined || body.rangeEnd !== undefined) throw new GatewayError('ARCHIVE_MODEL_OUTPUT_SHAPE_INVALID', 400);
  const nativeCoverage = nativeOutputArchiveCoverage(data,body.representation);
  if (body.purpose === 'MODEL_OUTPUT' && nativeCoverage.detected && !nativeCoverage.originalsEmbedded) {
    await db.update(conversationArchives).set({mediaComplete:false}).where(and(scopePredicate(conversationArchives,auth.context),eq(conversationArchives.requestId,request.id)));
  }
  const reference = await writeArchiveContent(auth.context, { requestId: request.id, purpose: body.purpose, sequence: body.sequence, representation: body.representation, data,
    sourceStepId: body.sourceStepId, eventSequence: body.eventSequence, executionPayloadDigest: body.payloadDigest, rangeStart: body.rangeStart, rangeEnd: body.rangeEnd }, undefined, signal);
  return { contentId: reference.id, state: reference.state, sourceHmac: reference.sourceHmac };
}
export async function completeGatewayArchiveOutput(raw: z.infer<typeof gatewayArchiveCompleteSchema>) {
  const body = gatewayArchiveCompleteSchema.parse(raw); await archiveContext(body.auth, false);
  if (!body.auth.context.archiveRequired) throw new GatewayError('ARCHIVE_NOT_ENABLED_FOR_REQUEST', 409);
  return db.transaction(async transaction => {
    const scope = body.auth.context;
    const [archive] = await transaction.select().from(conversationArchives).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, scope.businessRequestId))).for('update');
    if (!archive || (archive.modelOutputFinalSequence !== null && archive.modelOutputFinalSequence !== body.finalSequence)) throw new GatewayError('ARCHIVE_FINAL_SEQUENCE_CONFLICT', 409);
    const [count] = await transaction.select({ count: sql<number>`count(*)::int`, minimum: sql<number>`min(${archivedContentObjects.sequence})::int`, maximum: sql<number>`max(${archivedContentObjects.sequence})::int` }).from(archivedContentObjects)
      .where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.requestId, scope.businessRequestId), eq(archivedContentObjects.purpose, 'MODEL_OUTPUT'), eq(archivedContentObjects.state, 'MANIFEST_COMMITTED')));
    if (!count || count.count !== body.finalSequence + 1 || count.minimum !== 0 || count.maximum !== body.finalSequence) throw new GatewayError('ARCHIVE_MODEL_OUTPUT_INCOMPLETE', 409);
    await transaction.update(conversationArchives).set({ modelOutputFinalSequence: body.finalSequence, modelOutputUnavailableReason: null, version: archive.version + 1 }).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, scope.businessRequestId)));
    return { recordedThrough: body.finalSequence };
  });
}
