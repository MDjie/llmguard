package com.guardllm.gateway;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@Component
final class GatewayRuntimeClient {
    record Authorization(JsonNode auth, JsonNode snapshot, JsonNode preparedRequest, JsonNode preparedSegments) {
        Authorization(JsonNode auth, JsonNode snapshot) { this(auth, snapshot, null, null); }
        JsonNode context() { return auth.path("context"); }
        String id() { return context().path("businessRequestId").stringValue(); }
        String snapshotId() { return snapshot.path("id").stringValue(); }
        long deadline() { return context().path("deadline").asLong(); }
        GatewayRequestContext legacyContext() {
            JsonNode c = context();
            return new GatewayRequestContext(c.path("tenantId").stringValue(), c.path("applicationId").stringValue(), c.path("subjectId").stringValue(),
                    c.path("credentialId").asText(""), id(), c.path("traceId").stringValue(), c.path("sessionId").asText(null), deadline());
        }
    }
    private final WebClient client;
    private final ObjectMapper json;
    private final String nodeId;
    private final String secret;
    private final JsonNode publicKeys;
    private final ModelRouteRegistry routes;
    @org.springframework.beans.factory.annotation.Autowired
    GatewayRuntimeClient(@Qualifier("guardWebClient") WebClient client, ObjectMapper json, ModelRouteRegistry routes) {
        this.client = client; this.json = json; this.routes = routes;
        this.nodeId = System.getenv("GATEWAY_NODE_ID");
        this.secret = GatewaySettings.read("GATEWAY_WORKLOAD_SECRET", "GATEWAY_WORKLOAD_SECRET_FILE");
        String keys = GatewaySettings.read("GATEWAY_AUTH_PUBLIC_KEYS_JSON", "GATEWAY_AUTH_PUBLIC_KEYS_FILE");
        this.publicKeys = json.readTree(keys == null ? "{}" : keys);
    }
    Mono<Authorization> authorize(JsonNode request, HttpHeaders headers) {
        return Mono.defer(() -> {
            String id = identifier(headers.getFirst("x-request-id"));
            String trace = identifier(headers.getFirst("x-trace-id"));
            String session = headers.getFirst("x-session-id");
            String key = headers.getFirst("idempotency-key");
            if (session != null && !session.matches("[a-zA-Z0-9_-]{1,128}")) throw new GatewayFailure("SESSION_ID_INVALID", 400);
            if (key != null && !key.matches("[a-zA-Z0-9_:.\\-]{1,128}")) throw new GatewayFailure("IDEMPOTENCY_KEY_INVALID", 400);
            long deadline = System.currentTimeMillis() + 60000;
            if (headers.getFirst("x-guard-deadline") != null) {
                try { deadline = Math.min(deadline, Long.parseLong(headers.getFirst("x-guard-deadline"))); }
                catch (NumberFormatException error) { throw new GatewayFailure("DEADLINE_INVALID", 400); }
            }
            ObjectNode body = json.createObjectNode().put("contractVersion", "2.0").put("businessRequestId", id).put("traceId", trace)
                    .put("idempotencyKey", key == null ? id : key).put("deadline", deadline).put("modelRoute", StructuredContent.requiredText(request, "model"))
                    .put("requestDigest", CanonicalJson.sha256(CanonicalJson.encode(request))).put("requestJson", json.writeValueAsString(request));
            if (session != null) body.put("sessionId", session);
            String assertion = headers.getFirst("x-guard-console-assertion");
            if (assertion != null) body.put("userAssertion", assertion);
            return post("authorize", body, headers, deadline).map(response -> verify(response, body)).flatMap(authorization -> {
                JsonNode c = authorization.context();
                ObjectNode ack = json.createObjectNode().put("contractVersion", "2.0").put("tenantId", c.path("tenantId").stringValue()).put("applicationId", c.path("applicationId").stringValue())
                        .put("nodeId", nodeId).put("snapshotId", authorization.snapshotId()).put("digest", authorization.snapshot().path("digest").stringValue()).put("state", "LOADED");
                return post("runtime/ack", ack, new HttpHeaders(), authorization.deadline()).thenReturn(authorization);
            });
        });
    }
    private Authorization verify(JsonNode response, JsonNode request) {
        JsonNode auth = response.path("auth"), c = auth.path("context"), snapshot = response.path("snapshot"), manifest = snapshot.path("manifest");
        verifySignature("gateway-auth-v2", c, c.path("keyId").asText(""), auth.path("signature").asText(""));
        verifySignature("gateway-snapshot-v2", manifest, snapshot.path("keyId").asText(""), snapshot.path("signature").asText(""));
        if (!c.path("contractVersion").asText("").equals("2.0") || !c.path("issuer").asText("").equals("guard-control") || !c.path("audience").asText("").equals("guard-gateway")
                || c.path("expiresAt").asLong() <= System.currentTimeMillis() || c.path("issuedAt").asLong() > System.currentTimeMillis() + 1000
                || c.path("expiresAt").asLong() > c.path("deadline").asLong() || !c.path("deadline").equals(request.path("deadline"))
                || !c.path("requestDigest").equals(request.path("requestDigest")) || !c.path("businessRequestId").equals(request.path("businessRequestId"))
                || !c.path("traceId").equals(request.path("traceId")) || !c.path("sessionId").equals(request.path("sessionId"))
                || !c.path("tenantId").equals(manifest.path("tenantId")) || !c.path("applicationId").equals(manifest.path("applicationId"))
                || !c.path("policy").path("snapshotId").equals(snapshot.path("id")) || !c.path("policy").path("digest").equals(snapshot.path("digest"))
                || !c.path("policy").path("generation").equals(manifest.path("generation")) || !c.path("policy").path("bundleId").equals(manifest.path("bundleId"))
                || !snapshot.path("digest").asText("").equals(CanonicalJson.sha256(CanonicalJson.encode(manifest)))
                || snapshot.path("state").asText("").equals("REVOKED") || manifest.path("validUntil").asLong() < c.path("expiresAt").asLong()
                || !manifest.path("normalizationVersion").asText("").equals("guard-canonical-v2") || !c.path("dataBoundary").equals(manifest.path("dataBoundary"))
                || !c.path("allowedModelRoutes").equals(manifest.path("modelRoutes"))) throw new GatewayFailure("AUTHORIZATION_BINDING_INVALID", 503);
        boolean permitted = false;
        for (JsonNode model : c.path("allowedModelRoutes")) if (model.equals(request.path("modelRoute"))) permitted = true;
        if (!permitted) throw new GatewayFailure("MODEL_ROUTE_NOT_AUTHORIZED", 403);
        routes.validateSnapshot(json, manifest);
        JsonNode original = json.readTree(request.path("requestJson").stringValue());
        boolean hasReferences = original.has("guard_rag") || original.has("guard_artifacts");
        if (hasReferences != c.hasNonNull("preparedRequestDigest") || hasReferences != c.hasNonNull("inputSegmentsDigest")) throw new GatewayFailure("PREPARED_REQUEST_BINDING_INVALID", 503);
        if (!hasReferences) {
            if (response.has("preparedRequestJson") || response.has("inputSegments")) throw new GatewayFailure("UNEXPECTED_PREPARED_REQUEST", 503);
            return new Authorization(auth, snapshot);
        }
        if (!response.path("preparedRequestJson").isString() || !response.path("inputSegments").isArray()) throw new GatewayFailure("PREPARED_REQUEST_BINDING_INVALID", 503);
        JsonNode prepared = json.readTree(response.path("preparedRequestJson").stringValue());
        if (!CanonicalJson.sha256(CanonicalJson.encode(prepared)).equals(c.path("preparedRequestDigest").stringValue())
            || !CanonicalJson.sha256(CanonicalJson.encode(response.path("inputSegments"))).equals(c.path("inputSegmentsDigest").stringValue()) || prepared.has("guard_rag") || prepared.has("guard_artifacts")) throw new GatewayFailure("PREPARED_REQUEST_BINDING_INVALID", 503);
        var segments = new StructuredContent(json).authorizedSegments(prepared, response.path("inputSegments"), manifest.path("budgets").path("maxInputChars").asInt());
        return new Authorization(auth, snapshot, prepared, segments);
    }
    private void verifySignature(String purpose, JsonNode payload, String keyId, String signature) {
        try {
            String pem = publicKeys.path(keyId).stringValue();
            if (pem == null) throw new GatewayFailure("SIGNING_KEY_UNTRUSTED", 503);
            byte[] der = Base64.getDecoder().decode(pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replaceAll("\\s", ""));
            var verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der)));
            verifier.update((purpose + "\n" + CanonicalJson.encode(payload)).getBytes(StandardCharsets.UTF_8));
            if (!verifier.verify(Base64.getUrlDecoder().decode(signature))) throw new GatewayFailure("SIGNATURE_INVALID", 503);
        } catch (java.security.GeneralSecurityException | IllegalArgumentException error) { throw new GatewayFailure("SIGNATURE_INVALID", 503); }
    }
    Mono<JsonNode> evaluate(Authorization auth, String stage, JsonNode segments) {
        return evaluate(auth, stage, segments, 0, null);
    }
    Mono<JsonNode> evaluate(Authorization auth, String stage, JsonNode segments, int streamSeq, JsonNode window) {
        ObjectNode body = json.createObjectNode().put("contractVersion", "2.0").put("businessRequestId", auth.id()).put("stepId", auth.id() + "_" + stage + (window == null ? "" : "_" + streamSeq))
                .put("traceId", auth.context().path("traceId").stringValue()).put("stage", stage).put("streamSeq", streamSeq).put("attemptKind", stage.endsWith("RECHECK") ? "RECHECK" : "INITIAL")
                .put("snapshotId", auth.snapshotId()).put("deadline", auth.deadline());
        body.set("auth", auth.auth()); body.set("segments", segments); if (window != null) body.set("window", window);
        return post("evaluate", body, new HttpHeaders(), auth.deadline()).map(decision -> {
            if (!decision.path("contractVersion").asText("").equals("2.0") || !decision.path("stepId").equals(body.path("stepId")) || !decision.path("businessRequestId").equals(body.path("businessRequestId"))
                    || !decision.path("snapshotId").equals(body.path("snapshotId")) || !decision.path("coverage").asText("").equals("COMPLETE") || !decision.path("status").asText("").equals("SUCCEEDED")) throw new GatewayFailure("DETECTION_COVERAGE_INCOMPLETE", 503);
            return decision;
        });
    }
    Mono<Void> event(Authorization auth, int seq, String kind, JsonNode decision, JsonNode original, JsonNode segments, String reason) {
        int length = 0; if (segments != null) for (JsonNode segment : segments) length += segment.path("text").stringValue().length();
        return event(auth, seq, kind, decision, original, segments, reason, 0, length);
    }
    Mono<Void> event(Authorization auth, int seq, String kind, JsonNode decision, JsonNode original, JsonNode segments, String reason, int rangeStart, int rangeEnd) {
        ObjectNode event = json.createObjectNode().put("eventSeq", seq).put("kind", kind).put("snapshotId", auth.snapshotId());
        if (reason != null) event.put("reasonCode", reason);
        if (decision != null && original != null) {
            event.put("stepId", decision.path("stepId").stringValue()).put("decisionId", original.path("decisionId").stringValue()).put("actualAction", original.path("action").stringValue());
            if (!decision.path("decisionId").equals(original.path("decisionId"))) event.put("recheckDecisionId", decision.path("decisionId").stringValue());
        }
        if (segments != null) {
            event.put("rangeStart", rangeStart).put("rangeEnd", rangeEnd).put("payloadDigest", CanonicalJson.sha256(CanonicalJson.encode(segments)));
        }
        ObjectNode body = json.createObjectNode().put("contractVersion", "2.0"); body.set("auth", auth.auth()); body.putArray("events").add(event); if (kind.equals("TERMINATED")) body.put("terminalReconciliation", true);
        // Recording an outcome is allowed after the business deadline, for at most five seconds.
        long deadline = kind.equals("TERMINATED") || kind.equals("WRITE_ACCEPTED") || kind.equals("COMPLETED") ? System.currentTimeMillis() + 5000 : auth.deadline();
        return post("events", body, new HttpHeaders(), deadline).then();
    }
    Mono<Void> archiveContent(Authorization auth, String purpose, int sequence, String representation, JsonNode content,
                              JsonNode decision, JsonNode segments, Integer eventSequence, int rangeStart, int rangeEnd) {
        if (!auth.context().path("archiveRequired").asBoolean()) return Mono.empty();
        return Mono.defer(() -> {
            ObjectNode body = json.createObjectNode().put("contractVersion", "2.0").put("purpose", purpose).put("sequence", sequence)
                    .put("representation", representation).put("contentJson", json.writeValueAsString(content));
            body.set("auth", auth.auth());
            if (decision != null && segments != null && eventSequence != null) {
                body.put("sourceStepId", decision.path("stepId").stringValue()).put("eventSequence", eventSequence)
                        .put("payloadDigest", CanonicalJson.sha256(CanonicalJson.encode(segments))).put("rangeStart", rangeStart).put("rangeEnd", rangeEnd);
            }
            long deadline = purpose.equals("MODEL_OUTPUT") ? Math.max(auth.deadline(), System.currentTimeMillis() + 5000) : auth.deadline();
            return post("archive", body, new HttpHeaders(), deadline).flatMap(response -> response.path("state").asText().equals("MANIFEST_COMMITTED")
                    ? Mono.empty() : Mono.error(new GatewayFailure("ARCHIVE_PERSISTENCE_NOT_CONFIRMED", 503)));
        });
    }
    Mono<Void> archiveOutputComplete(Authorization auth, int finalSequence) {
        if (!auth.context().path("archiveRequired").asBoolean()) return Mono.empty();
        ObjectNode body = json.createObjectNode().put("contractVersion", "2.0").put("finalSequence", finalSequence); body.set("auth", auth.auth());
        return post("archive/complete", body, new HttpHeaders(), Math.max(auth.deadline(), System.currentTimeMillis() + 5000)).then();
    }
    private Mono<JsonNode> post(String operation, JsonNode body, HttpHeaders identity, long deadline) {
        return Mono.defer(() -> {
            if (nodeId == null || secret == null || secret.length() < 32) throw new GatewayFailure("WORKLOAD_CONFIGURATION_MISSING", 503);
            long remaining = deadline - System.currentTimeMillis();
            if (remaining <= 0) throw new GatewayFailure("DEADLINE_EXCEEDED", 504);
            String path = "/api/internal/gateway/" + operation, raw = json.writeValueAsString(body), stamp = String.valueOf(System.currentTimeMillis()), nonce = UUID.randomUUID().toString();
            String material = String.join("\n", "POST", path, stamp, nonce, CanonicalJson.sha256(raw));
            final String signature;
            try { Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256")); signature = HexFormat.of().formatHex(mac.doFinal(material.getBytes(StandardCharsets.UTF_8))); }
            catch (java.security.GeneralSecurityException error) { throw new IllegalStateException(error); }
            var call = client.post().uri(path).contentType(MediaType.APPLICATION_JSON).header("x-guard-workload", nodeId).header("x-guard-workload-time", stamp)
                    .header("x-guard-workload-nonce", nonce).header("x-guard-workload-signature", signature);
            for (String name : new String[]{"authorization", "x-guard-api-key"}) {
                if (identity.get(name) != null && identity.get(name).size() != 1) throw new GatewayFailure("AMBIGUOUS_IDENTITY", 401);
                if (identity.getFirst(name) != null) call.header(name, identity.getFirst(name));
            }
            return call.bodyValue(raw).exchangeToMono(response -> response.bodyToMono(JsonNode.class).switchIfEmpty(Mono.error(new GatewayFailure("CONTROL_RESPONSE_EMPTY", 503)))
                    .flatMap(value -> response.statusCode().is2xxSuccessful() ? Mono.just(value) : Mono.error(new GatewayFailure(safeCode(value.path("code").asText("CONTROL_PLANE_FAILED")), response.statusCode().value()))))
                    .timeout(Duration.ofMillis(remaining));
        });
    }
    private static String safeCode(String value) { return value.matches("[A-Z0-9_]{1,128}") ? value : "CONTROL_PLANE_FAILED"; }
    private static String identifier(String value) {
        if (value == null) return UUID.randomUUID().toString();
        if (!value.matches("[a-zA-Z0-9_-]{1,80}")) throw new GatewayFailure("REQUEST_IDENTIFIER_INVALID", 400);
        return value;
    }
}
