import { createHash } from 'node:crypto';
import type {
  ContextEnvelope,
  GuardAction,
  GuardDecision,
  GuardRequest,
  InstructionCapability,
  SourceType,
  TrustLevel,
} from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';
import type { TenantScope } from '@/lib/tenancy';
import { assessGroundedness } from './groundedness';
import { assessSemanticGroundedness } from './semantic-groundedness';
import { ragContentHash, type RagProvenance, verifyRagProvenance } from './provenance';

export interface RagCandidate extends RagProvenance {
  readonly text: string;
  readonly signature: string;
}

export interface RagPrincipal {
  readonly id: string;
  readonly roles: readonly string[];
  readonly clearance: number;
}

interface ContextSegment {
  readonly text: string;
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly trustLevel: TrustLevel;
  readonly instructionCapability: InstructionCapability;
  readonly sensitivityLabels: readonly string[];
}

const MAX_CONTEXT_CHARS = 1_000_000;
const RANK: Readonly<Record<GuardAction, number>> = {
  ALLOW: 0, WARN: 1, MASK: 2, REWRITE: 2, REQUIRE_REVIEW: 3, SAFE_RESPONSE: 4, BLOCK: 5,
};

function allowed(
  candidate: RagCandidate,
  scope: TenantScope,
  principal: RagPrincipal,
  minimumTrustLevel: number,
  now: number,
): string | null {
  if (candidate.tenantId !== scope.tenantId || candidate.applicationId !== scope.applicationId) return 'RAG_SCOPE_MISMATCH';
  if (candidate.contentHash !== ragContentHash(candidate.text)) return 'RAG_CONTENT_HASH_MISMATCH';
  const { signature } = candidate;
  const provenance: RagProvenance = {
    tenantId: candidate.tenantId,
    applicationId: candidate.applicationId,
    sourceId: candidate.sourceId,
    chunkId: candidate.chunkId,
    contentHash: candidate.contentHash,
    trustLevel: candidate.trustLevel,
    classification: candidate.classification,
    allowedPrincipals: candidate.allowedPrincipals,
    allowedRoles: candidate.allowedRoles,
    state: candidate.state,
    ...(candidate.sourceVersion ? { sourceVersion: candidate.sourceVersion } : {}),
    ...(candidate.validUntilEpochMs === undefined
      ? {}
      : { validUntilEpochMs: candidate.validUntilEpochMs }),
  };
  if (!verifyRagProvenance(provenance, signature)) return 'RAG_PROVENANCE_INVALID';
  if (candidate.state !== 'accepted') return 'RAG_CHUNK_NOT_ACCEPTED';
  if (candidate.validUntilEpochMs !== undefined && candidate.validUntilEpochMs <= now) return 'RAG_SOURCE_EXPIRED';
  if (candidate.trustLevel < minimumTrustLevel) return 'RAG_SOURCE_REPUTATION_LOW';
  if (candidate.classification > principal.clearance) return 'RAG_CLASSIFICATION_DENIED';
  const principalAllowed = candidate.allowedPrincipals.length === 0 || candidate.allowedPrincipals.includes(principal.id);
  const roleAllowed = candidate.allowedRoles.length === 0 || candidate.allowedRoles.some((role) => principal.roles.includes(role));
  if (!principalAllowed || !roleAllowed) return 'RAG_ACL_DENIED';
  return null;
}

function materializeSegments(
  scope: TenantScope,
  bundle: RuntimePolicyBundle,
  suffix: string,
  segments: readonly ContextSegment[],
): GuardRequest['content'] {
  const normalized = segments.length > 0 ? segments : [{
    text: '[empty RAG stage]',
    sourceType: 'SYSTEM' as const,
    sourceId: 'guardllm-rag-empty',
    trustLevel: 'TRUSTED' as const,
    instructionCapability: 'DATA_ONLY' as const,
    sensitivityLabels: [],
  }];
  let text = '';
  const envelopes: ContextEnvelope[] = [];
  normalized.forEach((segment, index) => {
    const start = text.length;
    text += segment.text;
    const end = text.length;
    envelopes.push({
      envelopeId: 'rag-' + createHash('sha256')
        .update(suffix + ':' + index + ':' + segment.sourceId, 'utf8')
        .digest('hex')
        .slice(0, 32),
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      sourceType: segment.sourceType,
      sourceId: segment.sourceId,
      trustLevel: segment.trustLevel,
      instructionCapability: segment.instructionCapability,
      sensitivityLabels: [...segment.sensitivityLabels],
      contentHash: ragContentHash(segment.text),
      parentEnvelopeIds: [],
      policyVersion: String(bundle.payload.policyVersion),
      eventSeq: index,
      contentStart: start,
      contentEnd: end,
    });
  });
  return { text, envelopes };
}

