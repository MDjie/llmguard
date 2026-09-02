package com.guardllm.gateway;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("guard.gateway.grpc")
public record GrpcServerProperties(
        boolean enabled,
        int port,
        boolean tlsRequired,
        String trustCertificate,
        String serverCertificate,
        String serverPrivateKey,
        int maxInboundMessageBytes,
        int maxBufferedRequests) {
    public GrpcServerProperties {
        port = port <= 0 ? 9090 : port;
        maxInboundMessageBytes = maxInboundMessageBytes <= 0 ? 2 * 1024 * 1024 : maxInboundMessageBytes;
        maxBufferedRequests = maxBufferedRequests <= 0 ? 64 : maxBufferedRequests;
        if (port > 65_535 || maxInboundMessageBytes > 4 * 1024 * 1024
                || maxBufferedRequests > 1_024) {
            throw new IllegalArgumentException("gRPC server limits are invalid");
        }
        if (enabled && tlsRequired
                && (blank(trustCertificate) || blank(serverCertificate) || blank(serverPrivateKey))) {
            throw new IllegalArgumentException(
                    "gRPC mTLS requires trust-certificate, server-certificate and server-private-key");
        }
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
