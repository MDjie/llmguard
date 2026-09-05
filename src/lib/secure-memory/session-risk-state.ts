import { createHash } from 'node:crypto';
import type { GuardDecision, GuardRequest, RiskLevel } from '@guardllm/contracts';
import type { SecureMemoryRiskState } from './types';

export type SessionIntentPhase =
  | 'BOUNDARY_PROBE'
  | 'FRAGMENT_REQUEST'
  | 'SENSITIVE_TARGET'
  | 'EXECUTION_REQUEST'
  | 'BENIGN';

export interface SessionIntentNode {
  readonly id: string;
  readonly occurredAt: string;
  readonly lastDecayedAt: string;
  readonly phases: readonly SessionIntentPhase[];
  readonly riskTypes: readonly string[];
  readonly decayedScore: number;
  readonly sources: readonly string[];
  readonly evidenceHmacs: readonly string[];
  readonly action: GuardDecision['action'];
}

export interface SessionStateTransition {
  readonly from: SecureMemoryRiskState;
  readonly to: SecureMemoryRiskState;
  readonly reasonCode: string;
  readonly occurredAt: string;
}

export interface SessionRiskAssessment {
  readonly state: SecureMemoryRiskState;
  readonly intentNodes: readonly SessionIntentNode[];
  readonly transitions: readonly SessionStateTransition[];
  readonly riskVector: Readonly<Record<string, number>>;
  readonly recentRiskTypes: readonly string[];
  readonly escalationLevel: number;
  readonly reasonCodes: readonly string[];
  readonly chainDepth: number;
}

export interface SessionRiskControl {
  readonly state: SecureMemoryRiskState;
  readonly enhancedDetection: boolean;
  readonly concurrencyPercent: number;
  readonly minimumAction?: GuardDecision['action'];
  readonly reasonCodes: readonly string[];
}

const MAX_INTENT_NODES = 32;
const MAX_TRANSITIONS = 64;
const HALF_LIFE_MS = 2 * 60 * 60 * 1_000;
const BENIGN_TURN_FACTOR = 0.82;
const PHASE_ORDER: readonly Exclude<SessionIntentPhase, 'BENIGN'>[] = [
  'BOUNDARY_PROBE',
  'FRAGMENT_REQUEST',
  'SENSITIVE_TARGET',
  'EXECUTION_REQUEST',
];

const PHASE_PATTERNS: ReadonlyArray<readonly [Exclude<SessionIntentPhase, 'BENIGN'>, RegExp]> = [
  ['BOUNDARY_PROBE', /(?:\b(?:policy|rules?|restriction|guardrail|boundary|forbidden)\b|规则|策略|限制|边界|不能回答|拒答)/iu],
  ['FRAGMENT_REQUEST', /(?:\b(?:fragment|chunk|piece|split|first\s+part|continue\s+from)\b|片段|分段|拆分|一部分|逐字|继续上次)/iu],
  ['SENSITIVE_TARGET', /(?:\b(?:system\s+prompt|developer\s+message|secret|credential|password|api[\s_-]?key|jailbreak|bypass)\b|系统提示|开发者指令|密钥|口令|凭证|绕过|越权)/iu],
  ['EXECUTION_REQUEST', /(?:\b(?:execute|run|apply|assemble|combine|reconstruct|follow\s+these\s+instructions)\b|执行|运行|拼接|组合|还原|照做)/iu],
];

const ACTION_SCORE: Readonly<Record<GuardDecision['action'], number>> = {
  ALLOW: 0,
  WARN: 0.25,
  MASK: 0.35,
  REWRITE: 0.45,
  REQUIRE_REVIEW: 0.7,
  SAFE_RESPONSE: 0.85,
  BLOCK: 1,
};

const ACTION_RANK: Readonly<Record<GuardDecision['action'], number>> = {
  ALLOW: 0,
  WARN: 1,
  MASK: 2,
  REWRITE: 2,
  REQUIRE_REVIEW: 3,
  SAFE_RESPONSE: 4,
  BLOCK: 5,
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 10_000) / 10_000));
}

function classifyPhases(text: string): readonly SessionIntentPhase[] {
  const normalized = text.normalize('NFKC');
  const phases = PHASE_PATTERNS
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([phase]) => phase);
  return phases.length > 0 ? phases : ['BENIGN'];
}

function sourceKinds(request: GuardRequest): readonly string[] {
  return [...new Set([
    ...(request.content.text ? ['VISIBLE_TEXT'] : []),
    ...(request.content.envelopes ?? []).map((envelope) => envelope.sourceType),
    ...(request.content.artifacts ?? []).map((artifact) => `ARTIFACT_${artifact.kind}`),
  ])].sort().slice(0, 32);
}

function evidenceDigests(request: GuardRequest, decision: GuardDecision): readonly string[] {
  const evidence = decision.observations.flatMap((observation) =>
    observation.evidence.map((item) => item.contentHmac));
  if (evidence.length > 0) return [...new Set(evidence)].slice(0, 16);
  return [createHash('sha256')
    .update(`${request.context.requestId}:${decision.decisionId}`, 'utf8')
    .digest('hex')];
}

