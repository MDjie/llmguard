package com.guardllm.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import tools.jackson.databind.ObjectMapper;

class StreamingCommitGateTest {
    @Test
    void detectsTextSplitAcrossChunksAndStopsUnsafeOutput() {
        var gate = gate(Duration.ofMillis(150), 8_192);
        var upstream = Flux.just(
                event("{\"choices\":[{\"delta\":{\"content\":\"for\"}}]}"),
                event("{\"choices\":[{\"delta\":{\"content\":\"bidden\"}}]}"),
                event("{\"choices\":[{\"delta\":{\"content\":\" leaked\"}}]}"),
                event("[DONE]"));
        StepVerifier.create(gate.gate(upstream, text -> Mono.just(decision(text.contains("forbidden")))))
                .assertNext(item -> assertEquals("message", item.event()))
                .assertNext(item -> assertEquals("[DONE]", item.data()))
                .verifyComplete();
    }

    @Test
    void rejectsMalformedUpstreamEventsRatherThanPassingThemThrough() {
        var gate = gate(Duration.ofMillis(150), 8_192);
        StepVerifier.create(gate.gate(Flux.just(event("{broken")), text -> Mono.just(decision(false))))
                .expectErrorMatches(error -> error instanceof IllegalArgumentException &&
                        error.getMessage().contains("malformed"))
                .verify();
    }

    @Test
    void releasesASemanticUnitOnlyAfterGuardApproval() {
        var gate = gate(Duration.ofMillis(150), 8_192);
        var evaluated = new AtomicBoolean();
        var safe = event("{\"choices\":[{\"delta\":{\"content\":\"Safe sentence.\"}}]}");
        StepVerifier.create(gate.gate(Flux.just(safe, event("[DONE]")), text -> {
            assertFalse(text.isEmpty());
            evaluated.set(true);
            return Mono.just(decision(false));
        }))
                .assertNext(item -> {
                    assertEquals(safe.data(), item.data());
                    assertEquals(true, evaluated.get());
                })
                .assertNext(item -> assertEquals("[DONE]", item.data()))
                .verifyComplete();
    }

    @Test
    void flushesAnIncompleteSentenceAtTheMaximumWait() {
        var gate = gate(Duration.ofMillis(100), 8_192);
        var partial = event("{\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}");
        Flux<ServerSentEvent<String>> upstream = Flux.concat(
                Flux.just(partial),
                Mono.delay(Duration.ofMillis(500)).map(ignored -> event("[DONE]")));
        StepVerifier.withVirtualTime(() -> gate.gate(upstream, text -> Mono.just(decision(false))))
                .expectSubscription()
                .expectNoEvent(Duration.ofMillis(99))
                .thenAwait(Duration.ofMillis(1))
                .assertNext(item -> assertEquals(partial.data(), item.data()))
                .thenAwait(Duration.ofMillis(400))
                .assertNext(item -> assertEquals("[DONE]", item.data()))
                .verifyComplete();
    }

    @Test
    void failsClosedWithoutLeakingAnOversizedChunkOrGuardFailure() {
        var gate = gate(Duration.ofMillis(150), 256);
        String oversized = "x".repeat(257);
        var oversizedEvent = event(
                "{\"choices\":[{\"delta\":{\"content\":\"" + oversized + "\"}}]}");
        StepVerifier.create(gate.gate(Flux.just(oversizedEvent), text -> Mono.just(decision(false))))
                .assertNext(item -> assertEquals("message", item.event()))
                .assertNext(item -> assertEquals("[DONE]", item.data()))
                .verifyComplete();

        var ordinary = event("{\"choices\":[{\"delta\":{\"content\":\"ordinary.\"}}]}");
        StepVerifier.create(gate.gate(Flux.just(ordinary), text -> Mono.error(
                        new IllegalStateException("guard unavailable"))))
                .assertNext(item -> assertEquals("message", item.event()))
                .assertNext(item -> assertEquals("[DONE]", item.data()))
                .verifyComplete();
    }

    private static StreamingCommitGate gate(Duration maximumWait, int maximumUncommittedChars) {
        return new StreamingCommitGate(
                new ObjectMapper(),
                new StreamingCommitGateProperties(
                        maximumWait,
                        maximumUncommittedChars,
                        Math.max(maximumUncommittedChars, 32_768)));
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
