package com.guardllm.gateway;

import io.grpc.Server;
import io.grpc.ServerInterceptors;
import io.grpc.netty.shaded.io.grpc.netty.GrpcSslContexts;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.netty.shaded.io.netty.handler.ssl.ClientAuth;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

@Component
final class GrpcServerLifecycle implements SmartLifecycle {
    private final GrpcServerProperties properties;
    private final GrpcGuardService service;
    private volatile Server server;
    private volatile boolean running;

    GrpcServerLifecycle(GrpcServerProperties properties, GrpcGuardService service) {
        this.properties = properties;
        this.service = service;
    }

    @Override
    public synchronized void start() {
        if (!properties.enabled() || running) return;
        try {
            var builder = NettyServerBuilder.forPort(properties.port())
                    .maxInboundMessageSize(properties.maxInboundMessageBytes())
                    .addService(ServerInterceptors.intercept(service, new GrpcContextAuthenticationInterceptor()));
            if (properties.tlsRequired()) {
                var ssl = GrpcSslContexts.forServer(
                        new File(properties.serverCertificate()), new File(properties.serverPrivateKey()))
                        .trustManager(new File(properties.trustCertificate()))
                        .clientAuth(ClientAuth.REQUIRE)
                        .build();
                builder.sslContext(ssl);
            }
            server = builder.build().start();
            running = true;
        } catch (IOException error) {
            throw new IllegalStateException("Unable to start the gRPC guard server", error);
        }
    }

    @Override
    public synchronized void stop() {
        Server active = server;
        running = false;
        server = null;
        if (active == null) return;
        active.shutdown();
        try {
            if (!active.awaitTermination(20, TimeUnit.SECONDS)) active.shutdownNow();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            active.shutdownNow();
        }
    }

    @Override public boolean isRunning() { return running; }
    @Override public boolean isAutoStartup() { return true; }
    @Override public int getPhase() { return Integer.MAX_VALUE - 100; }
}
