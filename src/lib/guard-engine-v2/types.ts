import type {
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

export interface GuardEnginePolicy {
  readonly id: string;
  readonly bundleId: string;
  readonly warnThreshold: number;
  readonly blockThreshold: number;
  readonly failClosedOnRequiredDetectorFailure: boolean;
  readonly actionOverrides?: Readonly<Record<string, GuardAction>>;
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
  EvidenceRef,
  GuardAction,
  GuardDecision,
  GuardRequest,
  Observation,
  RiskLevel,
};
