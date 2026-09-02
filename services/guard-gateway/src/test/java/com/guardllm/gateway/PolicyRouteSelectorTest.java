package com.guardllm.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.time.Duration;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

class PolicyRouteSelectorTest {
    @Test
    void canarySelectionIsStableAndBounded() {
        var selector = new PolicyRouteSelector(properties(20));
        long canary = IntStream.range(0, 100).mapToObj(i -> selector.select("request-" + i))
                .filter("canary"::equals).count();
        assertTrue(canary > 5 && canary < 40);
        assertEquals(selector.select("same-request"), selector.select("same-request"));
    }

    private static GuardGatewayProperties properties(int canaryPercent) {
        return new GuardGatewayProperties(
                "0123456789abcdef0123456789abcdef", URI.create("http://localhost:5000"), "key",
                URI.create("http://localhost:9000"), "", "active", "canary", canaryPercent,
                "shadow", Duration.ofSeconds(20), 10);
    }
}
