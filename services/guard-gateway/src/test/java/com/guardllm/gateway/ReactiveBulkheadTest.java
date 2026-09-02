package com.guardllm.gateway;

import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Flux;
import reactor.test.StepVerifier;
import reactor.test.publisher.TestPublisher;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

class ReactiveBulkheadTest {
    private static GatewayRequestContext context(
            String tenant,
            String application,
            String principal,
            String credential) {
        return new GatewayRequestContext(
                tenant,
                application,
                principal,
                credential,
                "req-1",
                "trace-1",
                "session-1",
                System.currentTimeMillis() + 10_000);
    }

    @Test
    void rejectsBeyondCapacityAndReleasesOnCancellation() {
        var bulkhead = new ReactiveBulkhead(1);
        var held = TestPublisher.<String>create();
        var first = bulkhead.execute(held::mono).subscribe();
        StepVerifier.create(bulkhead.execute(() -> Mono.just("second")))
                .expectError(ReactiveBulkhead.BulkheadFullException.class).verify();
        first.dispose();
        StepVerifier.create(bulkhead.execute(() -> Mono.just("after-cancel")))
                .expectNext("after-cancel").verifyComplete();
    }

    @Test
    void fluxBulkheadReleasesOnCancellation() {
        var bulkhead = new ReactiveBulkhead(1);
        var held = TestPublisher.<String>create();
        var first = bulkhead.executeFlux(held::flux).subscribe();
        StepVerifier.create(bulkhead.executeFlux(() -> Flux.just("second")))
                .expectError(ReactiveBulkhead.BulkheadFullException.class).verify();
        first.dispose();
        StepVerifier.create(bulkhead.executeFlux(() -> Flux.just("after-cancel")))
                .expectNext("after-cancel").verifyComplete();
    }

    @Test
    void isolatesApplicationsAndRollsBackPartialAcquisition() {
        var config = new GatewayConcurrencyProperties(true, 10, 1, 10, 10, 10, 100);
        var bulkhead = new ReactiveBulkhead(10, config);
        var held = TestPublisher.<String>create();
        var firstContext = context("tenant-a", "app-a", "user-a", "credential-a");
        var secondApplication = context("tenant-a", "app-b", "user-b", "credential-b");
        var first = bulkhead.execute(firstContext, "chat.complete", held::mono).subscribe();

        StepVerifier.create(bulkhead.execute(firstContext, "chat.complete", () -> Mono.just("blocked")))
                .expectErrorSatisfies(error -> {
                    var full = (ReactiveBulkhead.BulkheadFullException) error;
                    org.junit.jupiter.api.Assertions.assertEquals("application", full.scope());
                })
                .verify();
        StepVerifier.create(bulkhead.execute(
                        secondApplication,
                        "chat.complete",
                        () -> Mono.just("isolated")))
                .expectNext("isolated")
                .verifyComplete();

        first.dispose();
        StepVerifier.create(bulkhead.execute(
                        firstContext,
                        "chat.complete",
                        () -> Mono.just("released")))
                .expectNext("released")
                .verifyComplete();
    }

    @Test
    void releasesLeaseWhenSupplierThrowsSynchronously() {
        var bulkhead = new ReactiveBulkhead(1);
        StepVerifier.create(bulkhead.execute(() -> {
            throw new IllegalStateException("boom");
        })).expectError(IllegalStateException.class).verify();
        StepVerifier.create(bulkhead.execute(() -> Mono.just("after-error")))
                .expectNext("after-error")
                .verifyComplete();
    }

    @Test
    void rejectsScopeRegistryOverflowWithoutConsumingGlobalCapacity() {
        var config = new GatewayConcurrencyProperties(true, 10, 10, 10, 10, 10, 4);
        var bulkhead = new ReactiveBulkhead(1, config);
        var scoped = context("tenant-a", "app-a", "user-a", "credential-a");
        StepVerifier.create(bulkhead.execute(scoped, "chat.complete", () -> Mono.just("blocked")))
                .expectErrorSatisfies(error -> {
                    var full = (ReactiveBulkhead.BulkheadFullException) error;
                    org.junit.jupiter.api.Assertions.assertEquals("scope-registry", full.scope());
                })
                .verify();
        StepVerifier.create(bulkhead.execute(() -> Mono.just("global-still-free")))
                .expectNext("global-still-free")
                .verifyComplete();
    }

