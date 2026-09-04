# Generated from model/guard-v1.schema.json. Do not edit.
# Source SHA-256: 2da2dcd7e08805684ff47b35f29d160f2d583db74671af14c64f4a86b7911962
from typing import Literal, NotRequired, TypedDict

GUARD_CONTRACT_VERSION = '1.0'
GUARD_CONTRACT_SOURCE_SHA256 = '2da2dcd7e08805684ff47b35f29d160f2d583db74671af14c64f4a86b7911962'

Direction = Literal["INPUT", "OUTPUT_COMPLETE", "OUTPUT_CHUNK", "RAG_INGEST", "RAG_CONTEXT", "TOOL_REQUEST", "TOOL_RESULT"]

GuardAction = Literal["ALLOW", "WARN", "BLOCK", "MASK", "REWRITE", "SAFE_RESPONSE", "REQUIRE_REVIEW"]

RiskLevel = Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]

ObservationStatus = Literal["MATCH", "NO_MATCH", "TIMEOUT", "ERROR", "SKIPPED"]

ArtifactKind = Literal["TEXT", "IMAGE", "AUDIO", "VIDEO", "DOCUMENT", "TOOL_RESULT", "RAG_CHUNK"]

SourceType = Literal["SYSTEM", "USER", "RAG", "TOOL", "MEMORY", "AGENT", "FILE", "MEDIA"]

TrustLevel = Literal["TRUSTED", "CONTROLLED", "UNTRUSTED"]

InstructionCapability = Literal["ALLOWED", "DATA_ONLY", "FORBIDDEN"]

GuardFailMode = Literal["NORMAL", "FAIL_CLOSED", "DEGRADED", "FAIL_OPEN"]

ProcessingStage = Literal["INPUT_PRE", "MODEL_PRE", "MODEL_STREAM", "OUTPUT_POST", "RAG_INGEST", "RAG_RETRIEVE", "TOOL_PRE", "TOOL_POST", "MEDIA_ANALYZE", "OFFLINE_EVALUATE"]

SideEffect = Literal["NONE", "READ", "WRITE", "EXECUTE", "EXTERNAL_COMMUNICATION", "FINANCIAL", "PRIVILEGE_CHANGE"]

class ContextEnvelope(TypedDict):
    envelopeId: str
    tenantId: str
    applicationId: str
    sessionId: NotRequired[str]
    modality: NotRequired[ArtifactKind]
    artifactId: NotRequired[str]
    page: NotRequired[int]
    timeRangeMs: NotRequired[list[int]]
    region: NotRequired[list[float]]
    sourceType: SourceType
    sourceId: str
    trustLevel: TrustLevel
    instructionCapability: InstructionCapability
    sensitivityLabels: list[str]
    contentHash: str
    parentEnvelopeIds: list[str]
    policyVersion: str
    eventSeq: int
    contentStart: int
    contentEnd: int
    expiresAtEpochMs: NotRequired[int]
    signature: NotRequired[str]
    signatureKeyId: NotRequired[str]

class ActionIntent(TypedDict):
    intentId: str
    userGoal: str
    toolName: str
    parametersDigest: str
    targetResource: str
    sideEffect: SideEffect
    requiredPermissions: list[str]
    supportingEnvelopeIds: list[str]
    dataDestinations: list[str]
    riskBudget: float
    expiresAtEpochMs: NotRequired[int]

class RequestContext(TypedDict):
    traceId: str
    requestId: str
    tenantId: str
    applicationId: str
    sessionId: NotRequired[str]
    sourceType: NotRequired[SourceType]
    locale: NotRequired[str]
    jurisdiction: NotRequired[str]
    industry: NotRequired[str]
    direction: Direction
    absoluteDeadlineEpochMs: int
    policyBundleId: str
    subjectId: NotRequired[str]
    authContextId: NotRequired[str]
    tokenizerId: NotRequired[str]
    stage: NotRequired[ProcessingStage]

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
    envelopes: NotRequired[list[ContextEnvelope]]

class GuardRequest(TypedDict):
    contractVersion: Literal["1.0"]
    context: RequestContext
    content: GuardContent
    actionIntent: NotRequired[ActionIntent]

class EvidenceRef(TypedDict):
    viewId: str
    start: NotRequired[int]
    end: NotRequired[int]
    artifactId: NotRequired[str]
    region: NotRequired[list[float]]
    timeRangeMs: NotRequired[list[int]]
    maskedPreview: NotRequired[str]
    contentHmac: str
    sourceEnvelopeIds: NotRequired[list[str]]
    tokenStart: NotRequired[int]
    tokenEnd: NotRequired[int]
    tokenizerId: NotRequired[str]
    normalizedStart: NotRequired[int]
    normalizedEnd: NotRequired[int]
    normalizationTransforms: NotRequired[list[str]]

class Observation(TypedDict):
    detectorId: str
    detectorVersion: str
    riskType: str
    category: NotRequired[str]
    confidence: NotRequired[float]
    ruleId: NotRequired[str]
    ruleVersion: NotRequired[str]
    dictionaryReleaseId: NotRequired[str]
    dictionaryVersion: NotRequired[str]
    score: float
    severity: RiskLevel
    evidence: list[EvidenceRef]
    status: ObservationStatus
    reasonCode: NotRequired[str]
    modelVersion: NotRequired[str]
    configurationDigest: NotRequired[str]
    failMode: NotRequired[GuardFailMode]

class LatencyBreakdown(TypedDict):
    normalizationMs: NotRequired[int]
    detectionMs: NotRequired[int]
    aggregationMs: NotRequired[int]
    interventionMs: NotRequired[int]
    totalMs: int

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
    latencyBreakdown: NotRequired[LatencyBreakdown]
    degraded: NotRequired[bool]
    reasonCodes: NotRequired[list[str]]
    degradationReasons: list[str]
    transformedText: NotRequired[str]
    modelVersions: NotRequired[list[str]]
    failMode: NotRequired[GuardFailMode]
    evidenceComplete: NotRequired[bool]

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
    payload: GuardRequest | Observation | GuardDecision | ArtifactRef | ContextEnvelope | ActionIntent
    sequenceNumber: NotRequired[int]
    expiresAtEpochMs: NotRequired[int]
    signature: NotRequired[str]
    signatureKeyId: NotRequired[str]
