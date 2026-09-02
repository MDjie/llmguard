package com.guardllm.gateway;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Component
final class ReactiveBulkhead {
    private record ScopeCounter(int limit, int inFlight) {
        ScopeCounter acquire() {
            return new ScopeCounter(limit, inFlight + 1);
        }

        ScopeCounter release() {
            return new ScopeCounter(limit, inFlight - 1);
        }
    }

    private final int maxInFlight;
    private final GatewayConcurrencyProperties properties;
    private final GatewayDistributedConcurrencyProperties distributedProperties;
    private final ConcurrencyLeaseBackend distributedBackend;
    private final Map<String, ScopeCounter> scopes = new HashMap<>();
    private int inFlight;

    @Autowired
    ReactiveBulkhead(
            GuardGatewayProperties gateway,
            GatewayConcurrencyProperties concurrency,
            GatewayDistributedConcurrencyProperties distributedConcurrency,
            ConcurrencyLeaseBackend distributedBackend) {
        this(gateway.maxInFlight(), concurrency, distributedConcurrency, distributedBackend);
    }

    ReactiveBulkhead(int maxInFlight) {
        this(
                maxInFlight,
                new GatewayConcurrencyProperties(false, 0, 0, 0, 0, 0, 0),
                new GatewayDistributedConcurrencyProperties(false, true, Duration.ofSeconds(30)),
                (keys, limits, ttl) -> Mono.just(() -> Mono.empty()));
    }

    ReactiveBulkhead(int maxInFlight, GatewayConcurrencyProperties properties) {
        this(
                maxInFlight,
                properties,
                new GatewayDistributedConcurrencyProperties(false, true, Duration.ofSeconds(30)),
                (keys, limits, ttl) -> Mono.just(() -> Mono.empty()));
    }

    ReactiveBulkhead(
            int maxInFlight,
            GatewayConcurrencyProperties properties,
            GatewayDistributedConcurrencyProperties distributedProperties,
            ConcurrencyLeaseBackend distributedBackend) {
        if (maxInFlight <= 0) throw new IllegalArgumentException("maxInFlight must be positive");
        this.maxInFlight = maxInFlight;
        this.properties = properties;
        this.distributedProperties = distributedProperties;
        this.distributedBackend = distributedBackend;
    }

    <T> Mono<T> execute(Supplier<Mono<T>> operation) {
        return execute(null, "", operation);
    }

    <T> Mono<T> execute(
            GatewayRequestContext context,
            String api,
            Supplier<Mono<T>> operation) {
        return Mono.defer(() -> {
            Lease lease = acquire(context, api);
            return Mono.usingWhen(
                    distributedLease(context, api),
                    ignored -> Mono.defer(operation),
                    ConcurrencyLeaseBackend.Lease::release,
                    (distributed, error) -> distributed.release(),
                    ConcurrencyLeaseBackend.Lease::release)
                    .doFinally(ignored -> lease.release());
        });
    }

    <T> Flux<T> executeFlux(Supplier<Flux<T>> operation) {
        return executeFlux(null, "", operation);
    }

    <T> Flux<T> executeFlux(
            GatewayRequestContext context,
            String api,
            Supplier<Flux<T>> operation) {
        return Flux.defer(() -> {
            Lease lease = acquire(context, api);
            return Flux.usingWhen(
                    distributedLease(context, api),
                    ignored -> Flux.defer(operation),
                    ConcurrencyLeaseBackend.Lease::release,
                    (distributed, error) -> distributed.release(),
                    ConcurrencyLeaseBackend.Lease::release)
                    .doFinally(ignored -> lease.release());
        });
    }

