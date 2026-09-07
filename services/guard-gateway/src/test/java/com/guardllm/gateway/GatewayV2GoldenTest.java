package com.guardllm.gateway;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import tools.jackson.databind.json.JsonMapper;
final class GatewayV2GoldenTest {
  @Test void followsSharedCrossLanguageVectors() throws Exception {
    var json=JsonMapper.builder().build();
    var vectors=json.readTree(Files.readString(Path.of("../../packages/contracts/golden/gateway-v2.json")));
    for(var vector:vectors.path("valid")){
      var encoded=CanonicalJson.encode(json.readTree(vector.path("inputJson").stringValue()));
      assertEquals(vector.path("canonical").stringValue(),encoded,vector.path("name").stringValue());
      assertEquals(vector.path("sha256").stringValue(),CanonicalJson.sha256(encoded));
    }
    for(var vector:vectors.path("invalid")){
      assertThrows(RuntimeException.class,()->CanonicalJson.encode(json.readTree(vector.path("inputJson").stringValue())));
    }
    for(var vector:vectors.path("routing")){
      var value=json.createArrayNode().add(vector.path("tenantId").stringValue()).add(vector.path("applicationId").stringValue()).add(vector.path("businessKey").stringValue());
      byte[] hash=MessageDigest.getInstance("SHA-256").digest(CanonicalJson.encode(value).getBytes(StandardCharsets.UTF_8));
      assertEquals(vector.path("bucket").asInt(),Integer.toUnsignedLong(ByteBuffer.wrap(hash).getInt())%100);
    }
  }
}
