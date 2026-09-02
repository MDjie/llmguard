package com.guardllm.gateway;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

@Component
final class GatewayRateLimiter {
    private static final Duration WINDOW = Duration.ofMinutes(1);
    private final QuotaBackend backend;
    private final GatewayRateLimitProperties properties;

    GatewayRateLimiter(QuotaBackend backend, GatewayRateLimitProperties properties) {
        this.backend = backend;
        this.properties = properties;
    }

    Mono<Void> check(GatewayRequestContext context, String api, int textChars) {
        if (!properties.enabled()) return Mono.empty();
        if (textChars > properties.maxTextCharsPerRequest()) {
            return Mono.error(new RequestCapacityExceededException());
        }
        List<String> identities = new ArrayList<>();
        identities.add("tenant:" + digest(context.tenantId()));
        identities.add("application:" + digest(context.tenantId() + "\n" + context.applicationId()));
        if (context.principalId() != null) {
            identities.add("principal:" + digest(
                    context.tenantId() + "\n" + context.applicationId() + "\n" + context.principalId()));
        }
        if (context.credentialId() != null) {
            identities.add("credential:" + digest(
                    context.tenantId() + "\n" + context.applicationId() + "\n" + context.credentialId()));
        }
        if (context.sessionId() != null) {
            identities.add("session:" + digest(
                    context.tenantId() + "\n" + context.applicationId() + "\n" + context.sessionId()));
        }
        identities.add("api:" + digest(context.tenantId() + "\n" + context.applicationId() + "\n" + api));

        List<String> keys = new ArrayList<>(identities.size() * 3);
        List<Long> costs = new ArrayList<>(identities.size() * 3);
        List<Long> limits = new ArrayList<>(identities.size() * 3);
        long estimatedTokens = (Math.max(0L, textChars) + 3L) / 4L;
        for (String identity : identities) {
            keys.add("guard:quota:request:" + identity);
            costs.add(1L);
            limits.add((long) properties.requestsPerMinute());
            keys.add("guard:quota:chars:" + identity);
            costs.add((long) Math.max(0, textChars));
            limits.add((long) properties.textCharsPerMinute());
            keys.add("guard:quota:tokens:" + identity);
            costs.add(estimatedTokens);
            limits.add((long) properties.estimatedTokensPerMinute());
        }
        return backend.consume(keys, costs, limits, WINDOW)
                .onErrorMap(error -> error instanceof GatewayQuotaException
                        ? error : new QuotaBackendUnavailableException(error))
                .flatMap(allowed -> allowed
                        ? Mono.<Void>empty()
                        : Mono.<Void>error(new QuotaExceededException()))
                .onErrorResume(QuotaBackendUnavailableException.class, error ->
                        properties.failClosed()
                                ? Mono.<Void>error(error)
                                : Mono.<Void>empty());
    }

    private static String digest(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    sealed static class GatewayQuotaException extends RuntimeException
            permits QuotaExceededException, QuotaBackendUnavailableException,
                    RequestCapacityExceededException {
        GatewayQuotaException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    static final class QuotaExceededException extends GatewayQuotaException {
        QuotaExceededException() {
            super("Gateway quota exceeded", null);
        }
    }

    static final class QuotaBackendUnavailableException extends GatewayQuotaException {
        QuotaBackendUnavailableException(Throwable cause) {
            super("Gateway quota backend unavailable", cause);
        }
    }

    static final class RequestCapacityExceededException extends GatewayQuotaException {
        RequestCapacityExceededException() {
            super("Gateway request capacity exceeded", null);
        }
    }
}
