package com.guardllm.gateway;

import java.util.Map;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@RestController
public final class ChatProxyController {
    private final GuardedChatService service;
    private final ObjectMapper json;
    public ChatProxyController(GuardedChatService service, ObjectMapper json) { this.service = service; this.json = json; }
    @PostMapping(path = {"/v1/chat/completions", "/v1/chat/completions/stream"})
    public Mono<Void> chat(@RequestBody JsonNode original, ServerWebExchange exchange) {
        JsonNode request = original.deepCopy();
        if (!(request instanceof ObjectNode object)) return problem(exchange, new GatewayFailure("REQUEST_OBJECT_REQUIRED", 400));
        if (exchange.getRequest().getPath().value().endsWith("/stream")) object.put("stream", true);
        var writer = new GatewayHttpWriter(exchange.getResponse(), json, request.path("stream").asBoolean());
        return service.handle(request, exchange.getRequest().getHeaders(), writer).onErrorResume(error -> {
            if (writer.windowStarted()) return writer.terminateWindow(error instanceof GatewayFailure failure ? failure.code() : "GATEWAY_UNAVAILABLE").onErrorResume(ignored -> Mono.empty());
            return problem(exchange, error);
        });
    }
    private Mono<Void> problem(ServerWebExchange exchange, Throwable error) {
        var response = exchange.getResponse();
        if (response.isCommitted()) return response.setComplete();
        int status = error instanceof GatewayFailure failure ? failure.status() : error instanceof java.util.concurrent.TimeoutException ? 504 : 503;
        String code = error instanceof GatewayFailure failure ? failure.code() : status == 504 ? "GATEWAY_DEADLINE_EXCEEDED" : "GATEWAY_UNAVAILABLE";
        response.setStatusCode(HttpStatusCode.valueOf(status)); response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        response.getHeaders().set("Cache-Control", "no-store");
        return response.writeWith(Mono.just(response.bufferFactory().wrap(json.writeValueAsBytes(Map.of("error", Map.of("code", code, "retryable", status >= 500))))));
    }
}
