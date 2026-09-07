package com.guardllm.gateway;

import java.net.URI;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import static org.junit.jupiter.api.Assertions.*;

class ModelRoutingSnapshotTest {
    private final ObjectMapper json = new ObjectMapper();
    @Test void endpointAndBoundaryDriftCannotUseAnExistingSnapshot() {
        var registry = new ModelRouteRegistry(json, null, URI.create("https://model.example/v1"), "private-secret", name -> null);
        var boundaries = json.readTree("{\"default\":[\"internal\"]}");
        String canonical = CanonicalJson.encode(registry.signedConfiguration(json, boundaries));
        assertFalse(canonical.contains("private-secret"));
        var manifest = json.createObjectNode();
        manifest.putObject("modelRouting").put("configurationJson", canonical).put("configurationDigest", CanonicalJson.sha256(canonical));
        assertDoesNotThrow(() -> registry.validateSnapshot(json, manifest, boundaries));
        var changed = new ModelRouteRegistry(json, null, URI.create("https://other.example/v1"), "private-secret", name -> null);
        assertThrows(GatewayFailure.class, () -> changed.validateSnapshot(json, manifest, boundaries));
        assertThrows(GatewayFailure.class, () -> registry.validateSnapshot(json, manifest, json.readTree("{\"default\":[\"public\"]}")));
        assertThrows(GatewayFailure.class, () -> registry.validateSnapshot(json, json.createObjectNode(), boundaries));
    }
    @Test void explicitRouteIdCannotFallIntoAnotherWildcardDestination() {
        var registry = new ModelRouteRegistry(json, "[{\"id\":\"test\",\"baseUrl\":\"https://internal.example\",\"weight\":1},{\"id\":\"public\",\"baseUrl\":\"https://public.example\",\"weight\":100,\"modelPattern\":\"*\"}]", URI.create("https://unused.example"), "", name -> null);
        for (int i = 0; i < 100; i++) assertEquals("test", registry.select(json.readTree("{\"model\":\"test\"}"), "session" + i).routeId());
    }
}
