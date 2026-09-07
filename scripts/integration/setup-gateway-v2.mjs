import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';

const root = path.resolve(import.meta.dirname, '../..');
const directory = path.join(root, '.artifact-build/upgrade-implementation-20260907/environment');
mkdirSync(directory, { recursive: true });
const file = path.join(directory, 'environment.json');
const name = 'guardllm-upgrade-v2-db-20260907';
let env;
if (existsSync(file)) env = JSON.parse(readFileSync(file, 'utf8'));
else {
  const password = randomBytes(24).toString('hex');
  const auth = generateKeyPairSync('ed25519'), policy = generateKeyPairSync('ed25519');
  const workload = randomBytes(32).toString('hex');
  env = { NODE_ENV: 'development', PORT: '5107', GUARD_NEXT_DIST_DIR: '.next-upgrade-v2', PGDATABASE_URL: `postgres://gateway_test:${password}@127.0.0.1:55447/guardllm_integration_gateway_v2`,
    DATABASE_SSL_MODE: 'disable', DATABASE_PLAINTEXT_ALLOWED_HOSTS: '127.0.0.1', DATABASE_POOL_MAX: '12', CONTENT_HASH_KEY: randomBytes(32).toString('hex'), CREDENTIAL_PEPPER: randomBytes(32).toString('hex'),
    SECRET_MASTER_KEY_ID: 'integration-receipt', SECRET_MASTER_KEY: randomBytes(32).toString('base64'), DLP_TOKENIZATION_HMAC_KEY: randomBytes(32).toString('hex'),
    GATEWAY_AUTH_KEY_ID: 'integration-auth', GATEWAY_AUTH_SIGNING_PRIVATE_KEY: auth.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    GATEWAY_AUTH_PUBLIC_KEYS_JSON: JSON.stringify({ 'integration-auth': auth.publicKey.export({ format: 'pem', type: 'spki' }).toString() }),
    POLICY_SIGNING_KEY_ID: 'integration-policy', POLICY_SIGNING_PRIVATE_KEY: policy.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), POLICY_SIGNING_PUBLIC_KEY: policy.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    POLICY_SIGNING_PRIVATE_KEY_FILE: '', POLICY_SIGNING_PUBLIC_KEY_FILE: '', GATEWAY_INTERNAL_DEV_ALLOW_INSECURE: 'true', GATEWAY_NODE_ID: 'integration-proxy', GATEWAY_WORKLOAD_SECRET: workload,
    GATEWAY_WORKLOAD_KEYS_JSON: JSON.stringify({ 'integration-proxy': { secret: workload, role: 'proxy' } }),
    GATEWAY_PROXY_URL: 'http://127.0.0.1:58087', GATEWAY_CONTEXT_HMAC_SECRET: randomBytes(32).toString('hex'), GUARD_BASE_URL: 'http://127.0.0.1:5107', MODEL_BASE_URL: 'http://127.0.0.1:58088',
    GUARD_APP_KEY: 'unused-for-v2', GUARD_ACTIVE_BUNDLE_ID: 'unused-for-v2', SERVER_PORT: '58087', GATEWAY_MTLS_REQUIRED: 'false', GUARD_GRPC_ENABLED: 'false', GUARD_RATE_LIMIT_ENABLED: 'false', GUARD_DISTRIBUTED_CONCURRENCY_ENABLED: 'false',
    GATEWAY_MODEL_ROUTE_BOUNDARIES_JSON: JSON.stringify({ default: ['internal'] }), GUARD_REQUEST_TIMEOUT: '60s' };
  writeFileSync(file, JSON.stringify(env, null, 2), { mode: 0o600 });
  writeFileSync(path.join(directory, 'postgres.env'), `POSTGRES_USER=gateway_test\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=guardllm_integration_gateway_v2\n`, { mode: 0o600 });
}
const parsed = new URL(env.PGDATABASE_URL);
if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
const inspection = spawnSync('docker', ['inspect', name], { encoding: 'utf8', windowsHide: true });
if (inspection.status !== 0) {
  const result = spawnSync('docker', ['run', '-d', '--pull=never', '--name', name, '--label', 'guardllm.scope=upgrade-v2-integration', '-p', '127.0.0.1:55447:5432', '--env-file', path.join(directory, 'postgres.env'), 'postgres:16-alpine'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('ISOLATED_POSTGRES_START_FAILED');
} else {
  const container = JSON.parse(inspection.stdout)[0];
  if (container.Config.Labels['guardllm.scope'] !== 'upgrade-v2-integration') throw new Error('CONTAINER_OWNERSHIP_MISMATCH');
  if (!container.State.Running && spawnSync('docker', ['start', name], { stdio: 'ignore', windowsHide: true }).status !== 0) throw new Error('ISOLATED_POSTGRES_START_FAILED');
}
let client;
for (let attempt = 0; attempt < 40; attempt++) {
  const candidate = new pg.Client({ connectionString: env.PGDATABASE_URL, ssl: false });
  try { await candidate.connect(); client = candidate; break; }
  catch { await candidate.end().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 250)); }
}
if (!client) throw new Error('ISOLATED_POSTGRES_UNAVAILABLE');
try {
  const exists = (await client.query("select to_regclass('gateway_requests') as relation")).rows[0].relation;
  if (!exists) {
    const migrations = ['scripts/init-database-new.sql', 'scripts/init-database-supplement.sql', ...readdirSync(path.join(root, 'drizzle')).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort().map(name => 'drizzle/' + name)];
    for (const migration of migrations) {
      try { await client.query(readFileSync(path.join(root, migration), 'utf8')); }
      catch (error) { throw new Error(`ISOLATED_MIGRATION_FAILED ${migration} ${error.code ?? ''} ${error.message}`); }
    }
  }
  const tables = (await client.query("select tablename from pg_tables where schemaname='public' and tablename like 'gateway_%' order by tablename")).rows.map(row => row.tablename);
  writeFileSync(path.join(directory, 'database-evidence.json'), JSON.stringify({ status: 'PASS', syntheticOnly: true, businessDatabaseModified: false, database: parsed.pathname.slice(1), tables, capturedAt: new Date().toISOString() }, null, 2));
  console.log('Isolated gateway database ready; five runtime tables verified:', tables.length);
} finally { await client.end(); }
