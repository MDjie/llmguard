import { createHash } from 'node:crypto';
import type {
  ContextEnvelope,
  GuardRequest,
  InstructionCapability,
  Observation,
  SourceType,
  TrustLevel,
} from '@guardllm/contracts';

export type ContextEnvelopeErrorCode =
  | 'GRD_CONTEXT_ENVELOPE_CAPABILITY_ESCALATION'
  | 'GRD_CONTEXT_ENVELOPE_COVERAGE_INVALID'
  | 'GRD_CONTEXT_ENVELOPE_DUPLICATE'
  | 'GRD_CONTEXT_ENVELOPE_EXPIRED'
  | 'GRD_CONTEXT_ENVELOPE_HASH_MISMATCH'
  | 'GRD_CONTEXT_ENVELOPE_INVALID'
  | 'GRD_CONTEXT_ENVELOPE_SCOPE_MISMATCH';

export class ContextEnvelopeError extends Error {
  constructor(
    readonly code: ContextEnvelopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContextEnvelopeError';
  }
}

interface CompatibilityProfile {
  readonly sourceType: SourceType;
  readonly trustLevel: TrustLevel;
  readonly instructionCapability: InstructionCapability;
}

const DATA_ONLY_SOURCES = new Set<SourceType>(['RAG', 'TOOL', 'MEMORY', 'FILE', 'MEDIA']);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compatibilityProfile(request: GuardRequest): CompatibilityProfile {
  switch (request.context.direction) {
    case 'RAG_INGEST':
    case 'RAG_CONTEXT':
      return { sourceType: 'RAG', trustLevel: 'UNTRUSTED', instructionCapability: 'DATA_ONLY' };
    case 'TOOL_REQUEST':
    case 'TOOL_RESULT':
      return { sourceType: 'TOOL', trustLevel: 'UNTRUSTED', instructionCapability: 'DATA_ONLY' };
    case 'OUTPUT_CHUNK':
    case 'OUTPUT_COMPLETE':
      return { sourceType: 'AGENT', trustLevel: 'CONTROLLED', instructionCapability: 'DATA_ONLY' };
    case 'INPUT':
      return { sourceType: 'USER', trustLevel: 'UNTRUSTED', instructionCapability: 'ALLOWED' };
  }
}

