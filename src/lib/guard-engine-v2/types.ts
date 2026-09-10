import type {
  ContextEnvelope,
  Direction,
  EvidenceRef,
  GuardAction,
  GuardDecision,
  GuardRequest,
  Observation,
  RiskLevel,
} from '@guardllm/contracts';

export interface OriginSpan {
  readonly start: number;
  readonly end: number;
}

export interface NormalizationTransform {
  readonly method: string;
  readonly round: number;
  readonly confidence: number;
  readonly sourceViewId: string;
}

export interface NormalizedView {
  readonly sourceEnvelopeId?: string;
  readonly id: string;
  readonly text: string;
  readonly originSpans: readonly OriginSpan[];
  readonly transforms?: readonly NormalizationTransform[];
  readonly confidence?: number;
  readonly depth?: number;
  readonly sourceViewId?: string;
}

export type ProtectedContextKind =
  | 'SYSTEM_PROMPT'
  | 'DEVELOPER_PROMPT'
  | 'PROTECTED_CONTEXT';

export interface ProtectedContextFingerprint {
  readonly id: string;
  readonly kind: ProtectedContextKind;
  readonly digestVersion: 'guard-protected-context-1';
  readonly locale?: string;
  readonly shingleSize: number;
  readonly minimumMatches: number;
  readonly canaryHmacs: readonly string[];
  readonly canaryUnitLengths: readonly number[];
  readonly shingleHmacs: readonly string[];
  readonly structureHmacs: readonly string[];
}

export interface GuardDetectorContext {
  readonly previousObservations?: readonly Observation[];
  readonly request: GuardRequest;
  readonly envelopes: readonly ContextEnvelope[];
  readonly views: readonly NormalizedView[];
  readonly signal: AbortSignal;
  readonly evidenceHmac: (content: string) => string;
  readonly protectedContextFingerprints?: readonly ProtectedContextFingerprint[];
}

export interface GuardDetector {
  readonly id: string;
  readonly version: string;
  readonly required: boolean;
  detect(context: GuardDetectorContext): Promise<readonly Observation[]>;
}

export interface SemanticClassifierSpec {
  readonly coverage?: {
    readonly tenantId:string;readonly applicationId:string;readonly directions:readonly import('@/lib/judge/profile').JudgeScenario['direction'][];
    readonly locales:readonly string[];readonly contextScope:'full'|'window';
    readonly deploymentMode:'private'|'cloud';readonly dataBoundaryPolicyId:string;
    readonly qualityEvidenceId:string;readonly qualityValidUntil:string;
  };
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly modelSha256: string;
  readonly quantization: 'FP32' | 'FP16' | 'BF16' | 'INT8' | 'INT4';
  readonly baseUrl: string;
  readonly path: string;
  readonly providerType:
    | 'openai_compatible'
    | 'deepseek'
    | 'kimi'
    | 'doubao'
    | 'qwen'
    | 'glm'
    | 'ollama'
    | 'custom';
  readonly mode: 'SHADOW' | 'ENFORCE';
  readonly failurePolicy: DetectorFailurePolicy;
  readonly timeoutMs: number;
  readonly batchSize: number;
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
  readonly temperature: number;
  readonly labels: readonly {
    readonly label: string;
    readonly riskType: string;
    readonly severity: RiskLevel;
    readonly threshold: number;
  }[];
}

export type DetectorTier = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type DetectorRunCondition =
  | 'ALWAYS'
  | 'WHEN_PARENT_MATCHES'
  /** Run a refinement stage only when its direct parents emitted unresolved candidates. */
  | 'WHEN_PARENT_CANDIDATES'
  | 'WHEN_PARENT_FAILS'
  | 'WHEN_NO_MANDATORY_DENY'
  | 'WHEN_NO_BLOCKING_MATCH';
export type DetectorFailurePolicy = 'FAIL_CLOSED' | 'DEGRADE';

export interface DetectorNodeSpec {
  readonly id: string;
  readonly detectorId: string;
  readonly tier: DetectorTier;
  readonly dependsOn: readonly string[];
  readonly runCondition: DetectorRunCondition;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly costUnits: number;
  readonly failurePolicy: DetectorFailurePolicy;
}

export interface DetectorDagSpec {
  readonly version: string;
  readonly maximumCostUnits: number;
  readonly nodes: readonly DetectorNodeSpec[];
}

