package com.guardllm.gateway;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("guard.gateway.tls")
public record GatewayTlsProperties(
        boolean required,
        String trustCertificate,
        String clientCertificate,
        String clientPrivateKey) {
    public GatewayTlsProperties {
        if (required && (blank(trustCertificate) || blank(clientCertificate) || blank(clientPrivateKey))) {
            throw new IllegalArgumentException(
                    "mTLS requires trust-certificate, client-certificate and client-private-key");
        }
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