function initialScore(phases: readonly SessionIntentPhase[], decision: GuardDecision): number {
  const phaseScore = phases.reduce((total, phase) => total + (
    phase === 'BOUNDARY_PROBE' ? 0.18
      : phase === 'FRAGMENT_REQUEST' ? 0.22
        : phase === 'SENSITIVE_TARGET' ? 0.38
          : phase === 'EXECUTION_REQUEST' ? 0.42
            : 0
  ), 0);
  const observationScore = decision.observations
    .filter(isConfirmedObservation)
    .reduce((maximum, observation) => Math.max(maximum, observation.score), 0);
  return clampScore(Math.max(phaseScore, observationScore, ACTION_SCORE[decision.action]));
}

function decayNode(node: SessionIntentNode, at: Date, benignTurn: boolean): SessionIntentNode {
  const last = Date.parse(node.lastDecayedAt);
  const elapsed = Number.isFinite(last) ? Math.max(0, at.getTime() - last) : 0;
  const timeFactor = Math.exp(-Math.LN2 * elapsed / HALF_LIFE_MS);
  const turnFactor = benignTurn ? BENIGN_TURN_FACTOR : 1;
  return {
    ...node,
    lastDecayedAt: at.toISOString(),
    decayedScore: clampScore(node.decayedScore * timeFactor * turnFactor),
  };
}

export function detectProgressiveIntentChain(
  nodes: readonly SessionIntentNode[],
): { readonly depth: number; readonly matchedNodeIds: readonly string[] } {
  let expected = 0;
  const matchedNodeIds: string[] = [];
  for (const node of nodes) {
    if (node.decayedScore < 0.08) continue;
    if (node.phases.includes(PHASE_ORDER[expected])) {
      matchedNodeIds.push(node.id);
      expected += 1;
      if (expected === PHASE_ORDER.length) break;
    }
  }
  return { depth: expected, matchedNodeIds };
}

function stateFor(
  decision: GuardDecision,
  nodes: readonly SessionIntentNode[],
  chainDepth: number,
): { readonly state: SecureMemoryRiskState; readonly reasonCode: string } {
  const aggregate = nodes.reduce((total, node) => total + node.decayedScore, 0);
  const peak = nodes.reduce((maximum, node) => Math.max(maximum, node.decayedScore), 0);
  if (decision.action === 'BLOCK' || chainDepth >= 4 || aggregate >= 2.4) {
    return {
      state: 'LOCKED',
      reasonCode: chainDepth >= 4 ? 'SESSION_PROGRESSIVE_CHAIN_COMPLETE' : 'SESSION_CRITICAL_RISK',
    };
  }
  if (
    decision.action === 'SAFE_RESPONSE' || decision.action === 'REQUIRE_REVIEW' ||
    chainDepth >= 3 || aggregate >= 1.25 || peak >= 0.85
  ) {
    return {
      state: 'ESCALATED',
      reasonCode: chainDepth >= 3 ? 'SESSION_PROGRESSIVE_CHAIN_ESCALATED' : 'SESSION_ACCUMULATED_RISK',
    };
  }
  if (nodes.some((node) => node.decayedScore >= 0.16) || decision.action !== 'ALLOW') {
    return { state: 'WATCH', reasonCode: 'SESSION_RISK_WATCH' };
  }
  return { state: 'NORMAL', reasonCode: 'SESSION_RISK_DECAYED' };
}

