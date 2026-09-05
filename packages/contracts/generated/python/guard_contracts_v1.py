# Generated from model/guard-v1.schema.json. Do not edit.
# Source SHA-256: 01bb211282221f91e3fb858d2d0b4c19d0904d24c50e9d5d83e8326500e5aa3a
from typing import Literal, NotRequired, TypedDict

GUARD_CONTRACT_VERSION = '1.0'
GUARD_CONTRACT_SOURCE_SHA256 = '01bb211282221f91e3fb858d2d0b4c19d0904d24c50e9d5d83e8326500e5aa3a'

Direction = Literal["INPUT", "OUTPUT_COMPLETE", "OUTPUT_CHUNK", "RAG_INGEST", "RAG_CONTEXT", "TOOL_REQUEST", "TOOL_RESULT"]

GuardAction = Literal["ALLOW", "WARN", "BLOCK", "MASK", "REWRITE", "SAFE_RESPONSE", "REQUIRE_REVIEW"]

RiskLevel = Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]

ObservationStatus = Literal["MATCH", "NO_MATCH", "TIMEOUT", "ERROR", "SKIPPED"]

ContextRole = Literal["mention", "quotation", "news", "legal", "research", "education", "medical", "instruction", "transaction", "endorsement", "disclosure"]

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
    businessLine: NotRequired[str]
    legalDisclaimerVersion: NotRequired[str]

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
    canonicalTermId: NotRequired[str]
    variantId: NotRequired[str]
    dictionaryLayer: NotRequired[Literal["PLATFORM_REDLINE", "INDUSTRY", "TENANT", "APPLICATION", "INCIDENT"]]
    contextRole: NotRequired[ContextRole]
    decisionRole: NotRequired[Literal["HARD_DENY", "CANDIDATE", "CONFIRMED_RISK", "CLEARED", "UNKNOWN"]]
    semanticCoverage: NotRequired[Literal["COMPLETE", "INCOMPLETE", "UNSUPPORTED", "NOT_APPLICABLE"]]
    assessmentId: NotRequired[str]
    scoreMeaning: NotRequired[Literal["PROBABILITY", "POLICY", "UNCALIBRATED"]]

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
    score: NotRequired[float]
    confidence: NotRequired[float]
    compliance: NotRequired[ComplianceContext]
    transform: NotRequired[DecisionTransform]

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

DlpTransformOperation = Literal["PARTIAL_MASK", "FULL_MASK", "TOKENIZE", "REDACT", "BLOCK"]

DecisionTransformType = Literal["MASK", "REWRITE", "SAFE_RESPONSE", "REQUIRE_REVIEW", "BLOCK"]

class DecisionTransformRange(TypedDict):
    entityType: str
    operation: DlpTransformOperation
    start: int
    end: int
    outputStart: int
    outputEnd: int
    maskedPreview: str
    contentHmac: str

class DecisionTransform(TypedDict):
    type: DecisionTransformType
    ranges: list[DecisionTransformRange]
    templateId: NotRequired[str]
    templateVersion: NotRequired[int]
    outputHash: str
    recheckDecisionId: NotRequired[str]

class ComplianceContext(TypedDict):
    locale: str
    jurisdiction: str
    industry: str
    businessLine: str
    policyVersion: str
    legalDisclaimerVersion: str
