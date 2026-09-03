import { createHash } from 'node:crypto';
import { resolveContextEnvelopes } from '@/lib/context-trust';
import {
  appendSecureMemoryEvaluation,
  readSecureMemorySnapshot,
  SecureMemoryVersionConflictError,
  type SecureMemorySnapshot,
} from '@/lib/secure-memory';
import type { TenantScope } from '@/lib/tenancy';
import type { GuardDecision, GuardEngine, GuardRequest, Observation } from './types';

const ACTION_RANK = {
  ALLOW: 0,
  WARN: 1,
  MASK: 2,
  REWRITE: 2,
  REQUIRE_REVIEW: 3,
  SAFE_RESPONSE: 4,
  BLOCK: 5,
} as const;

function sessionObservation(observation: Observation): Observation {
  const reasoningChain = observation.riskType.startsWith('reasoning_attack.');
  return {
    ...observation,
    evidence: observation.evidence.map((item, index) => ({
      viewId: reasoningChain ? 'session_history_step_' + (index + 1) : 'session_history',
      contentHmac: item.contentHmac,
      maskedPreview: item.maskedPreview,
      ...(item.sourceEnvelopeIds ? { sourceEnvelopeIds: item.sourceEnvelopeIds } : {}),
    })),
    reasonCode: reasoningChain ? 'MULTI_TURN_REASONING_ATTACK' : 'MULTI_TURN_SESSION_RISK',
  };
}

export function chooseSessionDecision(
  current: GuardDecision,
  session: GuardDecision,
): GuardDecision {
  const sessionHasReasoningChain = session.observations.some(
    (observation) =>
      observation.status === 'MATCH' &&
      observation.riskType.startsWith('reasoning_attack.'),
  );
  if (
    ACTION_RANK[session.action] < ACTION_RANK[current.action] ||
    (ACTION_RANK[session.action] === ACTION_RANK[current.action] && !sessionHasReasoningChain)
  ) {
    return current;
  }
  return {
    ...session,
    traceId: current.traceId,
    observations: session.observations.map(sessionObservation),
    policyPath: [...session.policyPath, 'multi-turn-secure-memory'],
    latencyMs: Math.min(600_000, current.latencyMs + session.latencyMs),
  };
}

function requestWithSecureMemory(
  request: GuardRequest,
  snapshot: SecureMemorySnapshot,
): GuardRequest {
  const separator = '\n[guard-turn-boundary]\n';
  const memoryText = snapshot.hotWindow + separator;
  const currentText = request.content.text ?? '';
  const currentEnvelopes = resolveContextEnvelopes(request, Date.now());
  const sessionId = request.context.sessionId;
  if (!sessionId) return request;
  return {
    ...request,
    context: {
      ...request.context,
      requestId: request.context.requestId.slice(0, 105) + '-secure-memory',
    },
    content: {
      ...request.content,
      text: memoryText + currentText,
      envelopes: [
        {
          envelopeId: 'memory-' + createHash('sha256')
            .update(sessionId + ':' + snapshot.lastEventSequence, 'utf8')
            .digest('hex')
            .slice(0, 32),
          tenantId: request.context.tenantId,
          applicationId: request.context.applicationId,
          sessionId,
          sourceType: 'MEMORY',
          sourceId: 'secure-memory:' + sessionId,
          trustLevel: 'UNTRUSTED',
          instructionCapability: 'FORBIDDEN',
          sensitivityLabels: [],
          contentHash: createHash('sha256').update(memoryText, 'utf8').digest('hex'),
          parentEnvelopeIds: [],
          policyVersion: request.context.policyBundleId,
          eventSeq: snapshot.lastEventSequence,
          contentStart: 0,
          contentEnd: memoryText.length,
        },
        ...currentEnvelopes.map((envelope) => ({
          ...envelope,
          contentStart: envelope.contentStart + memoryText.length,
          contentEnd: envelope.contentEnd + memoryText.length,
        })),
      ],
    },
  };
}

export async function evaluateWithSessionContext(
  engine: GuardEngine,
  request: GuardRequest,
  scope: TenantScope,
): Promise<GuardDecision> {
  const current = await engine.evaluate(request);
  const sessionId = request.context.sessionId;
  if (!sessionId) return current;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await readSecureMemorySnapshot(scope, sessionId);
    const selected = snapshot.hasHistory
      ? chooseSessionDecision(
          current,
          await engine.evaluate(requestWithSecureMemory(request, snapshot)),
        )
      : current;
    try {
      await appendSecureMemoryEvaluation({
        scope,
        sessionId,
        expectedStateVersion: snapshot.stateVersion,
        request,
        decision: selected,
        tokenizerId: request.context.tokenizerId,
      });
      return selected;
    } catch (error) {
      if (error instanceof SecureMemoryVersionConflictError && attempt === 0) continue;
      throw error;
    }
  }
  throw new SecureMemoryVersionConflictError();
}
