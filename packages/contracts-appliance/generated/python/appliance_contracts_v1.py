# Generated from model/appliance-v1.schema.json. Do not edit.
# Source SHA-256: b10daf922dd2098768c989fea3284fa56fc6ebacadb8d35520c6fcec29f5a080
from typing import Literal, NotRequired, TypedDict

APPLIANCE_CONTRACT_VERSION = '1.0'
APPLIANCE_CONTRACT_SOURCE_SHA256 = 'b10daf922dd2098768c989fea3284fa56fc6ebacadb8d35520c6fcec29f5a080'

TransportProtocol = Literal["TCP", "UDP"]

ApplicationProtocol = Literal["UNKNOWN", "TLS", "HTTP_1_1", "HTTP_2", "HTTPS", "SSE", "WEBSOCKET", "GRPC", "OPENAI_API", "MQTT", "MCP"]

TrafficDirection = Literal["CLIENT_TO_SERVER", "SERVER_TO_CLIENT"]

ProtocolStage = Literal["FLOW_METADATA", "TLS_HANDSHAKE", "HEADERS", "MESSAGE", "ARTIFACT", "TRAILERS"]

DeploymentMode = Literal["REVERSE_PROXY", "TRANSPARENT_INLINE", "TAP_MIRROR", "HA_PAIR"]

AdmissionAction = Literal["INSPECT", "ALLOW_METADATA_ONLY", "BLOCK", "MIRROR_ONLY"]

EnforcementAction = Literal["ALLOW", "BLOCK", "RESET", "RATE_LIMIT", "REDIRECT", "MASK", "REWRITE", "QUARANTINE", "MIRROR_ONLY"]

HealthAction = Literal["HEALTHY", "DEGRADE", "DRAIN", "ISOLATE", "FAILOVER"]

ReceiptStatus = Literal["APPLIED", "REJECTED", "EXPIRED", "DUPLICATE"]

BundleActivationStatus = Literal["PREPARED", "ACTIVE", "REJECTED", "ROLLED_BACK"]

EngineType = Literal["FAST_PATH", "PROTOCOL_PROXY", "IPS", "ANTIVIRUS", "DOS", "DLP", "AI_GUARD", "FILE_ANALYZER", "HARDWARE_AGENT"]

class NetworkEndpoint(TypedDict):
    ip: str
    port: int
    mac: NotRequired[str]
    zone: NotRequired[str]

class TlsContext(TypedDict):
    intercepted: bool
    version: str
    serverName: str
    alpn: NotRequired[str]
    cipherSuite: NotRequired[str]
    peerCertificateSha256: str
    clientCertificateSha256: NotRequired[str]

class FlowEnvelope(TypedDict):
    contractVersion: Literal["1.0"]
    deviceId: str
    deviceGroupId: str
    flowId: str
    flowSeq: int
    tenantId: str
    applicationId: str
    sessionId: NotRequired[str]
    deploymentMode: DeploymentMode
    ingressInterface: str
    egressInterface: str
    vlanId: NotRequired[int]
    source: NetworkEndpoint
    destination: NetworkEndpoint
    transport: TransportProtocol
    applicationProtocol: ApplicationProtocol
    direction: TrafficDirection
    protectedTraffic: bool
    openedAtEpochMs: int
    absoluteDeadlineEpochMs: int
    policyBundleId: str
    tls: NotRequired[TlsContext]

class FlowAdmission(TypedDict):
    flowId: str
    flowSeq: int
    action: AdmissionAction
    reasonCode: str
    policyBundleId: str
    expiresAtEpochMs: int

class ContentReference(TypedDict):
    uri: str
    sha256: str
    authorizationId: NotRequired[str]
    expiresAtEpochMs: int

class FrameEnvelope(TypedDict):
    contractVersion: Literal["1.0"]
    flowId: str
    frameId: str
    flowSeq: int
    frameSeq: int
    direction: TrafficDirection
    applicationProtocol: ApplicationProtocol
    protocolStage: ProtocolStage
    mediaType: str
    contentEncoding: NotRequired[str]
    sizeBytes: int
    sha256: str
    streamOffsetStart: int
    streamOffsetEnd: int
    absoluteDeadlineEpochMs: int
    policyBundleId: str
    inlinePayloadBase64: NotRequired[str]
    contentReference: NotRequired[ContentReference]

class NetworkObservation(TypedDict):
    engineId: str
    engineType: EngineType
    engineVersion: str
    ruleVersion: str
    status: Literal["MATCH", "NO_MATCH", "TIMEOUT", "ERROR", "SKIPPED"]
    riskType: str
    severity: Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
    score: float
    reasonCode: NotRequired[str]
    evidenceDigest: str
    maskedPreview: NotRequired[str]

