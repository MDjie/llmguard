package io.guardllm.sdk;

public record GatewayContext(
        String tenantId,
        String applicationId,
        String principalId,
        String credentialId,
        String requestId,
        String traceId,
        String sessionId,
        long absoluteDeadlineEpochMs) {
    public GatewayContext {
        tenantId = bounded(tenantId, "tenantId", 1);
        applicationId = bounded(applicationId, "applicationId", 1);
        principalId = principalId == null || principalId.isBlank()
                ? null : bounded(principalId, "principalId", 1);
        credentialId = credentialId == null || credentialId.isBlank()
                ? null : bounded(credentialId, "credentialId", 1);
        requestId = bounded(requestId, "requestId", 8);
        traceId = bounded(traceId, "traceId", 16);
        sessionId = sessionId == null || sessionId.isBlank()
                ? null : bounded(sessionId, "sessionId", 1);
    }

    public GatewayContext(
            String tenantId,
            String applicationId,
            String requestId,
            String traceId,
            String sessionId,
            long absoluteDeadlineEpochMs) {
        this(tenantId, applicationId, null, null, requestId, traceId,
                sessionId, absoluteDeadlineEpochMs);
    }

    private static String bounded(String value, String name, int minimum) {
        if (value == null) throw new IllegalArgumentException(name + " is required");
        String candidate = value.trim();
        if (candidate.length() < minimum || candidate.length() > 128
                || candidate.indexOf('\r') >= 0 || candidate.indexOf('\n') >= 0) {
            throw new IllegalArgumentException(name + " is outside the supported length");
        }
        return candidate;
    }
}
