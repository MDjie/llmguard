package com.guardllm.gateway;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.socket.CloseStatus;
import org.springframework.web.reactive.socket.WebSocketHandler;
import org.springframework.web.reactive.socket.WebSocketMessage;
import org.springframework.web.reactive.socket.WebSocketSession;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@Component
final class ChatWebSocketHandler implements WebSocketHandler {
    private final GatewayContextAuthenticator authenticator;
    private final GuardClient guardClient;
    private final ModelClient modelClient;
    private final PolicyRouteSelector routeSelector;
    private final ShadowComparator shadowComparator;
    private final ReactiveBulkhead modelBulkhead;
    private final GatewayRateLimiter rateLimiter;
    private final StreamingCommitGate streamingCommitGate;
    private final ObjectMapper objectMapper;

    ChatWebSocketHandler(
            GatewayContextAuthenticator authenticator,
            GuardClient guardClient,
            ModelClient modelClient,
            PolicyRouteSelector routeSelector,
            ShadowComparator shadowComparator,
            ReactiveBulkhead modelBulkhead,
            GatewayRateLimiter rateLimiter,
            StreamingCommitGate streamingCommitGate,
            ObjectMapper objectMapper) {
        this.authenticator = authenticator;
        this.guardClient = guardClient;
        this.modelClient = modelClient;
        this.routeSelector = routeSelector;
        this.shadowComparator = shadowComparator;
        this.modelBulkhead = modelBulkhead;
        this.rateLimiter = rateLimiter;
        this.streamingCommitGate = streamingCommitGate;
        this.objectMapper = objectMapper;
    }

    @Override
    public Mono<Void> handle(WebSocketSession session) {
        final GatewayRequestContext context;
        try {
            context = authenticator.authenticate(session.getHandshakeInfo().getHeaders());
        } catch (RuntimeException error) {
            return session.close(CloseStatus.POLICY_VIOLATION);
        }

        Flux<WebSocketMessage> output = session.receive()
                .concatMap(message -> {
                    if (message.getType() != WebSocketMessage.Type.TEXT) {
                        return Flux.just(session.textMessage(problem("GATEWAY_WS_TEXT_REQUIRED")));
                    }
                    return exchange(message.getPayloadAsText(), context).map(session::textMessage);
                })
                .onErrorResume(error -> Flux.just(session.textMessage(problem(errorCode(error)))));
        return session.send(output);
    }

    Flux<String> exchange(String payload, GatewayRequestContext context) {
        final ObjectNode request;
        try {
            JsonNode parsed = objectMapper.readTree(payload);
            if (!parsed.isObject()) return Flux.just(problem("GATEWAY_REQUEST_INVALID"));
            request = (ObjectNode) parsed.deepCopy();
            request.put("stream", true);
        } catch (Exception error) {
            return Flux.just(problem("GATEWAY_REQUEST_INVALID"));
        }

        String inputText = OpenAiContentExtractor.inputText(request);
        String routeKey = context.sessionId() == null ? context.requestId() : context.sessionId();
        String bundleId = routeSelector.select(routeKey);
        Duration remaining = Duration.ofMillis(
                Math.max(1, context.absoluteDeadlineEpochMs() - System.currentTimeMillis()));
        return rateLimiter.check(context, "chat.websocket", inputText.length())
                .then(guardClient.evaluate(inputText, "INPUT", context, bundleId, false))
                .doOnNext(primary -> shadowComparator.compare(inputText, "INPUT", context, primary).subscribe())
                .flatMapMany(inputDecision -> {
                    if (inputDecision.blocks()) {
                        return Flux.just(blocked(inputDecision), "[DONE]");
                    }
                    Flux<ServerSentEvent<String>> upstream = modelBulkhead.executeFlux(
                            context,
                            "chat.websocket",
                            () -> modelClient.chatStream(request, routeKey));
                    return streamingCommitGate.gate(upstream, text ->
                                    guardClient.evaluate(text, "OUTPUT_CHUNK", context, bundleId, false)
                                            .doOnNext(primary -> shadowComparator.compare(
                                                    text, "OUTPUT_CHUNK", context, primary).subscribe()))
                            .map(event -> event.data() == null ? "" : event.data())
                            .filter(value -> !value.isEmpty());
                })
                .timeout(remaining);
    }

    private String blocked(GuardDecision decision) {
        return json(Map.of(
                "type", "guard.blocked",
                "error", Map.of(
                        "code", "GUARD_INPUT_BLOCKED",
                        "decisionId", decision.decisionId(),
                        "riskLevel", decision.riskLevel())));
    }

    private String problem(String code) {
        return json(Map.of(
                "type", "guard.error",
                "error", Map.of("code", code)));
    }

    private String json(Map<String, ?> value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception error) {
            return "{\"type\":\"guard.error\",\"error\":{\"code\":\"GATEWAY_SERIALIZATION_FAILED\"}}";
        }
    }

    private static String errorCode(Throwable error) {
        if (error instanceof ReactiveBulkhead.BulkheadFullException) return "GATEWAY_BULKHEAD_FULL";
        if (error instanceof ReactiveBulkhead.DistributedBackendUnavailableException) {
            return "GATEWAY_CONCURRENCY_BACKEND_UNAVAILABLE";
        }
        if (error instanceof GatewayRateLimiter.QuotaExceededException) return "GATEWAY_QUOTA_EXCEEDED";
        if (error instanceof GatewayRateLimiter.QuotaBackendUnavailableException) {
            return "GATEWAY_QUOTA_BACKEND_UNAVAILABLE";
        }
        if (error instanceof GatewayRateLimiter.RequestCapacityExceededException) {
            return "GATEWAY_REQUEST_CAPACITY_EXCEEDED";
        }
        if (error instanceof java.util.concurrent.TimeoutException) return "GATEWAY_DEADLINE_EXCEEDED";
        return "GATEWAY_UPSTREAM_FAILED";
    }
}
