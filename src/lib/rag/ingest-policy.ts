import type { GuardDecision, GuardRequest } from '@guardllm/contracts';
import { createHash } from 'node:crypto';
export function ragIngestContent(text: string, artifactId: string, context: GuardRequest['context']): GuardRequest['content'] {
    if (!text.trim())
        throw new Error('RAG_TEXT_EMPTY');
    return { text, envelopes: [{ envelopeId: 'rag-ingest-' + artifactId, tenantId: context.tenantId, applicationId: context.applicationId, sourceType: 'RAG', sourceId: artifactId, trustLevel: 'UNTRUSTED', instructionCapability: 'FORBIDDEN', sensitivityLabels: [], parentEnvelopeIds: [], policyVersion: context.policyBundleId, eventSeq: 0, contentStart: 0, contentEnd: text.length, contentHash: createHash('sha256').update(text).digest('hex') }] };
}
export function ragIngestDisposition(decision: GuardDecision): 'accepted' | 'quarantined' {
    return ['ALLOW', 'WARN'].includes(decision.action) && !decision.degraded && !decision.degradationReasons.length && decision.failMode === 'NORMAL' ? 'accepted' : 'quarantined';
}
