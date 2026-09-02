package io.guardllm.sdk;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Stream;

public final class GuardGatewayClient {
    private final URI baseUri;
    private final HttpClient httpClient;
    private final String tenantId;
    private final String applicationId;
    private final String credentialId;
    private final ContextSigner signer;
    private final String guardApiKey;
    private final Duration defaultTimeout;

    public GuardGatewayClient(
            URI baseUri,
            HttpClient httpClient,
            String tenantId,
            String applicationId,
            byte[] contextHmacSecret,
            String guardApiKey,
            Duration defaultTimeout) {
        this(baseUri, httpClient, tenantId, applicationId, null,
                contextHmacSecret, guardApiKey, defaultTimeout);
    }

    public GuardGatewayClient(
            URI baseUri,
            HttpClient httpClient,
            String tenantId,
            String applicationId,
            String credentialId,
            byte[] contextHmacSecret,
            String guardApiKey,
            Duration defaultTimeout) {
        if (baseUri == null || httpClient == null) {
            throw new IllegalArgumentException("baseUri and httpClient are required");
        }
        if (!"https".equalsIgnoreCase(baseUri.getScheme()) && !isLoopback(baseUri)) {
            throw new IllegalArgumentException("Guard gateway baseUri must use HTTPS outside loopback development");
        }
        var validatedScope = new GatewayContext(
                tenantId, applicationId, null, credentialId,
                "validation", "validation-trace-01", null, 1);
        this.baseUri = URI.create(baseUri.toString().replaceAll("/+$", ""));
        this.httpClient = httpClient;
        this.tenantId = validatedScope.tenantId();
        this.applicationId = validatedScope.applicationId();
        this.credentialId = validatedScope.credentialId();
        this.signer = new ContextSigner(contextHmacSecret);
        this.guardApiKey = guardApiKey;
        Duration configured = defaultTimeout == null ? Duration.ofSeconds(20) : defaultTimeout;
        this.defaultTimeout = configured.compareTo(Duration.ofSeconds(60)) > 0
                ? Duration.ofSeconds(60) : configured;
        if (this.defaultTimeout.isZero() || this.defaultTimeout.isNegative()) {
            throw new IllegalArgumentException("defaultTimeout must be positive");
        }
    }

    public GatewayContext newContext(String requestId, String traceId, String sessionId) {
        return newContext(requestId, traceId, sessionId, null);
    }

    public GatewayContext newContext(
            String requestId,
            String traceId,
            String sessionId,
            String principalId) {
        return new GatewayContext(
                tenantId,
                applicationId,
                principalId,
                credentialId,
                requestId == null ? UUID.randomUUID().toString() : requestId,
                traceId == null ? UUID.randomUUID().toString() : traceId,
                sessionId,
                System.currentTimeMillis() + defaultTimeout.toMillis());
    }

    public HttpRequest prepareChat(String requestJson, GatewayContext context, boolean stream) {
        if (requestJson == null || requestJson.isBlank()) {
            throw new IllegalArgumentException("requestJson is required");
        }
        String path = stream ? "/v1/chat/completions/stream" : "/v1/chat/completions";
        var builder = HttpRequest.newBuilder(baseUri.resolve(path))
                .timeout(Duration.ofMillis(Math.max(
                        1, context.absoluteDeadlineEpochMs() - System.currentTimeMillis())))
                .header("Content-Type", "application/json")
                .header("Accept", stream ? "text/event-stream" : "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(requestJson, StandardCharsets.UTF_8));
        addContextHeaders(builder, context);
        return builder.build();
    }

    public CompletableFuture<HttpResponse<String>> chat(String requestJson, GatewayContext context) {
        return httpClient.sendAsync(
                prepareChat(requestJson, context, false),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    public CompletableFuture<HttpResponse<Stream<String>>> chatStream(
            String requestJson,
            GatewayContext context) {
        return httpClient.sendAsync(
                prepareChat(requestJson, context, true),
                HttpResponse.BodyHandlers.ofLines());
    }

    public CompletableFuture<HttpResponse<String>> evaluate(String guardRequestJson) {
        if (guardApiKey == null || guardApiKey.isBlank()) {
            throw new IllegalStateException("guardApiKey is required for direct evaluation");
        }
        var request = HttpRequest.newBuilder(baseUri.resolve("/api/v1/guard/evaluate"))
                .timeout(defaultTimeout)
                .header("Content-Type", "application/json")
                .header("X-Guard-Api-Key", guardApiKey)
                .POST(HttpRequest.BodyPublishers.ofString(guardRequestJson, StandardCharsets.UTF_8))
                .build();
        return httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private void addContextHeaders(HttpRequest.Builder builder, GatewayContext context) {
        if (!tenantId.equals(context.tenantId()) || !applicationId.equals(context.applicationId())) {
            throw new IllegalArgumentException("Gateway context scope does not match the SDK client");
        }
        builder.header("X-Tenant-Id", context.tenantId())
                .header("X-Application-Id", context.applicationId())
                .header("X-Request-Id", context.requestId())
                .header("X-Trace-Id", context.traceId())
                .header("X-Absolute-Deadline-Epoch-Ms", Long.toString(context.absoluteDeadlineEpochMs()))
                .header("X-Guard-Context-Version", "3")
                .header("X-Guard-Context-Signature", signer.sign(context));
        if (context.sessionId() != null) builder.header("X-Session-Id", context.sessionId());
        if (context.principalId() != null) builder.header("X-Principal-Id", context.principalId());
        if (context.credentialId() != null) builder.header("X-Credential-Id", context.credentialId());
    }

    private static boolean isLoopback(URI uri) {
        return "localhost".equalsIgnoreCase(uri.getHost())
                || "127.0.0.1".equals(uri.getHost())
                || "::1".equals(uri.getHost());
    }
}
