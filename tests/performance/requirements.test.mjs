import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  performanceViolations,
  validatePerformanceReport,
} from '../../scripts/acceptance/validate-performance-report.mjs';

const manifest = JSON.parse(readFileSync('acceptance/performance-requirements.json', 'utf8'));

function passingReport() {
  return {
    environment: {
      targetEnvironment: true,
      fullPolicyEnabled: true,
      version: '1.0.0',
      configurationDigest: 'sha256:' + 'a'.repeat(64),
    },
    dataset: {
      attackBlockRate: 0.99,
      recall: 0.95,
      precision: 0.95,
      benignFalseBlockRate: 0.01,
    },
    fastPath: {
      classifierAccuracy: 0.98,
      classifierP99Ms: 200,
      mainPathP99Ms: 300,
      singleNodeQps: 20,
      clusterQps: 200,
      durationSeconds: 1800,
      errorRate: 0.001,
      scalingInterruptedRequests: 0,
    },
    concurrency: {
      sessions: 3000,
      consoleUsers: 300,
      sessionIsolationFailures: 0,
    },
    resources: {
      cpuPeakPercent: 80,
      memoryPeakPercent: 75,
      timeSeriesEvidence: 'evidence/prometheus.json',
    },
  };
}

describe('PER-001..006 performance acceptance', () => {
  it('accepts only a complete report at every exact threshold', () => {
    expect(validatePerformanceReport(passingReport(), manifest, { requireTarget: true }))
      .toEqual({ status: 'PASS', violations: [] });
  });

  it('rejects optimistic code fixtures in release mode', () => {
    const report = passingReport();
    report.environment.targetEnvironment = false;
    expect(performanceViolations(report, manifest, { requireTarget: true }))
      .toContain('TARGET_ENVIRONMENT_REQUIRED');
  });

  it('rejects latency, resource, concurrency and isolation regressions together', () => {
    const report = passingReport();
    report.fastPath.mainPathP99Ms = 301;
    report.concurrency.sessions = 2999;
    report.concurrency.sessionIsolationFailures = 1;
    report.resources.cpuPeakPercent = 80.1;
    expect(performanceViolations(report, manifest, { requireTarget: true })).toEqual([
      'MAIN_PATH_P99_ABOVE_TARGET',
      'SESSIONS_BELOW_TARGET',
      'CPU_PEAK_ABOVE_TARGET',
      'SESSION_ISOLATION_FAILURE',
    ]);
  });

  it('keeps load scripts aligned with 20/200 QPS, 3000 sessions and 300 console users', () => {
    const fastPath = readFileSync(manifest.scripts.fastPath, 'utf8');
    const sessions = readFileSync(manifest.scripts.sessions, 'utf8');
    const consoleUsers = readFileSync(manifest.scripts.console, 'utf8');
    expect(fastPath).toContain("GUARD_RATE || 20");
    expect(fastPath).toContain("'p(99)<300'");
    expect(sessions).toContain('GUARD_SESSIONS || 3000');
    expect(sessions).toContain('/api/v1/guard/evaluate');
    expect(consoleUsers).toContain('CONSOLE_USERS || 300');
    expect(consoleUsers).toContain('/api/stats');
  });
});
