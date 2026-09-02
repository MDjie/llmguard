package com.guardllm.gateway;

import tools.jackson.databind.JsonNode;

final class OpenAiContentExtractor {
    private static final int MAX_TEXT_CHARS = 1_048_576;

    private OpenAiContentExtractor() {
    }

    static String inputText(JsonNode request) {
        StringBuilder value = new StringBuilder();
        JsonNode messages = request.path("messages");
        if (messages.isArray()) {
            for (JsonNode message : messages) {
                appendContent(value, message.path("content"));
                appendContent(value, message.path("reasoning_content"));
                appendContent(value, message.path("thinking"));
            }
        } else {
            appendContent(value, request.path("prompt"));
            appendContent(value, request.path("input"));
        }
        return bounded(value.length() == 0 ? request.toString() : value.toString());
    }

    static String outputText(JsonNode response) {
        StringBuilder value = new StringBuilder();
        JsonNode choices = response.path("choices");
        if (choices.isArray()) {
            for (JsonNode choice : choices) {
                JsonNode message = choice.path("message");
                appendContent(value, message.path("content"));
                appendContent(value, message.path("reasoning_content"));
                appendContent(value, message.path("thinking"));
                appendContent(value, choice.path("text"));
            }
        }
        return bounded(value.length() == 0 ? response.toString() : value.toString());
    }

    private static void appendContent(StringBuilder target, JsonNode content) {
        if (content.isString()) {
            target.append(content.stringValue()).append('\n');
        } else if (content.isArray()) {
            for (JsonNode item : content) {
                if (item.isString()) target.append(item.stringValue()).append('\n');
                JsonNode text = item.path("text");
                if (text.isString()) target.append(text.stringValue()).append('\n');
            }
        }
    }

    private static String bounded(String value) {
        return value.length() <= MAX_TEXT_CHARS ? value : value.substring(0, MAX_TEXT_CHARS);
    }
}
