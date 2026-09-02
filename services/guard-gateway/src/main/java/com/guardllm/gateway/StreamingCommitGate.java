package com.guardllm.gateway;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Component
final class StreamingCommitGate {
    private static final int MAX_WINDOW_CHARS = 8_192;
    private final ObjectMapper objectMapper;

    StreamingCommitGate(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    Flux<ServerSentEvent<String>> gate(
            Flux<ServerSentEvent<String>> upstream,
            Function<String, Mono<GuardDecision>> evaluator) {
        var window = new StringBuilder();
        return upstream.concatMap(event -> {
            String data = event.data();
            if (data == null || "[DONE]".equals(data.trim())) return Mono.just(event);
            String text = extractDelta(data);
            if (text.isEmpty()) return Mono.just(event);
            appendBounded(window, text);
            return evaluator.apply(window.toString()).flatMap(decision ->
                    decision.blocks()
                            ? Mono.error(new OutputBlockedException(decision))
                            : Mono.just(event));
        }).onErrorResume(OutputBlockedException.class, error -> blockedStream(error.decision));
    }

    Flux<ServerSentEvent<String>> blockedStream(GuardDecision decision) {
        String body;
        try {
            body = objectMapper.writeValueAsString(Map.of(
                    "id", decision.decisionId(),
                    "object", "chat.completion.chunk",
                    "choices", List.of(Map.of(
                            "index", 0,
                            "delta", Map.of(
                                    "role", "assistant",
                                    "content", "The response was blocked by the configured safety policy."),
                            "finish_reason", "content_filter"))));
        } catch (Exception error) {
            return Flux.error(new IllegalStateException("Unable to create safe streaming response", error));
        }
        return Flux.just(
                ServerSentEvent.<String>builder().event("message").data(body).build(),
                ServerSentEvent.<String>builder().data("[DONE]").build());
    }

    private String extractDelta(String data) {
        try {
            JsonNode root = objectMapper.readTree(data);
            StringBuilder text = new StringBuilder();
            JsonNode choices = root.path("choices");
            if (!choices.isArray()) return "";
            for (JsonNode choice : choices) {
                appendContent(text, choice.path("delta").path("content"));
                appendContent(text, choice.path("message").path("content"));
                appendContent(text, choice.path("text"));
            }
            return text.toString();
        } catch (Exception error) {
            throw new IllegalArgumentException("Upstream returned malformed SSE JSON", error);
        }
    }

    private static void appendContent(StringBuilder target, JsonNode content) {
        if (content.isString()) {
            target.append(content.stringValue());
        } else if (content.isArray()) {
            for (JsonNode item : content) {
                JsonNode text = item.path("text");
                if (text.isString()) target.append(text.stringValue());
            }
        }
    }

    private static void appendBounded(StringBuilder window, String value) {
        window.append(value);
        if (window.length() > MAX_WINDOW_CHARS) {
            window.delete(0, window.length() - MAX_WINDOW_CHARS);
        }
    }

    private static final class OutputBlockedException extends RuntimeException {
        private final GuardDecision decision;

        private OutputBlockedException(GuardDecision decision) {
            super("Streaming output blocked");
            this.decision = decision;
        }
    }
}
