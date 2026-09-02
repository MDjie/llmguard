import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { validateEvidenceReport } from '../../scripts/acceptance/evidence.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'guardllm-evidence-'));
  mkdirSync(join(directory, 'artifacts'));
  const artifact = Buffer.from('immutable test evidence');
  writeFileSync(join(directory, 'artifacts', 'result.txt'), artifact);
  const report = {
    id: 'POC-01',
    status: 'PASS',
    environment: {
      name: 'isolated-test',
      os: 'Linux',
      cpu: 'x86_64',
      orchestrator: 'Kubernetes',
      policyBundleId: 'bundle-1',
      deploymentDigests: { app: 'sha256:' + 'a'.repeat(64) }
    },
    startedAt: '2026-09-01T00:00:00.000Z',
    completedAt: '2026-09-01T00:01:00.000Z',
    artifacts: [{
      path: 'artifacts/result.txt',
      sha256: 'sha256:' + createHash('sha256').update(artifact).digest('hex')
    }],
    approvers: ['security-reviewer', 'audit-reviewer']
  };
  const reportPath = join(directory, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report));
  return { directory, report, reportPath };
}

describe('acceptance evidence validation', () => {
  it('validates immutable in-directory evidence and two-person approval', () => {
    const { reportPath } = fixture();
    expect(validateEvidenceReport(reportPath, 'POC-01').report.status).toBe('PASS');
  });

  it('rejects artifact path traversal', () => {
    const { directory, report, reportPath } = fixture();
    report.artifacts[0].path = '../outside.txt';
    writeFileSync(join(directory, 'outside.txt'), 'immutable test evidence');
    writeFileSync(reportPath, JSON.stringify(report));
    expect(() => validateEvidenceReport(reportPath, 'POC-01')).toThrow(/escapes/);
  });

  it('rejects changed evidence bytes', () => {
    const { directory, reportPath } = fixture();
    writeFileSync(join(directory, 'artifacts', 'result.txt'), 'changed');
    expect(() => validateEvidenceReport(reportPath, 'POC-01')).toThrow(/hash mismatch/);
  });
});
