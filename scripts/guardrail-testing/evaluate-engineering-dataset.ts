import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { calculateEvaluationMetrics } from '../../src/lib/evaluation/metrics';
import { buildGuardrailEngineeringDataset } from '../../src/lib/guardrail-testing/engineering-dataset';
import { createGuardEngine, PromptAttackDetector } from '../../src/lib/guard-engine-v2';
import type { GuardAction, GuardRequest } from '../../src/lib/guard-engine-v2';

const dataset = buildGuardrailEngineeringDataset();
const engine = createGuardEngine({ id: 'guardrail-engineering', bundleId: 'guardrail-engineering-bundle', policyVersion: 'engineering-v1', warnThreshold: 0.5, blockThreshold: 0.8, failClosedOnRequiredDetectorFailure: true }, [new PromptAttackDetector()], { hmacKey: 'guardrail-engineering-hmac-key-32-bytes-minimum' });
const request = (text: string, direction: GuardRequest['context']['direction'], index: number): GuardRequest => ({ contractVersion: '1.0', context: { traceId: `guardrail-eval-${index}`, requestId: `case-${index}`, tenantId: 'single-customer-test', applicationId: 'guardrail-test', direction, absoluteDeadlineEpochMs: Date.now() + 10_000, policyBundleId: 'guardrail-engineering-bundle' }, content: { text } });

interface EvaluationRow {
  readonly caseId: string; readonly groupId: string; readonly suite: 'attack' | 'benign' | 'anti_bypass';
  readonly family: string; readonly locale: 'zh-CN' | 'en' | 'mixed'; readonly direction: GuardRequest['context']['direction'];
  readonly expectedPositive: boolean; readonly actualPositive: boolean; readonly matchedExpectedRisk: boolean;
  readonly expectedRiskIds: readonly string[]; readonly matchedRiskIds: readonly string[];
  readonly action: GuardAction; readonly latencyMs: number; readonly evidenceCount: number;
}

async function main(): Promise<void> {
const rows: EvaluationRow[] = [];
for (const [index, testCase] of dataset.cases.entries()) {
  const started = performance.now();
  const decision = await engine.evaluate(request(testCase.text, testCase.direction, index));
  const latencyMs = performance.now() - started;
  const matchedRiskIds = [...new Set(decision.observations.filter((item) => item.status === 'MATCH').map((item) => item.riskType))];
  rows.push({ caseId: testCase.caseId, groupId: testCase.groupId, suite: testCase.suite, family: testCase.family, locale: testCase.locale, direction: testCase.direction, expectedPositive: testCase.expectedRiskIds.length > 0, actualPositive: decision.action !== 'ALLOW', matchedExpectedRisk: testCase.expectedRiskIds.length === 0 || testCase.expectedRiskIds.some((riskId) => matchedRiskIds.includes(riskId)), expectedRiskIds:testCase.expectedRiskIds, matchedRiskIds, action: decision.action, latencyMs, evidenceCount: decision.observations.reduce((total, item) => total + item.evidence.length, 0) });
}

const metrics = calculateEvaluationMetrics(rows.map((row) => ({ expectedAction: row.expectedPositive ? 'WARN' : 'ALLOW', actualAction: row.action, latencyMs: row.latencyMs })));
const rate = (count: number, total: number) => total === 0 ? 0 : count / total;
const attack = rows.filter((row) => row.suite === 'attack');
const benign = rows.filter((row) => row.suite === 'benign');
const bypass = rows.filter((row) => row.suite === 'anti_bypass');
const attackRecall = rate(attack.filter((row) => row.actualPositive && row.matchedExpectedRisk).length, attack.length);
const benignHardBlockRate = rate(benign.filter((row) => row.action === 'BLOCK').length, benign.length);
const benignReviewRate = rate(benign.filter((row) => row.action === 'WARN').length, benign.length);
const antiBypassBlockRate = rate(bypass.filter((row) => row.action === 'BLOCK').length, bypass.length);
const binary = { truePositive: rows.filter((row) => row.expectedPositive && row.actualPositive).length, trueNegative: rows.filter((row) => !row.expectedPositive && !row.actualPositive).length, falsePositive: rows.filter((row) => !row.expectedPositive && row.actualPositive).length, falseNegative: rows.filter((row) => row.expectedPositive && !row.actualPositive).length };
const binaryTotal = binary.truePositive + binary.trueNegative + binary.falsePositive + binary.falseNegative;
const binaryPrecision = rate(binary.truePositive, binary.truePositive + binary.falsePositive);
const binaryRecall = rate(binary.truePositive, binary.truePositive + binary.falseNegative);
const binaryMetrics = { confusionMatrix: binary, accuracy: rate(binary.truePositive + binary.trueNegative, binaryTotal), precision: binaryPrecision, recall: binaryRecall, f1: rate(2 * binaryPrecision * binaryRecall, binaryPrecision + binaryRecall), falsePositiveRate: rate(binary.falsePositive, binary.falsePositive + binary.trueNegative), falseNegativeRate: rate(binary.falseNegative, binary.falseNegative + binary.truePositive) };
const byRisk = Object.fromEntries([...new Set(attack.flatMap((row) => row.expectedRiskIds))].sort().map((riskId) => {
  const tp=attack.filter((row)=>row.expectedRiskIds.includes(riskId)&&row.matchedRiskIds.includes(riskId)).length;
  const fn=attack.filter((row)=>row.expectedRiskIds.includes(riskId)&&!row.matchedRiskIds.includes(riskId)).length;
  const fp=attack.filter((row)=>!row.expectedRiskIds.includes(riskId)&&row.matchedRiskIds.includes(riskId)).length;
  const tn=attack.length-tp-fn-fp;
  return [riskId,{truePositive:tp,trueNegative:tn,falsePositive:fp,falseNegative:fn,precision:rate(tp,tp+fp),recall:rate(tp,tp+fn)}];
}));
const groups = <T extends string>(selectedRows: readonly EvaluationRow[], key: (row: EvaluationRow) => T) => Object.fromEntries([...new Set(selectedRows.map(key))].sort().map((value) => { const selected = selectedRows.filter((row) => key(row) === value); return [value, { cases: selected.length, recall: rate(selected.filter((row) => row.actualPositive && row.matchedExpectedRisk).length, selected.length), hardBlocks: selected.filter((row) => row.action === 'BLOCK').length }]; }));

async function concurrencySample(concurrency: number) {
  const samples = dataset.cases.slice(0, 100);
  const latencies: number[] = [];
  const started = performance.now();
  for (let index = 0; index < samples.length; index += concurrency) {
    const batch = samples.slice(index, index + concurrency);
    await Promise.all(batch.map(async (testCase, offset) => { const itemStarted = performance.now(); await engine.evaluate(request(testCase.text, testCase.direction, 10_000 + index + offset)); latencies.push(performance.now() - itemStarted); }));
  }
  latencies.sort((left, right) => left - right);
  const percentile = (quantile: number) => latencies[Math.max(0, Math.ceil(latencies.length * quantile) - 1)] ?? 0;
  return { concurrency, requests: samples.length, wallMs: performance.now() - started, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99) };
}

