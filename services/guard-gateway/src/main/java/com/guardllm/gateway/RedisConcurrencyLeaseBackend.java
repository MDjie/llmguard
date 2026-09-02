package com.guardllm.gateway;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

@Component
final class RedisConcurrencyLeaseBackend implements ConcurrencyLeaseBackend {
    private static final String ACQUIRE_SCRIPT = """
            local now_parts = redis.call('TIME')
            local now = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
            local ttl = tonumber(ARGV[1])
            local lease = ARGV[2]
            for i = 1, #KEYS do
              redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
              if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i + 2]) then
                return 0
              end
            end
            local expires = now + ttl
            for i = 1, #KEYS do
              redis.call('ZADD', KEYS[i], expires, lease)
              redis.call('PEXPIRE', KEYS[i], ttl * 2)
            end
            return 1
            """;
    private static final String RELEASE_SCRIPT = """
            for i = 1, #KEYS do
              redis.call('ZREM', KEYS[i], ARGV[1])
            end
            return 1
            """;

    private final ReactiveStringRedisTemplate redis;
    private final DefaultRedisScript<Long> acquireScript =
            new DefaultRedisScript<>(ACQUIRE_SCRIPT, Long.class);
    private final DefaultRedisScript<Long> releaseScript =
            new DefaultRedisScript<>(RELEASE_SCRIPT, Long.class);

    RedisConcurrencyLeaseBackend(ReactiveStringRedisTemplate redis) {
        this.redis = redis;
    }

    @Override
    public Mono<Lease> acquire(List<String> keys, List<Long> limits, Duration ttl) {
        if (keys.isEmpty() || keys.size() != limits.size()) {
            return Mono.error(new IllegalArgumentException("Concurrency lease vectors are invalid"));
        }
        String leaseId = UUID.randomUUID().toString();
        List<String> arguments = new ArrayList<>(2 + limits.size());
        arguments.add(Long.toString(ttl.toMillis()));
        arguments.add(leaseId);
        limits.forEach(limit -> arguments.add(Long.toString(limit)));
        return redis.execute(acquireScript, keys, arguments.toArray())
                .single()
                .flatMap(result -> result == 1L
                        ? Mono.just(new RedisLease(keys, leaseId))
                        : Mono.error(new RejectedException()));
    }

    private final class RedisLease implements Lease {
        private final List<String> keys;
        private final String leaseId;
        private final AtomicBoolean released = new AtomicBoolean();

        private RedisLease(List<String> keys, String leaseId) {
            this.keys = List.copyOf(keys);
            this.leaseId = leaseId;
        }

        @Override
        public Mono<Void> release() {
            if (!released.compareAndSet(false, true)) return Mono.empty();
            return redis.execute(releaseScript, keys, leaseId)
                    .then()
                    .onErrorResume(ignored -> Mono.empty());
        }
    }
}
