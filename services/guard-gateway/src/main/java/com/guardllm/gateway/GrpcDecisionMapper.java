package com.guardllm.gateway;

import io.guardllm.contracts.v1.proto.EvidenceRef;
import io.guardllm.contracts.v1.proto.GuardAction;
import io.guardllm.contracts.v1.proto.Observation;
import io.guardllm.contracts.v1.proto.ObservationStatus;
import io.guardllm.contracts.v1.proto.RiskLevel;
import tools.jackson.databind.JsonNode;

final class GrpcDecisionMapper {
    io.guardllm.contracts.v1.proto.GuardDecision toProto(GuardDecision decision, String traceId) {
        var builder = io.guardllm.contracts.v1.proto.GuardDecision.newBuilder()
                .setContractVersion(value(decision.contractVersion(), "1.0"))
                .setDecisionId(value(decision.decisionId(), "unknown"))
                .setTraceId(value(decision.traceId(), traceId))
                .setAction(enumValue(GuardAction.class, "GUARD_ACTION_", decision.action(), GuardAction.GUARD_ACTION_UNSPECIFIED))
                .setRiskLevel(enumValue(RiskLevel.class, "RISK_LEVEL_", decision.riskLevel(), RiskLevel.RISK_LEVEL_UNSPECIFIED))
                .setBundleId(value(decision.bundleId(), "unknown"))
                .setLatencyMs(Math.max(0, decision.latencyMs()));
        addStrings(decision.policyPath(), builder::addPolicyPath);
        addStrings(decision.degradationReasons(), builder::addDegradationReasons);
        if (decision.transformedText() != null) builder.setTransformedText(decision.transformedText());
        JsonNode observations = decision.observations();
        if (observations != null && observations.isArray()) {
            for (JsonNode item : observations) builder.addObservations(observation(item));
        }
        return builder.build();
    }

    private Observation observation(JsonNode item) {
        var builder = Observation.newBuilder()
                .setDetectorId(text(item, "detectorId", "unknown"))
                .setDetectorVersion(text(item, "detectorVersion", "unknown"))
                .setRiskType(text(item, "riskType", "unknown"))
                .setScore(number(item, "score", 0))
                .setSeverity(enumValue(RiskLevel.class, "RISK_LEVEL_", text(item, "severity", "UNSPECIFIED"), RiskLevel.RISK_LEVEL_UNSPECIFIED))
                .setStatus(enumValue(ObservationStatus.class, "OBSERVATION_STATUS_", text(item, "status", "UNSPECIFIED"), ObservationStatus.OBSERVATION_STATUS_UNSPECIFIED));
        String reasonCode = text(item, "reasonCode", "");
        if (!reasonCode.isBlank()) builder.setReasonCode(reasonCode);
        JsonNode evidence = item.path("evidence");
        if (evidence.isArray()) for (JsonNode value : evidence) builder.addEvidence(evidence(value));
        return builder.build();
    }

    private EvidenceRef evidence(JsonNode item) {
        var builder = EvidenceRef.newBuilder()
                .setViewId(text(item, "viewId", "unknown"))
                .setContentHmac(text(item, "contentHmac", "0".repeat(64)));
        setOptionalLong(item, "start", builder::setStart);
        setOptionalLong(item, "end", builder::setEnd);
        String artifactId = text(item, "artifactId", "");
        if (!artifactId.isBlank()) builder.setArtifactId(artifactId);
        String preview = text(item, "maskedPreview", "");
        if (!preview.isBlank()) builder.setMaskedPreview(preview);
        JsonNode region = item.path("region");
        if (region.isArray()) for (JsonNode value : region) builder.addRegion(value.doubleValue());
        JsonNode timeRange = item.path("timeRangeMs");
        if (timeRange.isArray()) for (JsonNode value : timeRange) builder.addTimeRangeMs(value.longValue());
        return builder.build();
    }

    private static void setOptionalLong(JsonNode item, String field, java.util.function.LongConsumer setter) {
        JsonNode value = item.path(field);
        if (value.isNumber()) setter.accept(value.longValue());
    }

    private static void addStrings(JsonNode values, java.util.function.Consumer<String> consumer) {
        if (values != null && values.isArray()) {
            for (JsonNode value : values) if (value.isString()) consumer.accept(value.stringValue());
        }
    }

    private static String text(JsonNode item, String field, String fallback) {
        JsonNode value = item.path(field);
        return value.isString() ? value.stringValue() : fallback;
    }

    private static double number(JsonNode item, String field, double fallback) {
        JsonNode value = item.path(field);
        return value.isNumber() ? value.doubleValue() : fallback;
    }

    private static String value(String input, String fallback) {
        return input == null || input.isBlank() ? fallback : input;
    }

    private static <T extends Enum<T>> T enumValue(Class<T> type, String prefix, String value, T fallback) {
        try {
            return Enum.valueOf(type, prefix + value.toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException | NullPointerException ignored) {
            return fallback;
        }
    }
}
