package com.guardllm.gateway;

import java.util.Set;
import tools.jackson.databind.JsonNode;

/** Keep metadata non-content and require every free-text generation field to be inspected. */
final class CompletionFields {
    private CompletionFields() { }
    static void validate(JsonNode root, boolean input) {
        StructuredContent.allowed(root, input ? Set.of("model","messages","tools","tool_choice","response_format","stop","stream","stream_options","temperature","top_p","presence_penalty","frequency_penalty","max_tokens","max_completion_tokens","n","seed","logit_bias","parallel_tool_calls","reasoning_effort","service_tier","user","safety_identifier","prompt_cache_key","store")
                : Set.of("id","object","created","model","choices","usage","system_fingerprint","service_tier"));
        if (!input) {
            for (String field : new String[]{"id","model","system_fingerprint","service_tier"}) identifier(root.path(field));
            if (root.has("object") && !Set.of("chat.completion","chat.completion.chunk").contains(root.path("object").asText(""))) fail("COMPLETION_OBJECT_INVALID");
            integer(root.path("created"), 0, 9007199254740991L);
            if (root.hasNonNull("usage")) numericTree(root.path("usage"), 0);
            return;
        }
        for (String field : new String[]{"model","user","safety_identifier","prompt_cache_key"}) identifier(root.path(field));
        for (String field : new String[]{"temperature","top_p","presence_penalty","frequency_penalty"}) if (root.has(field) && (!root.path(field).isNumber() || !Double.isFinite(root.path(field).doubleValue()))) fail("PROTOCOL_NUMBER_INVALID");
        for (String field : new String[]{"max_tokens","max_completion_tokens"}) integer(root.path(field), 1, 9007199254740991L);
        integer(root.path("n"), 1, 16); integer(root.path("seed"), -9007199254740991L, 9007199254740991L);
        for (String field : new String[]{"stream","parallel_tool_calls","store"}) if (root.has(field) && !root.path(field).isBoolean()) fail("PROTOCOL_BOOLEAN_INVALID");
        if (root.path("store").asBoolean()) throw new GatewayFailure("UPSTREAM_RETENTION_NOT_AUTHORIZED", 403);
        if (root.has("reasoning_effort") && !Set.of("none","minimal","low","medium","high","xhigh").contains(root.path("reasoning_effort").asText(""))) fail("REASONING_EFFORT_INVALID");
        if (root.has("service_tier") && !Set.of("auto","default","flex","scale","priority").contains(root.path("service_tier").asText(""))) fail("SERVICE_TIER_INVALID");
        if (root.has("stream_options")) {
            JsonNode options = root.path("stream_options");
            StructuredContent.allowed(options, Set.of("include_usage","include_obfuscation"));
            for (JsonNode value : options) if (!value.isBoolean()) fail("PROTOCOL_BOOLEAN_INVALID");
            if (options.path("include_obfuscation").asBoolean()) fail("SSE_OBFUSCATION_UNSUPPORTED");
        }
        if (root.has("logit_bias")) {
            JsonNode bias = root.path("logit_bias");
            if (!bias.isObject() || bias.size() > 1024) fail("LOGIT_BIAS_INVALID");
            for (var entry : bias.properties()) if (!entry.getKey().matches("\\d{1,10}") || !entry.getValue().isNumber() || !Double.isFinite(entry.getValue().doubleValue()) || Math.abs(entry.getValue().doubleValue()) > 100) fail("LOGIT_BIAS_INVALID");
        }
    }
    static void choice(JsonNode choice) {
        StructuredContent.allowed(choice, Set.of("index","message","finish_reason","logprobs"));
        integer(choice.path("index"), 0, 15);
        if (choice.hasNonNull("logprobs")) fail("LOGPROBS_COVERAGE_UNSUPPORTED");
        if (choice.has("finish_reason") && !Set.of("stop","length","tool_calls","content_filter").contains(choice.path("finish_reason").asText(""))) fail("COMPLETION_FINISH_INVALID");
    }
    static void identifier(JsonNode value) {
        if (!value.isMissingNode() && !value.isNull() && (!value.isString() || !value.stringValue().matches("[A-Za-z0-9_.:/@+\\-]{1,256}"))) fail("PROTOCOL_IDENTIFIER_INVALID");
    }
    private static void integer(JsonNode value, long min, long max) {
        if (value.isMissingNode() || value.isNull()) return;
        double number = value.asDouble(Double.NaN);
        if (!value.isNumber() || !Double.isFinite(number) || number != Math.rint(number) || number < min || number > max) fail("PROTOCOL_NUMBER_INVALID");
    }
    private static void numericTree(JsonNode value, int depth) {
        if (depth > 2 || !value.isObject()) fail("USAGE_STRUCTURE_INVALID");
        for (var entry : value.properties()) {
            if (!entry.getKey().matches("[a-z_]{1,64}")) fail("USAGE_STRUCTURE_INVALID");
            if (entry.getValue().isObject()) numericTree(entry.getValue(), depth + 1);
            else { if (entry.getValue().isNull()) fail("USAGE_STRUCTURE_INVALID"); integer(entry.getValue(), 0, 9007199254740991L); }
        }
    }
    private static void fail(String code) { throw new GatewayFailure(code, 422); }
}
