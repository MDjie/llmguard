package com.guardllm.gateway;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.socket.CloseStatus;
import org.springframework.web.reactive.socket.WebSocketHandler;
import org.springframework.web.reactive.socket.WebSocketMessage;
import org.springframework.web.reactive.socket.WebSocketSession;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@Component
final class ChatWebSocketHandler implements WebSocketHandler {
    private final GuardedChatService service;
    private final ObjectMapper json;
    ChatWebSocketHandler(GuardedChatService service, ObjectMapper json) { this.service = service; this.json = json; }
    @Override
    public Mono<Void> handle(WebSocketSession session) {
        // One business completion per connection makes send completion and cancellation
        // unambiguous. Reconnect for the next turn, retaining x-session-id if desired.
        var accepted = new AtomicBoolean();
        // Keep receiving subscribed while the guarded send is in flight. next()/take(1)
        // cancels Reactor Netty inbound and closes the socket before the send completes.
        return session.receive().timeout(Mono.delay(Duration.ofSeconds(15)), ignored -> Mono.never()).concatMap(message -> {
            if (!accepted.compareAndSet(false, true)) return session.close(CloseStatus.POLICY_VIOLATION);
            if (message.getType() != WebSocketMessage.Type.TEXT || message.getPayload().readableByteCount() > 1048576) return session.close(CloseStatus.POLICY_VIOLATION);
            JsonNode request;
            try { request = json.readTree(message.getPayloadAsText()); }
            catch (RuntimeException error) { return session.close(CloseStatus.BAD_DATA); }
            if (!(request instanceof ObjectNode object)) return session.close(CloseStatus.BAD_DATA);
            object.put("stream", true);
            HttpHeaders identity = new HttpHeaders(); identity.addAll(session.getHandshakeInfo().getHeaders());
            return service.handle(request, identity, reply -> session.send(Flux.fromIterable(reply.events()).map(event -> session.textMessage(event.data()))))
                    .then(Mono.defer(() -> session.close(CloseStatus.NORMAL)))
                    .onErrorResume(error -> session.close(CloseStatus.POLICY_VIOLATION));
        }, 1).then().onErrorResume(error -> session.close(CloseStatus.POLICY_VIOLATION));
    }
}