async function evaluate(
  bundle: RuntimePolicyBundle,
  context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'>,
  scope: TenantScope,
  suffix: string,
  direction: GuardRequest['context']['direction'],
  segments: readonly ContextSegment[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return createEngineForPolicyBundle(bundle).evaluate({
    contractVersion: '1.0',
    context: {
      ...context,
      requestId: (context.traceId + '-' + suffix).slice(0, 128),
      direction,
      policyBundleId: bundle.id,
      stage: direction === 'RAG_INGEST' ? 'RAG_INGEST'
        : direction === 'RAG_CONTEXT' ? 'RAG_RETRIEVE'
          : direction === 'OUTPUT_COMPLETE' ? 'OUTPUT_POST' : 'INPUT_PRE',
    },
    content: materializeSegments(scope, bundle, suffix, segments),
  }, signal);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

function stronger(left: GuardAction, right: GuardAction): GuardAction {
  return RANK[right] > RANK[left] ? right : left;
}

export async function guardRagFlow(input: {
  scope: TenantScope;
  principal: RagPrincipal;
  bundle: RuntimePolicyBundle;
  traceId: string;
  absoluteDeadlineEpochMs: number;
  query: string;
  candidates: readonly RagCandidate[];
  output?: string;
  citedChunkIds?: readonly string[];
  minimumTrustLevel?: number;
  maximumCandidatesPerSource?: number;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const context = {
    traceId: input.traceId,
    tenantId: input.scope.tenantId,
    applicationId: input.scope.applicationId,
    absoluteDeadlineEpochMs: input.absoluteDeadlineEpochMs,
  };
  const queryDecision = await evaluate(input.bundle, context, input.scope, 'query', 'INPUT', [{
    text: input.query,
    sourceType: 'USER',
    sourceId: input.principal.id,
    trustLevel: 'CONTROLLED',
    instructionCapability: 'ALLOWED',
    sensitivityLabels: [],
  }], input.signal);
  const rejected: Array<{ chunkId: string; code: string }> = [];
  const structurallyAccepted: RagCandidate[] = [];
  const sourceCounts = new Map<string, number>();
  const seenContent = new Set<string>();
  let acceptedChars = 0;
  const minimumTrustLevel = input.minimumTrustLevel ?? 0;
  const maximumCandidatesPerSource = input.maximumCandidatesPerSource ?? 20;
  const now = Date.now();
  for (const candidate of input.candidates) {
    let code = allowed(candidate, input.scope, input.principal, minimumTrustLevel, now);
    const sourceCount = (sourceCounts.get(candidate.sourceId) ?? 0) + 1;
    if (!code && sourceCount > maximumCandidatesPerSource) code = 'RAG_SOURCE_CONCENTRATION_LIMIT';
    if (!code && seenContent.has(candidate.contentHash)) code = 'RAG_DUPLICATE_CONTENT';
    if (!code && acceptedChars + candidate.text.length > MAX_CONTEXT_CHARS) code = 'RAG_CONTEXT_CAPACITY_EXCEEDED';
    if (code) {
      rejected.push({ chunkId: candidate.chunkId, code });
      continue;
    }
    sourceCounts.set(candidate.sourceId, sourceCount);
    seenContent.add(candidate.contentHash);
    acceptedChars += candidate.text.length;
    structurallyAccepted.push(candidate);
  }
  const candidateDecisions = await mapWithConcurrency(
    structurallyAccepted,
    8,
    (candidate, index) => evaluate(
      input.bundle,
      context,
      input.scope,
      'chunk-' + index,
      'RAG_CONTEXT',
      [{
        text: candidate.text,
        sourceType: 'RAG',
        sourceId: candidate.sourceId + ':' + candidate.chunkId,
        trustLevel: 'UNTRUSTED',
        instructionCapability: 'FORBIDDEN',
        sensitivityLabels: [
          'classification:' + candidate.classification,
          'reputation:' + candidate.trustLevel,
        ],
      }], input.signal,
    ),
  );
  const accepted: RagCandidate[] = [];
  const acceptedCandidateDecisions: GuardDecision[] = [];
  structurallyAccepted.forEach((candidate, index) => {
    const decision = candidateDecisions[index];
    if (['BLOCK', 'SAFE_RESPONSE', 'REQUIRE_REVIEW', 'MASK', 'REWRITE'].includes(decision.action)) {
      rejected.push({ chunkId: candidate.chunkId, code: 'RAG_CHUNK_GUARD_REJECTED' });
    } else {
      accepted.push(candidate);
      acceptedCandidateDecisions.push(decision);
    }
  });
  const contextSegments: ContextSegment[] = [{
    text: 'USER_QUERY:\n',
    sourceType: 'SYSTEM',
    sourceId: 'guardllm-rag-frame-query',
    trustLevel: 'TRUSTED',
    instructionCapability: 'DATA_ONLY',
    sensitivityLabels: [],
  }, {
    text: input.query,
    sourceType: 'USER',
    sourceId: input.principal.id,
    trustLevel: 'CONTROLLED',
    instructionCapability: 'ALLOWED',
    sensitivityLabels: [],
  }];
  for (const candidate of accepted) {
    contextSegments.push({
      text: '\nUNTRUSTED_SOURCE ' + candidate.chunkId + ':\n',
      sourceType: 'SYSTEM',
      sourceId: 'guardllm-rag-frame-' + candidate.chunkId,
      trustLevel: 'TRUSTED',
      instructionCapability: 'DATA_ONLY',
      sensitivityLabels: [],
    }, {
      text: candidate.text,
      sourceType: 'RAG',
      sourceId: candidate.sourceId + ':' + candidate.chunkId,
      trustLevel: 'UNTRUSTED',
      instructionCapability: 'FORBIDDEN',
      sensitivityLabels: [
        'classification:' + candidate.classification,
        'reputation:' + candidate.trustLevel,
      ],
    });
  }
  const contextDecision = await evaluate(
    input.bundle,
    context,
    input.scope,
    'combined-context',
    'RAG_CONTEXT',
    contextSegments, input.signal,
  );
  const combinationDecision = await evaluate(
    input.bundle,
    context,
    input.scope,
    'chunk-combination',
    'RAG_CONTEXT',
    accepted.map((candidate) => ({
      text: candidate.text,
      sourceType: 'RAG' as const,
      sourceId: candidate.sourceId + ':' + candidate.chunkId,
      trustLevel: 'UNTRUSTED' as const,
      instructionCapability: 'FORBIDDEN' as const,
      sensitivityLabels: [
        'classification:' + candidate.classification,
        'reputation:' + candidate.trustLevel,
      ],
    })), input.signal,
  );
  const outputDecision = input.output === undefined
    ? null
    : await evaluate(input.bundle, context, input.scope, 'output', 'OUTPUT_COMPLETE', [{
        text: input.output,
        sourceType: 'AGENT',
        sourceId: 'rag-model-output',
        trustLevel: 'CONTROLLED',
        instructionCapability: 'DATA_ONLY',
        sensitivityLabels: [],
      }], input.signal);
  input.signal?.throwIfAborted();
  const acceptedIds = new Set(accepted.map((item) => item.chunkId));
  const citations = input.citedChunkIds ?? [];
  const citationInvalid = input.output !== undefined && (
    citations.length === 0 || citations.some((id) => !acceptedIds.has(id))
  );
  const citedIds = new Set(citations.filter((id) => acceptedIds.has(id)));
  const lexicalGroundedness = assessGroundedness({
    output: input.output,
    citedTexts: accepted.filter((candidate) => citedIds.has(candidate.chunkId)).map((candidate) => candidate.text),
  });
  const groundedness=input.bundle.payload.semanticDecisionMode==='coverage-v1'
    ? await assessSemanticGroundedness({profiles:input.bundle.payload.judgeProfiles??[],scope:input.scope,output:input.output,
      citations:accepted.filter(candidate=>citedIds.has(candidate.chunkId)),traceId:input.traceId,deadline:input.absoluteDeadlineEpochMs})
    : lexicalGroundedness;
  const decisions = [
    queryDecision,
    ...candidateDecisions,
    contextDecision,
    combinationDecision,
    ...(outputDecision ? [outputDecision] : []),
  ];
  let action = decisions.reduce<GuardAction>(
    (strongest, item) => stronger(strongest, item.action),
    'ALLOW',
  );
  if (citationInvalid) action = 'BLOCK';
  else if (groundedness.status === 'FAIL' || groundedness.status === 'INSUFFICIENT_CONTEXT') {
    action = stronger(action, 'REQUIRE_REVIEW');
  }
  const uniqueSources = new Set(accepted.map((candidate) => candidate.sourceId)).size;
  const diversityLow = accepted.length >= 3 && uniqueSources < 2;
  if (diversityLow) action = stronger(action, 'WARN');
  const taintReasons = [
    ...(rejected.length > 0 ? ['retrieval_candidate_rejected'] : []),
    ...(acceptedCandidateDecisions.some((decision) => decision.action === 'WARN') ? ['candidate_guard_warning'] : []),
    ...(contextDecision.action !== 'ALLOW' ? ['context_guard_risk'] : []),
    ...(combinationDecision.action !== 'ALLOW' ? ['cross_chunk_combination_risk'] : []),
    ...(citationInvalid ? ['citation_invalid'] : []),
    ...groundedness.reasonCodes.map((code) => code.toLowerCase()),
    ...(diversityLow ? ['source_diversity_low'] : []),
  ];
  return {
    action,
    acceptedChunkIds: [...acceptedIds],
    rejected,
    tainted: taintReasons.length > 0,
    taintReasons: [...new Set(taintReasons)],
    sourceDiversity: { uniqueSources, acceptedChunks: accepted.length, low: diversityLow },
    groundedness,
    lexicalGroundedness,
    decisions: {
      query: queryDecision,
      candidates: candidateDecisions,
      context: contextDecision,
      combination: combinationDecision,
      output: outputDecision,
    },
  };
}
