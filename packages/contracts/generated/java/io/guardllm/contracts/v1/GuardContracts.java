// Generated from model/guard-v1.schema.json. Do not edit.
// Source SHA-256: 4de68b95fb3b68b2116a5e2bdfde666a49e00baf2e1ac0716d03bc315bf4e3a5
package io.guardllm.contracts.v1;

import java.util.List;
import java.util.Map;

public final class GuardContracts {
  public static final String CONTRACT_VERSION = "1.0";
  public static final String SOURCE_SHA256 = "4de68b95fb3b68b2116a5e2bdfde666a49e00baf2e1ac0716d03bc315bf4e3a5";
  private GuardContracts() {}

  public enum Direction { INPUT, OUTPUT_COMPLETE, OUTPUT_CHUNK, RAG_INGEST, RAG_CONTEXT, TOOL_REQUEST, TOOL_RESULT }

  public enum GuardAction { ALLOW, WARN, BLOCK, MASK, REWRITE, SAFE_RESPONSE, REQUIRE_REVIEW }

  public enum RiskLevel { NONE, LOW, MEDIUM, HIGH, CRITICAL }

  public enum ObservationStatus { MATCH, NO_MATCH, TIMEOUT, ERROR, SKIPPED }

  public enum ArtifactKind { TEXT, IMAGE, AUDIO, VIDEO, DOCUMENT, TOOL_RESULT, RAG_CHUNK }

  public record RequestContext(
    String traceId,
    String requestId,
    String tenantId,
    String applicationId,
    String sessionId,
    Direction direction,
    long absoluteDeadlineEpochMs,
    String policyBundleId
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
    List<ArtifactRef> artifacts
  ) {}

  public record GuardRequest(
    String contractVersion,
    RequestContext context,
    GuardContent content
  ) {}

  public record EvidenceRef(
    String viewId,
    Long start,
    Long end,
    String artifactId,
    List<Double> region,
    List<Long> timeRangeMs,
    String maskedPreview,
    String contentHmac
  ) {}

  public record Observation(
    String detectorId,
    String detectorVersion,
    String riskType,
    double score,
    RiskLevel severity,
    List<EvidenceRef> evidence,
    ObservationStatus status,
    String reasonCode
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
    String transformedText
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
    Object payload
  ) {}

}
