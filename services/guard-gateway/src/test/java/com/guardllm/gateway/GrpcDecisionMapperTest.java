package com.guardllm.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class GrpcDecisionMapperTest {
    @Test
    void preservesTraceActionObservationAndEvidence() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        GuardDecision source = new GuardDecision(
                "1.0", "decision-1", "trace-1234567890123456", "BLOCK", "HIGH",
                mapper.readTree("[{\"detectorId\":\"rules\",\"detectorVersion\":\"1\",\"riskType\":\"prompt_injection\",\"score\":0.9,\"severity\":\"HIGH\",\"status\":\"MATCH\",\"evidence\":[{\"viewId\":\"normalized\",\"contentHmac\":\"" + "a".repeat(64) + "\"}]}]"),
                mapper.readTree("[\"mandatory-deny\"]"), "bundle-1", 12,
                mapper.readTree("[]"), null);
        var result = new GrpcDecisionMapper().toProto(source, source.traceId());
        assertEquals(source.traceId(), result.getTraceId());
        assertEquals(io.guardllm.contracts.v1.proto.GuardAction.GUARD_ACTION_BLOCK, result.getAction());
        assertEquals(1, result.getObservationsCount());
        assertEquals(1, result.getObservations(0).getEvidenceCount());
        assertEquals("mandatory-deny", result.getPolicyPath(0));
    }
}
