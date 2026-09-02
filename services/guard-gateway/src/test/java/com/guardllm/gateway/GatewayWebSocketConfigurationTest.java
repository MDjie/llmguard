package com.guardllm.gateway;

import static org.junit.jupiter.api.Assertions.assertSame;

import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.web.reactive.handler.SimpleUrlHandlerMapping;

class GatewayWebSocketConfigurationTest {
    @Test
    void registersTheGuardedWebSocketEndpoint() {
        var handler = Mockito.mock(ChatWebSocketHandler.class);
        var mapping = (SimpleUrlHandlerMapping) new GatewayWebSocketConfiguration()
                .guardWebSocketHandlerMapping(handler);
        assertSame(handler, mapping.getUrlMap().get("/v1/chat/completions/ws"));
    }
}
