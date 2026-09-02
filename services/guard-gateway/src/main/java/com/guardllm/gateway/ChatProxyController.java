package com.guardllm.gateway;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import java.time.Duration;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Flux;

@RestController
public final class ChatProxyController {
    private final GuardClient guardClient;
    private final ModelClient modelClient;
    private final PolicyRouteSelector routeSelector;
    private final ShadowComparator shadowComparator;
    private final ReactiveBulkhead modelBulkhead;
    private final GatewayRateLimiter rateLimiter;
    private final StreamingCommitGate streamingCommitGate;
    private final ObjectMapper objectMapper;

    public ChatProxyController(GuardClient guardClient, ModelClient modelClient,
            PolicyRouteSelector routeSelector, ShadowComparator shadowComparator,
            StreamingCommitGate streamingCommitGate, ReactiveBulkhead modelBulkhead,
            GatewayRateLimiter rateLimiter, ObjectMapper objectMapper) {
        this.guardClient = guardClient;
        this.modelClient = modelClient;
        this.routeSelector = routeSelector;
        this.shadowComparator = shadowComparator;
        this.modelBulkhead = modelBulkhead;
        this.rateLimiter = rateLimiter;
        this.streamingCommitGate = streamingCommitGate;
        this.objectMapper = objectMapper;
    }

    @PostMapping(path = "/v1/chat/completions/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Mono<ResponseEntity<Flux<ServerSentEvent<String>>>> chatStream(
            @RequestBody JsonNode request,
            ServerWebExchange exchange) {
        GatewayRequestContext context = exchange.getAttribute(GatewayContextWebFilter.CONTEXT_ATTRIBUTE);
        if (context == null) return Mono.error(new ResponseStatusException(HttpStatus.UNAUTHORIZED));
        String inputText = OpenAiContentExtractor.inputText(request);
        String bundleId = routeSelector.select(context.sessionId() == null
                ? context.requestId() : context.sessionId());
        Duration remaining = remaining(context);
        return rateLimiter.check(context, "chat.stream", inputText.length())
                .then(guardClient.evaluate(inputText, "INPUT", context, bundleId, false))
                .doOnNext(primary -> shadowComparator.compare(inputText, "INPUT", context, primary).subscribe())
                .map(inputDecision -> {
                    if (inputDecision.blocks()) {
                        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                                .contentType(MediaType.TEXT_EVENT_STREAM)
                                .body(streamingCommitGate.blockedStream(inputDecision));
                    }
                    Flux<ServerSentEvent<String>> upstream = modelBulkhead.executeFlux(
                            context,
                            "chat.stream",
                            () -> modelClient.chatStream(request, context.sessionId() == null
                                    ? context.requestId() : context.sessionId()));
                    Flux<ServerSentEvent<String>> guarded = streamingCommitGate.gate(upstream, text ->
                            guardClient.evaluate(text, "OUTPUT_CHUNK", context, bundleId, false)
                                    .doOnNext(primary -> shadowComparator.compare(
                                            text, "OUTPUT_CHUNK", context, primary).subscribe()));
                    return ResponseEntity.ok()
                            .contentType(MediaType.TEXT_EVENT_STREAM)
                            .body(guarded);
                })
                .timeout(remaining);
    }

    @PostMapping(path = "/v1/chat/completions")
    public Mono<ResponseEntity<JsonNode>> chat(@RequestBody JsonNode request, ServerWebExchange exchange) {
        GatewayRequestContext context = exchange.getAttribute(GatewayContextWebFilter.CONTEXT_ATTRIBUTE);
        if (context == null) return Mono.error(new ResponseStatusException(HttpStatus.UNAUTHORIZED));
        if (request.path("stream").asBoolean(false)) {
            return Mono.error(new ResponseStatusException(
                    HttpStatus.UNPROCESSABLE_CONTENT, "Use the streaming commit-gate endpoint"));
        }
        String inputText = OpenAiContentExtractor.inputText(request);
        String bundleId = routeSelector.select(context.requestId());
        Duration remaining = remaining(context);
        return rateLimiter.check(context, "chat.complete", inputText.length())
                .then(guardClient.evaluate(inputText, "INPUT", context, bundleId, false))
                .doOnNext(primary -> shadowComparator.compare(inputText, "INPUT", context, primary).subscribe())
                .flatMap(inputDecision -> {
                    if (inputDecision.blocks()) return Mono.just(blocked(inputDecision));
                    return modelBulkhead.execute(context, "chat.complete", () -> modelClient.chat(
                                    request, context.sessionId() == null
                                            ? context.requestId() : context.sessionId()))
                            .flatMap(modelResponse -> {
                                String outputText = OpenAiContentExtractor.outputText(modelResponse);
                                return guardClient.evaluate(outputText, "OUTPUT_COMPLETE", context, bundleId, false)
                                        .doOnNext(primary -> shadowComparator.compare(
                                                outputText, "OUTPUT_COMPLETE", context, primary).subscribe())
                                        .map(outputDecision -> outputDecision.blocks()
                                                ? safeResponse(outputDecision) : ResponseEntity.ok(modelResponse));
                            });
                })
                .timeout(remaining);
    }

    private Duration remaining(GatewayRequestContext context) {
        return Duration.ofMillis(Math.max(1, context.absoluteDeadlineEpochMs() - System.currentTimeMillis()));
    }

    private ResponseEntity<JsonNode> blocked(GuardDecision decision) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(objectMapper.valueToTree(java.util.Map.of(
                "error", java.util.Map.of(
                        "code", "GUARD_INPUT_BLOCKED",
                        "decisionId", decision.decisionId(),
                        "riskLevel", decision.riskLevel()))));
    }

    private ResponseEntity<JsonNode> safeResponse(GuardDecision decision) {
        JsonNode body = objectMapper.valueToTree(java.util.Map.of(
                "id", decision.decisionId(),
                "object", "chat.completion",
                "choices", java.util.List.of(java.util.Map.of(
                        "index", 0,
                        "finish_reason", "content_filter",
                        "message", java.util.Map.of(
                                "role", "assistant",
                                "content", "The response was blocked by the configured safety policy.")))));
        return ResponseEntity.ok(body);
    }

}
