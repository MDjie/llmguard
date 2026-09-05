import { createHash } from 'node:crypto';
import { resolveContextEnvelopes } from '@/lib/context-trust';
import { projectContextDecision } from './context-projection';
import {
  advanceSessionRiskState,
  appendSecureMemoryEvaluation,
  applySessionRiskControl,
  readSecureMemorySnapshot,
  readSecureMemoryReplay,
  SecureMemoryVersionConflictError,
  sessionRiskControl,
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
  options: {readonly readOnly?:boolean;readonly snapshot?:SecureMemorySnapshot} = {},
): Promise<GuardDecision> {
  if (
    request.context.tenantId !== scope.tenantId ||
    request.context.applicationId !== scope.applicationId
  ) {
    throw new Error('GUARD_SESSION_SCOPE_MISMATCH');
  }
  const sessionId = request.context.sessionId;
  if(options.snapshot && !options.readOnly)throw new Error('GUARD_SESSION_SNAPSHOT_READ_ONLY_REQUIRED');
  if(sessionId && !options.readOnly) {
    const replay=await readSecureMemoryReplay(scope,request);
    if(replay)return replay;
  }
  if (!sessionId) return engine.evaluate(request);
  const unified=engine.contextEvaluationMode==='unified-v1';
  const current = unified ? undefined : await engine.evaluate(request);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = options.snapshot ?? await readSecureMemorySnapshot(scope, sessionId);
    const combined=snapshot.hasHistory?requestWithSecureMemory(request,snapshot):request;
    const contextualDecision = unified
      ? snapshot.hasHistory
        ? engine.evaluateContextual
          ? await engine.evaluateContextual(combined,request)
          : projectContextDecision(await engine.evaluate(combined),combined,request)
        : await engine.evaluate(request)
      : snapshot.hasHistory
      ? chooseSessionDecision(
          current!,
          await engine.evaluate(requestWithSecureMemory(request, snapshot)),
        )
      : current!;
    const riskAssessment = advanceSessionRiskState({
      previousState: snapshot.riskState,
      previousNodes: snapshot.intentNodes,
      previousTransitions: snapshot.stateTransitions,
      request,
      decision: contextualDecision,
    });
    const selected = applySessionRiskControl(
      contextualDecision,
      sessionRiskControl(riskAssessment),
    );
    if (options.readOnly) return selected;
    try {
      const stored=await appendSecureMemoryEvaluation({
        scope,
        sessionId,
        expectedStateVersion: snapshot.stateVersion,
        request,
        decision: selected,
        tokenizerId: request.context.tokenizerId,
        riskAssessment,
      });
      return stored.decision;
    } catch (error) {
      if (error instanceof SecureMemoryVersionConflictError && attempt === 0) continue;
      throw error;
    }
  }
  throw new SecureMemoryVersionConflictError();
}
