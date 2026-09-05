import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const workspace = process.cwd();
const appContainer = process.env.P6_SOURCE_APP_CONTAINER ?? 'guardllm-r0-app-1';
const databaseName = process.env.P6_DATABASE_NAME ?? 'guardllm_integration_p6';
const hostDatabasePort = process.env.P6_DATABASE_PORT ?? '5434';
const acceptancePort = process.env.P6_ACCEPTANCE_PORT ?? '58083';
const reportDirectory = path.resolve(
  process.env.P6_REPORT_DIRECTORY
    ?? '输出/测试报告/2026-09-04/security-hardening',
);
const inventoryPath = path.resolve(
  process.env.P6_ATTACHMENT_INVENTORY
    ?? '.tmp/p6-source-20260904/source-inventory.json',
);
const runtimeResultsPath = path.join(reportDirectory, 'P6-runtime-api-results.json');
const summaryPath = path.join(reportDirectory, 'P6-isolated-runtime-summary.json');
const logDirectory = path.join(reportDirectory, 'P6-logs');
const envFilePath = path.resolve('.tmp', `p6-runtime-${process.pid}.env`);
const containerName = `guardllm-p6-runtime-${process.pid}`;
const packageManager = process.platform === 'win32'
  ? process.env.ComSpec ?? 'cmd.exe'
  : 'pnpm';

function packageManagerArgs(args) {
  return process.platform === 'win32'
    ? ['/d', '/s', '/c', ['pnpm', ...args].join(' ')]
    : args;
}

function inspectSourceContainer() {
  const result = spawnSync(
    'docker',
    ['inspect', appContainer],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to inspect ${appContainer}`);
  }
  const [container] = JSON.parse(result.stdout);
  if (!container?.Config?.Image) throw new Error('Source app image is unavailable');
  const network = Object.keys(container.NetworkSettings?.Networks ?? {})[0];
  if (!network) throw new Error('Source app network is unavailable');
  const environment = new Map();
  for (const entry of container.Config.Env ?? []) {
    const separator = entry.indexOf('=');
    if (separator > 0) environment.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return { image: container.Config.Image, network, environment };
}

function setDatabaseName(value, { host, port }) {
  const url = new URL(value);
  url.hostname = host;
  url.port = port;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function databaseUrls(environment) {
  const source = environment.get('PGDATABASE_URL')
    ?? environment.get('COZE_SUPABASE_DB_URL')
    ?? environment.get('DATABASE_URL');
  if (!source) throw new Error('Source app does not expose a database URL');
  const parsed = new URL(source);
  return {
    network: setDatabaseName(source, { host: parsed.hostname, port: parsed.port || '5432' }),
    host: setDatabaseName(source, { host: '127.0.0.1', port: hostDatabasePort }),
  };
}

async function runCommand(label, command, args, environment, logFile) {
  const output = [];
  const child = spawn(command, args, {
    cwd: workspace,
    env: environment,
    shell: false,
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const rendered = Buffer.concat(output).toString('utf8');
  await writeFile(logFile, rendered, 'utf8');
  if (exitCode !== 0) throw new Error(`${label} failed; see ${path.relative(workspace, logFile)}`);
  process.stdout.write(`[P6 isolated] PASS ${label}\n`);
  return rendered;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 90_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health/policy`, { cache: 'no-store' });
      lastStatus = response.status;
      if (response.ok) return;
    } catch {
      // The container may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Isolated app health did not become ready (last status ${lastStatus ?? 'none'})`);
}

