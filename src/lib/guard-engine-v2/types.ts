import type {
  ContextEnvelope,
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

export interface NormalizedView {
  readonly id: string;
  readonly text: string;
  readonly originSpans: readonly OriginSpan[];
}

export interface GuardDetectorContext {
  readonly request: GuardRequest;
  readonly envelopes: readonly ContextEnvelope[];
  readonly views: readonly NormalizedView[];
  readonly signal: AbortSignal;
  readonly evidenceHmac: (content: string) => string;
}

export interface GuardDetector {
  readonly id: string;
  readonly version: string;
  readonly required: boolean;
  detect(context: GuardDetectorContext): Promise<readonly Observation[]>;
}

export interface SemanticClassifierSpec {
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
  | 'WHEN_PARENT_FAILS'
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
  readonly id: string;
  readonly bundleId: string;
  readonly warnThreshold: number;
  readonly blockThreshold: number;
  readonly failClosedOnRequiredDetectorFailure: boolean;
  readonly actionOverrides?: Readonly<Record<string, GuardAction>>;
  readonly actionOverrideThresholds?: Readonly<Record<string, number>>;
  readonly detectorDag?: DetectorDagSpec;
}

export interface GuardEngineDependencies {
  readonly now?: () => number;
  readonly hmacKey: string | Buffer;
}

export interface GuardEngine {
  evaluate(request: GuardRequest): Promise<GuardDecision>;
}

export interface RuleSpec {
  readonly id: string;
  readonly riskType: string;
  readonly pattern: string;
  readonly matchType: 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex';
  readonly caseSensitive: boolean;
  readonly score: number;
  readonly severity?: RiskLevel;
  readonly mandatoryDeny?: boolean;
}

export interface RuleExceptionSpec {
  readonly id: string;
  readonly pattern: string;
  readonly matchType: RuleSpec['matchType'];
  readonly caseSensitive: boolean;
  readonly dimensionScope: 'all' | 'specific';
  readonly dimensionCodes: readonly string[];
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
