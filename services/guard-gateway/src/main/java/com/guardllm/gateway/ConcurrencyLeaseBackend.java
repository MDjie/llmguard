package com.guardllm.gateway;

import java.time.Duration;
import java.util.List;
import reactor.core.publisher.Mono;

interface ConcurrencyLeaseBackend {
    Mono<Lease> acquire(List<String> keys, List<Long> limits, Duration ttl);

    interface Lease {
        Mono<Void> release();
    }

    final class RejectedException extends RuntimeException {
        RejectedException() {
            super("distributed concurrency capacity is full");
        }
    }
}
