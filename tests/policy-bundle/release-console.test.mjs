import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const releases = readFileSync('src/app/policy-releases/page.tsx', 'utf8');
const evaluations = readFileSync('src/app/evaluation-runs/page.tsx', 'utf8');
const navigation = readFileSync('src/components/layout/app-layout.tsx', 'utf8');

describe('signed policy release consoles', () => {
  it('drives the signed bundle lifecycle with optimistic locking and CSRF', () => {
    expect(releases).toContain("fetch('/api/policy-bundles'");
    expect(releases).toContain("method: 'PATCH'");
    expect(releases).toContain('expectedVersion: selected.lifecycleVersion');
    expect(releases).toContain("action === 'record_test_pass'");
    expect(releases).toContain("action === 'canary'");
    expect(releases).toContain('csrfHeaders()');
  });

  it('submits idempotent asynchronous evaluations and renders replayable evidence', () => {
    expect(evaluations).toContain("fetch('/api/evaluation-runs'");
    expect(evaluations).toContain('idempotencyKey');
    expect(evaluations).toContain('crypto.randomUUID()');
    expect(evaluations).toContain('detail.datasetHash');
    expect(evaluations).toContain('detail.failureHistory');
    expect(evaluations).toContain('detail.results');
  });

  it('exposes both workflows in the primary navigation', () => {
    expect(navigation).toContain("href: '/policy-releases'");
    expect(navigation).toContain("href: '/evaluation-runs'");
  });
});
