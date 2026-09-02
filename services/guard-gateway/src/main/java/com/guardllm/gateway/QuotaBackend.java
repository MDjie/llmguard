package com.guardllm.gateway;

import java.time.Duration;
import java.util.List;
import reactor.core.publisher.Mono;

interface QuotaBackend {
    Mono<Boolean> consume(
            List<String> keys,
            List<Long> costs,
            List<Long> limits,
            Duration window);
}
