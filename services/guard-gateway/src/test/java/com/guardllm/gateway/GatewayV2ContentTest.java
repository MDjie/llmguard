package com.guardllm.gateway;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;
import tools.jackson.databind.json.JsonMapper;

class GatewayV2ContentTest {
    private final JsonMapper json = JsonMapper.builder().build();
    @Test void nativeBytesHaveIdenticalMetadataAndUntrustedUrlsFailClosed() {
        var content = new StructuredContent(json);
        String template = "{\"model\":\"test\",\"messages\":[{\"role\":\"user\",\"content\":[%s]}]}";
        var request = json.readTree(template.formatted("{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,YQ==\"}}"));
        var segment = content.segments(request, true, 1000).get(0);
        assertEquals("FILE", segment.path("sourceType").asText());
        assertEquals("/messages/0/content/0", segment.path("contentPath").asText());
        assertEquals("{\"bytes\":1,\"kind\":\"native_media\",\"mimeType\":\"image/png\",\"modality\":\"IMAGE\",\"sha256\":\"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb\"}", segment.path("text").asText());
        assertThrows(GatewayFailure.class, () -> content.segments(json.readTree(template.formatted("{\"type\":\"image_url\",\"image_url\":{\"url\":\"https://untrusted.example/a.png\"}}")), true, 1000));
        assertThrows(GatewayFailure.class, () -> content.segments(json.readTree(template.formatted("{\"type\":\"input_audio\",\"input_audio\":{\"format\":\"wav\",\"data\":\"YQ\"}}")), true, 1000));
        assertThrows(GatewayFailure.class, () -> content.segments(json.readTree("{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,YQ==\"}}]}}]}"), false, 1000));
    }
    @Test void nativeOutputNeverBecomesTextCoverageThroughResponseMapping() {
        for (String value : new String[]{"{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"caption\",\"audio\":{\"data\":\"secret-audio\"}}}]}", "{\"choices\":[{\"delta\":{\"content\":[{\"type\":\"video_url\",\"video_url\":{\"url\":\"https://example.invalid/video\"}}]}}]}"}) {
            GatewayFailure failure = assertThrows(GatewayFailure.class, () -> StructuredContent.assertTextOutput(json.readTree(value)));
            assertEquals("NATIVE_OUTPUT_REVIEW_REQUIRED", failure.code());
        }
    }
    @Test void canonicalNumbersAndUnicodeMatchNode() {
        assertEquals("{\"a\":0.0000001,\"emoji\":\"😀\",\"z\":0}", CanonicalJson.encode(json.readTree("{\"z\":-0.0,\"emoji\":\"😀\",\"a\":1e-7}")));
        assertEquals("100000000000000000000000", CanonicalJson.encode(json.readTree("1e23")));
        assertThrows(GatewayFailure.class, () -> CanonicalJson.unicode("\ud800"));
    }
    @Test void patchesActualMessageAndRejectsUnicodeOrWrongSource() {
        var content = new StructuredContent(json);
        var request = json.readTree("{\"model\":\"test\",\"messages\":[{\"role\":\"system\",\"content\":\"rules\"},{\"role\":\"user\",\"content\":\"😀联系：13800138000\"}]}");
        var segments = content.segments(request, true, 1000); var segment = segments.get(1);
        var patch = json.createObjectNode().put("segmentId", segment.path("segmentId").stringValue()).put("contentPath", segment.path("contentPath").stringValue())
                .put("sourceDigest", segment.path("sourceDigest").stringValue()).put("start", 5).put("end", 16).put("replacement", "[PHONE]");
        assertEquals("😀联系：[PHONE]", content.patch(request, segments, json.createArrayNode().add(patch)).at("/messages/1/content").stringValue());
        patch.put("start", 1); assertThrows(GatewayFailure.class, () -> content.patch(request, segments, json.createArrayNode().add(patch)));
    }
    @Test void assemblesSplitToolArgumentsAndRequiresDoneAndFinish() {
        var buffer = new BufferedCompletion(json, 20, 1000);
        buffer.accept(ServerSentEvent.builder("{\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\"}}]},\"finish_reason\":null}]}").build());
        buffer.accept(ServerSentEvent.builder("{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"text\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}").build());
        assertThrows(GatewayFailure.class, buffer::complete);
        buffer.accept(ServerSentEvent.builder("[DONE]").build());
        var completed = buffer.complete();
        assertEquals("{\"q\":\"text\"}", completed.at("/choices/0/message/tool_calls/0/function/arguments").stringValue());
        assertEquals(2, new StructuredContent(json).segments(completed, false, 1000).size());
        assertThrows(GatewayFailure.class, () -> buffer.accept(ServerSentEvent.builder("[DONE]").build()));
    }
    @Test void refusesHiddenFieldsAndBufferOverflow() {
        var buffer = new BufferedCompletion(json, 1, 20);
        assertThrows(GatewayFailure.class, () -> buffer.accept(ServerSentEvent.builder("{\"choices\":[],\"secret_field\":\"unchecked\"}").build()));
        var parser = new StructuredContent(json);
        assertThrows(GatewayFailure.class, () -> parser.segments(json.readTree("{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"ok\",\"audio\":\"hidden\"}}]}"), false, 1000));
    }
    @Test void rejectsOpaqueMetadataAndCoversGenerationInstructions() {
        var parser = new StructuredContent(json);
        for (String fragment : new String[]{"\"hidden\":\"unchecked\"", "\"usage\":{\"prompt_tokens\":\"unchecked\"}", "\"id\":\"unchecked free text\""}) {
            var response = json.readTree("{" + fragment + ",\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"ok\"}}]}");
            assertThrows(GatewayFailure.class, () -> parser.segments(response, false, 1000));
        }
        var input = json.readTree("{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}],\"response_format\":{\"type\":\"json_schema\",\"description\":\"inspect this\"},\"stop\":[\"end\"]}");
        var segments = parser.segments(input, true, 1000);
        assertEquals(3, segments.size()); assertTrue(segments.get(1).path("text").stringValue().contains("inspect this"));
        var stop = segments.get(2);
        var patch = json.createObjectNode().put("segmentId", stop.path("segmentId").stringValue()).put("contentPath", stop.path("contentPath").stringValue()).put("sourceDigest", stop.path("sourceDigest").stringValue()).put("start", 0).put("end", 3).put("replacement", "done");
        assertEquals("done", parser.patch(input, segments, json.createArrayNode().add(patch)).at("/stop/0").stringValue());
    }

}
