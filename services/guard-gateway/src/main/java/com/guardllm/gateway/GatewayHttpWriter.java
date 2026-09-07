package com.guardllm.gateway;

import io.netty.buffer.Unpooled;
import io.netty.handler.codec.http.DefaultHttpContent;
import java.nio.charset.StandardCharsets;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.http.server.reactive.ServerHttpResponseDecorator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.netty.http.server.HttpServerResponse;
import tools.jackson.databind.ObjectMapper;

final class GatewayHttpWriter implements GatewayWindowWriter {
    private final ServerHttpResponse response;
    private final ObjectMapper json;
    private final boolean stream;
    private boolean windowStarted;
    GatewayHttpWriter(ServerHttpResponse response, ObjectMapper json, boolean stream) { this.response = response; this.json = json; this.stream = stream; }
    private void headers(GuardedChatService.Reply reply) {
        response.getHeaders().set("Cache-Control", "no-store");
        response.getHeaders().set("X-Request-Id", reply.requestId());
        response.getHeaders().set("X-Guard-Snapshot-Id", reply.snapshotId());
        response.getHeaders().set("X-Guard-Input-Action", reply.inputAction());
        response.getHeaders().set("X-Guard-Output-Action", reply.outputAction());
        response.getHeaders().set("X-Guard-Decision-Id", reply.decisionId());
        response.getHeaders().setContentType(stream ? MediaType.TEXT_EVENT_STREAM : MediaType.APPLICATION_JSON);
    }
    @Override public Mono<Void> apply(GuardedChatService.Reply reply) {
        headers(reply);
        if (stream) return response.writeWith(Flux.fromIterable(reply.events()).map(event -> response.bufferFactory().wrap(("data: " + event.data() + "\n\n").getBytes(StandardCharsets.UTF_8))));
        return response.writeWith(Mono.just(response.bufferFactory().wrap(json.writeValueAsBytes(reply.body()))));
    }
    @Override public Mono<Void> writeWindow(GuardedChatService.Reply reply) {
        return Mono.defer(() -> {
            HttpServerResponse transport = ServerHttpResponseDecorator.getNativeResponse(response);
            if (!windowStarted) {
                headers(reply);
                response.getHeaders().forEach((name, values) -> transport.responseHeaders().set(name, values));
                transport.chunkedTransfer(true); windowStarted = true;
            }
            StringBuilder wire = new StringBuilder();
            reply.events().forEach(event -> wire.append("data: ").append(event.data()).append("\n\n"));
            // Object send completion is Netty's writeAndFlush ChannelFuture, not an
            // upstream publisher's onNext. Do not nest this inside another send.
            return transport.sendHeaders().then().then(Mono.defer(() -> transport.sendObject(new DefaultHttpContent(Unpooled.wrappedBuffer(wire.toString().getBytes(StandardCharsets.UTF_8)))).then()));
        });
    }
    boolean windowStarted() { return windowStarted; }
    Mono<Void> terminateWindow(String code) {
        return Mono.defer(() -> {
            HttpServerResponse transport = ServerHttpResponseDecorator.getNativeResponse(response);
            String data = json.writeValueAsString(java.util.Map.of("error", java.util.Map.of("code", code, "retryable", false), "guard", java.util.Map.of("status", "TERMINATED", "deliveryConfirmed", false)));
            return transport.sendObject(new DefaultHttpContent(Unpooled.wrappedBuffer(("event: guard.terminated\ndata: " + data + "\n\n").getBytes(StandardCharsets.UTF_8)))).then();
        });
    }
}