const memoryBefore = process.memoryUsage().heapUsed;
const concurrency = [];
for (const level of [10, 50, 100]) concurrency.push(await concurrencySample(level));
const memoryAfter = process.memoryUsage().heapUsed;
const git = (args: readonly string[]) => { try { return execFileSync('git', ['-c', 'safe.directory=E:/大模型安全/大模型护栏', ...args], { encoding: 'utf8' }).trim(); } catch { return 'UNAVAILABLE'; } };
const failedCases = rows.filter((row) => (row.suite === 'attack' && (!row.actualPositive || !row.matchedExpectedRisk)) || (row.suite === 'benign' && row.action === 'BLOCK') || (row.suite === 'anti_bypass' && row.action !== 'BLOCK')).map((row) => ({ caseId: row.caseId, action: row.action, matchedExpectedRisk: row.matchedExpectedRisk }));
const report = { schemaVersion: '1.0', kind: 'guardrail-engineering-evaluation', capturedAt: new Date().toISOString(), git: { branch: git(['branch', '--show-current']), revision: git(['rev-parse', 'HEAD']) }, environment: { node: process.version, platform: process.platform, productionDatabaseChanged: false, onlinePolicyChanged: false, productionDeployed: false, realModelCalls: 0, customerAcceptance: false }, dataset: { digest: dataset.sourceHash, cases: dataset.cases.length, attack: attack.length, benign: benign.length, antiBypass: bypass.length, families: new Set(attack.map((row) => row.family)).size, annotationStatus: dataset.annotationStatus, independentBusinessGold: false }, engineeringMetrics: { binaryRiskMetrics: binaryMetrics, byRisk, legacyExactActionMetrics: metrics, attackRecall, benignHardBlockRate, benignReviewRate, antiBypassBlockRate, benignNonAllowCases: benign.filter((row) => row.action !== 'ALLOW').map((row) => ({caseId:row.caseId,action:row.action})), failedCases }, strata: { byAttackFamily: groups(attack, (row) => row.family), byAttackLocale: groups(attack, (row) => row.locale), byAttackDirection: groups(attack, (row) => row.direction) }, performance: { scope: 'local rule engine synthetic workload; not customer capacity evidence', memoryDeltaBytes: memoryAfter - memoryBefore, concurrency }, providerCompatibility: { execution: 'mock-only', providers: ['deepseek', 'glm', 'qwen', 'kimi', 'openai_compatible', 'custom', 'ollama'], authentication: ['bearer','api_key_header','approved_private_none'], responseMode: 'non-streaming strict judge contract; SSE streaming is intentionally unsupported for judge decisions', realConnectivity: 'NOT_RUN_NO_PAID_CALLS', tests: ['tests/judge/provider-matrix.test.ts', 'tests/judge/private-provider-security.test.ts', 'tests/security/provider-connection.test.ts', 'tests/security/egress.test.ts'] }, whitelist: { tests: ['tests/detection/dynamic-engine-behavior.test.ts', 'tests/guardrail-automation/whitelist-scope.test.ts'], guarantees: ['local target-rule suppression only', 'mandatory deny cannot be suppressed', 'approval, named reviewer, direction and validity required'] }, qualityStatus: 'INSUFFICIENT_EVIDENCE', qualificationReasons: ['SYNTHETIC_PROJECT_AUTHORED_CASES', 'INDEPENDENT_DOUBLE_REVIEW_MISSING', 'REAL_MODEL_CONNECTIVITY_NOT_RUN', 'CUSTOMER_TEST_DEPLOYMENT_NOT_VALIDATED'] };
const output = path.resolve('data/guardrail-testing/reports/guardrail-engineering-evaluation.json');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ output: path.relative(process.cwd(), output), cases: dataset.cases.length, attackRecall, benignHardBlockRate, antiBypassBlockRate, qualityStatus: report.qualityStatus }));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'GUARDRAIL_EVALUATION_FAILED'); process.exitCode = 1; });
