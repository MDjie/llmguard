import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const project = process.env.P6_COMPOSE_PROJECT ?? 'guardllm-r0';
const appContainer = process.env.P6_SOURCE_APP_CONTAINER ?? `${project}-app-1`;
const baseUrl = (process.env.P6_DEPLOYMENT_URL ?? 'http://127.0.0.1:58082').replace(/\/$/u, '');
const expectedServices = Number(process.env.P6_EXPECTED_SERVICES ?? 13);
const databasePort = process.env.P6_DATABASE_PORT ?? '5434';
const outputPath = path.resolve(
  process.env.P6_DEPLOYMENT_EVIDENCE
    ?? '输出/测试报告/2026-09-04/security-hardening/P6-deployment-verification.json',
);

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Docker inspection failed for ${args[0] ?? 'unknown operation'}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function environmentFrom(container) {
  const environment = new Map();
  for (const entry of container.Config?.Env ?? []) {
    const separator = entry.indexOf('=');
    if (separator > 0) environment.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return environment;
}

async function request(pathname, init) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, { cache: 'no-store', ...init });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await response.json().catch(() => null) : null;
  return {
    path: pathname,
    status: response.status,
    latencyMs: Number((performance.now() - startedAt).toFixed(3)),
    body,
  };
}

const [health, live, database, policy, anonymous] = await Promise.all([
  request('/api/health'),
  request('/api/health/live'),
  request('/api/health/db'),
  request('/api/health/policy'),
  request('/api/v1/guard/evaluate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }),
]);

const containerLines = docker([
  'ps',
  '--filter', `label=com.docker.compose.project=${project}`,
  '--format', '{{json .}}',
]).trim().split(/\r?\n/u).filter(Boolean);
const containers = containerLines.map((line) => JSON.parse(line));
const [app] = JSON.parse(docker(['inspect', appContainer]));
if (!app) throw new Error('The deployed application container is unavailable');

const logWindow = process.env.P6_LOG_WINDOW ?? '10m';
const logChecks = containers.map((container) => {
  const rendered = docker(['logs', '--since', logWindow, container.Names]);
  const structuredHighSeverity = rendered.match(/"level"\s*:\s*"(?:error|fatal)"/giu)?.length ?? 0;
  const processFailures = rendered.match(/(?:uncaught exception|unhandled rejection|segmentation fault|out of memory)/giu)?.length ?? 0;
  return {
    container: container.Names,
    structuredHighSeverity,
    processFailures,
  };
});

const deployedEnvironment = environmentFrom(app);
const databaseUrl = deployedEnvironment.get('PGDATABASE_URL')
  ?? deployedEnvironment.get('DATABASE_URL')
  ?? deployedEnvironment.get('COZE_SUPABASE_DB_URL');
if (!databaseUrl) throw new Error('The deployed database connection is unavailable');
const hostDatabaseUrl = new URL(databaseUrl);
hostDatabaseUrl.hostname = '127.0.0.1';
hostDatabaseUrl.port = databasePort;
const auditEnvironment = {
  ...process.env,
  PGDATABASE_URL: hostDatabaseUrl.toString(),
  DATABASE_URL: hostDatabaseUrl.toString(),
};
for (const name of ['AUDIT_CHAIN_KEY', 'AUDIT_CHAIN_KEY_ID', 'AUDIT_CHAIN_KEYS_JSON']) {
  const value = deployedEnvironment.get(name);
  if (value) auditEnvironment[name] = value;
}
const auditProcess = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'scripts/verify-audit-chain.ts'],
  { encoding: 'utf8', windowsHide: true, env: auditEnvironment },
);
if (auditProcess.status !== 0) throw new Error('Audit-chain verification failed');
const auditOutput = `${auditProcess.stdout ?? ''}${auditProcess.stderr ?? ''}`;
const auditMatch = auditOutput.match(/\{\s*"valid"\s*:\s*true[\s\S]*\}\s*$/u);
if (!auditMatch) throw new Error('Audit-chain verification output is invalid');
const audit = JSON.parse(auditMatch[0]);

const tmpfs = app.HostConfig?.Tmpfs ?? {};
const endpointChecks = {
  health: health.status === 200 && health.body?.status === 'healthy',
  live: live.status === 200,
  database: database.status === 200,
  policy: policy.status === 200 && policy.body?.ready === true,
  anonymousBoundary: anonymous.status === 401 && anonymous.body?.code === 'AUTHENTICATION_REQUIRED',
};
const runtimeChecks = {
  expectedServiceCount: containers.length === expectedServices,
  allServicesRunning: containers.length === expectedServices
    && containers.every((container) => String(container.Status).startsWith('Up ')),
  appHealthy: app.State?.Health?.Status === 'healthy',
  readOnlyRootFilesystem: app.HostConfig?.ReadonlyRootfs === true,
  boundedWritablePaths: Object.hasOwn(tmpfs, '/tmp') && Object.hasOwn(tmpfs, '/app/.next/cache'),
  noHighSeverityLogs: logChecks.every(
    (item) => item.structuredHighSeverity === 0 && item.processFailures === 0,
  ),
  auditChainValid: audit.valid === true && audit.partitions.every((partition) => partition.valid === true),
};

const evidence = {
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  status: [...Object.values(endpointChecks), ...Object.values(runtimeChecks)].every(Boolean)
    ? 'PASS'
    : 'FAIL',
  target: { baseUrl, composeProject: project },
  endpoints: [health, live, database, policy, anonymous].map((item) => ({
    path: item.path,
    status: item.status,
    latencyMs: item.latencyMs,
    ready: item.path.endsWith('/policy') ? item.body?.ready ?? null : undefined,
    generation: item.path.endsWith('/policy') ? item.body?.generation ?? null : undefined,
    code: item.path.endsWith('/evaluate') ? item.body?.code ?? null : undefined,
  })),
  endpointChecks,
  deployment: {
    serviceCount: containers.length,
    expectedServices,
    services: containers.map((container) => ({
      name: container.Names,
      image: container.Image,
      status: container.Status,
    })),
    appImageDigest: app.Image,
    appStartedAt: app.State?.StartedAt ?? null,
    appHealth: app.State?.Health?.Status ?? null,
    readOnlyRootFilesystem: app.HostConfig?.ReadonlyRootfs ?? null,
    writableTmpfsPaths: Object.keys(tmpfs).sort(),
  },
  logReview: { window: logWindow, containers: logChecks },
  auditChain: {
    valid: audit.valid,
    verifiedAt: audit.verifiedAt,
    totalChecked: audit.partitions.reduce((total, partition) => total + partition.checked, 0),
    partitions: audit.partitions.map((partition) => ({
      partitionKeySha256: createHash('sha256').update(partition.partitionKey).digest('hex'),
      valid: partition.valid,
      checked: partition.checked,
      headHash: partition.headHash,
    })),
  },
  runtimeChecks,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  status: evidence.status,
  serviceCount: evidence.deployment.serviceCount,
  policyGeneration: policy.body?.generation ?? null,
  auditEventsChecked: evidence.auditChain.totalChecked,
})}\n`);
if (evidence.status !== 'PASS') process.exitCode = 1;