function inferredEnvelope(request: GuardRequest, text: string): ContextEnvelope {
  const profile = compatibilityProfile(request);
  const contentHash = sha256(text);
  return {
    envelopeId: `compat_${contentHash.slice(0, 32)}`,
    tenantId: request.context.tenantId,
    applicationId: request.context.applicationId,
    sessionId: request.context.sessionId,
    sourceType: profile.sourceType,
    sourceId: request.context.requestId,
    trustLevel: profile.trustLevel,
    instructionCapability: profile.instructionCapability,
    sensitivityLabels: [],
    contentHash,
    parentEnvelopeIds: [],
    policyVersion: request.context.policyBundleId,
    eventSeq: 0,
    contentStart: 0,
    contentEnd: text.length,
  };
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function validateEnvelope(
  request: GuardRequest,
  text: string,
  envelope: ContextEnvelope,
  now: number,
): void {
  if (
    envelope.tenantId !== request.context.tenantId ||
    envelope.applicationId !== request.context.applicationId ||
    envelope.sessionId !== request.context.sessionId
  ) {
    throw new ContextEnvelopeError(
      'GRD_CONTEXT_ENVELOPE_SCOPE_MISMATCH',
      `Context envelope ${envelope.envelopeId} is outside the request scope`,
    );
  }
  if (
    !Number.isInteger(envelope.eventSeq) ||
    envelope.eventSeq < 0 ||
    !Number.isInteger(envelope.contentStart) ||
    !Number.isInteger(envelope.contentEnd) ||
    envelope.contentStart < 0 ||
    envelope.contentEnd > text.length ||
    (text.length > 0
      ? envelope.contentStart >= envelope.contentEnd
      : envelope.contentStart !== 0 || envelope.contentEnd !== 0) ||
    hasDuplicates(envelope.sensitivityLabels) ||
    hasDuplicates(envelope.parentEnvelopeIds)
  ) {
    throw new ContextEnvelopeError(
      'GRD_CONTEXT_ENVELOPE_INVALID',
      `Context envelope ${envelope.envelopeId} contains invalid bounds or duplicate metadata`,
    );
  }
  if (envelope.expiresAtEpochMs !== undefined && envelope.expiresAtEpochMs <= now) {
    throw new ContextEnvelopeError(
      'GRD_CONTEXT_ENVELOPE_EXPIRED',
      `Context envelope ${envelope.envelopeId} has expired`,
    );
  }
  if (DATA_ONLY_SOURCES.has(envelope.sourceType) && envelope.instructionCapability === 'ALLOWED') {
    throw new ContextEnvelopeError(
      'GRD_CONTEXT_ENVELOPE_CAPABILITY_ESCALATION',
      `Context envelope ${envelope.envelopeId} cannot grant instruction authority to ${envelope.sourceType}`,
    );
  }
  const actualHash = sha256(text.slice(envelope.contentStart, envelope.contentEnd));
  if (actualHash !== envelope.contentHash) {
    throw new ContextEnvelopeError(
      'GRD_CONTEXT_ENVELOPE_HASH_MISMATCH',
      `Context envelope ${envelope.envelopeId} does not match its content range`,
    );
  }
}

export function resolveContextEnvelopes(
  request: GuardRequest,
  now = Date.now(),
): readonly ContextEnvelope[] {
  const text = request.content.text ?? '';
  if (request.content.envelopes === undefined) {
    return request.content.text === undefined ? [] : [inferredEnvelope(request, text)];
  }
  const envelopes = [...request.content.envelopes];
  const envelopeIds = envelopes.map((envelope) => envelope.envelopeId);
  const eventSequences = envelopes.map((envelope) => envelope.eventSeq);
  if (hasDuplicates(envelopeIds) || new Set(eventSequences).size !== eventSequences.length) {
    throw new ContextEnvelopeError(
      'GRD_CONTEXT_ENVELOPE_DUPLICATE',
      'Context envelope ids and event sequences must be unique within a request',
    );
  }
  for (const envelope of envelopes) validateEnvelope(request, text, envelope, now);

  const ordered = envelopes.sort((left, right) =>
    left.contentStart - right.contentStart ||
    left.contentEnd - right.contentEnd ||
    left.envelopeId.localeCompare(right.envelopeId),
  );
  let cursor = 0;
  for (const envelope of ordered) {
    if (envelope.contentStart !== cursor) {
      throw new ContextEnvelopeError(
        'GRD_CONTEXT_ENVELOPE_COVERAGE_INVALID',
        'Context envelopes must form an exact, non-overlapping partition of request text',
      );
    }
    cursor = envelope.contentEnd;
  }
  if (cursor !== text.length || (text.length > 0 && ordered.length === 0)) {
    throw new ContextEnvelopeError(
      'GRD_CONTEXT_ENVELOPE_COVERAGE_INVALID',
      'Context envelopes must cover all request text',
    );
  }
  return ordered;
}

function sourceEnvelopeIds(
  start: number,
  end: number,
  envelopes: readonly ContextEnvelope[],
): readonly string[] {
  if (start === end) {
    return envelopes
      .filter((envelope) => start >= envelope.contentStart && start < envelope.contentEnd)
      .map((envelope) => envelope.envelopeId);
  }
  return envelopes
    .filter((envelope) => start < envelope.contentEnd && end > envelope.contentStart)
    .map((envelope) => envelope.envelopeId);
}

export function attachContextSources(
  observations: readonly Observation[],
  envelopes: readonly ContextEnvelope[],
): readonly Observation[] {
  return observations.map((observation) => ({
    ...observation,
    evidence: observation.evidence.map((evidence) => {
      if (evidence.start === undefined || evidence.end === undefined) return evidence;
      const envelopeIds = sourceEnvelopeIds(evidence.start, evidence.end, envelopes);
      return envelopeIds.length === 0
        ? evidence
        : { ...evidence, sourceEnvelopeIds: envelopeIds };
    }),
  }));
}

export function contextContentHash(value: string): string {
  return sha256(value);
}
