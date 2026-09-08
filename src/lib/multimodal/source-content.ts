import { createHash } from 'node:crypto';
import type { ContextEnvelope, GuardRequest } from '@guardllm/contracts';

export interface FusionSourceSpan {
  readonly start: number;
  readonly end: number;
  readonly source: string;
  readonly artifactId?: string;
}

/** Keep extracted media data separate from user instructions, including decoder views.
 * Separator whitespace belongs to the following source; evidence retains original offsets.
 */
export function fusionSourceContent(
  text: string,
  spans: readonly FusionSourceSpan[],
  context: GuardRequest['context'],
): GuardRequest['content'] {
  let cursor = 0;
  const envelopes: ContextEnvelope[] = spans.map((span, index) => {
    if (span.start < cursor || span.end <= span.start || span.end > text.length ||
        text.slice(cursor, span.start).trim()) throw new Error('FUSION_SOURCE_PARTITION_INVALID');
    const start = cursor;
    cursor = span.end;
    const userInput = span.source === 'user_text' && context.direction === 'INPUT';
    const sourceType = span.source === 'user_text' ? (userInput ? 'USER' : 'AGENT') : span.source === 'file_text' ? 'FILE' : 'MEDIA';
    return {
      envelopeId: 'fusion_' + index, tenantId: context.tenantId, applicationId: context.applicationId,
      sessionId: context.sessionId, sourceType,
      sourceId: span.artifactId ?? context.requestId + ':' + index,
      trustLevel: sourceType === 'AGENT' ? 'CONTROLLED' : 'UNTRUSTED',
      instructionCapability: userInput ? 'ALLOWED' : 'FORBIDDEN',
      sensitivityLabels: [], parentEnvelopeIds: [], policyVersion: context.policyBundleId,
      eventSeq: index, contentStart: start, contentEnd: span.end,
      contentHash: createHash('sha256').update(text.slice(start, span.end)).digest('hex'),
    };
  });
  if (cursor !== text.length) throw new Error('FUSION_SOURCE_PARTITION_INVALID');
  return { text, envelopes };
}
