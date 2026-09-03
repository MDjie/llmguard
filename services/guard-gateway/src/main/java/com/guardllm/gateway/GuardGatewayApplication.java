package com.guardllm.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties({
        GuardGatewayProperties.class,
        GatewayTlsProperties.class,
        GrpcServerProperties.class,
        GatewayRateLimitProperties.class,
        GatewayConcurrencyProperties.class,
        GatewayDistributedConcurrencyProperties.class,
        GatewayModelRoutingProperties.class,
        StreamingCommitGateProperties.class
})
public class GuardGatewayApplication {
    public static void main(String[] args) {
        SpringApplication.run(GuardGatewayApplication.class, args);
    }
}
