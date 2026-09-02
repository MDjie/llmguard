package com.guardllm.gateway;

import tools.jackson.databind.JsonNode;

public record GuardDecision(
        String contractVersion,
        String decisionId,
        String traceId,
        String action,
        String riskLevel,
        JsonNode observations,
        JsonNode policyPath,
        String bundleId,
        long latencyMs,
        JsonNode degradationReasons,
        String transformedText) {
    public boolean blocks() {
        return switch (action) {
            case "BLOCK", "SAFE_RESPONSE", "REQUIRE_REVIEW" -> true;
            default -> false;
        };
    }
}