    private Mono<ConcurrencyLeaseBackend.Lease> distributedLease(
            GatewayRequestContext context,
            String api) {
        if (!distributedProperties.enabled() || context == null) {
            return Mono.just(() -> Mono.empty());
        }
        List<String> rawScopes = scopeKeys(context, api);
        String tenantHash = digest(context.tenantId());
        List<String> keys = rawScopes.stream()
                .map(scope -> "guard:concurrency:{" + tenantHash + "}:" + digest(scope))
                .toList();
        List<Long> limits = rawScopes.stream().map(scope -> (long) limitFor(scope)).toList();
        long requestRemaining = Math.max(
                0,
                context.absoluteDeadlineEpochMs() - System.currentTimeMillis() + 5_000);
        long ttlMillis = Math.min(
                Duration.ofMinutes(10).toMillis(),
                Math.max(distributedProperties.leaseTtl().toMillis(), requestRemaining));
        return distributedBackend.acquire(keys, limits, Duration.ofMillis(ttlMillis))
                .onErrorMap(
                        ConcurrencyLeaseBackend.RejectedException.class,
                        ignored -> new BulkheadFullException("distributed"))
                .onErrorResume(error -> {
                    if (error instanceof BulkheadFullException) return Mono.error(error);
                    return distributedProperties.failClosed()
                            ? Mono.error(new DistributedBackendUnavailableException(error))
                            : Mono.just(() -> Mono.empty());
                });
    }

    private synchronized Lease acquire(GatewayRequestContext context, String api) {
        if (inFlight >= maxInFlight) throw new BulkheadFullException("global");
        List<String> keys = properties.enabled() && context != null
                ? scopeKeys(context, api)
                : List.of();
        int newScopes = 0;
        for (String key : keys) {
            ScopeCounter counter = scopes.get(key);
            int limit = limitFor(key);
            if (counter != null && counter.inFlight() >= counter.limit()) {
                throw new BulkheadFullException(scopeName(key));
            }
            if (counter == null) newScopes += 1;
        }
        if (scopes.size() + newScopes > properties.maxTrackedScopes()) {
            throw new BulkheadFullException("scope-registry");
        }
        inFlight += 1;
        for (String key : keys) {
            ScopeCounter current = scopes.get(key);
            scopes.put(key, current == null
                    ? new ScopeCounter(limitFor(key), 1)
                    : current.acquire());
        }
        return new Lease(keys);
    }

    private List<String> scopeKeys(GatewayRequestContext context, String api) {
        List<String> keys = new ArrayList<>(5);
        addScope(keys, "tenant", context.tenantId());
        addScope(keys, "application", context.applicationId());
        addScope(keys, "principal", context.principalId());
        addScope(keys, "credential", context.credentialId());
        addScope(keys, "api", api);
        return List.copyOf(keys);
    }

    private static void addScope(List<String> keys, String type, String value) {
        if (value != null && !value.isBlank()) keys.add(type + ":" + value);
    }

    private int limitFor(String key) {
        return switch (scopeName(key)) {
            case "tenant" -> properties.tenantMaxInFlight();
            case "application" -> properties.applicationMaxInFlight();
            case "principal" -> properties.principalMaxInFlight();
            case "credential" -> properties.credentialMaxInFlight();
            case "api" -> properties.apiMaxInFlight();
            default -> maxInFlight;
        };
    }

    private static String scopeName(String key) {
        int separator = key.indexOf(':');
        return separator < 0 ? key : key.substring(0, separator);
    }

    private static String digest(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    private synchronized void release(List<String> keys) {
        inFlight -= 1;
        for (String key : keys) {
            ScopeCounter current = scopes.get(key);
            if (current == null) continue;
            ScopeCounter next = current.release();
            if (next.inFlight() == 0) scopes.remove(key);
            else scopes.put(key, next);
        }
    }

    private final class Lease {
        private final List<String> keys;
        private boolean released;

        private Lease(List<String> keys) {
            this.keys = keys;
        }

        private void release() {
            synchronized (ReactiveBulkhead.this) {
                if (released) return;
                released = true;
            }
            ReactiveBulkhead.this.release(keys);
        }
    }

    static final class BulkheadFullException extends RuntimeException {
        private final String scope;

        BulkheadFullException(String scope) {
            super("gateway bulkhead is full for scope: " + scope);
            this.scope = scope;
        }

        String scope() {
            return scope;
        }
    }

    static final class DistributedBackendUnavailableException extends RuntimeException {
        DistributedBackendUnavailableException(Throwable cause) {
            super("distributed concurrency backend is unavailable", cause);
        }
    }
}
