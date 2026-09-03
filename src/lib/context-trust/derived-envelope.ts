import { createHash, randomUUID } from 'node:crypto';
import type {
  ContextEnvelope,
  InstructionCapability,
  SourceType,
  TrustLevel,
} from '@guardllm/contracts';

const trustRank: Readonly<Record<TrustLevel, number>> = {
  TRUSTED: 0,
  CONTROLLED: 1,
  UNTRUSTED: 2,
};
const capabilityRank: Readonly<Record<InstructionCapability, number>> = {
  ALLOWED: 0,
  DATA_ONLY: 1,
  FORBIDDEN: 2,
};

export function deriveContextEnvelope(input: {
  readonly content: string;
  readonly sourceType: Extract<SourceType, 'AGENT' | 'MEMORY'>;
  readonly sourceId: string;
  readonly parents: readonly ContextEnvelope[];
  readonly riskLabels?: readonly string[];
  readonly eventSeq: number;
  readonly policyVersion: string;
}): ContextEnvelope {
  if (input.parents.length === 0) throw new Error('DERIVED_CONTEXT_PARENT_REQUIRED');
  const [first] = input.parents;
  if (input.parents.some((parent) =>
    parent.tenantId !== first.tenantId ||
    parent.applicationId !== first.applicationId ||
    parent.sessionId !== first.sessionId)) {
    throw new Error('DERIVED_CONTEXT_SCOPE_MISMATCH');
  }
  const trustLevel = input.parents.reduce<TrustLevel>(
    (selected, parent) => trustRank[parent.trustLevel] > trustRank[selected]
      ? parent.trustLevel
      : selected,
    'TRUSTED',
  );
  const instructionCapability = input.parents.reduce<InstructionCapability>(
    (selected, parent) => capabilityRank[parent.instructionCapability] > capabilityRank[selected]
      ? parent.instructionCapability
      : selected,
    'ALLOWED',
  );
  const expiresAt = input.parents.flatMap((parent) =>
    parent.expiresAtEpochMs === undefined ? [] : [parent.expiresAtEpochMs]);
  return {
    envelopeId: 'derived-' + randomUUID(),
    tenantId: first.tenantId,
    applicationId: first.applicationId,
    ...(first.sessionId ? { sessionId: first.sessionId } : {}),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    trustLevel,
    instructionCapability,
    sensitivityLabels: [...new Set([
      ...input.parents.flatMap((parent) => parent.sensitivityLabels),
      ...(input.riskLabels ?? []).map((risk) => 'risk:' + risk),
    ])].sort(),
    contentHash: createHash('sha256').update(input.content, 'utf8').digest('hex'),
    parentEnvelopeIds: [...new Set(input.parents.map((parent) => parent.envelopeId))].sort(),
    policyVersion: input.policyVersion,
    eventSeq: input.eventSeq,
    contentStart: 0,
    contentEnd: input.content.length,
    ...(expiresAt.length > 0 ? { expiresAtEpochMs: Math.min(...expiresAt) } : {}),
  };
}
