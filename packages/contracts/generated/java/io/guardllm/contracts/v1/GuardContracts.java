// Generated from model/guard-v1.schema.json. Do not edit.
// Source SHA-256: 95d5f83807849b342487326076ea8dc4a664878ff7689e6ec89ce665d1316faf
package io.guardllm.contracts.v1;

import java.util.List;
import java.util.Map;

public final class GuardContracts {
  public static final String CONTRACT_VERSION = "1.0";
  public static final String SOURCE_SHA256 = "95d5f83807849b342487326076ea8dc4a664878ff7689e6ec89ce665d1316faf";
  private GuardContracts() {}

  public enum Direction { INPUT, OUTPUT_COMPLETE, OUTPUT_CHUNK, RAG_INGEST, RAG_CONTEXT, TOOL_REQUEST, TOOL_RESULT }

  public enum GuardAction { ALLOW, WARN, BLOCK, MASK, REWRITE, SAFE_RESPONSE, REQUIRE_REVIEW }

  public enum RiskLevel { NONE, LOW, MEDIUM, HIGH, CRITICAL }

  public enum ObservationStatus { MATCH, NO_MATCH, TIMEOUT, ERROR, SKIPPED }

  public enum ArtifactKind { TEXT, IMAGE, AUDIO, VIDEO, DOCUMENT, TOOL_RESULT, RAG_CHUNK }

  public enum SourceType { SYSTEM, USER, RAG, TOOL, MEMORY, AGENT, FILE, MEDIA }

  public enum TrustLevel { TRUSTED, CONTROLLED, UNTRUSTED }

  public enum InstructionCapability { ALLOWED, DATA_ONLY, FORBIDDEN }

  public enum GuardFailMode { NORMAL, FAIL_CLOSED, DEGRADED, FAIL_OPEN }

  public enum ProcessingStage { INPUT_PRE, MODEL_PRE, MODEL_STREAM, OUTPUT_POST, RAG_INGEST, RAG_RETRIEVE, TOOL_PRE, TOOL_POST, MEDIA_ANALYZE, OFFLINE_EVALUATE }

  public enum SideEffect { NONE, READ, WRITE, EXECUTE, EXTERNAL_COMMUNICATION, FINANCIAL, PRIVILEGE_CHANGE }

  public record ContextEnvelope(
    String envelopeId,
    String tenantId,
    String applicationId,
    String sessionId,
    SourceType sourceType,
    String sourceId,
    TrustLevel trustLevel,
    InstructionCapability instructionCapability,
    List<String> sensitivityLabels,
    String contentHash,
    List<String> parentEnvelopeIds,
    String policyVersion,
    long eventSeq,
    long contentStart,
    long contentEnd,
    Long expiresAtEpochMs,
    String signature,
    String signatureKeyId
  ) {}

  public record ActionIntent(
    String intentId,
    String userGoal,
    String toolName,
    String parametersDigest,
    String targetResource,
    SideEffect sideEffect,
    List<String> requiredPermissions,
    List<String> supportingEnvelopeIds,
    List<String> dataDestinations,
    double riskBudget,
    Long expiresAtEpochMs
  ) {}

  public record RequestContext(
    String traceId,
    String requestId,
    String tenantId,
    String applicationId,
    String sessionId,
    Direction direction,
    long absoluteDeadlineEpochMs,
    String policyBundleId,
    String subjectId,
    String authContextId,
    String tokenizerId,
    ProcessingStage stage
  ) {}

  public record ArtifactRef(
    String artifactId,
    ArtifactKind kind,
    String mediaType,
    long sizeBytes,
    String sha256,
    Map<String, Object> metadata
  ) {}

  public record GuardContent(
    String text,
    List<ArtifactRef> artifacts,
    List<ContextEnvelope> envelopes
  ) {}

  public record GuardRequest(
    String contractVersion,
    RequestContext context,
    GuardContent content,
    ActionIntent actionIntent
  ) {}

  public record EvidenceRef(
    String viewId,
    Long start,
    Long end,
    String artifactId,
    List<Double> region,
    List<Long> timeRangeMs,
    String maskedPreview,
    String contentHmac,
    List<String> sourceEnvelopeIds,
    Long tokenStart,
    Long tokenEnd,
    String tokenizerId
  ) {}

  public record Observation(
    String detectorId,
    String detectorVersion,
    String riskType,
    double score,
    RiskLevel severity,
    List<EvidenceRef> evidence,
    ObservationStatus status,
    String reasonCode,
    String modelVersion,
    String configurationDigest,
    GuardFailMode failMode
  ) {}

  public record GuardDecision(
    String contractVersion,
    String decisionId,
    String traceId,
    GuardAction action,
    RiskLevel riskLevel,
    List<Observation> observations,
    List<String> policyPath,
    String bundleId,
    long latencyMs,
    List<String> degradationReasons,
    String transformedText,
    List<String> modelVersions,
    GuardFailMode failMode,
    Boolean evidenceComplete
  ) {}

  public record GuardError(
    String contractVersion,
    String code,
    String message,
    String traceId,
    boolean retryable,
    Map<String, Object> details
  ) {}

  public record GuardEvent(
    String contractVersion,
    String eventId,
    String eventType,
    String occurredAt,
    String traceId,
    String tenantId,
    String applicationId,
    Object payload,
    Long sequenceNumber,
    Long expiresAtEpochMs,
    String signature,
    String signatureKeyId
  ) {}

}
