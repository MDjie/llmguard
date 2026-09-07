# Generated from model/gateway-v2.schema.json. Do not edit.
# Source SHA-256: 86662f37d842ad3909ba66deeea55d6fc0db3671a0aeb4f3c477fc70ae380f19
from typing import Literal, NotRequired, TypedDict

GUARD_CONTRACT_VERSION = '2.0'
GUARD_CONTRACT_SOURCE_SHA256 = '86662f37d842ad3909ba66deeea55d6fc0db3671a0aeb4f3c477fc70ae380f19'

GatewayAction = Literal["ALLOW", "WARN", "BLOCK", "MASK", "REWRITE", "SAFE_RESPONSE", "REQUIRE_REVIEW"]

GatewayStage = Literal["INPUT", "INPUT_RECHECK", "OUTPUT_COMPLETE", "OUTPUT_CHUNK", "OUTPUT_RECHECK", "TOOL_REQUEST", "TOOL_RESULT", "RAG_CONTEXT"]

GatewayCoverage = Literal["COMPLETE", "PARTIAL", "UNKNOWN"]

GatewayStatus = Literal["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"]

ExecutionKind = Literal["UPSTREAM_SEND_INTENT", "UPSTREAM_SEND_STARTED", "RELEASE_INTENT", "WRITE_ACCEPTED", "TERMINATED", "COMPLETED"]

SnapshotState = Literal["PREPARED", "LOADED", "CANARY", "ACTIVE", "REVOKED"]

class PolicyRef(TypedDict):
    snapshotId: str
    bundleId: str
    generation: int
    digest: str

class GatewayBudgets(TypedDict):
    maxInputChars: int
    maxOutputChars: int
    maxSteps: int
    maxEvents: int
    maxStreamEvents: int
    idleTimeoutMs: int
    absoluteTimeoutMs: int

class ModelRoutingRecord(TypedDict):
    configurationJson: str
    configurationDigest: str

class WindowPolicy(TypedDict):
    configurationDigest: str
    qualificationId: str
    qualificationExpiresAt: int
    contextChars: int
    chunkChars: int
    holdbackChars: int

class RuntimeManifest(TypedDict):
    tenantId: str
    applicationId: str
    generation: int
    bundleId: str
    bundleDigest: str
    modelRoutes: list[str]
    dataBoundary: str
    streamMode: Literal["FULL_BUFFER", "WINDOW"]
    windowQualified: bool
    holdbackChars: int
    budgets: GatewayBudgets
    validUntil: int
    normalizationVersion: Literal["guard-canonical-v2"]
    modelRouting: NotRequired[ModelRoutingRecord]
    windowPolicy: NotRequired[WindowPolicy]

class RuntimeSnapshot(TypedDict):
    id: str
    manifest: RuntimeManifest
    digest: str
    signature: str
    keyId: str
    state: SnapshotState

class AuthContext(TypedDict):
    contractVersion: Literal["2.0"]
    authContextId: str
    issuer: str
    audience: str
    keyId: str
    issuedAt: int
    expiresAt: int
    tenantId: str
    applicationId: str
    subjectId: str
    credentialId: NotRequired[str]
    authVersion: int
    businessRequestId: str
    traceId: str
    sessionId: NotRequired[str]
    requestDigest: str
    policy: PolicyRef
    allowedModelRoutes: list[str]
    permissions: list[str]
    dataBoundary: str
    deadline: int
    subjectVersion: NotRequired[int]
    preparedRequestDigest: NotRequired[str]
    inputSegmentsDigest: NotRequired[str]
    archiveRequired: NotRequired[bool]

class SignedAuthContext(TypedDict):
    context: AuthContext
    signature: str

class ContentSegment(TypedDict):
    segmentId: str
    contentPath: str
    role: str
    text: str
    sourceType: Literal["USER", "MODEL", "TOOL", "RAG", "FILE"]
    sourceDigest: str

class TransformPatch(TypedDict):
    segmentId: str
    contentPath: str
    start: int
    end: int
    replacement: str
    sourceDigest: str

class WindowInspection(TypedDict):
    contextStart: int
    releaseStart: int
    releaseEnd: int
    final: bool

class GatewayRequest(TypedDict):
    contractVersion: Literal["2.0"]
    auth: SignedAuthContext
    businessRequestId: str
    stepId: str
    traceId: str
    stage: GatewayStage
    streamSeq: int
    attemptKind: Literal["INITIAL", "RECHECK"]
    snapshotId: str
    deadline: int
    segments: list[ContentSegment]
    window: NotRequired[WindowInspection]

class GatewayDecision(TypedDict):
    contractVersion: Literal["2.0"]
    businessRequestId: str
    stepId: str
    decisionId: str
    snapshotId: str
    action: GatewayAction
    coverage: GatewayCoverage
    status: GatewayStatus
    riskLevel: Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
    reasonCodes: list[str]
    modelVersions: list[str]
    transformPatches: list[TransformPatch]
    safeResponse: NotRequired[str]
    latencyMs: int

class GatewayAuthorize(TypedDict):
    contractVersion: Literal["2.0"]
    businessRequestId: str
    traceId: str
    sessionId: NotRequired[str]
    idempotencyKey: str
    deadline: int
    modelRoute: str
    requestDigest: str
    requestJson: str
    userAssertion: NotRequired[str]

class GatewayAuthorization(TypedDict):
    auth: SignedAuthContext
    snapshot: RuntimeSnapshot
    replayState: str
    preparedRequestJson: NotRequired[str]
    inputSegments: NotRequired[list[ContentSegment]]

class ExecutionEvent(TypedDict):
    eventSeq: int
    stepId: NotRequired[str]
    decisionId: NotRequired[str]
    recheckDecisionId: NotRequired[str]
    kind: ExecutionKind
    rangeStart: NotRequired[int]
    rangeEnd: NotRequired[int]
    payloadDigest: NotRequired[str]
    actualAction: NotRequired[GatewayAction]
    reasonCode: NotRequired[str]
    snapshotId: str

class GatewayEvents(TypedDict):
    contractVersion: Literal["2.0"]
    auth: SignedAuthContext
    events: list[ExecutionEvent]
    terminalReconciliation: NotRequired[bool]

class GatewayNodeAck(TypedDict):
    contractVersion: Literal["2.0"]
    tenantId: str
    applicationId: str
    snapshotId: str
    nodeId: str
    digest: str
    state: Literal["LOADED", "FAILED"]
    reasonCode: NotRequired[str]

class GatewayError(TypedDict):
    contractVersion: Literal["2.0"]
    code: str
    requestId: str
    traceId: str
    retryable: bool
