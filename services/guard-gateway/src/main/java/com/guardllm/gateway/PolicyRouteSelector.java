package com.guardllm.gateway;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.stereotype.Component;

@Component
public final class PolicyRouteSelector {
    private final GuardGatewayProperties properties;

    public PolicyRouteSelector(GuardGatewayProperties properties) {
        this.properties = properties;
    }

    public String select(String routingKey) {
        if (properties.canaryBundleId() == null || properties.canaryBundleId().isBlank()
                || properties.canaryPercent() == 0) {
            return properties.activeBundleId();
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(routingKey.getBytes(StandardCharsets.UTF_8));
            long firstFourBytes = ((digest[0] & 0xffL) << 24) | ((digest[1] & 0xffL) << 16)
                    | ((digest[2] & 0xffL) << 8) | (digest[3] & 0xffL);
            return firstFourBytes % 100 < properties.canaryPercent()
                    ? properties.canaryBundleId() : properties.activeBundleId();
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }
}
