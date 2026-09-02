// Generated from model/guard-v1.schema.json. Do not edit.
// Source SHA-256: 4de68b95fb3b68b2116a5e2bdfde666a49e00baf2e1ac0716d03bc315bf4e3a5

export const GUARD_CONTRACT_VERSION = '1.0' as const;
export const GUARD_CONTRACT_SOURCE_SHA256 = '4de68b95fb3b68b2116a5e2bdfde666a49e00baf2e1ac0716d03bc315bf4e3a5' as const;

export type Direction = "INPUT" | "OUTPUT_COMPLETE" | "OUTPUT_CHUNK" | "RAG_INGEST" | "RAG_CONTEXT" | "TOOL_REQUEST" | "TOOL_RESULT";

export type GuardAction = "ALLOW" | "WARN" | "BLOCK" | "MASK" | "REWRITE" | "SAFE_RESPONSE" | "REQUIRE_REVIEW";

export type RiskLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ObservationStatus = "MATCH" | "NO_MATCH" | "TIMEOUT" | "ERROR" | "SKIPPED";

export type ArtifactKind = "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "DOCUMENT" | "TOOL_RESULT" | "RAG_CHUNK";

export interface RequestContext {
  readonly traceId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId?: string;
  readonly direction: Direction;
  readonly absoluteDeadlineEpochMs: number;
  readonly policyBundleId: string;
}

export interface ArtifactRef {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly metadata?: Readonly<Record<string, string | number | number | boolean | null>>;
}

export interface GuardContent {
  readonly text?: string;
  readonly artifacts?: readonly ArtifactRef[];
}

export interface GuardRequest {
  readonly contractVersion: "1.0";
  readonly context: RequestContext;
  readonly content: GuardContent;
}

export interface EvidenceRef {
  readonly viewId: string;
  readonly start?: number;
  readonly end?: number;
  readonly artifactId?: string;
  readonly region?: readonly number[];
  readonly timeRangeMs?: readonly number[];
  readonly maskedPreview?: string;
  readonly contentHmac: string;
}

export interface Observation {
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly riskType: string;
  readonly score: number;
  readonly severity: RiskLevel;
  readonly evidence: readonly EvidenceRef[];
  readonly status: ObservationStatus;
  readonly reasonCode?: string;
}

export interface GuardDecision {
  readonly contractVersion: "1.0";
  readonly decisionId: string;
  readonly traceId: string;
  readonly action: GuardAction;
  readonly riskLevel: RiskLevel;
  readonly observations: readonly Observation[];
  readonly policyPath: readonly string[];
  readonly bundleId: string;
  readonly latencyMs: number;
  readonly degradationReasons: readonly string[];
  readonly transformedText?: string;
}

export interface GuardError {
  readonly contractVersion: "1.0";
  readonly code: string;
  readonly message: string;
  readonly traceId: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string | number | number | boolean | null>>;
}

export interface GuardEvent {
  readonly contractVersion: "1.0";
  readonly eventId: string;
  readonly eventType: "GUARD_REQUEST_ACCEPTED" | "OBSERVATION_RECORDED" | "DECISION_RECORDED" | "ARTIFACT_STATE_CHANGED" | "POLICY_BUNDLE_ACTIVATED";
  readonly occurredAt: string;
  readonly traceId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly payload: GuardRequest | Observation | GuardDecision | ArtifactRef;
}
