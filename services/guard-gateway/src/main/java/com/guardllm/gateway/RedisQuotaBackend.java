package com.guardllm.gateway;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

@Component
final class RedisQuotaBackend implements QuotaBackend {
    private static final String SCRIPT = """
            local count = #KEYS
            local ttl = tonumber(ARGV[1])
            for i = 1, count do
              local cost = tonumber(ARGV[i * 2])
              local limit = tonumber(ARGV[(i * 2) + 1])
              local current = tonumber(redis.call('GET', KEYS[i]) or '0')
              if current + cost > limit then
                return 0
              end
            end
            for i = 1, count do
              local cost = tonumber(ARGV[i * 2])
              local current = redis.call('INCRBY', KEYS[i], cost)
              if current == cost then
                redis.call('PEXPIRE', KEYS[i], ttl)
              end
            end
            return 1
            """;

    private final ReactiveStringRedisTemplate redis;
    private final DefaultRedisScript<Long> script = new DefaultRedisScript<>(SCRIPT, Long.class);

    RedisQuotaBackend(ReactiveStringRedisTemplate redis) {
        this.redis = redis;
    }

    @Override
    public Mono<Boolean> consume(
            List<String> keys,
            List<Long> costs,
            List<Long> limits,
            Duration window) {
        if (keys.isEmpty() || keys.size() != costs.size() || keys.size() != limits.size()) {
            return Mono.error(new IllegalArgumentException("Quota vectors are invalid"));
        }
        List<String> arguments = new ArrayList<>(1 + keys.size() * 2);
        arguments.add(Long.toString(window.toMillis()));
        for (int index = 0; index < keys.size(); index += 1) {
            arguments.add(Long.toString(costs.get(index)));
            arguments.add(Long.toString(limits.get(index)));
        }
        return redis.execute(script, keys, arguments.toArray())
                .single()
                .map(result -> result == 1L);
    }
}
