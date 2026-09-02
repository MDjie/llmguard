package com.guardllm.gateway;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("guard.gateway.rate-limit")
public record GatewayRateLimitProperties(
        boolean enabled,
        boolean failClosed,
        int requestsPerMinute,
        int textCharsPerMinute,
        int estimatedTokensPerMinute,
        int maxTextCharsPerRequest) {
    public GatewayRateLimitProperties {
        requestsPerMinute = requestsPerMinute <= 0 ? 600 : requestsPerMinute;
        textCharsPerMinute = textCharsPerMinute <= 0 ? 10_000_000 : textCharsPerMinute;
        estimatedTokensPerMinute = estimatedTokensPerMinute <= 0
                ? 2_500_000 : estimatedTokensPerMinute;
        maxTextCharsPerRequest = maxTextCharsPerRequest <= 0 ? 1_000_000 : maxTextCharsPerRequest;
    }
}
