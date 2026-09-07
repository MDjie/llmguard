import type { GuardRequest as LegacyRequest, ContextEnvelope } from '@guardllm/contracts';
import type { ContentSegment, GatewayRequest } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { GatewayError, sha256 } from './protocol';

// Separators belong to the following untrusted span. Hashes cover their exact
// legacy text ranges; structured transformation offsets continue to exclude them.
export function legacyRequest(body: GatewayRequest): { request: LegacyRequest; spans: Array<{ segment: ContentSegment; start: number; end: number }> } {
  let text = '';
  const spans = body.segments.map((segment, i) => {
    if (segment.sourceDigest !== sha256(segment.text)) throw new GatewayError('SEGMENT_DIGEST_MISMATCH', 400);
    if (i) text += '\n';
    const start = text.length; text += segment.text;
    return { segment, start, end: text.length };
  });
  const context = body.auth.context;
  const direction: LegacyRequest['context']['direction'] = body.stage === 'INPUT' || body.stage === 'INPUT_RECHECK' ? 'INPUT' : body.stage === 'OUTPUT_RECHECK' || body.window?.final ? 'OUTPUT_COMPLETE' : body.stage;
  const request: LegacyRequest = { contractVersion: '1.0', context: { tenantId: context.tenantId, applicationId: context.applicationId, subjectId: context.subjectId, authContextId: context.authContextId, requestId: body.stepId,
    traceId: body.traceId, ...(context.sessionId ? { sessionId: context.sessionId } : {}), direction, absoluteDeadlineEpochMs: body.deadline, policyBundleId: context.policy.bundleId },
    content: { text, envelopes: spans.map<ContextEnvelope>(({ segment, start, end }, i) => ({ envelopeId: segment.segmentId, tenantId: context.tenantId, applicationId: context.applicationId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}), sourceType: segment.sourceType === 'MODEL' ? 'AGENT' : segment.sourceType,
      sourceId: segment.contentPath, trustLevel: 'UNTRUSTED', instructionCapability: segment.sourceType === 'TOOL' || segment.sourceType === 'RAG' ? 'FORBIDDEN' : 'DATA_ONLY',
      sensitivityLabels: [], contentHash: sha256(text.slice(i ? start - 1 : start, end)), parentEnvelopeIds: [], policyVersion: context.policy.bundleId, eventSeq: i, contentStart: i ? start - 1 : start, contentEnd: end })).filter(envelope => !text.length || envelope.contentStart < envelope.contentEnd) } };
  return { request, spans };
}
