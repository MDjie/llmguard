package com.guardllm.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

class GatewayRateLimiterTest {
    private final GatewayRequestContext context = new GatewayRequestContext(
            "tenant-1", "application-1", "user-1", "credential-1",
            "request-1", "trace-1234567890123456",
            "session-1", System.currentTimeMillis() + 10_000);

    @Test
    void appliesRequestAndCharacterLimitsAcrossAllScopedKeys() {
        var calls = new AtomicInteger();
        QuotaBackend backend = (keys, costs, limits, window) -> {
            calls.incrementAndGet();
            assertEquals(18, keys.size());
            assertEquals(18, costs.size());
            assertEquals(18, limits.size());
            assertEquals(13L, costs.get(2));
            assertEquals(Duration.ofMinutes(1), window);
            return Mono.just(false);
        };
        var limiter = new GatewayRateLimiter(
                backend, new GatewayRateLimitProperties(true, true, 10, 1_000, 250, 100));
        StepVerifier.create(limiter.check(context, "chat.complete", 50))
                .expectError(GatewayRateLimiter.QuotaExceededException.class)
                .verify();
        assertEquals(1, calls.get());
    }

    @Test
    void failsClosedWhenTheDistributedBackendIsUnavailable() {
        QuotaBackend backend = (keys, costs, limits, window) ->
                Mono.error(new IllegalStateException("redis unavailable"));
        var limiter = new GatewayRateLimiter(
                backend, new GatewayRateLimitProperties(true, true, 10, 1_000, 250, 100));
        StepVerifier.create(limiter.check(context, "chat.complete", 50))
                .expectError(GatewayRateLimiter.QuotaBackendUnavailableException.class)
                .verify();
    }

    @Test
    void canFailOpenOnlyWhenExplicitlyConfigured() {
        QuotaBackend backend = (keys, costs, limits, window) ->
                Mono.error(new IllegalStateException("redis unavailable"));
        var limiter = new GatewayRateLimiter(
                backend, new GatewayRateLimitProperties(true, false, 10, 1_000, 250, 100));
        StepVerifier.create(limiter.check(context, "chat.complete", 50))
                .verifyComplete();
    }

    @Test
    void rejectsOversizedInputBeforeCallingRedis() {
        var calls = new AtomicInteger();
        QuotaBackend backend = (keys, costs, limits, window) -> {
            calls.incrementAndGet();
            return Mono.just(true);
        };
        var limiter = new GatewayRateLimiter(
                backend, new GatewayRateLimitProperties(true, true, 10, 1_000, 250, 49));
        StepVerifier.create(limiter.check(context, "chat.complete", 50))
                .expectError(GatewayRateLimiter.RequestCapacityExceededException.class)
                .verify();
        assertEquals(0, calls.get());
    }
}
