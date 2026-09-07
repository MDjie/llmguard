// Generated from model/gateway-v2.schema.json. Do not edit.
// Source SHA-256: 121c28d9326b01100816725fd291a43f2d45a2d698a2d3d2749ab8f83cddb810

export const GUARD_CONTRACT_VERSION = '2.0' as const;
export const GUARD_CONTRACT_SOURCE_SHA256 = '121c28d9326b01100816725fd291a43f2d45a2d698a2d3d2749ab8f83cddb810' as const;

export type GatewayAction = "ALLOW" | "WARN" | "BLOCK" | "MASK" | "REWRITE" | "SAFE_RESPONSE" | "REQUIRE_REVIEW";

export type GatewayStage = "INPUT" | "INPUT_RECHECK" | "OUTPUT_COMPLETE" | "OUTPUT_CHUNK" | "OUTPUT_RECHECK" | "TOOL_REQUEST" | "TOOL_RESULT" | "RAG_CONTEXT";

export type GatewayCoverage = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export type GatewayStatus = "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED";

export type ExecutionKind = "UPSTREAM_SEND_INTENT" | "UPSTREAM_SEND_STARTED" | "RELEASE_INTENT" | "WRITE_ACCEPTED" | "TERMINATED" | "COMPLETED";

export type SnapshotState = "PREPARED" | "LOADED" | "CANARY" | "ACTIVE" | "REVOKED";

export interface PolicyRef {
  readonly snapshotId: string;
  readonly bundleId: string;
  readonly generation: number;
  readonly digest: string;
}

export interface GatewayBudgets {
  readonly maxInputChars: number;
  readonly maxOutputChars: number;
  readonly maxSteps: number;
  readonly maxEvents: number;
  readonly maxStreamEvents: number;
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
}

export interface ModelRoutingRecord {
  readonly configurationJson: string;
  readonly configurationDigest: string;
}

export interface WindowPolicy {
  readonly configurationDigest: string;
  readonly qualificationId: string;
  readonly qualificationExpiresAt: number;
  readonly contextChars: number;
  readonly chunkChars: number;
  readonly holdbackChars: number;
}

export interface RuntimeManifest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly generation: number;
  readonly bundleId: string;
  readonly bundleDigest: string;
  readonly modelRoutes: readonly string[];
  readonly dataBoundary: string;
  readonly streamMode: "FULL_BUFFER" | "WINDOW";
  readonly windowQualified: boolean;
  readonly holdbackChars: number;
  readonly budgets: GatewayBudgets;
  readonly validUntil: number;
  readonly normalizationVersion: "guard-canonical-v2";
  readonly modelRouting?: ModelRoutingRecord;
  readonly windowPolicy?: WindowPolicy;
}

export interface RuntimeSnapshot {
  readonly id: string;
  readonly manifest: RuntimeManifest;
  readonly digest: string;
  readonly signature: string;
  readonly keyId: string;
  readonly state: SnapshotState;
}

export interface AuthContext {
  readonly contractVersion: "2.0";
  readonly authContextId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly subjectId: string;
  readonly credentialId?: string;
  readonly authVersion: number;
  readonly businessRequestId: string;
  readonly traceId: string;
  readonly sessionId?: string;
  readonly requestDigest: string;
  readonly policy: PolicyRef;
  readonly allowedModelRoutes: readonly string[];
  readonly permissions: readonly string[];
  readonly dataBoundary: string;
  readonly deadline: number;
  readonly subjectVersion?: number;
  readonly preparedRequestDigest?: string;
  readonly inputSegmentsDigest?: string;
}

export interface SignedAuthContext {
  readonly context: AuthContext;
  readonly signature: string;
}

export interface ContentSegment {
  readonly segmentId: string;
  readonly contentPath: string;
  readonly role: string;
  readonly text: string;
  readonly sourceType: "USER" | "MODEL" | "TOOL" | "RAG" | "FILE";
  readonly sourceDigest: string;
}

export interface TransformPatch {
  readonly segmentId: string;
  readonly contentPath: string;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly sourceDigest: string;
}

export interface WindowInspection {
  readonly contextStart: number;
  readonly releaseStart: number;
  readonly releaseEnd: number;
  readonly final: boolean;
}

export interface GatewayRequest {
  readonly contractVersion: "2.0";
  readonly auth: SignedAuthContext;
  readonly businessRequestId: string;
  readonly stepId: string;
  readonly traceId: string;
  readonly stage: GatewayStage;
  readonly streamSeq: number;
  readonly attemptKind: "INITIAL" | "RECHECK";
  readonly snapshotId: string;
  readonly deadline: number;
  readonly segments: readonly ContentSegment[];
  readonly window?: WindowInspection;
}

export interface GatewayDecision {
  readonly contractVersion: "2.0";
  readonly businessRequestId: string;
  readonly stepId: string;
  readonly decisionId: string;
  readonly snapshotId: string;
  readonly action: GatewayAction;
  readonly coverage: GatewayCoverage;
  readonly status: GatewayStatus;
  readonly riskLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly reasonCodes: readonly string[];
  readonly modelVersions: readonly string[];
  readonly transformPatches: readonly TransformPatch[];
  readonly safeResponse?: string;
  readonly latencyMs: number;
}

export interface GatewayAuthorize {
  readonly contractVersion: "2.0";
  readonly businessRequestId: string;
  readonly traceId: string;
  readonly sessionId?: string;
  readonly idempotencyKey: string;
  readonly deadline: number;
  readonly modelRoute: string;
  readonly requestDigest: string;
  readonly requestJson: string;
  readonly userAssertion?: string;
}

export interface GatewayAuthorization {
  readonly auth: SignedAuthContext;
  readonly snapshot: RuntimeSnapshot;
  readonly replayState: string;
  readonly preparedRequestJson?: string;
  readonly inputSegments?: readonly ContentSegment[];
}

export interface ExecutionEvent {
  readonly eventSeq: number;
  readonly stepId?: string;
  readonly decisionId?: string;
  readonly recheckDecisionId?: string;
  readonly kind: ExecutionKind;
  readonly rangeStart?: number;
  readonly rangeEnd?: number;
  readonly payloadDigest?: string;
  readonly actualAction?: GatewayAction;
  readonly reasonCode?: string;
  readonly snapshotId: string;
}

export interface GatewayEvents {
  readonly contractVersion: "2.0";
  readonly auth: SignedAuthContext;
  readonly events: readonly ExecutionEvent[];
  readonly terminalReconciliation?: boolean;
}

export interface GatewayNodeAck {
  readonly contractVersion: "2.0";
  readonly tenantId: string;
  readonly applicationId: string;
  readonly snapshotId: string;
  readonly nodeId: string;
  readonly digest: string;
  readonly state: "LOADED" | "FAILED";
  readonly reasonCode?: string;
}

export interface GatewayError {
  readonly contractVersion: "2.0";
  readonly code: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly retryable: boolean;
}
