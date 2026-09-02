package com.guardllm.gateway;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("guard.gateway.model-routing")
public record GatewayModelRoutingProperties(String routesJson) {
    public GatewayModelRoutingProperties {
        routesJson = routesJson == null ? "" : routesJson.trim();
    }
}
