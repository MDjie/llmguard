// Generated from model/guard-v1.schema.json. Do not edit.
// Source SHA-256: 2da2dcd7e08805684ff47b35f29d160f2d583db74671af14c64f4a86b7911962
package io.guardllm.contracts.v1;

import java.util.List;
import java.util.Map;

public final class GuardContracts {
  public static final String CONTRACT_VERSION = "1.0";
  public static final String SOURCE_SHA256 = "2da2dcd7e08805684ff47b35f29d160f2d583db74671af14c64f4a86b7911962";
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
    ArtifactKind modality,
    String artifactId,
    Long page,
    List<Long> timeRangeMs,
    List<Double> region,
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
    SourceType sourceType,
    String locale,
    String jurisdiction,
    String industry,
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
    String tokenizerId,
    Long normalizedStart,
    Long normalizedEnd,
    List<String> normalizationTransforms
  ) {}

  public record Observation(
    String detectorId,
    String detectorVersion,
    String riskType,
    String category,
    Double confidence,
    String ruleId,
    String ruleVersion,
    String dictionaryReleaseId,
    String dictionaryVersion,
    double score,
    RiskLevel severity,
    List<EvidenceRef> evidence,
    ObservationStatus status,
    String reasonCode,
    String modelVersion,
    String configurationDigest,
    GuardFailMode failMode
  ) {}

  public record LatencyBreakdown(
    Long normalizationMs,
    Long detectionMs,
    Long aggregationMs,
    Long interventionMs,
    long totalMs
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
    LatencyBreakdown latencyBreakdown,
    Boolean degraded,
    List<String> reasonCodes,
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
