export type StreamGateMode = 'complete' | 'chunk' | 'parallel' | 'audit';

export interface StreamInspection {
  readonly action: 'ALLOW' | 'WARN' | 'BLOCK' | 'MASK' | 'REWRITE' | 'SAFE_RESPONSE' | 'REQUIRE_REVIEW';
  readonly decisionId: string;
  readonly riskLevel?: string;
  readonly semanticCoverage?: 'COMPLETE'|'INCOMPLETE';
}

export interface StreamInspectionContext {
  readonly sequence: number;
  readonly final: boolean;
  readonly signal: AbortSignal;
  readonly absoluteDeadlineEpochMs?:number;
}

export type StreamInspector = (
  text: string,
  context: StreamInspectionContext,
) => Promise<StreamInspection>;

export interface StreamGateOptions {
  readonly mode: StreamGateMode;
  readonly holdbackChars: number;
  readonly rollingWindowChars: number;
  readonly maxBufferedBytes: number;
  readonly inspectionTimeoutMs: number;
  readonly upstreamIdleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly requireSemanticCoverage?:boolean;
  readonly requireUpstreamCompletion?:boolean;
  readonly signal?:AbortSignal;
  readonly inspector: StreamInspector;
  readonly abortUpstream?: (reason: Error) => void;
  readonly onAuditDecision?: (decision: StreamInspection) => void;
}

export class StreamBlockedError extends Error {
  constructor(
    readonly decision: StreamInspection,
    message = 'The stream was blocked before commit',
  ) {
    super(message);
    this.name = 'StreamBlockedError';
  }
}

export class StreamGateCapacityError extends Error {
  constructor() {
    super('Stream commit-gate buffer limit exceeded');
    this.name = 'StreamGateCapacityError';
  }
}
