// Generated from model/appliance-v1.schema.json. Do not edit.
// Source SHA-256: b10daf922dd2098768c989fea3284fa56fc6ebacadb8d35520c6fcec29f5a080
package io.guardllm.appliance.contracts.v1;

import java.util.List;
import java.util.Map;

public final class ApplianceContracts {
  public static final String CONTRACT_VERSION = "1.0";
  public static final String SOURCE_SHA256 = "b10daf922dd2098768c989fea3284fa56fc6ebacadb8d35520c6fcec29f5a080";
  private ApplianceContracts() {}

  public enum TransportProtocol { TCP, UDP }

  public enum ApplicationProtocol { UNKNOWN, TLS, HTTP_1_1, HTTP_2, HTTPS, SSE, WEBSOCKET, GRPC, OPENAI_API, MQTT, MCP }

  public enum TrafficDirection { CLIENT_TO_SERVER, SERVER_TO_CLIENT }

  public enum ProtocolStage { FLOW_METADATA, TLS_HANDSHAKE, HEADERS, MESSAGE, ARTIFACT, TRAILERS }

  public enum DeploymentMode { REVERSE_PROXY, TRANSPARENT_INLINE, TAP_MIRROR, HA_PAIR }

  public enum AdmissionAction { INSPECT, ALLOW_METADATA_ONLY, BLOCK, MIRROR_ONLY }

  public enum EnforcementAction { ALLOW, BLOCK, RESET, RATE_LIMIT, REDIRECT, MASK, REWRITE, QUARANTINE, MIRROR_ONLY }

  public enum HealthAction { HEALTHY, DEGRADE, DRAIN, ISOLATE, FAILOVER }

  public enum ReceiptStatus { APPLIED, REJECTED, EXPIRED, DUPLICATE }

  public enum BundleActivationStatus { PREPARED, ACTIVE, REJECTED, ROLLED_BACK }

  public enum EngineType { FAST_PATH, PROTOCOL_PROXY, IPS, ANTIVIRUS, DOS, DLP, AI_GUARD, FILE_ANALYZER, HARDWARE_AGENT }

  public record NetworkEndpoint(
    String ip,
    long port,
    String mac,
    String zone
  ) {}

  public record TlsContext(
    boolean intercepted,
    String version,
    String serverName,
    String alpn,
    String cipherSuite,
    String peerCertificateSha256,
    String clientCertificateSha256
  ) {}

  public record FlowEnvelope(
    String contractVersion,
    String deviceId,
    String deviceGroupId,
    String flowId,
    long flowSeq,
    String tenantId,
    String applicationId,
    String sessionId,
    DeploymentMode deploymentMode,
    String ingressInterface,
    String egressInterface,
    Long vlanId,
    NetworkEndpoint source,
    NetworkEndpoint destination,
    TransportProtocol transport,
    ApplicationProtocol applicationProtocol,
    TrafficDirection direction,
    boolean protectedTraffic,
    long openedAtEpochMs,
    long absoluteDeadlineEpochMs,
    String policyBundleId,
    TlsContext tls
  ) {}

  public record FlowAdmission(
    String flowId,
    long flowSeq,
    AdmissionAction action,
    String reasonCode,
    String policyBundleId,
    long expiresAtEpochMs
  ) {}

  public record ContentReference(
    String uri,
    String sha256,
    String authorizationId,
    long expiresAtEpochMs
  ) {}

  public record FrameEnvelope(
    String contractVersion,
    String flowId,
    String frameId,
    long flowSeq,
    long frameSeq,
    TrafficDirection direction,
    ApplicationProtocol applicationProtocol,
    ProtocolStage protocolStage,
    String mediaType,
    String contentEncoding,
    long sizeBytes,
    String sha256,
    long streamOffsetStart,
    long streamOffsetEnd,
    long absoluteDeadlineEpochMs,
    String policyBundleId,
    String inlinePayloadBase64,
    ContentReference contentReference
  ) {}

  public record NetworkObservation(
    String engineId,
    EngineType engineType,
    String engineVersion,
    String ruleVersion,
    String status,
    String riskType,
    String severity,
    double score,
    String reasonCode,
    String evidenceDigest,
    String maskedPreview
  ) {}

