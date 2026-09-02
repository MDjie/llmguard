package com.guardllm.gateway;

import java.time.Clock;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;

@Component
final class GatewayContextAuthenticator {
    private final RequestContextVerifier verifier;

    GatewayContextAuthenticator(GuardGatewayProperties properties) {
        this.verifier = new RequestContextVerifier(properties.contextHmacSecret(), Clock.systemUTC());
    }

    GatewayRequestContext authenticate(HttpHeaders headers) {
        String version = required(headers.getFirst("X-Guard-Context-Version"));
        var context = new GatewayRequestContext(
                required(headers.getFirst("X-Tenant-Id")),
                required(headers.getFirst("X-Application-Id")),
                optional(headers.getFirst("X-Principal-Id")),
                optional(headers.getFirst("X-Credential-Id")),
                required(headers.getFirst("X-Request-Id")),
                required(headers.getFirst("X-Trace-Id")),
                optional(headers.getFirst("X-Session-Id")),
                Long.parseLong(required(headers.getFirst("X-Absolute-Deadline-Epoch-Ms"))));
        if (!verifier.verify(
                context,
                headers.getFirst("X-Guard-Context-Signature"),
                version)) {
            throw new IllegalArgumentException("Invalid gateway context");
        }
        return context;
    }

    private static String required(String value) {
        if (value == null || value.isBlank() || value.length() > 128) {
            throw new IllegalArgumentException("Invalid gateway context field");
        }
        return value;
    }

    private static String optional(String value) {
        if (value == null || value.isBlank()) return null;
        return required(value);
    }
}