function dockerRun(source, environment) {
  environment.set('PGDATABASE_URL', source.networkDatabaseUrl);
  environment.set('DATABASE_URL', source.networkDatabaseUrl);
  environment.set('COZE_SUPABASE_DB_URL', source.networkDatabaseUrl);
  environment.set('PORT', '5000');
  environment.set('DEPLOY_RUN_PORT', '5000');
  environment.set('SESSION_COOKIE_SECURE', 'false');
  environment.delete('POLICY_SIGNING_PRIVATE_KEY');
  environment.delete('POLICY_SIGNING_PRIVATE_KEY_FILE');
  const lines = [...environment]
    .filter(([, value]) => !value.includes('\n') && !value.includes('\r'))
    .map(([key, value]) => `${key}=${value}`);
  return writeFile(envFilePath, `${lines.join('\n')}\n`, 'utf8').then(() => {
    const result = spawnSync('docker', [
      'run', '--detach', '--rm',
      '--name', containerName,
      '--network', source.network,
      '--volumes-from', `${appContainer}:ro`,
      '--publish', `127.0.0.1:${acceptancePort}:5000`,
      '--env-file', envFilePath,
      source.image,
    ], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error('Unable to start isolated app container');
  });
}

async function captureContainerLogs() {
  const result = spawnSync('docker', ['logs', '--timestamps', containerName], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sanitized = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/giu, 'postgresql://<redacted>@')
    .replace(/(authorization|cookie|set-cookie)(["'=:\s]+)[^\r\n,}]+/giu, '$1$2<redacted>');
  await writeFile(path.join(logDirectory, '15f-isolated-app.log'), sanitized, 'utf8');
}

async function stopContainer() {
  spawnSync('docker', ['stop', '--time', '10', containerName], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

await mkdir(logDirectory, { recursive: true });
await mkdir(path.dirname(envFilePath), { recursive: true });
const source = inspectSourceContainer();
const urls = databaseUrls(source.environment);
const username = `p6qa_${randomBytes(6).toString('hex')}`;
const password = `Z9!${randomBytes(18).toString('base64url')}a`;
const baseEnvironment = {
  ...process.env,
  PGDATABASE_URL: urls.host,
  DATABASE_URL: urls.host,
  COZE_SUPABASE_DB_URL: urls.host,
  BOOTSTRAP_ADMIN_USERNAME: username,
  BOOTSTRAP_ADMIN_PASSWORD: password,
  BOOTSTRAP_ADMIN_EMAIL: '',
  BOOTSTRAP_TENANT_CODE: 'legacy',
  BOOTSTRAP_APPLICATION_CODE: 'default',
  SESSION_COOKIE_SECURE: 'false',
};

let appStarted = false;
try {
  await runCommand(
    'admin bootstrap',
    packageManager,
    packageManagerArgs(['auth:bootstrap']),
    baseEnvironment,
    path.join(logDirectory, '15a-isolated-admin-bootstrap.log'),
  );
  await runCommand(
    'policy bootstrap',
    process.execPath,
    ['--import', 'tsx', 'scripts/bootstrap-policy-bundle.ts', '--allow-local-development'],
    baseEnvironment,
    path.join(logDirectory, '15b-isolated-policy-bootstrap.log'),
  );
  await dockerRun({
    ...source,
    networkDatabaseUrl: urls.network,
  }, new Map(source.environment));
  appStarted = true;
  await unlink(envFilePath).catch(() => {});

  const baseUrl = `http://127.0.0.1:${acceptancePort}`;
  await waitForHealth(baseUrl);
  const acceptanceEnvironment = {
    ...process.env,
    E2E_BASE_URL: baseUrl,
    E2E_PORT: acceptancePort,
    E2E_USERNAME: username,
    E2E_PASSWORD: password,
    ATTACHMENT_INVENTORY: inventoryPath,
    ATTACHMENT_API_RESULTS: runtimeResultsPath,
    CI: '',
  };
  const runtimeLog = await runCommand(
    '32-case runtime API acceptance',
    process.execPath,
    ['scripts/qa/run_attachment_api_tests.mjs'],
    acceptanceEnvironment,
    path.join(logDirectory, '15c-runtime-api.log'),
  );
  const e2eLog = await runCommand(
    'authenticated browser E2E',
    packageManager,
    packageManagerArgs(['test:e2e']),
    acceptanceEnvironment,
    path.join(logDirectory, '15d-e2e-authenticated.log'),
  );
  await stopContainer();
  appStarted = false;
  await dockerRun({
    ...source,
    networkDatabaseUrl: urls.network,
  }, new Map(source.environment));
  appStarted = true;
  await unlink(envFilePath).catch(() => {});
  await waitForHealth(baseUrl);
  const smokeLog = await runCommand(
    'deployment capability smoke',
    process.execPath,
    ['scripts/acceptance/run-deployment-smoke.mjs'],
    acceptanceEnvironment,
    path.join(logDirectory, '15e-deployment-smoke.log'),
  );

  const runtime = JSON.parse(await readFile(runtimeResultsPath, 'utf8'));
  runtime.source = path.relative(workspace, inventoryPath).replaceAll('\\', '/');
  runtime.principal = { username: '<ephemeral-p6-admin>', role: runtime.principal?.role ?? null };
  await writeFile(runtimeResultsPath, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
  const e2ePassed = Number(e2eLog.match(/(\d+) passed/)?.[1] ?? 0);
  const runtimeSummary = JSON.parse(runtimeLog.trim().split(/\r?\n/).at(-1));
  const smokeSummary = JSON.parse(smokeLog.trim().split(/\r?\n/).at(-1));
  const summary = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    status: runtimeSummary.failedAssertions === 0
      && runtimeSummary.selectedCases === 32
      && e2ePassed === 10
      && smokeSummary.checks === 15
      && smokeSummary.failed === 0
      ? 'PASS'
      : 'FAIL',
    isolation: {
      database: databaseName,
      appPort: Number(acceptancePort),
      principal: '<ephemeral-p6-admin>',
      productionAccountMutated: false,
    },
    runtimeApi: runtimeSummary,
    authenticatedE2E: { passed: e2ePassed, expected: 10 },
    deploymentSmoke: smokeSummary,
    evidence: {
      runtimeResults: path.basename(runtimeResultsPath),
      runtimeLog: 'P6-logs/15c-runtime-api.log',
      e2eLog: 'P6-logs/15d-e2e-authenticated.log',
      deploymentSmoke: 'P6-deployment-smoke.json',
      deploymentSmokeLog: 'P6-logs/15e-deployment-smoke.log',
    },
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ status: summary.status, runtimeApi: summary.runtimeApi, authenticatedE2E: summary.authenticatedE2E, deploymentSmoke: summary.deploymentSmoke })}\n`);
  if (summary.status !== 'PASS') process.exitCode = 1;
} finally {
  if (appStarted) {
    await captureContainerLogs();
    await stopContainer();
  }
  await unlink(envFilePath).catch(() => {});
}
