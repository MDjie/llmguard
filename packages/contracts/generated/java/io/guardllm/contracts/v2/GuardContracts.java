// Generated from model/gateway-v2.schema.json. Do not edit.
// Source SHA-256: 86662f37d842ad3909ba66deeea55d6fc0db3671a0aeb4f3c477fc70ae380f19
package io.guardllm.contracts.v2;

import java.util.List;
import java.util.Map;

public final class GuardContracts {
  public static final String CONTRACT_VERSION = "2.0";
  public static final String SOURCE_SHA256 = "86662f37d842ad3909ba66deeea55d6fc0db3671a0aeb4f3c477fc70ae380f19";
  private GuardContracts() {}

  public enum GatewayAction { ALLOW, WARN, BLOCK, MASK, REWRITE, SAFE_RESPONSE, REQUIRE_REVIEW }

  public enum GatewayStage { INPUT, INPUT_RECHECK, OUTPUT_COMPLETE, OUTPUT_CHUNK, OUTPUT_RECHECK, TOOL_REQUEST, TOOL_RESULT, RAG_CONTEXT }

  public enum GatewayCoverage { COMPLETE, PARTIAL, UNKNOWN }

  public enum GatewayStatus { SUCCEEDED, FAILED, TIMED_OUT, CANCELLED }

  public enum ExecutionKind { UPSTREAM_SEND_INTENT, UPSTREAM_SEND_STARTED, RELEASE_INTENT, WRITE_ACCEPTED, TERMINATED, COMPLETED }

  public enum SnapshotState { PREPARED, LOADED, CANARY, ACTIVE, REVOKED }

  public record PolicyRef(
    String snapshotId,
    String bundleId,
    long generation,
    String digest
  ) {}

  public record GatewayBudgets(
    long maxInputChars,
    long maxOutputChars,
    long maxSteps,
    long maxEvents,
    long maxStreamEvents,
    long idleTimeoutMs,
    long absoluteTimeoutMs
  ) {}

  public record ModelRoutingRecord(
    String configurationJson,
    String configurationDigest
  ) {}

  public record WindowPolicy(
    String configurationDigest,
    String qualificationId,
    long qualificationExpiresAt,
    long contextChars,
    long chunkChars,
    long holdbackChars
  ) {}

  public record RuntimeManifest(
    String tenantId,
    String applicationId,
    long generation,
    String bundleId,
    String bundleDigest,
    List<String> modelRoutes,
    String dataBoundary,
    String streamMode,
    boolean windowQualified,
    long holdbackChars,
    GatewayBudgets budgets,
    long validUntil,
    String normalizationVersion,
    ModelRoutingRecord modelRouting,
    WindowPolicy windowPolicy
  ) {}

  public record RuntimeSnapshot(
    String id,
    RuntimeManifest manifest,
    String digest,
    String signature,
    String keyId,
    SnapshotState state
  ) {}

  public record AuthContext(
    String contractVersion,
    String authContextId,
    String issuer,
    String audience,
    String keyId,
    long issuedAt,
    long expiresAt,
    String tenantId,
    String applicationId,
    String subjectId,
    String credentialId,
    long authVersion,
    String businessRequestId,
    String traceId,
    String sessionId,
    String requestDigest,
    PolicyRef policy,
    List<String> allowedModelRoutes,
    List<String> permissions,
    String dataBoundary,
    long deadline,
    Long subjectVersion,
    String preparedRequestDigest,
    String inputSegmentsDigest,
    Boolean archiveRequired
  ) {}

  public record SignedAuthContext(
    AuthContext context,
    String signature
  ) {}

  public record ContentSegment(
    String segmentId,
    String contentPath,
    String role,
    String text,
    String sourceType,
    String sourceDigest
  ) {}

  public record TransformPatch(
    String segmentId,
    String contentPath,
    long start,
    long end,
    String replacement,
    String sourceDigest
  ) {}

  public record WindowInspection(
    long contextStart,
    long releaseStart,
    long releaseEnd,
    boolean final
  ) {}

  public record GatewayRequest(
    String contractVersion,
    SignedAuthContext auth,
    String businessRequestId,
    String stepId,
    String traceId,
    GatewayStage stage,
    long streamSeq,
    String attemptKind,
    String snapshotId,
    long deadline,
    List<ContentSegment> segments,
    WindowInspection window
  ) {}

  public record GatewayDecision(
    String contractVersion,
    String businessRequestId,
    String stepId,
    String decisionId,
    String snapshotId,
    GatewayAction action,
    GatewayCoverage coverage,
    GatewayStatus status,
    String riskLevel,
    List<String> reasonCodes,
    List<String> modelVersions,
    List<TransformPatch> transformPatches,
    String safeResponse,
    long latencyMs
  ) {}

  public record GatewayAuthorize(
    String contractVersion,
    String businessRequestId,
    String traceId,
    String sessionId,
    String idempotencyKey,
    long deadline,
    String modelRoute,
    String requestDigest,
    String requestJson,
    String userAssertion
  ) {}

  public record GatewayAuthorization(
    SignedAuthContext auth,
    RuntimeSnapshot snapshot,
    String replayState,
    String preparedRequestJson,
    List<ContentSegment> inputSegments
  ) {}

  public record ExecutionEvent(
    long eventSeq,
    String stepId,
    String decisionId,
    String recheckDecisionId,
    ExecutionKind kind,
    Long rangeStart,
    Long rangeEnd,
    String payloadDigest,
    GatewayAction actualAction,
    String reasonCode,
    String snapshotId
  ) {}

  public record GatewayEvents(
    String contractVersion,
    SignedAuthContext auth,
    List<ExecutionEvent> events,
    Boolean terminalReconciliation
  ) {}

  public record GatewayNodeAck(
    String contractVersion,
    String tenantId,
    String applicationId,
    String snapshotId,
    String nodeId,
    String digest,
    String state,
    String reasonCode
  ) {}

  public record GatewayError(
    String contractVersion,
    String code,
    String requestId,
    String traceId,
    boolean retryable
  ) {}

}
