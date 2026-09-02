package com.guardllm.gateway;

import java.net.URI;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("guard.gateway")
public record GuardGatewayProperties(
        String contextHmacSecret,
        URI guardBaseUrl,
        String guardAppKey,
        URI modelBaseUrl,
        String modelBearerToken,
        String activeBundleId,
        String canaryBundleId,
        int canaryPercent,
        String shadowBundleId,
        Duration requestTimeout,
        int maxInFlight) {
    public GuardGatewayProperties {
        if (contextHmacSecret == null || contextHmacSecret.getBytes().length < 32) {
            throw new IllegalArgumentException("context-hmac-secret must contain at least 32 bytes");
        }
        if (guardBaseUrl == null || modelBaseUrl == null) {
            throw new IllegalArgumentException("guard-base-url and model-base-url are required");
        }
        if (!"https".equalsIgnoreCase(modelBaseUrl.getScheme()) && !isLoopback(modelBaseUrl)) {
            throw new IllegalArgumentException("model-base-url must use HTTPS outside loopback development");
        }
        if (activeBundleId == null || activeBundleId.isBlank()) {
            throw new IllegalArgumentException("active-bundle-id is required");
        }
        if (canaryPercent < 0 || canaryPercent > 99) {
            throw new IllegalArgumentException("canary-percent must be in range 0..99");
        }
        requestTimeout = requestTimeout == null ? Duration.ofSeconds(20) : requestTimeout;
        maxInFlight = maxInFlight <= 0 ? 200 : maxInFlight;
    }

    private static boolean isLoopback(URI value) {
        return "localhost".equalsIgnoreCase(value.getHost()) || "127.0.0.1".equals(value.getHost());
    }
}
