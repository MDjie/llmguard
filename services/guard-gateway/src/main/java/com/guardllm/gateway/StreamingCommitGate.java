package com.guardllm.gateway;

import java.util.ArrayList;
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
    private final ObjectMapper objectMapper;
    private final StreamingCommitGateProperties properties;

    StreamingCommitGate(ObjectMapper objectMapper, StreamingCommitGateProperties properties) {
        this.objectMapper = objectMapper;
        this.properties = properties;
    }

    Flux<ServerSentEvent<String>> gate(
            Flux<ServerSentEvent<String>> upstream,
            Function<String, Mono<GuardDecision>> evaluator) {
        return Flux.defer(() -> {
            var inspectionHistory = new StringBuilder();
            var expander = new SignalExpander(properties.maximumUncommittedChars());
            return upstream.publish(shared -> {
                Flux<GateSignal> events = shared.map(this::toEventSignal);
                Flux<GateSignal> flushTicks = Flux.interval(properties.maximumWait())
                        .map(ignored -> (GateSignal) FlushSignal.INSTANCE)
                        .onBackpressureDrop()
                        .takeUntilOther(shared.ignoreElements());
                return Flux.merge(events, flushTicks)
                        .concatMap(expander::expand)
                        .concatWithValues(FlushSignal.INSTANCE)
                        .bufferUntil(FlushSignal.class::isInstance)
                        .concatMap(batch -> inspectBatch(batch, inspectionHistory, evaluator));
            });
        })
                .onErrorResume(OutputBlockedException.class, error -> blockedStream(error.decision))
                .onErrorResume(StreamCapacityExceededException.class,
                        error -> safeTermination("stream_capacity_exceeded"))
                .onErrorResume(GuardEvaluationException.class,
                        error -> safeTermination("guard_evaluation_failed"));
    }

    Flux<ServerSentEvent<String>> blockedStream(GuardDecision decision) {
        return safeTermination(decision.decisionId());
    }

    private Flux<ServerSentEvent<String>> inspectBatch(
            List<GateSignal> batch,
            StringBuilder inspectionHistory,
            Function<String, Mono<GuardDecision>> evaluator) {
        List<EventSignal> pending = batch.stream()
                .filter(EventSignal.class::isInstance)
                .map(EventSignal.class::cast)
                .toList();
        if (pending.isEmpty()) return Flux.empty();
        String text = pending.stream().map(EventSignal::text).reduce("", String::concat);
        if (text.isEmpty()) {
            return Flux.fromIterable(pending).map(EventSignal::event);
        }
        String candidate = boundedHistory(inspectionHistory + text);
        Mono<GuardDecision> evaluation;
        try {
            evaluation = evaluator.apply(candidate);
        } catch (RuntimeException error) {
            return Flux.error(new GuardEvaluationException(error));
        }
        return evaluation
                .switchIfEmpty(Mono.error(new GuardEvaluationException(
                        new IllegalStateException("Guard evaluator returned no decision"))))
                .onErrorMap(error -> error instanceof GuardEvaluationException
                        ? error
                        : new GuardEvaluationException(error))
                .flatMapMany(decision -> {
                    if (decision.blocks()) return Flux.error(new OutputBlockedException(decision));
                    inspectionHistory.setLength(0);
                    inspectionHistory.append(candidate);
                    return Flux.fromIterable(pending).map(EventSignal::event);
                });
    }

    private EventSignal toEventSignal(ServerSentEvent<String> event) {
        String data = event.data();
        boolean done = data != null && "[DONE]".equals(data.trim());
        String text = data == null || done ? "" : extractDelta(data);
        return new EventSignal(event, text, done);
    }

    private Flux<ServerSentEvent<String>> safeTermination(String decisionId) {
        String body;
        try {
            body = objectMapper.writeValueAsString(Map.of(
                    "id", decisionId,
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

    private String boundedHistory(String value) {
        int maximum = properties.maximumHistoryChars();
        return value.length() <= maximum ? value : value.substring(value.length() - maximum);
    }

    private static boolean endsSemanticBoundary(String text) {
        String stripped = text.stripTrailing();
        if (stripped.isEmpty()) return false;
        return ".!?;。！？；\n".indexOf(stripped.charAt(stripped.length() - 1)) >= 0;
    }

    private sealed interface GateSignal permits EventSignal, FlushSignal {}

    private record EventSignal(
            ServerSentEvent<String> event,
            String text,
            boolean done) implements GateSignal {}

    private enum FlushSignal implements GateSignal {
        INSTANCE
    }

    private static final class SignalExpander {
        private final int maximumUncommittedChars;
        private int pendingChars;
        private boolean pending;

        private SignalExpander(int maximumUncommittedChars) {
            this.maximumUncommittedChars = maximumUncommittedChars;
        }

        private Flux<GateSignal> expand(GateSignal signal) {
            if (signal instanceof FlushSignal) {
                if (!pending) return Flux.empty();
                reset();
                return Flux.just(FlushSignal.INSTANCE);
            }
            EventSignal event = (EventSignal) signal;
            if (event.text().length() > maximumUncommittedChars) {
                return Flux.error(new StreamCapacityExceededException());
            }
            List<GateSignal> expanded = new ArrayList<>(3);
            if (pending && pendingChars + event.text().length() > maximumUncommittedChars) {
                expanded.add(FlushSignal.INSTANCE);
                reset();
            }
            expanded.add(event);
            pending = true;
            pendingChars += event.text().length();
            if (event.done() || pendingChars >= maximumUncommittedChars
                    || endsSemanticBoundary(event.text())) {
                expanded.add(FlushSignal.INSTANCE);
                reset();
            }
            return Flux.fromIterable(expanded);
        }

        private void reset() {
            pending = false;
            pendingChars = 0;
        }
    }

    private static final class OutputBlockedException extends RuntimeException {
        private final GuardDecision decision;

        private OutputBlockedException(GuardDecision decision) {
            super("Streaming output blocked");
            this.decision = decision;
        }
    }

    private static final class StreamCapacityExceededException extends RuntimeException {
        private StreamCapacityExceededException() {
            super("Streaming uncommitted buffer capacity exceeded");
        }
    }

    private static final class GuardEvaluationException extends RuntimeException {
        private GuardEvaluationException(Throwable cause) {
            super("Streaming guard evaluation failed", cause);
        }
    }
}
