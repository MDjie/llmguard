package com.guardllm.gateway;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("guard.gateway.concurrency")
public record GatewayConcurrencyProperties(
        boolean enabled,
        int tenantMaxInFlight,
        int applicationMaxInFlight,
        int principalMaxInFlight,
        int credentialMaxInFlight,
        int apiMaxInFlight,
        int maxTrackedScopes) {
    public GatewayConcurrencyProperties {
        tenantMaxInFlight = positiveOrDefault(tenantMaxInFlight, 200);
        applicationMaxInFlight = positiveOrDefault(applicationMaxInFlight, 100);
        principalMaxInFlight = positiveOrDefault(principalMaxInFlight, 20);
        credentialMaxInFlight = positiveOrDefault(credentialMaxInFlight, 50);
        apiMaxInFlight = positiveOrDefault(apiMaxInFlight, 200);
        maxTrackedScopes = positiveOrDefault(maxTrackedScopes, 10_000);
    }

    private static int positiveOrDefault(int value, int defaultValue) {
        return value > 0 ? value : defaultValue;
    }
}
