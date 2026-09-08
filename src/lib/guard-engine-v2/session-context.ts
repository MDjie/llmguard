import { createHash } from 'node:crypto';
import { resolveContextEnvelopes } from '@/lib/context-trust';
import { projectContextDecision } from './context-projection';
import { combineActionConstraints } from './action-constraints';
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
  if (current.bundleId !== session.bundleId) throw new Error('SESSION_POLICY_BUNDLE_MISMATCH');
  const action = combineActionConstraints([current.action, session.action]).action;
  if (session.observations.length === 0 && action === current.action && !session.degraded) return current;
  const historical = session.observations.map(sessionObservation);
  const riskOrder = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const;
  const degradationReasons = [...new Set([...current.degradationReasons, ...session.degradationReasons])].sort();
  const result: GuardDecision = {
    ...current,
    action,
    decisionId: 'dec_' + createHash('sha256').update(JSON.stringify([
      current.decisionId, session.decisionId, action,
    ])).digest('hex').slice(0, 32),
    riskLevel: riskOrder[current.riskLevel] >= riskOrder[session.riskLevel] ? current.riskLevel : session.riskLevel,
    observations: [...historical, ...current.observations],
    policyPath: [...new Set([...current.policyPath, ...session.policyPath, 'multi-turn-secure-memory'])],
    latencyMs: Math.min(600_000, current.latencyMs + session.latencyMs),
    latencyBreakdown: { totalMs: Math.min(600_000, current.latencyMs + session.latencyMs) },
    degradationReasons,
    degraded: Boolean(current.degraded || session.degraded || degradationReasons.length),
    reasonCodes: [...new Set([...(current.reasonCodes ?? []), ...(session.reasonCodes ?? [])])].sort(),
    evidenceComplete: current.evidenceComplete === true && session.evidenceComplete === true,
    failMode: current.failMode === 'FAIL_CLOSED' || session.failMode === 'FAIL_CLOSED' ? 'FAIL_CLOSED'
      : degradationReasons.length > 0 ? 'DEGRADED' : current.failMode ?? session.failMode ?? 'NORMAL',
  };
  // A combined-history transformation never describes the current response body.
  if (action !== current.action) {
    const { transformedText: _text, transform: _transform, ...withoutTransform } = result;
    return withoutTransform;
  }
  return result;
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
          eventSeq: 0,
          contentStart: 0,
          contentEnd: memoryText.length,
        },
        ...currentEnvelopes.map((envelope, index) => ({
          ...envelope,
          eventSeq: index + 1,
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
  options: {readonly readOnly?:boolean;readonly snapshot?:SecureMemorySnapshot;readonly signal?:AbortSignal} = {},
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
  if (!sessionId) return engine.evaluate(request, options.signal);
  const unified=engine.contextEvaluationMode==='unified-v1';
  const current = unified ? undefined : await engine.evaluate(request, options.signal);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = options.snapshot ?? await readSecureMemorySnapshot(scope, sessionId);
    const combined=snapshot.hasHistory?requestWithSecureMemory(request,snapshot):request;
    const contextualDecision = unified
      ? snapshot.hasHistory
        ? engine.evaluateContextual
          ? await engine.evaluateContextual(combined,request,options.signal)
          : projectContextDecision(await engine.evaluate(combined, options.signal),combined,request)
        : await engine.evaluate(request, options.signal)
      : snapshot.hasHistory
      ? chooseSessionDecision(
          current!,
          await engine.evaluate(requestWithSecureMemory(request, snapshot), options.signal),
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
