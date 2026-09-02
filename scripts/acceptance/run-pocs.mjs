import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifySignedEvidence } from './evidence.mjs';

const mode = process.argv.includes('--release') ? 'release' : 'code';
const evidencePublicKey = process.env.ACCEPTANCE_COSIGN_PUBLIC_KEY;
const manifest = JSON.parse(readFileSync('acceptance/poc-manifest.json', 'utf8'));
if (manifest.pocs.length !== 15 || new Set(manifest.pocs.map((poc) => poc.id)).size !== 15) {
  throw new Error('POC manifest must contain exactly 15 unique items');
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDirectory = resolve('acceptance/evidence/runs', stamp + '-' + randomBytes(4).toString('hex'));
mkdirSync(dirname(runDirectory), { recursive: true });
mkdirSync(runDirectory, { recursive: false });
const results = [];
for (const poc of manifest.pocs) {
  const startedAt = new Date().toISOString();
  const externalReport = resolve('acceptance/evidence/external', poc.id, 'report.json');
  const missingExternalInput = /acceptance[\\/]evidence[\\/]external/.test(poc.command)
    && !existsSync(poc.command.match(/acceptance[\\/]evidence[\\/]external[\\/][^\s]+/)?.[0] ?? '');
  let commandResult = null;
  if (!missingExternalInput) {
    commandResult = spawnSync(poc.command, {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: true,
      timeout: 30 * 60 * 1000,
      env: { ...process.env, NO_COLOR: '1' }
    });
  }
  const commandPassed = commandResult?.status === 0;
  let external = null;
  let externalError = null;
  if (existsSync(externalReport)) {
    try {
      external = mode === 'release'
        ? verifySignedEvidence(externalReport, poc.id, evidencePublicKey)
        : JSON.parse(readFileSync(externalReport, 'utf8'));
    } catch (error) {
      externalError = error instanceof Error ? error.message : String(error);
    }
  }
  const externalPassed = external?.id === poc.id && external?.status === 'PASS' && externalError === null;
  const status = mode === 'release'
    ? commandPassed && externalPassed ? 'PASS' : 'FAIL'
    : commandPassed ? 'CODE_CHECK_PASS_EXTERNAL_PENDING'
      : missingExternalInput ? 'PENDING_EXTERNAL_INPUT' : 'CODE_CHECK_FAIL';
  const output = [
    'COMMAND: ' + poc.command,
    'EXIT: ' + (commandResult?.status ?? 'NOT_RUN'),
    '',
    commandResult?.stdout ?? '',
    commandResult?.stderr ?? ''
  ].join('\n');
  writeFileSync(join(runDirectory, poc.id + '.log'), output, { flag: 'wx' });
  results.push({
    id: poc.id,
    name: poc.name,
    threshold: poc.threshold,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    commandExit: commandResult?.status ?? null,
    externalEvidence: externalReport,
    externalEvidencePresent: external !== null,
    externalError
  });
}
const requirementEvidence = { required: 101, passed: 0, failures: [] };
if (mode === 'release') {
  const traceability = JSON.parse(readFileSync('acceptance/generated/requirements.json', 'utf8'));
  for (const requirement of traceability.requirements) {
    const reportPath = resolve(requirement.evidenceDirectory, 'report.json');
    try {
      verifySignedEvidence(reportPath, requirement.id, evidencePublicKey);
      requirementEvidence.passed += 1;
    } catch (error) {
      requirementEvidence.failures.push({
        id: requirement.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
const report = {
  schemaVersion: '1.0',
  mode,
  policy: manifest.policy,
  runDirectory,
  startedAt: results[0]?.startedAt,
  completedAt: new Date().toISOString(),
  status: results.every((result) => result.status === 'PASS')
    && (mode !== 'release' || requirementEvidence.passed === requirementEvidence.required) ? 'PASS'
    : results.some((result) => result.status === 'CODE_CHECK_FAIL' || result.status === 'FAIL') ? 'FAIL'
      : 'PENDING_EXTERNAL_EVIDENCE',
  results,
  requirementEvidence
};
const reportText = JSON.stringify(report, null, 2) + '\n';
writeFileSync(join(runDirectory, 'report.json'), reportText, { flag: 'wx' });
const files = ['report.json', ...results.map((result) => result.id + '.log')];
const sums = files.map((file) => createHash('sha256').update(readFileSync(join(runDirectory, file))).digest('hex') + '  ' + file);
writeFileSync(join(runDirectory, 'SHA256SUMS'), sums.join('\n') + '\n', { flag: 'wx' });
if (mode === 'release') {
  const signingKey = process.env.ACCEPTANCE_COSIGN_KEY;
  if (!signingKey) throw new Error('ACCEPTANCE_COSIGN_KEY is required for a release acceptance run');
  const signed = spawnSync('cosign', [
    'sign-blob', '--yes', '--key', signingKey,
    '--output-signature', join(runDirectory, 'report.sig'),
    join(runDirectory, 'report.json')
  ], { encoding: 'utf8' });
  if (signed.status !== 0) throw new Error('Acceptance report signing failed: ' + signed.stderr);
}
console.log(JSON.stringify({ runDirectory, status: report.status }));
if (report.status === 'FAIL' || (mode === 'release' && report.status !== 'PASS')) process.exitCode = 1;
