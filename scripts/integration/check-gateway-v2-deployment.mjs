import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateGatewayRuntimeConfig } from '../gateway-v2-runtime-config.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const directory = path.join(root, '.artifact-build/upgrade-implementation-20260907/environment');
const env = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
if (new URL(env.PGDATABASE_URL).pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_FIXTURE_REQUIRED');
env.GATEWAY_V2_ENABLED = 'true';
validateGatewayRuntimeConfig(env);
assert.throws(() => validateGatewayRuntimeConfig({ ...env, GATEWAY_PROXY_URL: 'http://127.0.0.1:8080' }));
assert.throws(() => validateGatewayRuntimeConfig({ ...env, GATEWAY_INTERNAL_DEV_ALLOW_INSECURE: 'true' }));
assert.throws(() => validateGatewayRuntimeConfig({ ...env, GATEWAY_AUTH_KEY_ID: 'unknown-key' }));
assert.throws(() => validateGatewayRuntimeConfig({ ...env, GATEWAY_WORKLOAD_KEYS_JSON: '{"node":{"secret":"too-short"}}' }));
assert.throws(() => validateGatewayRuntimeConfig({ ...env, GATEWAY_CONTROL_TLS_KEY: env.GATEWAY_CONSOLE_TLS_KEY }));
assert.throws(() => validateGatewayRuntimeConfig({ ...env, GATEWAY_AUTH_SIGNING_PRIVATE_KEY_FILE: 'ambiguous-file' }));
const composeFiles = ['docker-compose.yml', 'docker-compose.gateway-v2.yml'];
const composeEnv = { ...process.env };
// Parse-only placeholders. Never deploy these or pass test keys into Compose.
const placeholder = path.join(directory, 'deployment-parse-placeholder.txt');
writeFileSync(placeholder, 'parse only, not a credential\n');
for (const file of composeFiles) {
  const source = readFileSync(path.join(root, file), 'utf8');
  for (const match of source.matchAll(/\$\{([A-Z0-9_]+)(?::[^}]*)?\}/g)) {
    composeEnv[match[1]] = match[1].endsWith('_FILE') ? placeholder : 'deployment-parse-only';
  }
}
for (const name of ['DB_PORT', 'APP_PORT', 'GATEWAY_PORT']) composeEnv[name] = '58000';
Object.assign(composeEnv, { APP_BIND_HOST: '127.0.0.1', ANALYZER_CPU_LIMIT: '4', ANALYZER_MEMORY_LIMIT: '8g', GATEWAY_CPU_LIMIT: '4', GATEWAY_MEMORY_LIMIT: '4g' });
const result = spawnSync('docker', ['compose', '-p', 'guardllm-upgrade-v2-parse', ...composeFiles.flatMap(file => ['-f', file]), 'config', '--format', 'json'], { cwd: root, env: composeEnv, encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw new Error('DEPLOYMENT_COMPOSE_PARSE_FAILED: ' + result.stderr.slice(0, 500));
const config = JSON.parse(result.stdout);
const initMounts=config.services.postgres.volumes.filter(volume=>volume.target.startsWith('/docker-entrypoint-initdb.d/'));
assert.equal(new Set(initMounts.map(volume=>volume.target)).size,initMounts.length);
for(const prefix of ['0055_','0056_','0057_','0058_']) assert.ok(initMounts.some(volume=>path.basename(volume.source).startsWith(prefix)));
assert.equal(config.services.gateway.build.context,root);
assert.equal(config.services.gateway.build.dockerfile,'services/guard-gateway/Dockerfile');
const gatewaySecrets = config.services.gateway.secrets.map(item => item.source);
assert.ok(!gatewaySecrets.includes('gateway_signing_private'));
assert.ok(!gatewaySecrets.includes('gateway_workload_registry'));
assert.ok(config.services.app.secrets.some(item => item.source === 'gateway_signing_private'));
assert.equal(config.services.gateway.environment.SPRING_PROFILES_ACTIVE, 'gateway-v2');
assert.equal(config.services.gateway.environment.GUARD_RATE_LIMIT_FAIL_CLOSED, 'true');
assert.equal(config.services.gateway.ports[0].host_ip, '127.0.0.1');
assert.ok(!config.services['gateway-redis'].ports);
const profile = readFileSync(path.join(root, 'services/guard-gateway/src/main/resources/application-gateway-v2.yml'), 'utf8');
assert.match(profile, /client-auth: need/);
assert.match(profile, /address: 127\.0\.0\.1/);
writeFileSync(path.join(directory, 'deployment-evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), status: 'PASS', checks: ['valid certificate/signing configuration', 'unsafe or ambiguous settings rejected', 'compose structure validated', 'private signing key isolated from proxy', 'proxy requires mTLS', 'management listener loopback only', 'Redis not published'], deploymentExecuted: false }, null, 2));
console.log('Gateway deployment configuration: PASS (validation only; no services deployed).');
