package com.guardllm.gateway;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

@Component
final class GuardClient {
    private final WebClient webClient;
    private final GuardGatewayProperties properties;

    GuardClient(@Qualifier("guardWebClient") WebClient webClient, GuardGatewayProperties properties) {
        this.webClient = webClient;
        this.properties = properties;
    }

    Mono<GuardDecision> evaluate(String text, String direction, GatewayRequestContext context,
            String bundleId, boolean shadow) {
        Map<String, Object> guardContext = new LinkedHashMap<>();
        guardContext.put("traceId", context.traceId());
        guardContext.put("requestId", context.requestId());
        guardContext.put("tenantId", context.tenantId());
        guardContext.put("applicationId", context.applicationId());
        if (context.sessionId() != null) guardContext.put("sessionId", context.sessionId());
        guardContext.put("direction", direction);
        guardContext.put("absoluteDeadlineEpochMs", context.absoluteDeadlineEpochMs());
        guardContext.put("policyBundleId", bundleId);
        Map<String, Object> request = Map.of(
                "contractVersion", "1.0",
                "context", guardContext,
                "content", Map.of("text", text));
        long remaining = Math.max(1, context.absoluteDeadlineEpochMs() - System.currentTimeMillis());
        return webClient.post().uri(shadow ? "/api/v1/guard/evaluate-shadow" : "/api/v1/guard/evaluate")
                .contentType(MediaType.APPLICATION_JSON)
                .header("X-Guard-Api-Key", properties.guardAppKey())
                .bodyValue(request)
                .retrieve()
                .bodyToMono(GuardDecision.class)
                .timeout(Duration.ofMillis(remaining));
    }
}
