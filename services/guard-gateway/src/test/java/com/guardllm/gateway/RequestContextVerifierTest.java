package com.guardllm.gateway;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

class RequestContextVerifierTest {
    private static final String SECRET = "0123456789abcdef0123456789abcdef";
    private static final Clock CLOCK = Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC);

    @Test
    void verifiesSignedV3ScopeAndRejectsTampering() throws Exception {
        var context = new GatewayRequestContext(
                "tenant-1", "app-1", "user-1", "credential-1",
                "request-123", "trace-1234567890", "session-1", 31_000);
        var verifier = new RequestContextVerifier(SECRET, CLOCK);
        String signature = signature(context, "3");
        assertTrue(verifier.verify(context, signature, "3"));
        assertFalse(verifier.verify(new GatewayRequestContext(
                "tenant-2", context.applicationId(), context.principalId(), context.credentialId(),
                context.requestId(), context.traceId(), context.sessionId(),
                context.absoluteDeadlineEpochMs()), signature, "3"));
        assertFalse(verifier.verify(new GatewayRequestContext(
                context.tenantId(), context.applicationId(), "user-tampered", context.credentialId(),
                context.requestId(), context.traceId(), context.sessionId(),
                context.absoluteDeadlineEpochMs()), signature, "3"));
        assertFalse(verifier.verify(new GatewayRequestContext(
                context.tenantId(), context.applicationId(), context.principalId(), "credential-tampered",
                context.requestId(), context.traceId(), context.sessionId(),
                context.absoluteDeadlineEpochMs()), signature, "3"));
        assertFalse(verifier.verify(new GatewayRequestContext(
                context.tenantId(), context.applicationId(), context.principalId(), context.credentialId(),
                context.requestId(), "trace-tampered", context.sessionId(),
                context.absoluteDeadlineEpochMs()), signature, "3"));
        assertFalse(verifier.verify(context, signature, "1"));
    }

    @Test
    void acceptsV2OnlyWithoutUnsignedIdentityFields() throws Exception {
        var verifier = new RequestContextVerifier(SECRET, CLOCK);
        var legacy = new GatewayRequestContext(
                "tenant-1", "app-1", null, null,
                "request-123", "trace-1234567890", "session-1", 31_000);
        String signature = signature(legacy, "2");
        assertTrue(verifier.verify(legacy, signature, "2"));
        assertFalse(verifier.verify(new GatewayRequestContext(
                legacy.tenantId(), legacy.applicationId(), "unsigned-user", null,
                legacy.requestId(), legacy.traceId(), legacy.sessionId(),
                legacy.absoluteDeadlineEpochMs()), signature, "2"));
    }

    @Test
    void rejectsExpiredAndExcessiveDeadlines() throws Exception {
        var verifier = new RequestContextVerifier(SECRET, CLOCK);
        var expired = new GatewayRequestContext("t", "a", null, null, "r", "trace", null, 999);
        var excessive = new GatewayRequestContext("t", "a", null, null, "r", "trace", null, 61_001);
        assertFalse(verifier.verify(expired, signature(expired, "2"), "2"));
        assertFalse(verifier.verify(excessive, signature(excessive, "2"), "2"));
    }

    private static String signature(GatewayRequestContext context, String version) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String payload = "3".equals(version)
                ? String.join("\n", "guard-context-v3",
                        context.tenantId(), context.applicationId(),
                        value(context.principalId()), value(context.credentialId()),
                        context.requestId(), context.traceId(), value(context.sessionId()),
                        Long.toString(context.absoluteDeadlineEpochMs()))
                : String.join("\n", "guard-context-v2",
                        context.tenantId(), context.applicationId(), context.requestId(),
                        context.traceId(), value(context.sessionId()),
                        Long.toString(context.absoluteDeadlineEpochMs()));
        return HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
    }

    private static String value(String input) {
        return input == null ? "" : input;
    }
}
