# Generated from model/guard-v1.schema.json. Do not edit.
# Source SHA-256: 4de68b95fb3b68b2116a5e2bdfde666a49e00baf2e1ac0716d03bc315bf4e3a5
from typing import Literal, NotRequired, TypedDict

GUARD_CONTRACT_VERSION = '1.0'
GUARD_CONTRACT_SOURCE_SHA256 = '4de68b95fb3b68b2116a5e2bdfde666a49e00baf2e1ac0716d03bc315bf4e3a5'

Direction = Literal["INPUT", "OUTPUT_COMPLETE", "OUTPUT_CHUNK", "RAG_INGEST", "RAG_CONTEXT", "TOOL_REQUEST", "TOOL_RESULT"]

GuardAction = Literal["ALLOW", "WARN", "BLOCK", "MASK", "REWRITE", "SAFE_RESPONSE", "REQUIRE_REVIEW"]

RiskLevel = Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]

ObservationStatus = Literal["MATCH", "NO_MATCH", "TIMEOUT", "ERROR", "SKIPPED"]

ArtifactKind = Literal["TEXT", "IMAGE", "AUDIO", "VIDEO", "DOCUMENT", "TOOL_RESULT", "RAG_CHUNK"]

class RequestContext(TypedDict):
    traceId: str
    requestId: str
    tenantId: str
    applicationId: str
    sessionId: NotRequired[str]
    direction: Direction
    absoluteDeadlineEpochMs: int
    policyBundleId: str

class ArtifactRef(TypedDict):
    artifactId: str
    kind: ArtifactKind
    mediaType: str
    sizeBytes: int
    sha256: str
    metadata: NotRequired[dict[str, object]]

class GuardContent(TypedDict):
    text: NotRequired[str]
    artifacts: NotRequired[list[ArtifactRef]]

class GuardRequest(TypedDict):
    contractVersion: Literal["1.0"]
    context: RequestContext
    content: GuardContent

class EvidenceRef(TypedDict):
    viewId: str
    start: NotRequired[int]
    end: NotRequired[int]
    artifactId: NotRequired[str]
    region: NotRequired[list[float]]
    timeRangeMs: NotRequired[list[int]]
    maskedPreview: NotRequired[str]
    contentHmac: str

class Observation(TypedDict):
    detectorId: str
    detectorVersion: str
    riskType: str
    score: float
    severity: RiskLevel
    evidence: list[EvidenceRef]
    status: ObservationStatus
    reasonCode: NotRequired[str]

class GuardDecision(TypedDict):
    contractVersion: Literal["1.0"]
    decisionId: str
    traceId: str
    action: GuardAction
    riskLevel: RiskLevel
    observations: list[Observation]
    policyPath: list[str]
    bundleId: str
    latencyMs: int
    degradationReasons: list[str]
    transformedText: NotRequired[str]

class GuardError(TypedDict):
    contractVersion: Literal["1.0"]
    code: str
    message: str
    traceId: str
    retryable: bool
    details: NotRequired[dict[str, object]]

class GuardEvent(TypedDict):
    contractVersion: Literal["1.0"]
    eventId: str
    eventType: Literal["GUARD_REQUEST_ACCEPTED", "OBSERVATION_RECORDED", "DECISION_RECORDED", "ARTIFACT_STATE_CHANGED", "POLICY_BUNDLE_ACTIVATED"]
    occurredAt: str
    traceId: str
    tenantId: str
    applicationId: str
    payload: GuardRequest | Observation | GuardDecision | ArtifactRef
