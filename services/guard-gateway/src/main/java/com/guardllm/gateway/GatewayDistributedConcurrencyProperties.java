package com.guardllm.gateway;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("guard.gateway.concurrency.distributed")
public record GatewayDistributedConcurrencyProperties(
        boolean enabled,
        boolean failClosed,
        Duration leaseTtl) {
    public GatewayDistributedConcurrencyProperties {
        leaseTtl = leaseTtl == null ? Duration.ofSeconds(30) : leaseTtl;
        if (leaseTtl.compareTo(Duration.ofSeconds(5)) < 0
                || leaseTtl.compareTo(Duration.ofMinutes(10)) > 0) {
            throw new IllegalArgumentException("distributed concurrency lease-ttl must be 5s..10m");
        }
    }
}