class EnforcementDecision(TypedDict):
    contractVersion: Literal["1.0"]
    decisionId: str
    flowId: str
    frameId: str
    flowSeq: int
    frameSeq: int
    contentSha256: str
    action: EnforcementAction
    terminal: bool
    reasonCode: str
    policyBundleId: str
    guardDecisionId: NotRequired[str]
    observations: list[NetworkObservation]
    issuedAtEpochMs: int
    expiresAtEpochMs: int
    evidenceComplete: bool
    transformedPayloadBase64: NotRequired[str]
    enforcementToken: str

class EnforcementReceipt(TypedDict):
    receiptId: str
    decisionId: str
    deviceId: str
    flowId: str
    frameId: str
    action: EnforcementAction
    status: ReceiptStatus
    reasonCode: NotRequired[str]
    executedAtEpochMs: int
    bytesForwardedBeforeDecision: int
    receiptDigest: str

class ArtifactEnvelope(TypedDict):
    contractVersion: Literal["1.0"]
    flowId: str
    frameId: str
    artifactId: str
    mediaType: str
    fileName: NotRequired[str]
    sizeBytes: int
    sha256: str
    contentReference: ContentReference
    absoluteDeadlineEpochMs: int
    policyBundleId: str

class FlowClose(TypedDict):
    flowId: str
    flowSeq: int
    closedAtEpochMs: int
    reasonCode: str

class FlowReceipt(TypedDict):
    flowId: str
    flowSeq: int
    status: ReceiptStatus
    closedAtEpochMs: int
    receiptDigest: str

class EngineCapability(TypedDict):
    engineId: str
    engineType: EngineType
    version: str
    artifactSha256: str
    protocols: list[ApplicationProtocol]
    actions: list[EnforcementAction]

class HardwareCapability(TypedDict):
    cpuArchitecture: str
    cpuModel: str
    memoryBytes: int
    nicModels: list[str]
    acceleratorModels: list[str]
    driverDigests: list[str]
    firmwareDigests: list[str]
    physicalBypassAvailable: bool
    trustedKeyDeviceAvailable: bool

class CapabilityManifest(TypedDict):
    contractVersion: Literal["1.0"]
    deviceId: str
    deviceGroupId: str
    generation: int
    reportedAtEpochMs: int
    softwareVersion: str
    softwareDigest: str
    deploymentModes: list[DeploymentMode]
    engines: list[EngineCapability]
    hardware: HardwareCapability
    manifestDigest: str

class HealthComponent(TypedDict):
    componentId: str
    action: HealthAction
    reasonCodes: list[str]
    utilization: NotRequired[float]
    queueDepth: NotRequired[int]
    temperatureCelsius: NotRequired[float]

class HealthSnapshot(TypedDict):
    deviceId: str
    generation: int
    capturedAtEpochMs: int
    action: HealthAction
    components: list[HealthComponent]
    snapshotDigest: str

class BundleActivationReceipt(TypedDict):
    deviceId: str
    bundleId: str
    generation: int
    bundleDigest: str
    status: BundleActivationStatus
    reasonCode: NotRequired[str]
    componentDigests: dict[str, object]
    recordedAtEpochMs: int
    receiptDigest: str

class NetworkBypassPermitPayloadV2(TypedDict):
    version: Literal["2.0"]
    permitId: str
    deviceGroupId: str
    tenantId: str
    applicationId: str
    portPairs: list[str]
    protocols: list[ApplicationProtocol]
    maximumConnections: int
    maximumBytes: int
    reason: str
    changeTicketId: str
    approverIds: list[str]
    policyBundleId: str
    issuedAtEpochMs: int
    expiresAtEpochMs: int

class SignedNetworkBypassPermitV2(TypedDict):
    keyId: str
    algorithm: Literal["Ed25519"]
    payload: NetworkBypassPermitPayloadV2
    signature: str

class CapabilityAck(TypedDict):
    deviceId: str
    generation: int
    accepted: bool
    reasonCode: str

class HealthAck(TypedDict):
    deviceId: str
    generation: int
    accepted: bool
    requiredAction: HealthAction

class BundleAck(TypedDict):
    deviceId: str
    bundleId: str
    generation: int
    accepted: bool
    reasonCode: str

class ReceiptAck(TypedDict):
    receiptId: str
    accepted: bool
    reasonCode: str
