import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) {
  throw new Error('Run this gate through pnpm so npm_execpath identifies the approved package manager');
}
const pnpmCommand = process.execPath;
const pnpmPrefix = [pnpmEntrypoint];
const reportPath = resolve(root, 'acceptance/appliance/generated/software-baseline-evidence.json');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(name, command, args) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '') +
    (result.error ? String.fromCharCode(10) + String(result.error) : '');
  return {
    name,
    command: [command, ...args].join(' '),
    status: result.status === 0 ? 'PASSED' : 'FAILED',
    exitCode: result.status ?? -1,
    durationMs: Date.now() - startedAt,
    outputSha256: sha256(output),
    outputTail: output.trim().split(/\r?\n/u).slice(-12),
  };
}

function git(args) {
  const result = spawnSync('git', [
    '-c', 'safe.directory=E:/大模型安全/大模型护栏', ...args,
  ], { cwd: root, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : 'UNAVAILABLE';
}

const runPnpm = (name, args) => run(name, pnpmCommand, [...pnpmPrefix, ...args]);
const checks = [
  runPnpm('appliance-contracts', ['appliance:contracts:check']),
  runPnpm('appliance-plan', ['appliance:plan-check']),
  runPnpm('typescript-strict', ['ts-check']),
  runPnpm('appliance-tests', [
    'exec', 'vitest', '--config', 'vitest.config.mts', '--run',
    'tests/appliance',
    'tests/contracts/appliance-contracts.test.mjs',
    'tests/acceptance/appliance-plan.test.mjs',
    'tests/artifacts/security-gate.test.ts',
  ]),
];

const execution = JSON.parse(readFileSync(
  resolve(root, 'acceptance/appliance/execution-manifest.json'),
  'utf8',
));
const environment = JSON.parse(readFileSync(
  resolve(root, 'acceptance/appliance/environment.json'),
  'utf8',
));
const evidencePaths = [...new Set(execution.workPackages.flatMap(
  (workPackage) => workPackage.acceptanceEvidence ?? [],
))].sort();
const evidenceFiles = evidencePaths.map((path) => {
  const bytes = readFileSync(resolve(root, path));
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
});
const workPackageStatus = Object.fromEntries(
  execution.workPackages.map((workPackage) => [workPackage.id, workPackage.status]),
);
const unresolvedExternalInputs = [...new Set(execution.workPackages.flatMap(
  (workPackage) => workPackage.blockingInputs ?? [],
))].sort();
const allPassed = checks.every((check) => check.status === 'PASSED');
const sourceStatus = git([
  'status', '--porcelain', '--', '.',
  ':(exclude)acceptance/appliance/generated/software-baseline-evidence.json',
]).length === 0 ? 'CLEAN' : 'DIRTY';
const report = {
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  reportType: 'VERSION_B_SOFTWARE_BASELINE',
  status: allPassed ? 'SOFTWARE_BASELINE_VERIFIED' : 'SOFTWARE_BASELINE_FAILED',
  targetAcceptanceStatus: environment.status,
  targetClaimsUnlocked: false,
  source: {
    commit: git(['rev-parse', 'HEAD']),
    workingTreeStatus: sourceStatus,
    evidenceSetDigest: sha256(JSON.stringify(evidenceFiles)),
  },
  checks,
  workPackageStatus,
  evidenceFiles,
  unresolvedExternalInputs,
  limitations: [
    'This report verifies repository software baselines only.',
    'It is not target-NIC, target-hardware, OEM-license, performance, 72-hour, HA field or customer acceptance evidence.',
    'REFERENCE_BASELINE components do not perform production packet I/O.',
  ],
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify({
  status: report.status,
  targetAcceptanceStatus: report.targetAcceptanceStatus,
  checks: checks.map(({ name, status }) => ({ name, status })),
  report: 'acceptance/appliance/generated/software-baseline-evidence.json',
}) + '\n');
if (!allPassed) process.exitCode = 1;
