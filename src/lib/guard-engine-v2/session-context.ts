import { and, eq } from 'drizzle-orm';
import { loadMasterKey, openSecret, sealSecret } from '@/lib/secrets';
import type { TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { guardSessionRiskStates } from '@/storage/database/shared/schema';
import type { GuardDecision, GuardEngine, GuardRequest, Observation } from './types';

const MAX_SESSION_TAIL_CHARS = 4_096;
const MAX_CONTRACT_TEXT_CHARS = 1_048_576;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const ACTION_RANK = {
  ALLOW: 0,
  WARN: 1,
  MASK: 2,
  REWRITE: 2,
  REQUIRE_REVIEW: 3,
  SAFE_RESPONSE: 4,
  BLOCK: 5,
} as const;

function stateReference(scope: TenantScope, sessionId: string): string {
  return `guard-session:${scope.tenantId}:${scope.applicationId}:${sessionId}`;
}

function ttlMs(): number {
  const configured = Number(process.env.GUARD_SESSION_STATE_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(configured)
    ? Math.min(MAX_TTL_MS, Math.max(60_000, Math.floor(configured)))
    : DEFAULT_TTL_MS;
}

export async function appendGuardSessionTurn(
  scope: TenantScope,
  sessionId: string,
  currentText: string,
): Promise<{ combinedText: string; hasHistory: boolean; turnCount: number }> {
  if (!sessionId || sessionId.length > 128) throw new Error('GUARD_SESSION_ID_INVALID');
  const key = loadMasterKey();
  const reference = stateReference(scope, sessionId);
  try {
    return await db.transaction(async (transaction) => {
      const [stored] = await transaction.select().from(guardSessionRiskStates).where(and(
        eq(guardSessionRiskStates.tenantId, scope.tenantId),
        eq(guardSessionRiskStates.applicationId, scope.applicationId),
        eq(guardSessionRiskStates.sessionId, sessionId),
      )).limit(1).for('update');
      const active = stored && stored.expiresAt.getTime() > Date.now() ? stored : undefined;
      const previous = active ? openSecret(active.tailEnvelope, reference, key) : '';
      const combined = previous
        ? `${previous}\n[guard-turn-boundary]\n${currentText}`
        : currentText;
      const combinedText = combined.slice(-MAX_CONTRACT_TEXT_CHARS);
      const tail = combinedText.slice(-MAX_SESSION_TAIL_CHARS);
      const envelope = sealSecret(tail, reference, key);
      const next = {
        ...scope,
        sessionId,
        tailEnvelope: envelope,
        turnCount: (active?.turnCount ?? 0) + 1,
        stateVersion: (active?.stateVersion ?? 0) + 1,
        expiresAt: new Date(Date.now() + ttlMs()),
        updatedAt: new Date(),
      };
      await transaction.insert(guardSessionRiskStates).values(next).onConflictDoUpdate({
        target: [
          guardSessionRiskStates.tenantId,
          guardSessionRiskStates.applicationId,
          guardSessionRiskStates.sessionId,
        ],
        set: {
          tailEnvelope: next.tailEnvelope,
          turnCount: next.turnCount,
          stateVersion: next.stateVersion,
          expiresAt: next.expiresAt,
          updatedAt: next.updatedAt,
        },
      });
      return {
        combinedText,
        hasHistory: Boolean(previous),
        turnCount: next.turnCount,
      };
    });
  } finally {
    key.bytes.fill(0);
  }
}

function sessionObservation(observation: Observation): Observation {
  const reasoningChain = observation.riskType.startsWith('reasoning_attack.');
  return {
    ...observation,
    evidence: observation.evidence.map((item, index) => ({
      viewId: reasoningChain ? `session_history_step_${index + 1}` : 'session_history',
      contentHmac: item.contentHmac,
      maskedPreview: item.maskedPreview,
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
    policyPath: [...session.policyPath, 'multi-turn-session'],
    latencyMs: Math.min(600_000, current.latencyMs + session.latencyMs),
  };
}

export async function evaluateWithSessionContext(
  engine: GuardEngine,
  request: GuardRequest,
  scope: TenantScope,
): Promise<GuardDecision> {
  const currentPromise = engine.evaluate(request);
  const sessionId = request.context.sessionId;
  if (!sessionId) return currentPromise;
  const [current, sessionState] = await Promise.all([
    currentPromise,
    appendGuardSessionTurn(scope, sessionId, request.content.text ?? ''),
  ]);
  if (!sessionState.hasHistory) return current;
  const sessionRequest: GuardRequest = {
    ...request,
    context: {
      ...request.context,
      requestId: `${request.context.requestId.slice(0, 115)}-session`,
    },
    content: {
      ...request.content,
      text: sessionState.combinedText,
    },
  };
  return chooseSessionDecision(current, await engine.evaluate(sessionRequest));
}
