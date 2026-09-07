package com.guardllm.gateway;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

class RagPreparedSegmentsTest {
    private final ObjectMapper json = new ObjectMapper();
    @Test void acceptsBoundRagTextAndPreservesItsSourceOnInputRecheck() {
        var content = new StructuredContent(json);
        var request = json.readTree("{\"model\":\"test\",\"messages\":[{\"role\":\"user\",\"content\":\"retrieved data\"}]}");
        var supplied = content.segments(request, true, 1000); ((ObjectNode) supplied.get(0)).put("sourceType", "RAG");
        assertEquals(supplied, content.authorizedSegments(request, supplied, 1000));
        assertEquals("RAG", content.inheritSources(content.segments(request, true, 1000), supplied).get(0).path("sourceType").stringValue());
        var tampered = supplied.deepCopy(); ((ObjectNode) tampered.get(0)).put("text", "other data");
        assertThrows(GatewayFailure.class, () -> content.authorizedSegments(request, tampered, 1000));
    }
    @Test void preservesFileSourceAndRejectsSystemEscalation() {
        var content = new StructuredContent(json);
        var request = json.readTree("{\"model\":\"test\",\"messages\":[{\"role\":\"user\",\"content\":\"file text\"}]}");
        var supplied = content.segments(request, true, 1000); ((ObjectNode) supplied.get(0)).put("sourceType", "FILE");
        assertEquals(supplied, content.authorizedSegments(request, supplied, 1000));
        assertEquals("FILE", content.inheritSources(content.segments(request, true, 1000), supplied).get(0).path("sourceType").stringValue());
        ((ObjectNode) supplied.get(0)).put("role", "system");
        assertThrows(GatewayFailure.class, () -> content.authorizedSegments(request, supplied, 1000));
    }
    @Test void referenceCannotAcquireSystemRoleOrToolPermission() {
        var content = new StructuredContent(json);
        var system = json.readTree("{\"model\":\"test\",\"messages\":[{\"role\":\"system\",\"content\":\"protected\"}]}");
        var supplied = content.segments(system, true, 1000); ((ObjectNode) supplied.get(0)).put("sourceType", "RAG");
        assertThrows(GatewayFailure.class, () -> content.authorizedSegments(system, supplied, 1000));
        ((ObjectNode) supplied.get(0)).put("sourceType", "TOOL");
        assertThrows(GatewayFailure.class, () -> content.authorizedSegments(system, supplied, 1000));
    }
}
