package com.guardllm.gateway;

import java.util.function.Function;
import reactor.core.publisher.Mono;

/** Each completion acknowledges a socket write, never client receipt. */
interface GatewayWindowWriter extends Function<GuardedChatService.Reply, Mono<Void>> {
    Mono<Void> writeWindow(GuardedChatService.Reply reply);
}
