package io.guardllm.sdk;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

class ContextSignerTest {
    private static final byte[] SECRET =
            "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.UTF_8);

    @Test
    void signatureV3BindsIdentityTraceAndSession() {
        var signer = new ContextSigner(
                SECRET, Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC));
        var context = new GatewayContext(
                "tenant-1", "app-1", "user-1", "credential-1",
                "request-123", "trace-1234567890", "session-1", 20_000);
        String signature = signer.sign(context);
        assertTrue(signer.verify(context, signature));
        assertFalse(signer.verify(new GatewayContext(
                context.tenantId(), context.applicationId(), context.principalId(), context.credentialId(),
                context.requestId(), "trace-tampered-0", context.sessionId(),
                context.absoluteDeadlineEpochMs()), signature));
        assertFalse(signer.verify(new GatewayContext(
                context.tenantId(), context.applicationId(), "user-tampered", context.credentialId(),
                context.requestId(), context.traceId(), context.sessionId(),
                context.absoluteDeadlineEpochMs()), signature));
        assertTrue(signer.payload(context).startsWith("guard-context-v3\n"));
    }

    @Test
    void rejectsUnsafeScopeAndDeadlines() {
        var signer = new ContextSigner(
                SECRET, Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC));
        var expired = new GatewayContext("t", "a", "request-1", "trace-1234567890", null, 999);
        org.junit.jupiter.api.Assertions.assertThrows(
                IllegalArgumentException.class, () -> signer.sign(expired));
        org.junit.jupiter.api.Assertions.assertThrows(
                IllegalArgumentException.class,
                () -> new GatewayContext(
                        "tenant\nother", "a", "request-1", "trace-1234567890", null, 20_000));
    }
}
