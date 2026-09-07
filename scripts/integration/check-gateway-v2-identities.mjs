import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { validateGatewayIdentityMaterial } from '../release/gateway-v2-identity-preflight.mjs';
const root = path.resolve(import.meta.dirname, '../..'), directory = path.join(root, '.artifact-build/upgrade-implementation-20260907/environment/identity-preflight-' + Date.now());
mkdirSync(directory, { recursive: true });
const names = ['guard-v2-proxy-0', 'guard-v2-proxy-1', 'guard-v2-proxy-2', 'control', 'console'];
const commands = ['set -eu', 'umask 077', 'openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 365 -subj /CN=Isolated-identity-fixture-CA'];
for (const name of names) {
  const proxy = name.startsWith('guard-'), usage = proxy ? 'serverAuth,clientAuth' : name === 'control' ? 'serverAuth' : 'clientAuth';
  writeFileSync(path.join(directory, name + '.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=' + usage + '\n' +
    (proxy ? 'subjectAltName=DNS:guard-v2-proxy,DNS:' + name + '\n' : name === 'control' ? 'subjectAltName=DNS:guard-v2-control\n' : ''));
  commands.push('openssl req -newkey rsa:2048 -nodes -keyout ' + name + '.key -out ' + name + '.csr -subj /CN=' + name);
  commands.push('openssl x509 -req -in ' + name + '.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out ' + name + '.crt -days 365 -extfile ' + name + '.ext');
}
writeFileSync(path.join(directory, 'generate.sh'), commands.join('\n') + '\n');
const generated = spawnSync('docker', ['run', '--rm', '--pull=never', '--network', 'none', '-v', directory + ':/fixtures', '-w', '/fixtures', 'maven:3.9.12-eclipse-temurin-21', 'sh', 'generate.sh'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
if (generated.status !== 0) throw new Error('ISOLATED_CERTIFICATE_GENERATION_FAILED');
const read = file => readFileSync(path.join(directory, file), 'utf8');
const pair = name => ({ certificatePem: read(name + '.crt'), privateKeyPem: read(name + '.key') });
const identities = names.slice(0, 3).map(nodeId => ({ nodeId, ...pair(nodeId), secret: randomBytes(32).toString('hex') }));
const workloads = Object.fromEntries(identities.map(identity => [identity.nodeId, { role: 'proxy', secret: identity.secret, certificateSha256: createHash('sha256').update(new X509Certificate(identity.certificatePem).raw).digest('hex') }]));
const signing = generateKeyPairSync('ed25519');
const material = { release: 'guard', replicas: 3, identities, workloads, caPem: read('ca.crt'), control: pair('control'), console: pair('console'),
  signingPrivateKeyPem: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeys: { test: signing.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, keyId: 'test' };
const results = [];
function check(name, run) { run(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
check('three ordinal certificates, workload pins, server names, usages and signing keys match', () => { const result = validateGatewayIdentityMaterial(material); assert.equal(result.checked.length, 5); assert.ok(!JSON.stringify(result).includes(identities[0].secret)); });
check('duplicate HMAC keys across proxies are rejected', () => { const value = structuredClone(material); value.workloads['guard-v2-proxy-1'].secret = value.workloads['guard-v2-proxy-0'].secret; assert.throws(() => validateGatewayIdentityMaterial(value), /SECRET_REUSED/); });
check('wrong certificate key and wrong workload pins are rejected', () => { const value = structuredClone(material); value.identities[0].privateKeyPem = value.identities[1].privateKeyPem; assert.throws(() => validateGatewayIdentityMaterial(value), /PRIVATE_KEY_MISMATCH/); const wrong = structuredClone(material); wrong.workloads['guard-v2-proxy-0'].certificateSha256 = 'f'.repeat(64); assert.throws(() => validateGatewayIdentityMaterial(wrong), /PIN_MISMATCH/); });
check('missing future ordinal and wrong release SAN cannot pass preflight', () => { assert.throws(() => validateGatewayIdentityMaterial({ ...material, replicas: 4 }), /COUNT_MISMATCH/); const value = structuredClone(material); value.identities[0].certificatePem = value.identities[1].certificatePem; value.identities[0].privateKeyPem = value.identities[1].privateKeyPem; assert.throws(() => validateGatewayIdentityMaterial(value), /SERVICE_NAME_MISMATCH/); });
check('server-only certificates cannot be used as console clients', () => { assert.throws(() => validateGatewayIdentityMaterial({ ...material, console: material.control }), /EXTENDED_USAGE_REQUIRED/); });
check('expiry margin and public signing-key mismatch fail closed', () => { assert.throws(() => validateGatewayIdentityMaterial({ ...material, now: Date.now() + 340 * 86400000 }), /EXPIRING/); const value = structuredClone(material); value.publicKeys.test = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(); assert.throws(() => validateGatewayIdentityMaterial(value), /PUBLIC_KEY_MISMATCH/); });
writeFileSync(path.join(root, '.artifact-build/upgrade-implementation-20260907/environment/identity-preflight-evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), status: 'PASS', engineeringCertificatesOnly: true, kubernetesRuntimeTested: false, results }, null, 2));
