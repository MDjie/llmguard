import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const reportDirectory = path.resolve(
  process.env.P6_REPORT_DIRECTORY
    ?? '输出/测试报告/2026-09-04/security-hardening',
);
const logPath = path.join(reportDirectory, 'P6-logs', '16-fault-injection.log');
const outputPath = path.join(reportDirectory, 'P6-fault-injection-summary.json');
const testFiles = [
  'tests/policy-bundle/policy-bundle.test.ts',
  'tests/policy-bundle/local-keys.test.ts',
  'tests/policy-bundle/runtime-error.test.ts',
  'tests/detection/no-policy.test.ts',
  'tests/guardrail/template-runtime.test.ts',
  'tests/guardrail/output-control.test.ts',
  'tests/resource-control/resource-control.test.ts',
  'tests/resource-control/resilience.test.ts',
  'tests/media-analyzer/core.test.ts',
  'tests/media-analyzer/resilience.test.ts',
  'tests/detection/judge.test.ts',
  'tests/guard-engine-v2/dag.test.ts',
  'tests/guard-engine-v2/engine.test.ts',
  'tests/stream-gate/sse-gate.test.ts',
  'tests/guard-jobs/cancellation-contract.test.ts',
  'tests/deployment/production-assets.test.mjs',
];

const scenarios = [
  {
    id: 'FI-POLICY-TAMPER',
    injectedFault: 'Signed policy payload and detector DAG are modified after signing',
    expectedControl: 'Ed25519 verification rejects the modified payload',
    testFiles: ['tests/policy-bundle/policy-bundle.test.ts'],
  },
  {
    id: 'FI-PUBLIC-KEY-MISMATCH',
    injectedFault: 'Private key is paired with an unrelated public key',
    expectedControl: 'Key-pair validation refuses the mismatch',
    testFiles: ['tests/policy-bundle/local-keys.test.ts'],
  },
  {
    id: 'FI-DATABASE-UNAVAILABLE',
    injectedFault: 'Policy storage reports SQLSTATE 08006 or ECONNREFUSED',
    expectedControl: 'Only transient transport failures qualify for bounded last-known-good handling',
    testFiles: ['tests/policy-bundle/runtime-error.test.ts'],
  },
  {
    id: 'FI-NO-POLICY-OR-BINDING',
    injectedFault: 'The policy lookup returns no executable policy rows',
    expectedControl: 'Detection fails closed with POLICY_NOT_AVAILABLE',
    testFiles: ['tests/detection/no-policy.test.ts'],
  },
  {
    id: 'FI-TEMPLATE-RENDER-OR-RECHECK',
    injectedFault: 'Forbidden variables or unsafe rewritten output reach the template path',
    expectedControl: 'Template rendering is refused or converted to a safe fail-closed response',
    testFiles: [
      'tests/guardrail/template-runtime.test.ts',
      'tests/guardrail/output-control.test.ts',
    ],
  },
  {
    id: 'FI-DECODE-BOMB-AND-RESOURCE-BUDGET',
    injectedFault: 'Oversized decode/decompression/media costs exceed signed budgets',
    expectedControl: 'Admission rejects before quota reservation and media parsing rejects bombs',
    testFiles: [
      'tests/resource-control/resilience.test.ts',
      'tests/media-analyzer/core.test.ts',
    ],
  },
  {
    id: 'FI-TENANT-FAIRNESS-AND-BACKLOG',
    injectedFault: 'One tenant fills ordinary queue capacity and queued leases expire or duplicate',
    expectedControl: 'Critical reserve and bounded fair scheduling remain available',
    testFiles: [
      'tests/resource-control/resource-control.test.ts',
      'tests/resource-control/resilience.test.ts',
    ],
  },
  {
    id: 'FI-OCR-ASR-TIMEOUT-AND-CANCEL',
    injectedFault: 'Analyzer dependency stalls, reaches bulkhead limits, or caller cancels',
    expectedControl: 'Bounded retry/circuit/bulkhead logic terminates and propagates cancellation',
    testFiles: [
      'tests/media-analyzer/resilience.test.ts',
      'tests/media-analyzer/core.test.ts',
    ],
  },
  {
    id: 'FI-JUDGE-TIMEOUT',
    injectedFault: 'Judge provider hangs beyond its configured deadline',
    expectedControl: 'Provider is aborted and configured fallback is recorded',
    testFiles: ['tests/detection/judge.test.ts'],
  },
  {
    id: 'FI-DETECTOR-TIMEOUT-AND-COST',
    injectedFault: 'Detector ignores cancellation or exceeds signed DAG cost and time budgets',
    expectedControl: 'Guard returns by the absolute deadline and required failures close safely',
    testFiles: [
      'tests/guard-engine-v2/dag.test.ts',
      'tests/guard-engine-v2/engine.test.ts',
    ],
  },
  {
    id: 'FI-STREAM-CANCEL-AND-BUFFER',
    injectedFault: 'Sensitive tokens span events or the hold-back buffer overflows',
    expectedControl: 'No unsafe commit occurs and upstream is cancelled',
    testFiles: ['tests/stream-gate/sse-gate.test.ts'],
  },
  {
    id: 'FI-JOB-CANCELLATION-RACE',
    injectedFault: 'Cancellation races with retryable worker completion',
    expectedControl: 'Cancellation remains a distinct non-retryable terminal outcome',
    testFiles: ['tests/guard-jobs/cancellation-contract.test.ts'],
  },
  {
    id: 'FI-READONLY-CACHE-MITIGATION',
    injectedFault: 'Application root filesystem remains read-only',
    expectedControl: 'Only bounded /app/.next/cache tmpfs is writable',
    testFiles: ['tests/deployment/production-assets.test.mjs'],
  },
];

function command() {
  if (process.platform === 'win32') {
    return {
      executable: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', ['pnpm', 'test:unit', '--run', ...testFiles].join(' ')],
    };
  }
  return { executable: 'pnpm', args: ['test:unit', '--run', ...testFiles] };
}

await mkdir(path.dirname(logPath), { recursive: true });
const invocation = command();
const chunks = [];
const child = spawn(invocation.executable, invocation.args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  windowsHide: true,
});
child.stdout.on('data', (chunk) => {
  chunks.push(chunk);
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  chunks.push(chunk);
  process.stderr.write(chunk);
});
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
});
const log = Buffer.concat(chunks).toString('utf8');
await writeFile(logPath, log, 'utf8');
const fileCount = Number(log.match(/Test Files\s+(\d+) passed/)?.[1] ?? 0);
const testCount = Number(log.match(/Tests\s+(\d+) passed/)?.[1] ?? 0);
const status = exitCode === 0 && fileCount === testFiles.length ? 'PASS' : 'FAIL';
const output = {
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  status,
  execution: {
    command: 'pnpm test:unit --run <16 fixed fault-injection files>',
    exitCode,
    testFiles: fileCount,
    tests: testCount,
    log: 'P6-logs/16-fault-injection.log',
  },
  scenarios: scenarios.map((scenario) => ({
    ...scenario,
    status: exitCode === 0 ? 'PASS' : 'FAIL',
  })),
  qualification: {
    localControlledFaults: true,
    targetTopologyChaosExercise: 'BLOCKED_EXTERNAL',
  },
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ status, testFiles: fileCount, tests: testCount })}\n`);
if (status !== 'PASS') process.exitCode = 1;