export interface GuardEnginePolicy {
  readonly semanticDecisionMode?: 'coverage-v1';
  readonly semanticCoverage?: import('./semantic-coverage').SemanticCoveragePolicy;
  readonly semanticClassifier?: SemanticClassifierSpec;
  readonly decisionPolicyVersion?: 1 | 2;
  readonly riskThresholds?: Readonly<Record<string, { readonly warn: number; readonly block: number }>>;
  readonly judgeProfiles?: readonly import('@/lib/judge/profile').JudgeProfile[];
  /** Opt-in P1 funnel: a Judge is required only after an unresolved candidate. */
  readonly judgeCandidateFunnel?: { readonly enabled: true; };
  readonly id: string;
  readonly bundleId: string;
  readonly policyVersion?: string;
  readonly warnThreshold: number;
  readonly blockThreshold: number;
  readonly failClosedOnRequiredDetectorFailure: boolean;
  readonly actionOverrides?: Readonly<Record<string, GuardAction>>;
  readonly actionOverrideThresholds?: Readonly<Record<string, number>>;
  readonly detectorDag?: DetectorDagSpec;
}

export interface GuardEvaluationTrace {
  readonly requestId:string;
  readonly normalization:Omit<import('./normalization').NormalizationResult,'views'> & {readonly viewCount:number;readonly sourceCount:number};
  readonly nodes:readonly {
    readonly nodeId:string;
    readonly detectorId:string;
    readonly tier:DetectorTier;
    readonly runCondition:DetectorRunCondition;
    /** Whether a direct dependency supplied an unresolved candidate to this node. */
    readonly candidateInput:boolean;
    readonly failurePolicy:DetectorFailurePolicy;
    readonly status:string;
    readonly attempts:number;
    readonly reason:string;
  }[];
  readonly aggregateAction:GuardAction;
}
export interface GuardEngineDependencies {
  readonly onEvaluationTrace?: (trace:GuardEvaluationTrace)=>void;
  readonly now?: () => number;
  readonly hmacKey: string | Buffer;
  readonly protectedContextFingerprints?: readonly ProtectedContextFingerprint[];
  readonly normalizationBudget?: Partial<{
    readonly maxRounds: number;
    readonly maxDepth: number;
    readonly maxViews: number;
    readonly maxBranchesPerView: number;
    readonly maxViewChars: number;
    readonly maxTotalBytes: number;
    readonly maxExpansionRatio: number;
    readonly maxCpuMs: number;
  }>;
}

export interface GuardEngine {
  readonly contextEvaluationMode?: 'unified-v1';
  evaluateContextual?(combined:GuardRequest,current:GuardRequest,signal?:AbortSignal):Promise<GuardDecision>;
  evaluate(request: GuardRequest, signal?: AbortSignal): Promise<GuardDecision>;
}

export interface RuleSpec {
  readonly matchConstraints?: import('./rule-constraints').RuleMatchConstraints;
  readonly sourceIds?: readonly string[];
  readonly actionHint?: string;
  readonly sourceMatchMode?: string;
  readonly id: string;
  readonly riskType: string;
  readonly pattern: string;
  readonly matchType: 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex';
  readonly caseSensitive: boolean;
  readonly score: number;
  readonly severity?: RiskLevel;
  readonly ruleVersion?: string;
  readonly mandatoryDeny?: boolean;
  readonly canonicalTermId?: string;
  readonly variantId?: string;
  readonly dictionaryReleaseId?: string;
  readonly dictionaryVersion?: string;
  readonly owner?: string;
  readonly locale?: string;
  readonly direction?: Direction | 'BOTH';
  readonly industry?: string;
  readonly contexts?: readonly string[];
  readonly validFromEpochMs?: number;
  readonly validToEpochMs?: number;
  readonly evidenceRequirement?: string;
  readonly approximate?: {
    readonly maxEditDistance: 1 | 2;
    readonly maxPatternLength: number;
    readonly maxCandidates: number;
  };
  readonly dictionaryLayer?:
    | 'PLATFORM_REDLINE'
    | 'INDUSTRY'
    | 'TENANT'
    | 'APPLICATION'
    | 'INCIDENT';
  readonly priority?: number;
  readonly jurisdiction?: string;
  readonly businessLine?: string;
}

export interface RuleExceptionSpec {
  readonly id: string;
  readonly pattern: string;
  readonly matchType: RuleSpec['matchType'];
  readonly caseSensitive: boolean;
  readonly dimensionScope: 'all' | 'specific';
  readonly dimensionCodes: readonly string[];
  readonly targetRuleIds?: readonly string[];
  readonly directions?: readonly Direction[];
  readonly validFromEpochMs?: number;
  readonly expiresAtEpochMs?: number;
  readonly approvalStatus?: 'approved';
  readonly approvedBy?: string;
}

export type {
  ContextEnvelope,
  EvidenceRef,
  GuardAction,
  GuardDecision,
  GuardRequest,
  Observation,
  RiskLevel,
};
