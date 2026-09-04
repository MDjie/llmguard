// Generated from model/appliance-v1.schema.json. Do not edit.
// Source SHA-256: b10daf922dd2098768c989fea3284fa56fc6ebacadb8d35520c6fcec29f5a080

export const APPLIANCE_CONTRACT_VERSION = '1.0' as const;
export const APPLIANCE_CONTRACT_SOURCE_SHA256 = 'b10daf922dd2098768c989fea3284fa56fc6ebacadb8d35520c6fcec29f5a080' as const;

export type TransportProtocol = "TCP" | "UDP";

export type ApplicationProtocol = "UNKNOWN" | "TLS" | "HTTP_1_1" | "HTTP_2" | "HTTPS" | "SSE" | "WEBSOCKET" | "GRPC" | "OPENAI_API" | "MQTT" | "MCP";

export type TrafficDirection = "CLIENT_TO_SERVER" | "SERVER_TO_CLIENT";

export type ProtocolStage = "FLOW_METADATA" | "TLS_HANDSHAKE" | "HEADERS" | "MESSAGE" | "ARTIFACT" | "TRAILERS";

export type DeploymentMode = "REVERSE_PROXY" | "TRANSPARENT_INLINE" | "TAP_MIRROR" | "HA_PAIR";

export type AdmissionAction = "INSPECT" | "ALLOW_METADATA_ONLY" | "BLOCK" | "MIRROR_ONLY";

export type EnforcementAction = "ALLOW" | "BLOCK" | "RESET" | "RATE_LIMIT" | "REDIRECT" | "MASK" | "REWRITE" | "QUARANTINE" | "MIRROR_ONLY";

export type HealthAction = "HEALTHY" | "DEGRADE" | "DRAIN" | "ISOLATE" | "FAILOVER";

export type ReceiptStatus = "APPLIED" | "REJECTED" | "EXPIRED" | "DUPLICATE";

export type BundleActivationStatus = "PREPARED" | "ACTIVE" | "REJECTED" | "ROLLED_BACK";

export type EngineType = "FAST_PATH" | "PROTOCOL_PROXY" | "IPS" | "ANTIVIRUS" | "DOS" | "DLP" | "AI_GUARD" | "FILE_ANALYZER" | "HARDWARE_AGENT";

export interface NetworkEndpoint {
  readonly ip: string;
  readonly port: number;
  readonly mac?: string;
  readonly zone?: string;
}

export interface TlsContext {
  readonly intercepted: boolean;
  readonly version: string;
  readonly serverName: string;
  readonly alpn?: string;
  readonly cipherSuite?: string;
  readonly peerCertificateSha256: string;
  readonly clientCertificateSha256?: string;
}

export interface FlowEnvelope {
  readonly contractVersion: "1.0";
  readonly deviceId: string;
  readonly deviceGroupId: string;
  readonly flowId: string;
  readonly flowSeq: number;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId?: string;
  readonly deploymentMode: DeploymentMode;
  readonly ingressInterface: string;
  readonly egressInterface: string;
  readonly vlanId?: number;
  readonly source: NetworkEndpoint;
  readonly destination: NetworkEndpoint;
  readonly transport: TransportProtocol;
  readonly applicationProtocol: ApplicationProtocol;
  readonly direction: TrafficDirection;
  readonly protectedTraffic: boolean;
  readonly openedAtEpochMs: number;
  readonly absoluteDeadlineEpochMs: number;
  readonly policyBundleId: string;
  readonly tls?: TlsContext;
}

export interface FlowAdmission {
  readonly flowId: string;
  readonly flowSeq: number;
  readonly action: AdmissionAction;
  readonly reasonCode: string;
  readonly policyBundleId: string;
  readonly expiresAtEpochMs: number;
}

export interface ContentReference {
  readonly uri: string;
  readonly sha256: string;
  readonly authorizationId?: string;
  readonly expiresAtEpochMs: number;
}

export interface FrameEnvelope {
  readonly contractVersion: "1.0";
  readonly flowId: string;
  readonly frameId: string;
  readonly flowSeq: number;
  readonly frameSeq: number;
  readonly direction: TrafficDirection;
  readonly applicationProtocol: ApplicationProtocol;
  readonly protocolStage: ProtocolStage;
  readonly mediaType: string;
  readonly contentEncoding?: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly streamOffsetStart: number;
  readonly streamOffsetEnd: number;
  readonly absoluteDeadlineEpochMs: number;
  readonly policyBundleId: string;
  readonly inlinePayloadBase64?: string;
  readonly contentReference?: ContentReference;
}

export interface NetworkObservation {
  readonly engineId: string;
  readonly engineType: EngineType;
  readonly engineVersion: string;
  readonly ruleVersion: string;
  readonly status: "MATCH" | "NO_MATCH" | "TIMEOUT" | "ERROR" | "SKIPPED";
  readonly riskType: string;
  readonly severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly score: number;
  readonly reasonCode?: string;
  readonly evidenceDigest: string;
  readonly maskedPreview?: string;
}

