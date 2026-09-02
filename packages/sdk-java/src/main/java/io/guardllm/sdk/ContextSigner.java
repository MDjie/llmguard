package io.guardllm.sdk;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class ContextSigner {
    private final byte[] secret;
    private final Clock clock;

    public ContextSigner(byte[] secret) {
        this(secret, Clock.systemUTC());
    }

    ContextSigner(byte[] secret, Clock clock) {
        if (secret == null || secret.length < 32) {
            throw new IllegalArgumentException("Gateway context HMAC secret must contain at least 32 bytes");
        }
        this.secret = secret.clone();
        this.clock = clock;
    }

    public String payload(GatewayContext context) {
        return String.join("\n",
                "guard-context-v3",
                context.tenantId(),
                context.applicationId(),
                context.principalId() == null ? "" : context.principalId(),
                context.credentialId() == null ? "" : context.credentialId(),
                context.requestId(),
                context.traceId(),
                context.sessionId() == null ? "" : context.sessionId(),
                Long.toString(context.absoluteDeadlineEpochMs()));
    }

    public String sign(GatewayContext context) {
        long now = clock.millis();
        if (context.absoluteDeadlineEpochMs() <= now
                || context.absoluteDeadlineEpochMs() - now > 60_000) {
            throw new IllegalArgumentException("Gateway deadline must be within the next 60 seconds");
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return HexFormat.of().formatHex(
                    mac.doFinal(payload(context).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new IllegalStateException("HmacSHA256 is unavailable", error);
        }
    }

    public boolean verify(GatewayContext context, String signature) {
        try {
            return MessageDigest.isEqual(
                    HexFormat.of().parseHex(sign(context)),
                    HexFormat.of().parseHex(signature));
        } catch (IllegalArgumentException error) {
            return false;
        }
    }
}
