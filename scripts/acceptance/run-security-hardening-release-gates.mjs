import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const root = path.resolve(import.meta.dirname, '../..');
const outputDirectory = path.resolve(
  process.env.P6_LOG_DIR ?? '输出/测试报告/2026-09-04/security-hardening/P6-logs',
);
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run this gate through pnpm so npm_execpath is available.');
const sourceAppContainer = process.env.P6_SOURCE_APP_CONTAINER ?? 'guardllm-r0-app-1';
const hostDatabasePort = process.env.P6_DATABASE_PORT ?? '5434';

const gates = [
  ['01-contracts', ['contracts:check']],
  ['02-plan', ['plan:check']],
  ['03-quality', ['quality:full']],
  ['04-unit', ['test:unit', '--run']],
  ['05-coverage', ['test:coverage', '--run']],
  ['06-integration', ['test:integration']],
  ['07-e2e', ['test:e2e']],
  ['08-sdk-python', ['test:sdk-python']],
  ['09-sdk-go', ['test:sdk-go']],
  ['10-compatibility', ['compatibility:check']],
  ['11-appliance', ['appliance:validate']],
  ['12-build', ['build']],
  ['13-sdk-java', ['test:sdk-java']],
  ['14-gateway-java', ['test:gateway-java']],
];

await mkdir(outputDirectory, { recursive: true });
const summary = {
  schemaVersion: '1.0',
  startedAt: new Date().toISOString(),
  commit: process.env.P6_COMMIT ?? null,
  gates: [],
};

function inspectSourceDatabaseUrl() {
  const result = spawnSync('docker', ['inspect', sourceAppContainer], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Unable to inspect ${sourceAppContainer} for the integration database bootstrap`);
  }
  const [container] = JSON.parse(result.stdout);
  const environment = new Map();
  for (const entry of container?.Config?.Env ?? []) {
    const separator = entry.indexOf('=');
    if (separator > 0) environment.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  const source = environment.get('PGDATABASE_URL')
    ?? environment.get('COZE_SUPABASE_DB_URL')
    ?? environment.get('DATABASE_URL');
  if (!source) throw new Error(`${sourceAppContainer} does not expose a database URL`);
  return source;
}

function toHostDatabaseUrl(source, databaseName) {
  const url = new URL(source);
  url.hostname = '127.0.0.1';
  url.port = hostDatabasePort;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function prepareIntegrationDatabase() {
  if (process.env.INTEGRATION_DATABASE_URL) {
    const parsed = new URL(process.env.INTEGRATION_DATABASE_URL);
    return {
      url: process.env.INTEGRATION_DATABASE_URL,
      databaseName: parsed.pathname.slice(1),
      mode: 'provided',
      applySchema: process.env.INTEGRATION_APPLY_SCHEMA,
      cleanup: async () => 'NOT_REQUIRED',
    };
  }

  const source = inspectSourceDatabaseUrl();
  const sourceDatabaseName = new URL(source).pathname.slice(1);
  const databaseName = `guardllm_integration_p6_${process.pid}_${randomBytes(3).toString('hex')}`;
  if (!/^guardllm_integration_[a-z0-9_]+$/u.test(databaseName)) {
    throw new Error('Generated integration database name is invalid');
  }
  const administratorUrl = toHostDatabaseUrl(source, sourceDatabaseName);
  const client = new pg.Client({ connectionString: administratorUrl, ssl: false });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }

  return {
    url: toHostDatabaseUrl(source, databaseName),
    databaseName,
    mode: 'auto-created-local',
    applySchema: 'true',
    cleanup: async () => {
      const cleanupClient = new pg.Client({ connectionString: administratorUrl, ssl: false });
      await cleanupClient.connect();
      try {
        await cleanupClient.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      } finally {
        await cleanupClient.end();
      }
      return 'PASS';
    },
  };
}

async function runGate(id, args, integrationDatabase) {
  const startedAt = new Date();
  const logPath = path.join(outputDirectory, `${id}.log`);
  const log = createWriteStream(logPath, { encoding: 'utf8' });
  const commandLabel = `pnpm ${args.join(' ')}`;
  log.write(`command=${commandLabel}\nstartedAt=${startedAt.toISOString()}\n\n`);
  process.stdout.write(`\n[P6] START ${id}: ${commandLabel}\n`);
  const code = await new Promise((resolve, reject) => {
    const environment = id === '06-integration'
      ? {
          ...process.env,
          INTEGRATION_DATABASE_URL: integrationDatabase.url,
          ...(integrationDatabase.applySchema
            ? { INTEGRATION_APPLY_SCHEMA: integrationDatabase.applySchema }
            : {}),
        }
      : process.env;
    const child = spawn(process.execPath, [pnpmCli, ...args], {
      cwd: root,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); log.write(chunk); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); log.write(chunk); });
    child.on('error', reject);
    child.on('close', resolve);
  });
  const finishedAt = new Date();
  log.end(`\nfinishedAt=${finishedAt.toISOString()}\nexitCode=${code}\n`);
  const result = {
    id,
    command: commandLabel,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    exitCode: code,
    status: code === 0 ? 'PASS' : 'FAIL',
    log: `${id}.log`,
  };
  summary.gates.push(result);
  await writeFile(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`[P6] ${result.status} ${id} (${result.durationMs} ms)\n`);
}

const integrationDatabase = await prepareIntegrationDatabase();
summary.integrationDatabase = {
  mode: integrationDatabase.mode,
  database: integrationDatabase.databaseName,
  cleanup: 'PENDING',
};
try {
  for (const [id, args] of gates) await runGate(id, args, integrationDatabase);
} finally {
  try {
    summary.integrationDatabase.cleanup = await integrationDatabase.cleanup();
  } catch (error) {
    summary.integrationDatabase.cleanup = 'FAIL';
    summary.integrationDatabase.cleanupError = error instanceof Error ? error.message : String(error);
  }
}
summary.finishedAt = new Date().toISOString();
summary.status = summary.gates.every((gate) => gate.status === 'PASS')
  && summary.integrationDatabase.cleanup !== 'FAIL'
  ? 'PASS'
  : 'FAIL';
await writeFile(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
process.stdout.write(`[P6] COMPLETE status=${summary.status}\n`);
if (summary.status !== 'PASS') process.exitCode = 1;
