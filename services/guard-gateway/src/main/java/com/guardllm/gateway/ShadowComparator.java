package com.guardllm.gateway;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

@Component
final class ShadowComparator {
    private static final Logger LOG = LoggerFactory.getLogger(ShadowComparator.class);
    private final GuardClient guardClient;
    private final GuardGatewayProperties properties;
    private final Counter differences;

    ShadowComparator(GuardClient guardClient, GuardGatewayProperties properties, MeterRegistry registry) {
        this.guardClient = guardClient;
        this.properties = properties;
        this.differences = registry.counter("guard_gateway_shadow_decision_differences_total");
    }

    Mono<Void> compare(String text, String direction, GatewayRequestContext context, GuardDecision primary) {
        if (properties.shadowBundleId() == null || properties.shadowBundleId().isBlank()) return Mono.empty();
        return guardClient.evaluate(text, direction, context, properties.shadowBundleId(), true)
                .doOnNext(shadow -> {
                    if (!primary.action().equals(shadow.action())) differences.increment();
                    LOG.info("shadow_decision requestId={} primaryBundle={} primaryAction={} shadowBundle={} shadowAction={}",
                            context.requestId(), primary.bundleId(), primary.action(), shadow.bundleId(), shadow.action());
                })
                .onErrorResume(error -> {
                    LOG.warn("shadow_evaluation_failed requestId={} type={}",
                            context.requestId(), error.getClass().getSimpleName());
                    return Mono.empty();
                }).then();
    }
}
