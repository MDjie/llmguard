import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createGuardEngine,
  PromptAttackDetector,
} from '../../src/lib/guard-engine-v2';

interface SampleResult {
  readonly latencyMs: number;
  readonly action: string | null;
  readonly degraded: boolean;
  readonly errorCode: string | null;
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function rounded(value: number | null, digits = 3): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

function summarize(
  results: readonly SampleResult[],
  elapsedMs: number,
  cpu: NodeJS.CpuUsage,
  rssBefore: number,
  rssAfter: number,
) {
  const successful = results.filter((item) => item.errorCode === null);
  const latencies = successful.map((item) => item.latencyMs);
  const actions = successful.reduce<Record<string, number>>((counts, item) => {
    const action = item.action ?? 'UNKNOWN';
    counts[action] = (counts[action] ?? 0) + 1;
    return counts;
  }, {});
  return {
    requests: results.length,
    successes: successful.length,
    errors: results.length - successful.length,
    errorRate: rounded((results.length - successful.length) / Math.max(results.length, 1), 6),
    degradationRate: rounded(
      successful.filter((item) => item.degraded).length / Math.max(successful.length, 1),
      6,
    ),
    latencyMs: {
      min: rounded(latencies.length ? Math.min(...latencies) : null),
      p50: rounded(percentile(latencies, 0.5)),
      p95: rounded(percentile(latencies, 0.95)),
      p99: rounded(percentile(latencies, 0.99)),
      max: rounded(latencies.length ? Math.max(...latencies) : null),
    },
    qps: rounded(results.length / Math.max(elapsedMs / 1_000, 0.001)),
    elapsedMs: rounded(elapsedMs),
    cpuMs: {
      user: rounded(cpu.user / 1_000),
      system: rounded(cpu.system / 1_000),
      total: rounded((cpu.user + cpu.system) / 1_000),
    },
    memoryBytes: {
      rssBefore,
      rssAfter,
      rssDelta: rssAfter - rssBefore,
    },
    actions,
    errorCodes: results
      .filter((item) => item.errorCode !== null)
      .reduce<Record<string, number>>((counts, item) => {
        const code = item.errorCode ?? 'UNKNOWN';
        counts[code] = (counts[code] ?? 0) + 1;
        return counts;
      }, {}),
  };
}

const workspace = process.cwd();

async function main(): Promise<void> {
const outputPath = path.resolve(argument(
  '--output',
  '输出/测试报告/2026-09-04/security-hardening/P6-performance-local.json',
));
const policyBundleId = 'p6-local-fast-path-bundle';
const guard = createGuardEngine({
  id: 'p6-local-fast-path-policy',
  bundleId: policyBundleId,
  policyVersion: 'p6-local-benchmark',
  warnThreshold: 0.5,
  blockThreshold: 0.8,
  failClosedOnRequiredDetectorFailure: true,
}, [new PromptAttackDetector()], {
  hmacKey: 'p6-local-benchmark-hmac-key-at-least-32-bytes',
});

let sequence = 0;
async function evaluate(estimatedTokens: number, tenantId = 'benchmark-tenant-a'): Promise<SampleResult> {
  sequence += 1;
  const text = '安'.repeat(estimatedTokens);
  const startedAt = performance.now();
  try {
    const decision = await guard.evaluate({
      contractVersion: '1.0',
      context: {
        traceId: `p6-fast-path-trace-${String(sequence).padStart(8, '0')}`,
        requestId: `p6-fast-path-request-${String(sequence).padStart(8, '0')}`,
        tenantId,
        applicationId: 'benchmark-app',
        direction: 'INPUT',
        absoluteDeadlineEpochMs: Date.now() + 60_000,
        policyBundleId,
      },
      content: { text },
    });
    return {
      latencyMs: performance.now() - startedAt,
      action: decision.action,
      degraded: Boolean(decision.degraded),
      errorCode: null,
    };
  } catch (error) {
    return {
      latencyMs: performance.now() - startedAt,
      action: null,
      degraded: false,
      errorCode: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    };
  }
}

async function runSequential(estimatedTokens: number, iterations: number) {
  await evaluate(estimatedTokens);
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  const results: SampleResult[] = [];
  for (let index = 0; index < iterations; index += 1) {
    results.push(await evaluate(estimatedTokens));
  }
  const elapsedMs = performance.now() - startedAt;
  return summarize(
    results,
    elapsedMs,
    process.cpuUsage(cpuBefore),
    rssBefore,
    process.memoryUsage().rss,
  );
}

async function runConcurrent(concurrency: number, totalRequests: number) {
  const results: SampleResult[] = [];
  let next = 0;
  let active = 0;
  let maxObservedActive = 0;
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async (_, workerIndex) => {
    while (true) {
      const current = next;
      next += 1;
      if (current >= totalRequests) return;
      active += 1;
      maxObservedActive = Math.max(maxObservedActive, active);
      results.push(await evaluate(
        1_024,
        workerIndex % 2 === 0 ? 'benchmark-tenant-a' : 'benchmark-tenant-b',
      ));
      active -= 1;
    }
  }));
  const elapsedMs = performance.now() - startedAt;
  return {
    ...summarize(
      results,
      elapsedMs,
      process.cpuUsage(cpuBefore),
      rssBefore,
      process.memoryUsage().rss,
    ),
    requestedConcurrency: concurrency,
    maxObservedActive,
    queue: {
      implementation: 'in_process_promise_workers',
      maxQueuedRequests: Math.max(0, totalRequests - concurrency),
      externalWorkerBacklogMeasured: false,
    },
    tenants: 2,
  };
}