    @Test
    void acquiresAndReleasesDistributedScopesOnCompletion() {
        var releases = new AtomicInteger();
        ConcurrencyLeaseBackend backend = (keys, limits, ttl) -> {
            org.junit.jupiter.api.Assertions.assertEquals(5, keys.size());
            org.junit.jupiter.api.Assertions.assertEquals(5, limits.size());
            org.junit.jupiter.api.Assertions.assertTrue(keys.stream().allMatch(
                    key -> key.startsWith("guard:concurrency:{")));
            org.junit.jupiter.api.Assertions.assertTrue(ttl.compareTo(Duration.ofSeconds(5)) >= 0);
            return Mono.just(() -> Mono.fromRunnable(releases::incrementAndGet));
        };
        var bulkhead = new ReactiveBulkhead(
                10,
                new GatewayConcurrencyProperties(true, 10, 10, 10, 10, 10, 100),
                new GatewayDistributedConcurrencyProperties(true, true, Duration.ofSeconds(30)),
                backend);
        StepVerifier.create(bulkhead.execute(
                        context("tenant-a", "app-a", "user-a", "credential-a"),
                        "chat.complete",
                        () -> Mono.just("done")))
                .expectNext("done")
                .verifyComplete();
        org.junit.jupiter.api.Assertions.assertEquals(1, releases.get());
    }

    @Test
    void failsClosedOrOpenAccordingToDistributedBackendPolicy() {
        ConcurrencyLeaseBackend unavailable = (keys, limits, ttl) ->
                Mono.error(new IllegalStateException("redis unavailable"));
        var local = new GatewayConcurrencyProperties(true, 10, 10, 10, 10, 10, 100);
        var request = context("tenant-a", "app-a", "user-a", "credential-a");
        var closed = new ReactiveBulkhead(
                10,
                local,
                new GatewayDistributedConcurrencyProperties(true, true, Duration.ofSeconds(30)),
                unavailable);
        StepVerifier.create(closed.execute(request, "chat.complete", () -> Mono.just("denied")))
                .expectError(ReactiveBulkhead.DistributedBackendUnavailableException.class)
                .verify();

        var open = new ReactiveBulkhead(
                10,
                local,
                new GatewayDistributedConcurrencyProperties(true, false, Duration.ofSeconds(30)),
                unavailable);
        StepVerifier.create(open.execute(request, "chat.complete", () -> Mono.just("allowed")))
                .expectNext("allowed")
                .verifyComplete();
    }

    @Test
    void mapsDistributedCapacityRejectionWithoutRunningOperation() {
        var executions = new AtomicInteger();
        ConcurrencyLeaseBackend full = (keys, limits, ttl) ->
                Mono.error(new ConcurrencyLeaseBackend.RejectedException());
        var bulkhead = new ReactiveBulkhead(
                10,
                new GatewayConcurrencyProperties(true, 10, 10, 10, 10, 10, 100),
                new GatewayDistributedConcurrencyProperties(true, true, Duration.ofSeconds(30)),
                full);
        StepVerifier.create(bulkhead.execute(
                        context("tenant-a", "app-a", "user-a", "credential-a"),
                        "chat.complete",
                        () -> {
                            executions.incrementAndGet();
                            return Mono.just("unexpected");
                        }))
                .expectErrorSatisfies(error -> {
                    var rejected = (ReactiveBulkhead.BulkheadFullException) error;
                    org.junit.jupiter.api.Assertions.assertEquals("distributed", rejected.scope());
                })
                .verify();
        org.junit.jupiter.api.Assertions.assertEquals(0, executions.get());
    }
}
