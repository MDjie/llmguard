import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('Missing evidence field: ' + name);
}

export function validateEvidenceReport(reportPath, expectedId) {
  const absoluteReport = resolve(reportPath);
  if (!existsSync(absoluteReport)) throw new Error(expectedId + ' evidence report is missing');
  const directory = dirname(absoluteReport);
  const report = JSON.parse(readFileSync(absoluteReport, 'utf8'));
  if (report.id !== expectedId || report.status !== 'PASS') throw new Error(expectedId + ' does not contain a PASS report');
  requireString(report.startedAt, 'startedAt');
  requireString(report.completedAt, 'completedAt');
  const startedAt = Date.parse(report.startedAt);
  const completedAt = Date.parse(report.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new Error(expectedId + ' evidence timestamps are invalid');
  }
  for (const key of ['name', 'os', 'cpu', 'orchestrator', 'policyBundleId']) {
    requireString(report.environment?.[key], 'environment.' + key);
  }
  if (!report.environment?.deploymentDigests || Object.keys(report.environment.deploymentDigests).length === 0) {
    throw new Error(expectedId + ' has no deployment digests');
  }
  if (!Array.isArray(report.approvers) || new Set(report.approvers).size < 2) {
    throw new Error(expectedId + ' requires at least two distinct approvers');
  }
  if (!Array.isArray(report.artifacts) || report.artifacts.length === 0) {
    throw new Error(expectedId + ' requires at least one artifact');
  }
  for (const artifact of report.artifacts) {
    requireString(artifact.path, 'artifact.path');
    if (!/^sha256:[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw new Error(expectedId + ' has an invalid artifact hash');
    if (isAbsolute(artifact.path)) throw new Error(expectedId + ' artifact paths must be relative');
    const target = resolve(directory, artifact.path);
    const relation = relative(directory, target);
    if (relation.startsWith('..') || isAbsolute(relation)) throw new Error(expectedId + ' artifact escapes its evidence directory');
    if (!existsSync(target)) throw new Error(expectedId + ' artifact is missing: ' + artifact.path);
    const actual = 'sha256:' + createHash('sha256').update(readFileSync(target)).digest('hex');
    if (actual !== artifact.sha256) throw new Error(expectedId + ' artifact hash mismatch: ' + artifact.path);
  }
  return { report, absoluteReport };
}

export function verifySignedEvidence(reportPath, expectedId, publicKey) {
  const validated = validateEvidenceReport(reportPath, expectedId);
  requireString(publicKey, 'ACCEPTANCE_COSIGN_PUBLIC_KEY');
  const signature = validated.absoluteReport.replace(/\.json$/, '.sig');
  if (!existsSync(signature)) throw new Error(expectedId + ' detached signature is missing');
  const verification = spawnSync('cosign', [
    'verify-blob', '--key', publicKey, '--signature', signature, validated.absoluteReport
  ], { encoding: 'utf8' });
  if (verification.status !== 0) throw new Error(expectedId + ' signature verification failed: ' + verification.stderr);
  return validated.report;
}
