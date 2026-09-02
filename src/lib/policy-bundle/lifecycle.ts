export type PolicyBundleState =
  | 'draft'
  | 'testing'
  | 'pending_approval'
  | 'approved'
  | 'shadow'
  | 'canary'
  | 'active'
  | 'retired'
  | 'archived';

export type BundleTransition =
  | 'submit_test'
  | 'record_test_pass'
  | 'approve'
  | 'reject'
  | 'shadow'
  | 'canary'
  | 'activate'
  | 'rollback'
  | 'withdraw'
  | 'archive';

export class PolicyBundleTransitionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PolicyBundleTransitionError';
  }
}

const TRANSITIONS: Readonly<Record<PolicyBundleState, Partial<Record<BundleTransition, PolicyBundleState>>>> = {
  draft: { submit_test: 'testing' },
  testing: { record_test_pass: 'pending_approval' },
  pending_approval: { approve: 'approved', reject: 'draft' },
  approved: { shadow: 'shadow' },
  shadow: { canary: 'canary', withdraw: 'retired' },
  canary: { canary: 'canary', activate: 'active', withdraw: 'retired' },
  active: { rollback: 'retired', withdraw: 'retired' },
  retired: { archive: 'archived' },
  archived: {},
};

export function nextPolicyBundleState(current: PolicyBundleState, action: BundleTransition): PolicyBundleState {
  const next = TRANSITIONS[current]?.[action];
  if (!next) {
    throw new PolicyBundleTransitionError(
      'BUNDLE_STATE_INVALID',
      `Transition ${action} is not allowed from ${current}`,
    );
  }
  return next;
}

export interface PolicyEvaluationGate {
  readonly minimumCases: number;
  readonly minimumAccuracy: number;
  readonly minimumRecall: number;
  readonly maximumFalsePositiveRate: number;
  readonly maximumFalseNegativeRate: number;
}

export interface PolicyEvaluationEvidence {
  readonly status: string;
  readonly totalCases: number;
  readonly completedCases: number;
  readonly accuracy: number;
  readonly recall: number;
  readonly falsePositiveRate: number;
  readonly falseNegativeRate: number;
}

function percent(value: string | number | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return parsed;
}

export function resolvePolicyEvaluationGate(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PolicyEvaluationGate {
  const values = {
    minimumCases: Number(environment.POLICY_GATE_MIN_CASES ?? '2000'),
    minimumAccuracy: Number(environment.POLICY_GATE_MIN_ACCURACY ?? '95'),
    minimumRecall: Number(environment.POLICY_GATE_MIN_RECALL ?? '95'),
    maximumFalsePositiveRate: Number(environment.POLICY_GATE_MAX_FPR ?? '1'),
    maximumFalseNegativeRate: Number(environment.POLICY_GATE_MAX_FNR ?? '5'),
  };
  if (!Number.isSafeInteger(values.minimumCases) || values.minimumCases < 1 || values.minimumCases > 10_000_000) {
    throw new Error('POLICY_GATE_MIN_CASES must be a positive integer');
  }
  for (const [name, value] of Object.entries(values).slice(1)) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${name} must be between 0 and 100`);
  }
  return values;
}

export function evaluationGateViolations(
  evidence: {
    readonly status: string;
    readonly totalCases: number;
    readonly completedCases: number;
    readonly accuracy: string | number | null;
    readonly recall: string | number | null;
    readonly falsePositiveRate: string | number | null;
    readonly falseNegativeRate: string | number | null;
  },
  gate: PolicyEvaluationGate,
): readonly string[] {
  const normalized: PolicyEvaluationEvidence = {
    status: evidence.status,
    totalCases: evidence.totalCases,
    completedCases: evidence.completedCases,
    accuracy: percent(evidence.accuracy),
    recall: percent(evidence.recall),
    falsePositiveRate: percent(evidence.falsePositiveRate),
    falseNegativeRate: percent(evidence.falseNegativeRate),
  };
  const violations: string[] = [];
  if (normalized.status !== 'completed') violations.push('EVALUATION_NOT_COMPLETED');
  if (normalized.totalCases < gate.minimumCases) violations.push('EVALUATION_CASES_INSUFFICIENT');
  if (normalized.completedCases !== normalized.totalCases) violations.push('EVALUATION_CASES_INCOMPLETE');
  if (!Number.isFinite(normalized.accuracy) || normalized.accuracy < gate.minimumAccuracy) violations.push('ACCURACY_BELOW_GATE');
  if (!Number.isFinite(normalized.recall) || normalized.recall < gate.minimumRecall) violations.push('RECALL_BELOW_GATE');
  if (!Number.isFinite(normalized.falsePositiveRate) || normalized.falsePositiveRate > gate.maximumFalsePositiveRate) violations.push('FALSE_POSITIVE_RATE_ABOVE_GATE');
  if (!Number.isFinite(normalized.falseNegativeRate) || normalized.falseNegativeRate > gate.maximumFalseNegativeRate) violations.push('FALSE_NEGATIVE_RATE_ABOVE_GATE');
  return violations;
}
