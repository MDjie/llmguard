package io.guardllm.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class GuardGatewayClientTest {
    @Test
    void preparesSignedSseRequest() {
        var client = new GuardGatewayClient(
                URI.create("http://localhost:8080"),
                HttpClient.newHttpClient(),
                "tenant-1",
                "app-1",
                "credential-1",
                "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.UTF_8),
                "guard-key",
                Duration.ofSeconds(20));
        var context = client.newContext(
                "request-123", "trace-1234567890", "session-1", "user-1");
        var request = client.prepareChat("{\"messages\":[],\"stream\":true}", context, true);
        assertEquals("/v1/chat/completions/stream", request.uri().getPath());
        assertEquals("3", request.headers().firstValue("X-Guard-Context-Version").orElseThrow());
        assertEquals("user-1", request.headers().firstValue("X-Principal-Id").orElseThrow());
        assertEquals("credential-1", request.headers().firstValue("X-Credential-Id").orElseThrow());
        assertEquals("session-1", request.headers().firstValue("X-Session-Id").orElseThrow());
        assertTrue(request.headers().firstValue("X-Guard-Context-Signature").orElseThrow()
                .matches("[a-f0-9]{64}"));
    }
}
