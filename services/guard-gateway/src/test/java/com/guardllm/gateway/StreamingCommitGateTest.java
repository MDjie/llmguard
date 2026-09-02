package com.guardllm.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import tools.jackson.databind.ObjectMapper;

class StreamingCommitGateTest {
    @Test
    void detectsTextSplitAcrossChunksAndStopsUnsafeOutput() {
        var gate = new StreamingCommitGate(new ObjectMapper());
        var upstream = Flux.just(
                event("{\"choices\":[{\"delta\":{\"content\":\"for\"}}]}"),
                event("{\"choices\":[{\"delta\":{\"content\":\"bidden\"}}]}"),
                event("{\"choices\":[{\"delta\":{\"content\":\" leaked\"}}]}"),
                event("[DONE]"));
        StepVerifier.create(gate.gate(upstream, text -> Mono.just(decision(text.contains("forbidden")))))
                .assertNext(item -> assertEquals(
                        "{\"choices\":[{\"delta\":{\"content\":\"for\"}}]}", item.data()))
                .assertNext(item -> assertEquals("message", item.event()))
                .assertNext(item -> assertEquals("[DONE]", item.data()))
                .verifyComplete();
    }

    @Test
    void rejectsMalformedUpstreamEventsRatherThanPassingThemThrough() {
        var gate = new StreamingCommitGate(new ObjectMapper());
        StepVerifier.create(gate.gate(Flux.just(event("{broken")), text -> Mono.just(decision(false))))
                .expectErrorMatches(error -> error instanceof IllegalArgumentException &&
                        error.getMessage().contains("malformed"))
                .verify();
    }

    private static ServerSentEvent<String> event(String data) {
        return ServerSentEvent.builder(data).build();
    }

    private static GuardDecision decision(boolean blocked) {
        return new GuardDecision(
                "1.0", "decision-1", "trace-1", blocked ? "BLOCK" : "ALLOW",
                blocked ? "HIGH" : "NONE", new ObjectMapper().valueToTree(List.of()),
                new ObjectMapper().valueToTree(List.of()), "bundle-1", 1,
                new ObjectMapper().valueToTree(List.of()), null);
    }
}
