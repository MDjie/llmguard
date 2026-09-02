package com.guardllm.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

class ModelRouteRegistryTest {
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void mapsAliasesAndKeepsWeightedSelectionStableForASession() throws Exception {
        String routes = """
                [
                  {"id":"primary","baseUrl":"https://primary.example/v1",
                   "modelPattern":"business-chat","targetModel":"deepseek-v3",
                   "weight":70,"bearerTokenEnv":"PRIMARY_TOKEN",
                   "requestMappings":[
                     {"from":"/max_tokens","to":"/max_completion_tokens"}
                   ],
                   "responseMappings":[
                     {"from":"/choices/*/message/reasoning","to":"/choices/*/message/reasoning_content"}
                   ]},
                  {"id":"secondary","baseUrl":"https://secondary.example/api/v3",
                   "modelPattern":"business-chat","targetModel":"qwen-max",
                   "weight":30,"bearerTokenEnv":"SECONDARY_TOKEN"}
                ]
                """;
        var registry = new ModelRouteRegistry(
                objectMapper, routes, URI.create("https://unused.example"),
                "", name -> Map.of(
                        "PRIMARY_TOKEN", "primary-secret",
                        "SECONDARY_TOKEN", "secondary-secret").get(name));
        var request = objectMapper.readTree(
                "{\"model\":\"business-chat\",\"max_tokens\":128,"
                + "\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}");
        var first = registry.select(request, "session-stable");
        var second = registry.select(request, "session-stable");
        assertEquals(first.routeId(), second.routeId());
        assertEquals(first.chatUri(), second.chatUri());
        assertTrue(first.chatUri().getPath().endsWith("/chat/completions"));
        assertTrue(first.request().path("model").isString());
        assertTrue(!first.request().path("model").stringValue().equals("business-chat"));
        if ("primary".equals(first.routeId())) {
            assertEquals(128, first.request().path("max_completion_tokens").asInt());
            assertTrue(first.request().path("max_tokens").isMissingNode());
            JsonNode normalized = registry.normalize(first, objectMapper.readTree(
                    "{\"choices\":[{\"message\":{\"content\":\"ok\",\"reasoning\":\"why\"}}]}"));
            assertEquals("why", normalized.at("/choices/0/message/reasoning_content").stringValue());
            assertTrue(normalized.at("/choices/0/message/reasoning").isMissingNode());
        }
    }

    @Test
    void rejectsUntrustedSchemesAndMissingSecretReferences() {
        String unsafe = """
                [{"id":"unsafe","baseUrl":"http://metadata.internal",
                  "modelPattern":"*","weight":100}]
                """;
        assertThrows(IllegalArgumentException.class, () -> new ModelRouteRegistry(
                objectMapper, unsafe, URI.create("https://unused.example"), "", name -> null));
        String missingSecret = """
                [{"id":"missing","baseUrl":"https://model.example/v1",
                  "modelPattern":"*","weight":100,"bearerTokenEnv":"MISSING_TOKEN"}]
                """;
        assertThrows(IllegalArgumentException.class, () -> new ModelRouteRegistry(
                objectMapper, missingSecret, URI.create("https://unused.example"), "", name -> null));
    }

    @Test
    void appliesRequestAndWildcardResponseMappings() throws Exception {
        String routes = """
                [{"id":"mapped","baseUrl":"https://model.example/v1",
                  "modelPattern":"*","weight":100,
                  "requestMappings":[
                    {"from":"/max_tokens","to":"/max_completion_tokens"}
                  ],
                  "responseMappings":[
                    {"from":"/choices/*/message/reasoning","to":"/choices/*/message/reasoning_content"}
                  ]}]
                """;
        var registry = new ModelRouteRegistry(
                objectMapper, routes, URI.create("https://unused.example"), "", name -> null);
        var selected = registry.select(
                objectMapper.readTree("{\"model\":\"test\",\"max_tokens\":64}"), "route-key");
        assertEquals(64, selected.request().path("max_completion_tokens").asInt());
        assertTrue(selected.request().path("max_tokens").isMissingNode());
        JsonNode normalized = registry.normalize(selected, objectMapper.readTree(
                "{\"choices\":[{\"message\":{\"reasoning\":\"first\"}},"
                + "{\"message\":{\"reasoning\":\"second\"}}]}"));
        assertEquals("first", normalized.at("/choices/0/message/reasoning_content").stringValue());
        assertEquals("second", normalized.at("/choices/1/message/reasoning_content").stringValue());
        assertTrue(normalized.at("/choices/0/message/reasoning").isMissingNode());
    }
}