  public record EnforcementDecision(
    String contractVersion,
    String decisionId,
    String flowId,
    String frameId,
    long flowSeq,
    long frameSeq,
    String contentSha256,
    EnforcementAction action,
    boolean terminal,
    String reasonCode,
    String policyBundleId,
    String guardDecisionId,
    List<NetworkObservation> observations,
    long issuedAtEpochMs,
    long expiresAtEpochMs,
    boolean evidenceComplete,
    String transformedPayloadBase64,
    String enforcementToken
  ) {}

  public record EnforcementReceipt(
    String receiptId,
    String decisionId,
    String deviceId,
    String flowId,
    String frameId,
    EnforcementAction action,
    ReceiptStatus status,
    String reasonCode,
    long executedAtEpochMs,
    long bytesForwardedBeforeDecision,
    String receiptDigest
  ) {}

  public record ArtifactEnvelope(
    String contractVersion,
    String flowId,
    String frameId,
    String artifactId,
    String mediaType,
    String fileName,
    long sizeBytes,
    String sha256,
    ContentReference contentReference,
    long absoluteDeadlineEpochMs,
    String policyBundleId
  ) {}

  public record FlowClose(
    String flowId,
    long flowSeq,
    long closedAtEpochMs,
    String reasonCode
  ) {}

  public record FlowReceipt(
    String flowId,
    long flowSeq,
    ReceiptStatus status,
    long closedAtEpochMs,
    String receiptDigest
  ) {}

  public record EngineCapability(
    String engineId,
    EngineType engineType,
    String version,
    String artifactSha256,
    List<ApplicationProtocol> protocols,
    List<EnforcementAction> actions
  ) {}

  public record HardwareCapability(
    String cpuArchitecture,
    String cpuModel,
    long memoryBytes,
    List<String> nicModels,
    List<String> acceleratorModels,
    List<String> driverDigests,
    List<String> firmwareDigests,
    boolean physicalBypassAvailable,
    boolean trustedKeyDeviceAvailable
  ) {}

  public record CapabilityManifest(
    String contractVersion,
    String deviceId,
    String deviceGroupId,
    long generation,
    long reportedAtEpochMs,
    String softwareVersion,
    String softwareDigest,
    List<DeploymentMode> deploymentModes,
    List<EngineCapability> engines,
    HardwareCapability hardware,
    String manifestDigest
  ) {}

  public record HealthComponent(
    String componentId,
    HealthAction action,
    List<String> reasonCodes,
    Double utilization,
    Long queueDepth,
    Double temperatureCelsius
  ) {}

  public record HealthSnapshot(
    String deviceId,
    long generation,
    long capturedAtEpochMs,
    HealthAction action,
    List<HealthComponent> components,
    String snapshotDigest
  ) {}

  public record BundleActivationReceipt(
    String deviceId,
    String bundleId,
    long generation,
    String bundleDigest,
    BundleActivationStatus status,
    String reasonCode,
    Map<String, Object> componentDigests,
    long recordedAtEpochMs,
    String receiptDigest
  ) {}

  public record NetworkBypassPermitPayloadV2(
    String version,
    String permitId,
    String deviceGroupId,
    String tenantId,
    String applicationId,
    List<String> portPairs,
    List<ApplicationProtocol> protocols,
    long maximumConnections,
    long maximumBytes,
    String reason,
    String changeTicketId,
    List<String> approverIds,
    String policyBundleId,
    long issuedAtEpochMs,
    long expiresAtEpochMs
  ) {}

  public record SignedNetworkBypassPermitV2(
    String keyId,
    String algorithm,
    NetworkBypassPermitPayloadV2 payload,
    String signature
  ) {}

  public record CapabilityAck(
    String deviceId,
    long generation,
    boolean accepted,
    String reasonCode
  ) {}

  public record HealthAck(
    String deviceId,
    long generation,
    boolean accepted,
    HealthAction requiredAction
  ) {}

  public record BundleAck(
    String deviceId,
    String bundleId,
    long generation,
    boolean accepted,
    String reasonCode
  ) {}

  public record ReceiptAck(
    String receiptId,
    boolean accepted,
    String reasonCode
  ) {}

}
