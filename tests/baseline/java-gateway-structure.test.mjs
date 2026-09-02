import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = 'services/guard-gateway';

describe('Java guard gateway structure', () => {
  it('pins Java 21, WebFlux, actuator and test execution in the image build', () => {
    const pom = readFileSync(`${root}/pom.xml`, 'utf8');
    const dockerfile = readFileSync(`${root}/Dockerfile`, 'utf8');
    expect(pom).toContain('<java.version>21</java.version>');
    expect(pom).toContain('spring-boot-starter-webflux');
    expect(pom).toContain('spring-boot-starter-actuator');
    expect(dockerfile).toContain('mvn -B -ntp verify');
    expect(dockerfile).toContain('USER 10001');
  });

  it('contains authentication, deadline, bulkhead, shadow and mTLS controls', () => {
    const filter = readFileSync(`${root}/src/main/java/com/guardllm/gateway/GatewayContextWebFilter.java`, 'utf8');
    const authenticator = readFileSync(`${root}/src/main/java/com/guardllm/gateway/GatewayContextAuthenticator.java`, 'utf8');
    const bulkhead = readFileSync(`${root}/src/main/java/com/guardllm/gateway/ReactiveBulkhead.java`, 'utf8');
    const websocket = readFileSync(`${root}/src/main/java/com/guardllm/gateway/ChatWebSocketHandler.java`, 'utf8');
    const quota = readFileSync(`${root}/src/main/java/com/guardllm/gateway/RedisQuotaBackend.java`, 'utf8');
    const shadow = readFileSync(`${root}/src/main/java/com/guardllm/gateway/ShadowComparator.java`, 'utf8');
    const readme = readFileSync(`${root}/README.md`, 'utf8');
    expect(filter).toContain('authenticator.authenticate');
    expect(authenticator).toContain('X-Guard-Context-Signature');
    expect(authenticator).toContain('X-Absolute-Deadline-Epoch-Ms');
    expect(bulkhead).toContain('doFinally');
    expect(websocket).toContain('streamingCommitGate.gate');
    expect(quota).toContain("redis.call('INCRBY'");
    expect(shadow).not.toContain('text={');
    expect(readme).toContain('mutual TLS');
  });
});
