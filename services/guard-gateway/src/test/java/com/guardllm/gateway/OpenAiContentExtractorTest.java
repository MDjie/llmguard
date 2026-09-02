package com.guardllm.gateway;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class OpenAiContentExtractorTest {
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void includesTextPartsAndThinkingFieldsInInputInspection() throws Exception {
        var request = objectMapper.readTree("""
                {"messages":[
                  {"role":"user","content":[{"type":"text","text":"visible"}]},
                  {"role":"assistant","thinking":"hidden-plan"}
                ]}
                """);
        String extracted = OpenAiContentExtractor.inputText(request);
        assertTrue(extracted.contains("visible"));
        assertTrue(extracted.contains("hidden-plan"));
    }

    @Test
    void includesProviderReasoningFieldsInOutputInspection() throws Exception {
        var response = objectMapper.readTree("""
                {"choices":[{"message":{
                  "content":"answer",
                  "reasoning_content":"unsafe-reasoning"
                }}]}
                """);
        String extracted = OpenAiContentExtractor.outputText(response);
        assertTrue(extracted.contains("answer"));
        assertTrue(extracted.contains("unsafe-reasoning"));
        assertFalse(extracted.contains("choices"));
    }
}
