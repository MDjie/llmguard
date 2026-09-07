package com.guardllm.gateway;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;
import org.springframework.http.codec.ServerSentEvent;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/** An entire SSE completion is private until every content-bearing field is inspected. */
final class BufferedCompletion {
    private final ObjectMapper json;
    private final int maxEvents;
    private final int maxChars;
    private final List<ServerSentEvent<String>> events = new ArrayList<>();
    private final TreeMap<Integer, ObjectNode> choices = new TreeMap<>();
    private final ObjectNode response;
    private int chars;
    private boolean done;
    BufferedCompletion(ObjectMapper json, int maxEvents, int maxChars) {
        this.json = json; this.maxEvents = maxEvents; this.maxChars = maxChars;
        this.response = json.createObjectNode().put("object", "chat.completion");
    }
    void accept(ServerSentEvent<String> event) {
        if (done) throw new GatewayFailure("SSE_EVENT_AFTER_DONE", 502);
        if (event.id() != null || event.event() != null || event.comment() != null || event.retry() != null) throw new GatewayFailure("SSE_METADATA_UNSUPPORTED", 422);
        String data = event.data();
        if (data == null || data.isBlank()) return;
        chars = Math.addExact(chars, data.length());
        if (events.size() >= maxEvents || chars > maxChars * 8) throw new GatewayFailure("STREAM_BUFFER_LIMIT", 413);
        events.add(event);
        if (data.equals("[DONE]")) { done = true; return; }
        JsonNode chunk;
        try { chunk = json.readTree(data); } catch (RuntimeException error) { throw new GatewayFailure("SSE_JSON_INVALID", 502); }
        CompletionFields.validate(chunk, false);
        for (String field : new String[]{"id", "created", "model", "system_fingerprint", "service_tier"}) if (chunk.has(field)) {
            if (response.has(field) && !response.path(field).equals(chunk.path(field))) throw new GatewayFailure("SSE_METADATA_CHANGED", 502);
            response.set(field, chunk.path(field));
        }
        if (chunk.hasNonNull("usage")) response.set("usage", chunk.path("usage"));
        JsonNode incoming = chunk.path("choices");
        if (!incoming.isArray() || incoming.size() > 16) throw new GatewayFailure("SSE_CHOICES_INVALID", 502);
        for (JsonNode item : incoming) {
            StructuredContent.allowed(item, Set.of("index", "delta", "finish_reason", "logprobs"));
            int index = item.path("index").asInt(-1);
            if (index < 0 || index >= 16 || item.hasNonNull("logprobs")) throw new GatewayFailure("SSE_CHOICE_UNSUPPORTED", 422);
            ObjectNode choice = choices.computeIfAbsent(index, ignored -> {
                ObjectNode value = json.createObjectNode().put("index", index); value.putObject("message").put("role", "assistant"); return value;
            });
            if (choice.hasNonNull("finish_reason")) throw new GatewayFailure("SSE_CONTENT_AFTER_FINISH", 502);
            JsonNode delta = item.path("delta");
            StructuredContent.allowed(delta, Set.of("role", "content", "refusal", "tool_calls"));
            ObjectNode message = (ObjectNode) choice.path("message");
            if (delta.has("role") && !delta.path("role").asText("").equals("assistant")) throw new GatewayFailure("SSE_ROLE_INVALID", 502);
            for (String field : new String[]{"content", "refusal"}) if (delta.hasNonNull(field)) append(message, field, StructuredContent.requiredText(delta, field));
            if (delta.has("tool_calls")) {
                JsonNode calls = delta.path("tool_calls");
                if (!calls.isArray() || calls.size() > 64) throw new GatewayFailure("SSE_TOOL_INVALID", 502);
                var target = message.has("tool_calls") ? (tools.jackson.databind.node.ArrayNode) message.path("tool_calls") : message.putArray("tool_calls");
                for (JsonNode call : calls) {
                    StructuredContent.allowed(call, Set.of("index", "id", "type", "function"));
                    int toolIndex = call.path("index").asInt(-1);
                    if (toolIndex < 0 || toolIndex > target.size() || toolIndex >= 64) throw new GatewayFailure("SSE_TOOL_INDEX_INVALID", 502);
                    if (toolIndex == target.size()) target.addObject().putObject("function");
                    ObjectNode tool = (ObjectNode) target.get(toolIndex);
                    for (String field : new String[]{"id", "type"}) if (call.has(field)) {
                        if (tool.has(field) && !tool.path(field).equals(call.path(field))) throw new GatewayFailure("SSE_TOOL_ID_CHANGED", 502);
                        tool.set(field, call.path(field));
                    }
                    if (call.has("function")) {
                        StructuredContent.allowed(call.path("function"), Set.of("name", "arguments"));
                        for (String field : new String[]{"name", "arguments"}) if (call.path("function").has(field)) append((ObjectNode) tool.path("function"), field, StructuredContent.requiredText(call.path("function"), field));
                    }
                }
            }
            if (item.hasNonNull("finish_reason")) {
                String finish = item.path("finish_reason").asText("");
                if (!Set.of("stop", "length", "tool_calls", "content_filter").contains(finish)) throw new GatewayFailure("SSE_FINISH_INVALID", 502);
                choice.put("finish_reason", finish);
            }
        }
    }
    private void append(ObjectNode target, String field, String fragment) {
        String text = target.path(field).asText("") + fragment;
        if (text.length() > maxChars) throw new GatewayFailure("STREAM_CONTENT_LIMIT", 413);
        target.put(field, text);
    }
    JsonNode complete() {
        if (!done || choices.isEmpty() || choices.values().stream().anyMatch(choice -> !choice.hasNonNull("finish_reason"))) throw new GatewayFailure("SSE_TRUNCATED", 502);
        var output = response.putArray("choices"); choices.values().forEach(output::add);
        return response;
    }
    String windowText() {
        if (choices.isEmpty()) return "";
        if (choices.size() != 1 || !choices.containsKey(0)) throw new GatewayFailure("WINDOW_SINGLE_CHOICE_REQUIRED", 422);
        JsonNode message = choices.get(0).path("message");
        if (message.has("tool_calls") || message.hasNonNull("refusal")) throw new GatewayFailure("WINDOW_TEXT_ONLY_REQUIRED", 422);
        return message.path("content").asText("");
    }
    List<ServerSentEvent<String>> events() { return List.copyOf(events); }
    static List<ServerSentEvent<String>> replacement(ObjectMapper json, JsonNode response) {
        ObjectNode chunk = ((ObjectNode) response).deepCopy(); chunk.put("object", "chat.completion.chunk");
        for (JsonNode value : chunk.path("choices")) {
            ObjectNode choice = (ObjectNode) value;
            choice.set("delta", choice.remove("message"));
        }
        return List.of(ServerSentEvent.builder(json.writeValueAsString(chunk)).build(), ServerSentEvent.builder("[DONE]").build());
    }
}
