// Generated from model/guard-v1.schema.json. Do not edit.
// Source SHA-256: 95d5f83807849b342487326076ea8dc4a664878ff7689e6ec89ce665d1316faf

export const GUARD_CONTRACT_VERSION = '1.0' as const;
export const GUARD_CONTRACT_SOURCE_SHA256 = '95d5f83807849b342487326076ea8dc4a664878ff7689e6ec89ce665d1316faf' as const;

export type Direction = "INPUT" | "OUTPUT_COMPLETE" | "OUTPUT_CHUNK" | "RAG_INGEST" | "RAG_CONTEXT" | "TOOL_REQUEST" | "TOOL_RESULT";

export type GuardAction = "ALLOW" | "WARN" | "BLOCK" | "MASK" | "REWRITE" | "SAFE_RESPONSE" | "REQUIRE_REVIEW";

export type RiskLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ObservationStatus = "MATCH" | "NO_MATCH" | "TIMEOUT" | "ERROR" | "SKIPPED";

export type ArtifactKind = "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "DOCUMENT" | "TOOL_RESULT" | "RAG_CHUNK";

export type SourceType = "SYSTEM" | "USER" | "RAG" | "TOOL" | "MEMORY" | "AGENT" | "FILE" | "MEDIA";

export type TrustLevel = "TRUSTED" | "CONTROLLED" | "UNTRUSTED";

export type InstructionCapability = "ALLOWED" | "DATA_ONLY" | "FORBIDDEN";

export type GuardFailMode = "NORMAL" | "FAIL_CLOSED" | "DEGRADED" | "FAIL_OPEN";

export type ProcessingStage = "INPUT_PRE" | "MODEL_PRE" | "MODEL_STREAM" | "OUTPUT_POST" | "RAG_INGEST" | "RAG_RETRIEVE" | "TOOL_PRE" | "TOOL_POST" | "MEDIA_ANALYZE" | "OFFLINE_EVALUATE";

export type SideEffect = "NONE" | "READ" | "WRITE" | "EXECUTE" | "EXTERNAL_COMMUNICATION" | "FINANCIAL" | "PRIVILEGE_CHANGE";

export interface ContextEnvelope {
  readonly envelopeId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId?: string;
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly trustLevel: TrustLevel;
  readonly instructionCapability: InstructionCapability;
  readonly sensitivityLabels: readonly string[];
  readonly contentHash: string;
  readonly parentEnvelopeIds: readonly string[];
  readonly policyVersion: string;
  readonly eventSeq: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly expiresAtEpochMs?: number;
  readonly signature?: string;
  readonly signatureKeyId?: string;
}

export interface ActionIntent {
  readonly intentId: string;
  readonly userGoal: string;
  readonly toolName: string;
  readonly parametersDigest: string;
  readonly targetResource: string;
  readonly sideEffect: SideEffect;
  readonly requiredPermissions: readonly string[];
  readonly supportingEnvelopeIds: readonly string[];
  readonly dataDestinations: readonly string[];
  readonly riskBudget: number;
  readonly expiresAtEpochMs?: number;
}

export interface RequestContext {
  readonly traceId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId?: string;
  readonly direction: Direction;
  readonly absoluteDeadlineEpochMs: number;
  readonly policyBundleId: string;
  readonly subjectId?: string;
  readonly authContextId?: string;
  readonly tokenizerId?: string;
  readonly stage?: ProcessingStage;
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
  readonly envelopes?: readonly ContextEnvelope[];
}

export interface GuardRequest {
  readonly contractVersion: "1.0";
  readonly context: RequestContext;
  readonly content: GuardContent;
  readonly actionIntent?: ActionIntent;
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
  readonly sourceEnvelopeIds?: readonly string[];
  readonly tokenStart?: number;
  readonly tokenEnd?: number;
  readonly tokenizerId?: string;
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
  readonly modelVersion?: string;
  readonly configurationDigest?: string;
  readonly failMode?: GuardFailMode;
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
  readonly modelVersions?: readonly string[];
  readonly failMode?: GuardFailMode;
  readonly evidenceComplete?: boolean;
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
  readonly payload: GuardRequest | Observation | GuardDecision | ArtifactRef | ContextEnvelope | ActionIntent;
  readonly sequenceNumber?: number;
  readonly expiresAtEpochMs?: number;
  readonly signature?: string;
  readonly signatureKeyId?: string;
}
