import { X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const relative = '.artifact-build/upgrade-implementation-20260907/environment';
const directory = path.join(root, relative), tls = path.join(directory, 'tls');
mkdirSync(tls, { recursive: true });
const inside = '/workspace/' + relative + '/tls';
function openssl(args) {
  const result = spawnSync('docker', ['run','--rm','--pull=never','--network','none','-v',`${root}:/workspace`,'-w',inside,'maven:3.9.12-eclipse-temurin-21','openssl',...args], { encoding:'utf8', windowsHide:true });
  if (result.status !== 0) throw new Error('TEST_CERTIFICATE_GENERATION_FAILED');
}
if (!existsSync(path.join(tls,'client.crt'))) {
  writeFileSync(path.join(tls,'server.ext'), 'subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n');
  writeFileSync(path.join(tls,'client.ext'), 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE\n');
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','7','-subj','/CN=GuardLLM isolated test CA']);
  for (const role of ['server','client']) {
    openssl(['req','-newkey','rsa:2048','-nodes','-keyout',role+'.key','-out',role+'.csr','-subj','/CN=guardllm-integration-'+role]);
    openssl(['x509','-req','-in',role+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',role+'.crt','-days','7','-extfile',role+'.ext']);
  }
}
const envFile = path.join(directory,'environment.json');
const env = JSON.parse(readFileSync(envFile,'utf8'));
env.GATEWAY_CONTROL_TLS_CERT = path.join(tls,'server.crt'); env.GATEWAY_CONTROL_TLS_KEY = path.join(tls,'server.key'); env.GATEWAY_CONTROL_TLS_CA = path.join(tls,'ca.crt');
env.GUARD_BASE_URL = 'https://host.docker.internal:5107'; env.MODEL_BASE_URL = 'https://host.docker.internal:58088';
env.SPRING_PROFILES_ACTIVE = 'gateway-v2';
env.GATEWAY_SERVER_TLS_CERT = inside+'/server.crt'; env.GATEWAY_SERVER_TLS_KEY = inside+'/server.key'; env.GATEWAY_SERVER_TLS_CA = inside+'/ca.crt';
env.GATEWAY_PROXY_URL = 'https://127.0.0.1:58087'; env.GATEWAY_CONSOLE_TLS_CERT = path.join(tls,'client.crt'); env.GATEWAY_CONSOLE_TLS_KEY = path.join(tls,'client.key'); env.GATEWAY_CONSOLE_TLS_CA = path.join(tls,'ca.crt');
env.GATEWAY_MTLS_REQUIRED = 'true'; env.GATEWAY_INTERNAL_DEV_ALLOW_INSECURE = 'false';
env.GATEWAY_TRUST_CERTIFICATE = inside+'/ca.crt'; env.GATEWAY_CLIENT_CERTIFICATE = inside+'/client.crt'; env.GATEWAY_CLIENT_PRIVATE_KEY = inside+'/client.key';
env.GATEWAY_WORKLOAD_KEYS_JSON = JSON.stringify({ 'integration-proxy': { secret: env.GATEWAY_WORKLOAD_SECRET, role:'proxy', certificateSha256:new X509Certificate(readFileSync(path.join(tls,'client.crt'))).fingerprint256.replaceAll(':','').toLowerCase() } });
writeFileSync(envFile, JSON.stringify(env,null,2), {mode:0o600});
// Docker env-files cannot contain PEM newlines. Java only needs public keys in
// JSON (escaped newlines), plus ordinary gateway settings.
const javaNames = ['SPRING_PROFILES_ACTIVE','GATEWAY_SERVER_TLS_CERT','GATEWAY_SERVER_TLS_KEY','GATEWAY_SERVER_TLS_CA','GATEWAY_NODE_ID','GATEWAY_WORKLOAD_SECRET','GATEWAY_AUTH_PUBLIC_KEYS_JSON','GATEWAY_CONTEXT_HMAC_SECRET','GUARD_BASE_URL','MODEL_BASE_URL','GUARD_APP_KEY','GUARD_ACTIVE_BUNDLE_ID','SERVER_PORT','GATEWAY_MTLS_REQUIRED','GUARD_GRPC_ENABLED','GUARD_RATE_LIMIT_ENABLED','GUARD_DISTRIBUTED_CONCURRENCY_ENABLED','GATEWAY_MODEL_ROUTE_BOUNDARIES_JSON','GUARD_REQUEST_TIMEOUT','GATEWAY_TRUST_CERTIFICATE','GATEWAY_CLIENT_CERTIFICATE','GATEWAY_CLIENT_PRIVATE_KEY'];
writeFileSync(path.join(directory,'gateway.env'), javaNames.map(name => `${name}=${env[name]}`).join('\n')+'\n', {mode:0o600});
console.log('Isolated mutual TLS certificates and peer pins prepared.');
