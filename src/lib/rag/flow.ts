import type { GuardAction, GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';
import type { TenantScope } from '@/lib/tenancy';
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

const RANK: Readonly<Record<GuardAction, number>> = {
  ALLOW: 0, WARN: 1, MASK: 2, REWRITE: 2, REQUIRE_REVIEW: 3, SAFE_RESPONSE: 4, BLOCK: 5,
};

function allowed(candidate: RagCandidate, scope: TenantScope, principal: RagPrincipal): string | null {
  if (candidate.tenantId !== scope.tenantId || candidate.applicationId !== scope.applicationId) return 'RAG_SCOPE_MISMATCH';
  if (candidate.contentHash !== ragContentHash(candidate.text)) return 'RAG_CONTENT_HASH_MISMATCH';
  const { text: _text, signature, ...provenance } = candidate;
  if (!verifyRagProvenance(provenance, signature)) return 'RAG_PROVENANCE_INVALID';
  if (candidate.state !== 'accepted') return 'RAG_CHUNK_NOT_ACCEPTED';
  if (candidate.classification > principal.clearance) return 'RAG_CLASSIFICATION_DENIED';
  const principalAllowed = candidate.allowedPrincipals.length === 0 || candidate.allowedPrincipals.includes(principal.id);
  const roleAllowed = candidate.allowedRoles.length === 0 || candidate.allowedRoles.some((role) => principal.roles.includes(role));
  if (!principalAllowed || !roleAllowed) return 'RAG_ACL_DENIED';
  return null;
}

async function evaluate(bundle: RuntimePolicyBundle, context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'>, suffix: string, direction: GuardRequest['context']['direction'], text: string) {
  return createEngineForPolicyBundle(bundle).evaluate({
    contractVersion: '1.0',
    context: {
      ...context, requestId: `${context.traceId}-${suffix}`, direction, policyBundleId: bundle.id,
    },
    content: { text: text || '[empty RAG stage]' },
  });
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
}) {
  const context = {
    traceId: input.traceId,
    tenantId: input.scope.tenantId,
    applicationId: input.scope.applicationId,
    absoluteDeadlineEpochMs: input.absoluteDeadlineEpochMs,
  };
  const queryDecision = await evaluate(input.bundle, context, 'query', 'INPUT', input.query);
  const rejected: Array<{ chunkId: string; code: string }> = [];
  const accepted = input.candidates.filter((candidate) => {
    const code = allowed(candidate, input.scope, input.principal);
    if (code) rejected.push({ chunkId: candidate.chunkId, code });
    return !code;
  });
  const guardedContext = [
    `USER_QUERY: ${input.query}`,
    ...accepted.map((candidate) =>
      `UNTRUSTED_SOURCE chunk=${candidate.chunkId} trust=${candidate.trustLevel}: ${candidate.text}`),
  ].join('\n');
  const contextDecision = await evaluate(input.bundle, context, 'context', 'RAG_CONTEXT', guardedContext);
  const outputDecision = input.output === undefined
    ? null
    : await evaluate(input.bundle, context, 'output', 'OUTPUT_COMPLETE', input.output);
  const acceptedIds = new Set(accepted.map((item) => item.chunkId));
  const citations = input.citedChunkIds ?? [];
  const citationInvalid = input.output !== undefined && accepted.length > 0 &&
    (citations.length === 0 || citations.some((id) => !acceptedIds.has(id)));
  const decisions = [queryDecision, contextDecision, ...(outputDecision ? [outputDecision] : [])];
  let action = decisions.reduce<GuardAction>(
    (strongest, item) => RANK[item.action] > RANK[strongest] ? item.action : strongest,
    'ALLOW',
  );
  if (citationInvalid) action = 'BLOCK';
  const taintReasons = [
    ...(rejected.length > 0 ? ['retrieval_candidate_rejected'] : []),
    ...(contextDecision.action !== 'ALLOW' ? ['context_guard_risk'] : []),
    ...(citationInvalid ? ['citation_invalid'] : []),
  ];
  return {
    action,
    acceptedChunkIds: [...acceptedIds],
    rejected,
    tainted: taintReasons.length > 0,
    taintReasons,
    decisions: { query: queryDecision, context: contextDecision, output: outputDecision },
  };
}
