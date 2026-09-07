package com.guardllm.gateway;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

final class GatewaySettings {
    private GatewaySettings() { }
    static String read(String inlineName, String fileName) {
        String inline = System.getenv(inlineName), file = System.getenv(fileName);
        if (inline != null && !inline.isBlank() && file != null && !file.isBlank()) throw new GatewayFailure("GATEWAY_SETTING_AMBIGUOUS", 503);
        if (file == null || file.isBlank()) {
            if (inline != null && inline.length() > 1048576) throw new GatewayFailure("GATEWAY_SETTING_TOO_LARGE", 503);
            return inline;
        }
        try {
            Path path = Path.of(file);
            if (!Files.isRegularFile(path) || Files.size(path) > 1048576) throw new GatewayFailure("GATEWAY_SETTING_TOO_LARGE", 503);
            return Files.readString(path, StandardCharsets.UTF_8).trim();
        } catch (IOException error) { throw new GatewayFailure("GATEWAY_SETTING_UNAVAILABLE", 503); }
    }
}
