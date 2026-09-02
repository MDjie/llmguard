package com.guardllm.gateway;

public record GatewayRequestContext(
        String tenantId,
        String applicationId,
        String principalId,
        String credentialId,
        String requestId,
        String traceId,
        String sessionId,
        long absoluteDeadlineEpochMs) {
}