const profiles = [
  { estimatedTokens: 1_024, iterations: 40, signoff: 'LOCAL_MEASURED' },
  { estimatedTokens: 8_192, iterations: 16, signoff: 'LOCAL_MEASURED' },
  { estimatedTokens: 32_768, iterations: 6, signoff: 'LOCAL_MEASURED' },
  {
    estimatedTokens: 131_072,
    iterations: 2,
    signoff: 'LOCAL_PROXY_ONLY_TARGET_MODEL_AND_TOKENIZER_REQUIRED',
  },
] as const;
const profileResults = [];
for (const profile of profiles) {
  const metrics = await runSequential(profile.estimatedTokens, profile.iterations);
  profileResults.push({
    ...profile,
    generatedCharacters: profile.estimatedTokens,
    tokenizer: 'synthetic_cjk_one_codepoint_proxy',
    metrics,
  });
  process.stdout.write(
    `[P6 benchmark] ${profile.estimatedTokens} token proxy: ${metrics.successes}/${metrics.requests}\n`,
  );
}
const concurrency = await runConcurrent(8, 64);
const localGateProfiles = profileResults.filter((item) => item.estimatedTokens <= 32_768);
const status = localGateProfiles.every((item) => item.metrics.errors === 0)
  && concurrency.errors === 0
  ? 'PASS'
  : 'FAIL';

const report = {
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  status,
  scope: {
    path: 'GuardEngineV2 + bounded normalization + PromptAttackDetector',
    payload: 'deterministic benign synthetic CJK; no customer content',
    measuredEnvironment: 'local developer workstation',
    productionSloClaimed: false,
  },
  host: {
    platform: process.platform,
    architecture: process.arch,
    logicalCpuCount: os.cpus().length,
    nodeVersion: process.version,
  },
  profiles: profileResults,
  concurrency,
  externalAcceptance: {
    exact128kTargetTokenizer: 'BLOCKED_EXTERNAL',
    targetTopologyThirtyMinuteLoad: 'BLOCKED_EXTERNAL',
    targetHardwareAndCustomerDatabase: 'BLOCKED_EXTERNAL',
  },
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ status, output: path.relative(workspace, outputPath) })}\n`);
if (status !== 'PASS') process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown benchmark error';
  process.stderr.write(`P6 benchmark failed: ${message}\n`);
  process.exitCode = 1;
});
