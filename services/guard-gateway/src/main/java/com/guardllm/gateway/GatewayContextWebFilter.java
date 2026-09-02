package com.guardllm.gateway;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

@Component
public final class GatewayContextWebFilter implements WebFilter {
    public static final String CONTEXT_ATTRIBUTE = GatewayRequestContext.class.getName();
    private final GatewayContextAuthenticator authenticator;

    public GatewayContextWebFilter(GatewayContextAuthenticator authenticator) {
        this.authenticator = authenticator;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        if (!exchange.getRequest().getPath().value().startsWith("/v1/")) {
            return chain.filter(exchange);
        }
        try {
            var context = authenticator.authenticate(exchange.getRequest().getHeaders());
            exchange.getAttributes().put(CONTEXT_ATTRIBUTE, context);
            return chain.filter(exchange);
        } catch (RuntimeException ignored) {
            return reject(exchange);
        }
    }

    private static Mono<Void> reject(ServerWebExchange exchange) {
        exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
        return exchange.getResponse().setComplete();
    }
}