export function advanceSessionRiskState(input: {
  readonly previousState: SecureMemoryRiskState;
  readonly previousNodes: readonly SessionIntentNode[];
  readonly previousTransitions?: readonly SessionStateTransition[];
  readonly request: GuardRequest;
  readonly decision: GuardDecision;
  readonly occurredAt?: Date;
}): SessionRiskAssessment {
  const occurredAt = input.occurredAt ?? new Date();
  const phases = classifyPhases(input.request.content.text ?? '');
  const benignTurn = phases.length === 1 && phases[0] === 'BENIGN' && input.decision.action === 'ALLOW';
  const decayed = input.previousNodes
    .map((node) => decayNode(node, occurredAt, benignTurn))
    .filter((node) => node.decayedScore >= 0.02);
  const riskTypes = [...new Set(input.decision.observations
    .filter(isConfirmedObservation)
    .map((observation) => observation.riskType))].sort().slice(0, 32);
  const node: SessionIntentNode = {
    id: createHash('sha256')
      .update(`${input.request.context.requestId}:${input.decision.decisionId}`, 'utf8')
      .digest('hex')
      .slice(0, 32),
    occurredAt: occurredAt.toISOString(),
    lastDecayedAt: occurredAt.toISOString(),
    phases,
    riskTypes,
    decayedScore: initialScore(phases, input.decision),
    sources: sourceKinds(input.request),
    evidenceHmacs: evidenceDigests(input.request, input.decision),
    action: input.decision.action,
  };
  const intentNodes = [...decayed, node].slice(-MAX_INTENT_NODES);
  const chain = detectProgressiveIntentChain(intentNodes);
  const next = stateFor(input.decision, intentNodes, chain.depth);
  const transition: SessionStateTransition | undefined = next.state === input.previousState
    ? undefined
    : {
        from: input.previousState,
        to: next.state,
        reasonCode: next.reasonCode,
        occurredAt: occurredAt.toISOString(),
      };
  const transitions = [
    ...(input.previousTransitions ?? []),
    ...(transition ? [transition] : []),
  ].slice(-MAX_TRANSITIONS);
  const riskVector = Object.fromEntries(intentNodes.flatMap((item) =>
    item.riskTypes.map((riskType) => [riskType, item.decayedScore]))) as Record<string, number>;
  const recentRiskTypes = [...new Set(intentNodes.flatMap((item) => item.riskTypes))].slice(-32);
  const escalationLevel = next.state === 'NORMAL' ? 0
    : next.state === 'WATCH' ? 1
      : next.state === 'ESCALATED' ? 2
        : 3;
  return {
    state: next.state,
    intentNodes,
    transitions,
    riskVector,
    recentRiskTypes,
    escalationLevel,
    reasonCodes: [...new Set([
      next.reasonCode,
      ...(chain.depth > 0 ? [`SESSION_PROGRESSIVE_CHAIN_DEPTH_${chain.depth}`] : []),
    ])],
    chainDepth: chain.depth,
  };
}

export function closeSessionRiskState(input: {
  readonly previousState: SecureMemoryRiskState;
  readonly previousTransitions?: readonly SessionStateTransition[];
  readonly occurredAt?: Date;
}): SessionRiskAssessment {
  const occurredAt = input.occurredAt ?? new Date();
  const transition: SessionStateTransition | undefined = input.previousState === 'NORMAL'
    ? undefined
    : {
        from: input.previousState,
        to: 'NORMAL',
        reasonCode: 'SESSION_EXPLICITLY_ENDED',
        occurredAt: occurredAt.toISOString(),
      };
  return {
    state: 'NORMAL',
    intentNodes: [],
    transitions: [...(input.previousTransitions ?? []), ...(transition ? [transition] : [])]
      .slice(-MAX_TRANSITIONS),
    riskVector: {},
    recentRiskTypes: [],
    escalationLevel: 0,
    reasonCodes: ['SESSION_EXPLICITLY_ENDED'],
    chainDepth: 0,
  };
}

export function sessionRiskControl(
  assessment: Pick<SessionRiskAssessment, 'state' | 'reasonCodes'>,
): SessionRiskControl {
  switch (assessment.state) {
    case 'LOCKED':
      return {
        state: assessment.state,
        enhancedDetection: true,
        concurrencyPercent: 0,
        minimumAction: 'BLOCK',
        reasonCodes: assessment.reasonCodes,
      };
    case 'ESCALATED':
      return {
        state: assessment.state,
        enhancedDetection: true,
        concurrencyPercent: 40,
        minimumAction: 'SAFE_RESPONSE',
        reasonCodes: assessment.reasonCodes,
      };
    case 'WATCH':
      return {
        state: assessment.state,
        enhancedDetection: true,
        concurrencyPercent: 75,
        reasonCodes: assessment.reasonCodes,
      };
    default:
      return {
        state: assessment.state,
        enhancedDetection: false,
        concurrencyPercent: 100,
        reasonCodes: assessment.reasonCodes,
      };
  }
}

export function applySessionRiskControl(
  decision: GuardDecision,
  control: SessionRiskControl,
): GuardDecision {
  if (!control.minimumAction || ACTION_RANK[decision.action] >= ACTION_RANK[control.minimumAction]) {
    return control.enhancedDetection
      ? { ...decision, policyPath: [...decision.policyPath, `session-state:${control.state.toLowerCase()}`] }
      : decision;
  }
  const riskLevel: RiskLevel = control.minimumAction === 'BLOCK' ? 'CRITICAL' : 'HIGH';
  return {
    ...decision,
    action: control.minimumAction,
    riskLevel,
    observations: [
      ...decision.observations,
      {
        detectorId: 'session-risk-state',
        detectorVersion: '1.0.0',
        riskType: 'reasoning_attack.progressive_session',
        score: control.minimumAction === 'BLOCK' ? 1 : 0.9,
        severity: riskLevel,
        evidence: [],
        status: 'MATCH',
        reasonCode: control.reasonCodes[0] ?? 'SESSION_RISK_ESCALATION',
      },
    ],
    policyPath: [...decision.policyPath, `session-state:${control.state.toLowerCase()}`],
  };
}
import { isConfirmedObservation } from '@/lib/guard-engine-v2/observation-role';