export interface EnforcementDecision {
  readonly contractVersion: "1.0";
  readonly decisionId: string;
  readonly flowId: string;
  readonly frameId: string;
  readonly flowSeq: number;
  readonly frameSeq: number;
  readonly contentSha256: string;
  readonly action: EnforcementAction;
  readonly terminal: boolean;
  readonly reasonCode: string;
  readonly policyBundleId: string;
  readonly guardDecisionId?: string;
  readonly observations: readonly NetworkObservation[];
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly evidenceComplete: boolean;
  readonly transformedPayloadBase64?: string;
  readonly enforcementToken: string;
}

export interface EnforcementReceipt {
  readonly receiptId: string;
  readonly decisionId: string;
  readonly deviceId: string;
  readonly flowId: string;
  readonly frameId: string;
  readonly action: EnforcementAction;
  readonly status: ReceiptStatus;
  readonly reasonCode?: string;
  readonly executedAtEpochMs: number;
  readonly bytesForwardedBeforeDecision: number;
  readonly receiptDigest: string;
}

export interface ArtifactEnvelope {
  readonly contractVersion: "1.0";
  readonly flowId: string;
  readonly frameId: string;
  readonly artifactId: string;
  readonly mediaType: string;
  readonly fileName?: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentReference: ContentReference;
  readonly absoluteDeadlineEpochMs: number;
  readonly policyBundleId: string;
}

export interface FlowClose {
  readonly flowId: string;
  readonly flowSeq: number;
  readonly closedAtEpochMs: number;
  readonly reasonCode: string;
}

export interface FlowReceipt {
  readonly flowId: string;
  readonly flowSeq: number;
  readonly status: ReceiptStatus;
  readonly closedAtEpochMs: number;
  readonly receiptDigest: string;
}

export interface EngineCapability {
  readonly engineId: string;
  readonly engineType: EngineType;
  readonly version: string;
  readonly artifactSha256: string;
  readonly protocols: readonly ApplicationProtocol[];
  readonly actions: readonly EnforcementAction[];
}

export interface HardwareCapability {
  readonly cpuArchitecture: string;
  readonly cpuModel: string;
  readonly memoryBytes: number;
  readonly nicModels: readonly string[];
  readonly acceleratorModels: readonly string[];
  readonly driverDigests: readonly string[];
  readonly firmwareDigests: readonly string[];
  readonly physicalBypassAvailable: boolean;
  readonly trustedKeyDeviceAvailable: boolean;
}

export interface CapabilityManifest {
  readonly contractVersion: "1.0";
  readonly deviceId: string;
  readonly deviceGroupId: string;
  readonly generation: number;
  readonly reportedAtEpochMs: number;
  readonly softwareVersion: string;
  readonly softwareDigest: string;
  readonly deploymentModes: readonly DeploymentMode[];
  readonly engines: readonly EngineCapability[];
  readonly hardware: HardwareCapability;
  readonly manifestDigest: string;
}

export interface HealthComponent {
  readonly componentId: string;
  readonly action: HealthAction;
  readonly reasonCodes: readonly string[];
  readonly utilization?: number;
  readonly queueDepth?: number;
  readonly temperatureCelsius?: number;
}

export interface HealthSnapshot {
  readonly deviceId: string;
  readonly generation: number;
  readonly capturedAtEpochMs: number;
  readonly action: HealthAction;
  readonly components: readonly HealthComponent[];
  readonly snapshotDigest: string;
}

export interface BundleActivationReceipt {
  readonly deviceId: string;
  readonly bundleId: string;
  readonly generation: number;
  readonly bundleDigest: string;
  readonly status: BundleActivationStatus;
  readonly reasonCode?: string;
  readonly componentDigests: Readonly<Record<string, string>>;
  readonly recordedAtEpochMs: number;
  readonly receiptDigest: string;
}

export interface NetworkBypassPermitPayloadV2 {
  readonly version: "2.0";
  readonly permitId: string;
  readonly deviceGroupId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly portPairs: readonly string[];
  readonly protocols: readonly ApplicationProtocol[];
  readonly maximumConnections: number;
  readonly maximumBytes: number;
  readonly reason: string;
  readonly changeTicketId: string;
  readonly approverIds: readonly string[];
  readonly policyBundleId: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface SignedNetworkBypassPermitV2 {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly payload: NetworkBypassPermitPayloadV2;
  readonly signature: string;
}

export interface CapabilityAck {
  readonly deviceId: string;
  readonly generation: number;
  readonly accepted: boolean;
  readonly reasonCode: string;
}

export interface HealthAck {
  readonly deviceId: string;
  readonly generation: number;
  readonly accepted: boolean;
  readonly requiredAction: HealthAction;
}

export interface BundleAck {
  readonly deviceId: string;
  readonly bundleId: string;
  readonly generation: number;
  readonly accepted: boolean;
  readonly reasonCode: string;
}

export interface ReceiptAck {
  readonly receiptId: string;
  readonly accepted: boolean;
  readonly reasonCode: string;
}
