package com.guardllm.gateway;

import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.HandlerMapping;
import org.springframework.web.reactive.handler.SimpleUrlHandlerMapping;
import org.springframework.web.reactive.socket.WebSocketHandler;
import org.springframework.web.reactive.socket.server.support.WebSocketHandlerAdapter;

@Configuration
class GatewayWebSocketConfiguration {
    @Bean
    HandlerMapping guardWebSocketHandlerMapping(ChatWebSocketHandler handler) {
        Map<String, WebSocketHandler> handlers = Map.of(
                "/v1/chat/completions/ws", handler);
        return new SimpleUrlHandlerMapping(handlers, -2);
    }

    @Bean
    WebSocketHandlerAdapter guardWebSocketHandlerAdapter() {
        return new WebSocketHandlerAdapter();
    }
}
