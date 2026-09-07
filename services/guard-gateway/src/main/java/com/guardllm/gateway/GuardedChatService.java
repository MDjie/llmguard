package com.guardllm.gateway;

import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.function.Function;
import org.springframework.http.HttpHeaders;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

@Component
final class GuardedChatService {
    record Approved(JsonNode body, ArrayNode segments, JsonNode decision, String originalAction, JsonNode originalDecision) { }
    record Reply(JsonNode body, List<ServerSentEvent<String>> events, String requestId, String snapshotId, String inputAction, String outputAction, String decisionId) { }
    private static final class Execution {
        final GatewayRuntimeClient.Authorization auth;
        int seq;
        int windowSeq;
        int released;
        boolean sendStarted;
        boolean upstreamFinished;
        boolean completed;
        Execution(GatewayRuntimeClient.Authorization auth) { this.auth = auth; }
    }
    private final GatewayRuntimeClient runtime;
    private final ModelClient model;
    private final ReactiveBulkhead bulkhead;
    private final GatewayRateLimiter quotas;
    private final StructuredContent content;
    private final ObjectMapper json;
    GuardedChatService(GatewayRuntimeClient runtime, ModelClient model, ReactiveBulkhead bulkhead, GatewayRateLimiter quotas, ObjectMapper json) {
        this.runtime = runtime; this.model = model; this.bulkhead = bulkhead; this.quotas = quotas; this.json = json; this.content = new StructuredContent(json);
    }
    Mono<Void> handle(JsonNode request, HttpHeaders headers, Function<Reply, Mono<Void>> writer) {
        return Mono.usingWhen(runtime.authorize(request, headers).map(Execution::new), execution -> {
            var auth = execution.auth;
            JsonNode budgets = auth.snapshot().path("manifest").path("budgets");
            int inputLimit = budgets.path("maxInputChars").asInt(131072);
            JsonNode authorizedRequest = auth.preparedRequest() == null ? request : auth.preparedRequest();
            ArrayNode input = auth.preparedSegments() instanceof ArrayNode prepared ? prepared : content.segments(authorizedRequest, true, inputLimit);
            int length = 0; for (JsonNode segment : input) length += segment.path("text").stringValue().length();
            return quotas.check(auth.legacyContext(), "chat.business", length)
                    .then(inspect(execution, authorizedRequest, input, "INPUT"))
                    .flatMap(approvedInput -> {
                        if (approvedInput.originalAction().equals("SAFE_RESPONSE")) return release(execution, approvedInput, approvedInput.originalAction(), List.of(), request.path("stream").asBoolean(), writer);
                        return event(execution, "UPSTREAM_SEND_INTENT", approvedInput, null)
                                .then(event(execution, "UPSTREAM_SEND_STARTED", null, null))
                                .then(Mono.defer(() -> {
                                    execution.sendStarted = true;
                                    return upstream(execution, approvedInput, request.path("stream").asBoolean(), writer);
                                }));
                    }).timeout(Duration.ofMillis(Math.max(1, auth.deadline() - System.currentTimeMillis())));
        }, execution -> Mono.empty(), (execution, error) -> terminate(execution, error), execution -> terminate(execution, new GatewayFailure("CLIENT_CANCELLED", 499)));
    }
    private Mono<Void> upstream(Execution execution, Approved input, boolean stream, Function<Reply, Mono<Void>> writer) {
        var auth = execution.auth;
        String routeKey = CanonicalJson.encode(json.valueToTree(List.of(auth.context().path("tenantId").stringValue(), auth.context().path("applicationId").stringValue(), auth.context().path("sessionId").asText(auth.id()))));
        int outputLimit = auth.snapshot().path("manifest").path("budgets").path("maxOutputChars").asInt(262144);
        if (!stream) return bulkhead.execute(auth.legacyContext(), "chat.model", () -> model.chatAuthorized(input.body(), routeKey, auth.context(), auth.snapshot().path("manifest")))
                .doOnNext(response -> execution.upstreamFinished = true)
                .flatMap(response -> inspect(execution, response, content.segments(response, false, outputLimit), "OUTPUT_COMPLETE"))
                .flatMap(output -> release(execution, output, input.originalAction(), List.of(), false, writer));
        String mode = auth.snapshot().path("manifest").path("streamMode").asText("");
        if (mode.equals("WINDOW") && writer instanceof GatewayWindowWriter windowWriter && !input.body().has("tools") && input.body().path("n").asInt(1) == 1) return windowUpstream(execution, input, routeKey, outputLimit, windowWriter);
        if (!Set.of("FULL_BUFFER", "WINDOW").contains(mode)) return Mono.error(new GatewayFailure("STREAM_MODE_NOT_IMPLEMENTED", 503));
        var buffer = new BufferedCompletion(json, auth.snapshot().path("manifest").path("budgets").path("maxStreamEvents").asInt(16384), outputLimit);
        long idle = auth.snapshot().path("manifest").path("budgets").path("idleTimeoutMs").asLong(15000);
        return bulkhead.executeFlux(auth.legacyContext(), "chat.model", () -> model.chatStreamAuthorized(input.body(), routeKey, auth.context(), auth.snapshot().path("manifest")))
                .timeout(Duration.ofMillis(idle)).doOnNext(buffer::accept).then(Mono.fromCallable(buffer::complete))
                .doOnNext(response -> execution.upstreamFinished = true)
                .flatMap(response -> inspect(execution, response, content.segments(response, false, outputLimit), "OUTPUT_COMPLETE"))
                .flatMap(output -> release(execution, output, input.originalAction(), buffer.events(), true, writer));
    }
    private Mono<Void> windowUpstream(Execution execution, Approved input, String routeKey, int outputLimit, GatewayWindowWriter writer) {
        var auth = execution.auth;
        JsonNode manifest = auth.snapshot().path("manifest"), policy = manifest.path("windowPolicy");
        if (!manifest.path("windowQualified").asBoolean() || !policy.isObject() || policy.path("qualificationExpiresAt").asLong() <= System.currentTimeMillis()) return Mono.error(new GatewayFailure("STREAM_WINDOW_NOT_QUALIFIED", 503));
        var buffer = new BufferedCompletion(json, manifest.path("budgets").path("maxStreamEvents").asInt(16384), outputLimit);
        return bulkhead.executeFlux(auth.legacyContext(), "chat.model", () -> model.chatStreamAuthorized(input.body(), routeKey, auth.context(), manifest))
                .timeout(Duration.ofMillis(manifest.path("budgets").path("idleTimeoutMs").asLong(15000)))
                .concatMap(event -> { buffer.accept(event); return drainWindows(execution, input, buffer, writer, false); }, 1)
                .then(Mono.defer(() -> { buffer.complete(); execution.upstreamFinished = true; return drainWindows(execution, input, buffer, writer, true); }));
    }
    private Mono<Void> drainWindows(Execution execution, Approved input, BufferedCompletion buffer, GatewayWindowWriter writer, boolean complete) {
        return Mono.defer(() -> {
            String text = buffer.windowText(); JsonNode policy = execution.auth.snapshot().path("manifest").path("windowPolicy");
            var range = WindowRanges.next(text, execution.released, policy.path("contextChars").asInt(), policy.path("chunkChars").asInt(), policy.path("holdbackChars").asInt(), complete);
            if (range == null) return Mono.empty();
            ObjectNode window = json.createObjectNode().put("contextStart", range.contextStart()).put("releaseStart", range.releaseStart()).put("releaseEnd", range.releaseEnd()).put("final", range.last());
            JsonNode inspected = textResponse(execution.auth.id(), text.substring(range.contextStart(), range.inspectedEnd()));
            ArrayNode segments = content.segments(inspected, false, 262144);
            return runtime.evaluate(execution.auth, "OUTPUT_CHUNK", segments, execution.windowSeq, window).flatMap(decision -> {
                String action = decision.path("action").asText("");
                if (!Set.of("ALLOW", "WARN").contains(action)) return Mono.error(new GatewayFailure(action.equals("REQUIRE_REVIEW") ? "REVIEW_REQUIRED" : action.equals("BLOCK") ? "GUARD_OUTPUT_BLOCKED" : "WINDOW_TRANSFORM_REQUIRES_FULL_BUFFER", 403));
                JsonNode released = textResponse(execution.auth.id(), text.substring(range.releaseStart(), range.releaseEnd()));
                ArrayNode releasedSegments = content.segments(released, false, 262144);
                ObjectNode chunk = json.createObjectNode().put("id", execution.auth.id()).put("object", "chat.completion.chunk");
                ObjectNode choice = chunk.putArray("choices").addObject().put("index", 0);
                choice.putObject("delta").put("role", "assistant").put("content", text.substring(range.releaseStart(), range.releaseEnd()));
                if (range.last()) choice.set("finish_reason", buffer.complete().path("choices").get(0).path("finish_reason")); else choice.putNull("finish_reason");
                var events = new java.util.ArrayList<ServerSentEvent<String>>(); events.add(ServerSentEvent.builder(json.writeValueAsString(chunk)).build());
                if (range.last()) events.add(ServerSentEvent.builder("[DONE]").build());
                Reply reply = new Reply(released, events, execution.auth.id(), execution.auth.snapshotId(), input.originalAction(), action, decision.path("decisionId").stringValue());
                return windowEvent(execution, "RELEASE_INTENT", decision, releasedSegments, range)
                    .then(Mono.defer(() -> writer.writeWindow(reply)))
                    .then(windowEvent(execution, "WRITE_ACCEPTED", decision, releasedSegments, range))
                    .then(Mono.defer(() -> {
                        execution.released = range.releaseEnd(); execution.windowSeq++;
                        if (range.last()) return event(execution, "COMPLETED", null, null).doOnSuccess(ignored -> execution.completed = true);
                        return drainWindows(execution, input, buffer, writer, complete);
                    }));
            });
        });
    }
    private JsonNode textResponse(String id, String text) {
        ObjectNode body = json.createObjectNode().put("id", id).put("object", "chat.completion");
        body.putArray("choices").addObject().put("index", 0).putObject("message").put("role", "assistant").put("content", text);
        return body;
    }
    private Mono<Void> windowEvent(Execution execution, String kind, JsonNode decision, ArrayNode segments, WindowRanges.Range range) {
        return Mono.defer(() -> runtime.event(execution.auth, execution.seq + 1, kind, decision, decision, segments, null, range.releaseStart(), range.releaseEnd()).doOnSuccess(ignored -> execution.seq++));
    }
    private Mono<Approved> inspect(Execution execution, JsonNode body, ArrayNode segments, String stage) {
        return runtime.evaluate(execution.auth, stage, segments).flatMap(decision -> {
            String action = decision.path("action").asText("");
            return switch (action) {
                case "ALLOW", "WARN" -> Mono.just(new Approved(body, segments, decision, action, decision));
                case "BLOCK" -> Mono.error(new GatewayFailure(stage.equals("INPUT") ? "GUARD_INPUT_BLOCKED" : "GUARD_OUTPUT_BLOCKED", 403));
                case "REQUIRE_REVIEW" -> Mono.error(new GatewayFailure("REVIEW_REQUIRED", 409));
                case "MASK", "REWRITE", "SAFE_RESPONSE" -> {
                    boolean safe = action.equals("SAFE_RESPONSE");
                    JsonNode transformed = safe ? safeResponse(execution.auth.id(), StructuredContent.requiredText(decision, "safeResponse")) : content.patch(body, segments, decision.path("transformPatches"));
                    String recheck = !safe && stage.equals("INPUT") ? "INPUT_RECHECK" : "OUTPUT_RECHECK";
                    int limit = execution.auth.snapshot().path("manifest").path("budgets").path(recheck.equals("INPUT_RECHECK") ? "maxInputChars" : "maxOutputChars").asInt();
                    ArrayNode changed = content.segments(transformed, recheck.equals("INPUT_RECHECK"), limit);
                    if (recheck.equals("INPUT_RECHECK")) content.inheritSources(changed, segments);
                    yield runtime.evaluate(execution.auth, recheck, changed).flatMap(checked -> {
                        if (!Set.of("ALLOW", "WARN").contains(checked.path("action").asText(""))) return Mono.error(new GatewayFailure("TRANSFORM_RECHECK_FAILED", 403));
                        return Mono.just(new Approved(transformed, changed, checked, action, decision));
                    });
                }
                default -> Mono.error(new GatewayFailure("DECISION_ACTION_UNKNOWN", 503));
            };
        });
    }
    private JsonNode safeResponse(String id, String text) {
        ObjectNode body = json.createObjectNode().put("id", id).put("object", "chat.completion");
        body.putArray("choices").addObject().put("index", 0).put("finish_reason", "content_filter").putObject("message").put("role", "assistant").put("content", text);
        return body;
    }
    private Mono<Void> release(Execution execution, Approved output, String inputAction, List<ServerSentEvent<String>> original, boolean stream, Function<Reply, Mono<Void>> writer) {
        List<ServerSentEvent<String>> events = stream ? (Set.of("ALLOW", "WARN").contains(output.originalAction()) && !original.isEmpty() ? original : BufferedCompletion.replacement(json, output.body())) : List.of();
        Reply reply = new Reply(output.body(), events, execution.auth.id(), execution.auth.snapshotId(), inputAction, output.originalAction(), output.decision().path("decisionId").stringValue());
        return event(execution, "RELEASE_INTENT", output, null)
                .then(Mono.defer(() -> writer.apply(reply)))
                // writeWith/send completion means the server accepted the write; it is not a delivery receipt.
                .then(event(execution, "WRITE_ACCEPTED", output, null))
                .then(event(execution, "COMPLETED", null, null)).doOnSuccess(ignored -> execution.completed = true);
    }
    private Mono<Void> event(Execution execution, String kind, Approved approved, String reason) {
        return Mono.defer(() -> runtime.event(execution.auth, execution.seq + 1, kind, approved == null ? null : approved.decision(), approved == null ? null : approved.originalDecision(), approved == null ? null : approved.segments(), reason).doOnSuccess(ignored -> execution.seq++));
    }
    private Mono<Void> terminate(Execution execution, Throwable error) {
        if (execution.completed) return Mono.empty();
        String reason = execution.sendStarted && !execution.upstreamFinished ? "UPSTREAM_OUTCOME_UNKNOWN" : error instanceof GatewayFailure failure ? failure.code() : "GATEWAY_EXECUTION_FAILED";
        return event(execution, "TERMINATED", null, reason).onErrorResume(ignored -> {
            org.slf4j.LoggerFactory.getLogger(GuardedChatService.class).error("GATEWAY_TERMINATION_RECONCILIATION_REQUIRED requestId={}", execution.auth.id());
            return Mono.empty();
        });
    }
}
