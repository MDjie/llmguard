package com.guardllm.gateway;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class RequestContextVerifier {
    private final byte[] secret;
    private final Clock clock;

    RequestContextVerifier(String secret, Clock clock) {
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
        this.clock = clock;
    }

    boolean verify(GatewayRequestContext context, String signature, String version) {
        if ((!"2".equals(version) && !"3".equals(version)) || signature == null
                || context.absoluteDeadlineEpochMs() <= clock.millis()
                || context.absoluteDeadlineEpochMs() - clock.millis() > 60_000) {
            return false;
        }
        if ("2".equals(version)
                && (context.principalId() != null || context.credentialId() != null)) {
            return false;
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            String payload = "3".equals(version)
                    ? String.join("\n", "guard-context-v3",
                            context.tenantId(), context.applicationId(),
                            empty(context.principalId()), empty(context.credentialId()),
                            context.requestId(), context.traceId(), empty(context.sessionId()),
                            Long.toString(context.absoluteDeadlineEpochMs()))
                    : String.join("\n", "guard-context-v2",
                            context.tenantId(), context.applicationId(), context.requestId(),
                            context.traceId(), empty(context.sessionId()),
                            Long.toString(context.absoluteDeadlineEpochMs()));
            byte[] expected = mac.doFinal(payload.getBytes(StandardCharsets.UTF_8));
            byte[] actual = HexFormat.of().parseHex(signature);
            return MessageDigest.isEqual(expected, actual);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String empty(String value) {
        return value == null ? "" : value;
    }
}
