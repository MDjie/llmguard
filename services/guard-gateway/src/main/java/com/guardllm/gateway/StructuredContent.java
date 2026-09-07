package com.guardllm.gateway;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

final class StructuredContent {
    private final ObjectMapper json;
    StructuredContent(ObjectMapper json) { this.json = json; }
    ArrayNode segments(JsonNode root, boolean input, int limit) {
        if (!input) assertTextOutput(root);
        CompletionFields.validate(root, input);
        var result = json.createArrayNode();
        JsonNode items = root.path(input ? "messages" : "choices");
        if (!items.isArray() || items.isEmpty() || items.size() > (input ? 100 : 16)) throw new GatewayFailure("MESSAGES_INVALID", 422);
        for (int i = 0; i < items.size(); i++) {
            if (!input) CompletionFields.choice(items.get(i));
            if (!input && !items.get(i).path("logprobs").isMissingNode() && !items.get(i).path("logprobs").isNull()) throw new GatewayFailure("LOGPROBS_COVERAGE_UNSUPPORTED", 422);
            message(input ? items.get(i) : items.get(i).path("message"), input ? "/messages/" + i : "/choices/" + i + "/message", input, result);
        }
        if (input && root.has("tools")) {
            JsonNode tools = root.path("tools");
            if (!tools.isArray() || tools.size() > 64) throw new GatewayFailure("TOOLS_INVALID", 422);
            for (int i = 0; i < tools.size(); i++) add(result, CanonicalJson.encode(tools.get(i)), "/tools/" + i, "tool", "TOOL");
        }
        if (input) {
            for (String field : new String[]{"response_format","tool_choice"}) if (root.has(field)) add(result, CanonicalJson.encode(root.path(field)), "/" + field, "tool", "TOOL");
            if (root.hasNonNull("stop")) {
                JsonNode stop = root.path("stop");
                if (stop.isString()) add(result, stop.stringValue(), "/stop", "user", "USER");
                else if (stop.isArray() && stop.size() <= 4) { for (int i = 0; i < stop.size(); i++) {
                    if (!stop.get(i).isString()) throw new GatewayFailure("STOP_STRUCTURE_INVALID", 422);
                    add(result, stop.get(i).stringValue(), "/stop/" + i, "user", "USER");
                } } else throw new GatewayFailure("STOP_STRUCTURE_INVALID", 422);
            }
        }
        int total = 0;
        for (JsonNode segment : result) total = Math.addExact(total, segment.path("text").stringValue().length());
        if (total > limit || result.size() > 256) throw new GatewayFailure("CONTENT_BUDGET_EXCEEDED", 413);
        if (result.isEmpty()) throw new GatewayFailure("CONTENT_COVERAGE_EMPTY", 422);
        return result;
    }
    static void assertTextOutput(JsonNode root) {
        JsonNode choices = root.path("choices");
        if (!choices.isArray()) return;
        for (JsonNode choice : choices) for (String name : new String[]{"message", "delta"}) {
            JsonNode message = choice.path(name);
            for (String field : new String[]{"audio", "images", "video"}) if (message.hasNonNull(field)) throw new GatewayFailure("NATIVE_OUTPUT_REVIEW_REQUIRED", 409);
            JsonNode content = message.path("content");
            if (content.isArray()) for (JsonNode block : content) if (Set.of("image_url", "input_audio", "output_audio", "video_url", "image", "audio", "video").contains(block.path("type").asText(""))) throw new GatewayFailure("NATIVE_OUTPUT_REVIEW_REQUIRED", 409);
        }
    }
    ArrayNode authorizedSegments(JsonNode prepared, JsonNode supplied, int limit) {
        ArrayNode expected = segments(prepared, true, limit);
        if (!supplied.isArray() || supplied.size() != expected.size()) throw new GatewayFailure("PREPARED_SEGMENTS_INVALID", 503);
        for (int i = 0; i < expected.size(); i++) {
            JsonNode value = supplied.get(i);
            ObjectNode baseline = (ObjectNode) expected.get(i);
            if (java.util.Set.of("RAG", "FILE").contains(value.path("sourceType").asText(""))) {
                if (!baseline.path("role").asText("").equals("user") || !baseline.path("contentPath").asText("").startsWith("/messages/")) throw new GatewayFailure("PREPARED_SOURCE_ROLE_INVALID", 503);
                baseline.put("sourceType", value.path("sourceType").asText());
            }
            if (!baseline.equals(value)) throw new GatewayFailure("PREPARED_SEGMENTS_INVALID", 503);
        }
        return expected;
    }
    ArrayNode inheritSources(ArrayNode changed, ArrayNode original) {
        for (JsonNode value : changed) for (JsonNode prior : original) {
            if (value.path("contentPath").equals(prior.path("contentPath")) && java.util.Set.of("RAG", "FILE").contains(prior.path("sourceType").asText(""))) ((ObjectNode) value).put("sourceType", prior.path("sourceType").asText());
        }
        return changed;
    }
    private void message(JsonNode message, String path, boolean input, ArrayNode result) {
        allowed(message, Set.of("role", "content", "name", "tool_call_id", "tool_calls", "refusal"));
        String role = message.path("role").asText("");
        if (!Set.of("system", "developer", "user", "assistant", "tool").contains(role) || (!input && !role.equals("assistant"))) throw new GatewayFailure("MESSAGE_ROLE_INVALID", 422);
        CompletionFields.identifier(message.path("name")); CompletionFields.identifier(message.path("tool_call_id"));
        String source = role.equals("tool") ? "TOOL" : input ? "USER" : "MODEL";
        JsonNode content = message.path("content");
        if (content.isString()) add(result, content.stringValue(), path + "/content", role, source);
        else if (content.isArray()) for (int i = 0; i < content.size(); i++) {
            JsonNode block = content.get(i);
            if (input && role.equals("user") && Set.of("image_url", "input_audio", "video_url").contains(block.path("type").asText(""))) {
                add(result, CanonicalJson.encode(nativeMetadata(block)), path + "/content/" + i, role, "FILE");
                continue;
            }
            allowed(block, Set.of("type", "text"));
            if (!Set.of("text", "input_text", "output_text").contains(block.path("type").asText(""))) throw new GatewayFailure("ARTIFACT_PIPELINE_REQUIRED", 422);
            add(result, requiredText(block, "text"), path + "/content/" + i + "/text", role, source);
        } else if (!content.isNull() && !content.isMissingNode()) throw new GatewayFailure("CONTENT_STRUCTURE_UNSUPPORTED", 422);
        if (message.hasNonNull("refusal")) add(result, requiredText(message, "refusal"), path + "/refusal", role, source);
        if (message.has("tool_calls")) {
            JsonNode calls = message.path("tool_calls");
            if (!calls.isArray() || calls.size() > 64) throw new GatewayFailure("TOOL_STRUCTURE_UNSUPPORTED", 422);
            for (int i = 0; i < calls.size(); i++) {
                JsonNode call = calls.get(i); JsonNode fn = call.path("function");
                allowed(call, Set.of("id", "type", "function")); allowed(fn, Set.of("name", "arguments")); CompletionFields.identifier(call.path("id"));
                if (!call.path("type").asText("").equals("function")) throw new GatewayFailure("TOOL_STRUCTURE_UNSUPPORTED", 422);
                String args = requiredText(fn, "arguments");
                try { if (json.readTree(args) == null) throw new GatewayFailure("TOOL_ARGUMENTS_INVALID", 422); } catch (RuntimeException error) { throw new GatewayFailure("TOOL_ARGUMENTS_INVALID", 422); }
                add(result, requiredText(fn, "name"), path + "/tool_calls/" + i + "/function/name", role, "TOOL");
                add(result, args, path + "/tool_calls/" + i + "/function/arguments", role, "TOOL");
            }
        }
    }
    private ObjectNode nativeMetadata(JsonNode block) {
        String field = block.path("type").asText("");
        allowed(block, Set.of("type", field));
        JsonNode inner = block.path(field);
        String modality, mime, base64;
        if (field.equals("input_audio")) {
            allowed(inner, Set.of("data", "format"));
            String format = requiredText(inner, "format");
            if (!Set.of("mp3", "wav").contains(format)) throw new GatewayFailure("NATIVE_MEDIA_BLOCK_INVALID", 422);
            modality = "AUDIO"; mime = format.equals("mp3") ? "audio/mpeg" : "audio/wav";
            base64 = requiredText(inner, "data");
        } else {
            allowed(inner, Set.of("url"));
            var matcher = java.util.regex.Pattern.compile("^data:((?:image/(?:png|jpeg|webp|gif))|video/mp4);base64,([A-Za-z0-9+/]*={0,2})$").matcher(requiredText(inner, "url"));
            if (!matcher.matches()) throw new GatewayFailure("NATIVE_MEDIA_BLOCK_INVALID", 422);
            mime = matcher.group(1); base64 = matcher.group(2); modality = field.equals("image_url") ? "IMAGE" : "VIDEO";
            if (modality.equals("IMAGE") != mime.startsWith("image/")) throw new GatewayFailure("NATIVE_MEDIA_BLOCK_INVALID", 422);
        }
        if (base64.isEmpty() || base64.length() > 1398104 || !base64.matches("[A-Za-z0-9+/]*={0,2}")) throw new GatewayFailure("NATIVE_MEDIA_BLOCK_INVALID", 422);
        byte[] bytes;
        try { bytes = java.util.Base64.getDecoder().decode(base64); } catch (IllegalArgumentException error) { throw new GatewayFailure("NATIVE_MEDIA_BLOCK_INVALID", 422); }
        try {
            if (bytes.length == 0 || bytes.length > 1048576 || !java.util.Base64.getEncoder().encodeToString(bytes).equals(base64)) throw new GatewayFailure("NATIVE_MEDIA_BLOCK_INVALID", 422);
            String digest = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
            return json.createObjectNode().put("kind", "native_media").put("modality", modality).put("mimeType", mime).put("sha256", digest).put("bytes", bytes.length);
        } catch (java.security.GeneralSecurityException error) { throw new IllegalStateException(error); }
        finally { java.util.Arrays.fill(bytes, (byte) 0); }
    }
    private void add(ArrayNode result, String text, String path, String role, String source) {
        CanonicalJson.unicode(text);
        result.addObject().put("segmentId", CanonicalJson.sha256(path).substring(0, 32)).put("contentPath", path).put("role", role)
                .put("text", text).put("sourceType", source).put("sourceDigest", CanonicalJson.sha256(text));
    }
    static void allowed(JsonNode object, Set<String> names) {
        if (!object.isObject() || object.properties().stream().anyMatch(entry -> !names.contains(entry.getKey()))) throw new GatewayFailure("PROTOCOL_FIELD_UNSUPPORTED", 422);
    }
    static String requiredText(JsonNode object, String field) {
        if (!object.path(field).isString()) throw new GatewayFailure("PROTOCOL_TEXT_REQUIRED", 422);
        return object.path(field).stringValue();
    }
    JsonNode patch(JsonNode body, ArrayNode segments, JsonNode patches) {
        if (!patches.isArray() || patches.isEmpty()) throw new GatewayFailure("TRANSFORM_PATCHES_MISSING", 503);
        var byId = new HashMap<String, JsonNode>();
        for (JsonNode segment : segments) byId.put(segment.path("segmentId").stringValue(), segment);
        Map<String, List<JsonNode>> grouped = new HashMap<>();
        for (JsonNode patch : patches) {
            JsonNode segment = byId.get(patch.path("segmentId").asText(""));
            if (segment == null || !segment.path("contentPath").equals(patch.path("contentPath")) || !segment.path("sourceDigest").equals(patch.path("sourceDigest"))) throw new GatewayFailure("TRANSFORM_BINDING_MISMATCH", 503);
            if (segment.path("sourceType").asText("").equals("TOOL")) throw new GatewayFailure("TOOL_REWRITE_REQUIRES_NEW_INTENT", 422);
            String text = segment.path("text").stringValue();
            int start = patch.path("start").asInt(-1), end = patch.path("end").asInt(-1);
            if (!patch.path("start").isIntegralNumber() || !patch.path("end").isIntegralNumber() || start < 0 || start >= end || end > text.length()) throw new GatewayFailure("TRANSFORM_RANGE_INVALID", 503);
            CanonicalJson.unicode(text.substring(0, start)); CanonicalJson.unicode(text.substring(end)); CanonicalJson.unicode(requiredText(patch, "replacement"));
            grouped.computeIfAbsent(segment.path("segmentId").stringValue(), ignored -> new ArrayList<>()).add(patch);
        }
        JsonNode result = body.deepCopy();
        for (var entry : grouped.entrySet()) {
            JsonNode segment = byId.get(entry.getKey()); String path = segment.path("contentPath").stringValue(); String text = segment.path("text").stringValue();
            List<JsonNode> edits = entry.getValue(); edits.sort(Comparator.comparingInt(item -> item.path("start").asInt()));
            for (int i = 1; i < edits.size(); i++) if (edits.get(i).path("start").asInt() < edits.get(i - 1).path("end").asInt()) throw new GatewayFailure("TRANSFORM_RANGE_OVERLAP", 503);
            if (!result.at(path).isString() || !result.at(path).stringValue().equals(text)) throw new GatewayFailure("TRANSFORM_SOURCE_CHANGED", 503);
            for (JsonNode edit : edits.reversed()) text = text.substring(0, edit.path("start").asInt()) + edit.path("replacement").stringValue() + text.substring(edit.path("end").asInt());
            JsonNode parent = result.at(path.substring(0, path.lastIndexOf('/')));
            String key = path.substring(path.lastIndexOf('/') + 1);
            if (parent instanceof ObjectNode object) object.put(key, text);
            else if (parent instanceof ArrayNode array) array.set(Integer.parseInt(key), json.getNodeFactory().stringNode(text));
            else throw new GatewayFailure("TRANSFORM_PATH_INVALID", 503);
        }
        return result;
    }
}
