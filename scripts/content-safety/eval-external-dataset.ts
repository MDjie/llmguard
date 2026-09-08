// 离线规则引擎外部数据集评测(无 DB、无网络、无裁判模型)。
// 用法: tsx scripts/content-safety/eval-external-dataset.ts <cases.jsonl> <outPrefix> [builtin|builtin+lexicon]
// 数据格式: detectionCaseSchema JSONL (由 eval-data/llmguard-eval/convert_to_cases.py 生成)
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { detectionCaseSchema } from '../../src/lib/evaluation/optimization-dataset';
import { createEngineForPolicyBundle } from '../../src/lib/guard-engine-v2';
import type { RuleExceptionSpec, RuleSpec } from '../../src/lib/guard-engine-v2';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHADOW_PATH = path.join(PROJECT_ROOT, 'data/content-safety/lexicon/releases/content-safety-lexicon.v0.1.0-candidate.shadow.json');
const HMAC_KEY = 'offline-external-dataset-eval-key-32-bytes';
const ENGINE_POLICY_ID = 'offline-external-eval';
const BUNDLE_ID = 'offline-external-eval-bundle';

interface ShadowLexicon {
  readonly lexiconVersion: string;
  readonly contentHash: string;
  readonly rules: readonly RuleSpec[];
  readonly exceptions: readonly RuleExceptionSpec[];
}

const rate = (count: number, total: number): number => (total === 0 ? 0 : count / total);

const percentile = (sorted: readonly number[], q: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0;

const git = (args: readonly string[]): string => {
  try {
    return execFileSync('git', ['-c', 'safe.directory=' + PROJECT_ROOT, ...args], { encoding: 'utf8', cwd: PROJECT_ROOT }).trim();
  } catch {
    return 'UNAVAILABLE';
  }
};

async function loadCases(casesPath: string) {
  const lines = (await readFile(casesPath, 'utf8')).split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    const parsed = detectionCaseSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`case line ${index + 1} failed schema: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

async function main(): Promise<void> {
  const [casesPath, outPrefix, config = 'builtin+lexicon'] = process.argv.slice(2);
  if (!casesPath || !outPrefix) {
    throw new Error('usage: eval-external-dataset.ts <cases.jsonl> <outPrefix> [builtin|builtin+lexicon]');
  }
  const includeLexicon = config === 'builtin+lexicon';

  let lexicon: ShadowLexicon | null = null;
  let rules: readonly RuleSpec[] = [];
  let exceptions: readonly RuleExceptionSpec[] = [];
  if (includeLexicon) {
    lexicon = JSON.parse(await readFile(SHADOW_PATH, 'utf8')) as ShadowLexicon;
    rules = lexicon.rules;
    exceptions = lexicon.exceptions;
  }

  const engine = createEngineForPolicyBundle(
    {
      id: BUNDLE_ID,
      generation: 0,
      payload: {
        schemaVersion: '1.0',
        policyId: ENGINE_POLICY_ID,
        policyVersion: 1,
        dimensions: [],
        rules,
        exceptions: exceptions.map(exception => ({ ...exception, mandatoryDenyExempt: false as const })),
        thresholds: [],
      },
    },
    HMAC_KEY,
  );

  const cases = await loadCases(casesPath);
  interface Row {
    caseId: string;
    expectedPositive: boolean;
    actualPositive: boolean;
    action: string;
    matchedRiskIds: readonly string[];
    familyTags: readonly string[];
    latencyMs: number;
  }
  const rows: Row[] = [];
  const startedAll = performance.now();
  for (const [index, testCase] of cases.entries()) {
    const started = performance.now();
    const decision = await engine.evaluate({
      contractVersion: '1.0',
      context: {
        traceId: `external-eval-${index}`,
        requestId: testCase.caseId,
        tenantId: 'offline-eval',
        applicationId: 'external-dataset',
        direction: testCase.direction,
        locale: testCase.locale,
        absoluteDeadlineEpochMs: Date.now() + 30_000,
        policyBundleId: BUNDLE_ID,
      },
      content: { text: testCase.text },
    });
    const latencyMs = performance.now() - started;
    const matchedRiskIds = [...new Set(decision.observations.filter((item) => item.status === 'MATCH').map((item) => item.riskType))];
    rows.push({
      caseId: testCase.caseId,
      expectedPositive: testCase.expectedRiskIds.length > 0,
      actualPositive: decision.action !== 'ALLOW',
      action: decision.action,
      matchedRiskIds,
      familyTags: testCase.familyTags,
      latencyMs,
    });
    if ((index + 1) % 5000 === 0) {
      console.log(`  ${index + 1}/${cases.length} elapsed=${((performance.now() - startedAll) / 1000).toFixed(0)}s`);
    }
  }

  const positives = rows.filter((row) => row.expectedPositive);
  const negatives = rows.filter((row) => !row.expectedPositive);
  const tp = positives.filter((row) => row.actualPositive).length;
  const fn = positives.length - tp;
  const fp = negatives.filter((row) => row.actualPositive).length;
  const tn = negatives.length - fp;
  const precision = rate(tp, tp + fp);
  const recall = rate(tp, tp + fn);
  const latencies = rows.map((row) => row.latencyMs).sort((left, right) => left - right);

  const actionOnPositive = Object.fromEntries(
    [...new Set(positives.map((row) => row.action))].sort().map((action) => [action, positives.filter((row) => row.action === action).length]),
  );
  const actionOnNegative = Object.fromEntries(
    [...new Set(negatives.map((row) => row.action))].sort().map((action) => [action, negatives.filter((row) => row.action === action).length]),
  );

  const byRisk = Object.fromEntries(
    [...new Set(rows.flatMap((row) => row.matchedRiskIds))].sort().map((riskId) => {
      const riskTp = positives.filter((row) => row.actualPositive && row.matchedRiskIds.includes(riskId)).length;
      return [riskId, { positiveHits: riskTp, hitRateOnPositive: rate(riskTp, positives.length), totalMatches: rows.filter((row) => row.matchedRiskIds.includes(riskId)).length }];
    }),
  );

  const strata: Record<string, unknown> = {};
  const allTags = [...new Set(rows.flatMap((row) => row.familyTags))].sort();
  for (const tag of allTags) {
    const subset = rows.filter((row) => row.familyTags.includes(tag));
    const subsetPositives = subset.filter((row) => row.expectedPositive);
    const subsetNegatives = subset.filter((row) => !row.expectedPositive);
    strata[tag] = {
      cases: subset.length,
      recall: rate(subsetPositives.filter((row) => row.actualPositive).length, subsetPositives.length),
      falsePositiveRate: rate(subsetNegatives.filter((row) => row.actualPositive).length, subsetNegatives.length),
      nonAllowRate: rate(subset.filter((row) => row.actualPositive).length, subset.length),
    };
  }

  const report = {
    schemaVersion: '1.0',
    kind: 'offline-external-dataset-evaluation',
    capturedAt: new Date().toISOString(),
    git: { branch: git(['branch', '--show-current']), revision: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0 },
    environment: { node: process.version, platform: process.platform, database: 'NOT_USED', network: 'NOT_USED', realModelCalls: 0 },
    engine: {
      config,
      bundleId: BUNDLE_ID,
      policyId: ENGINE_POLICY_ID,
      lexiconVersion: lexicon?.lexiconVersion ?? null,
      lexiconContentHash: lexicon?.contentHash ?? null,
      lexiconRuleCount: rules.length,
    },
    dataset: { path: path.relative(PROJECT_ROOT, path.resolve(casesPath)), cases: cases.length, positives: positives.length, negatives: negatives.length },
    binary: {
      confusion: { tp, fp, tn, fn },
      precision: rate(tp, tp + fp),
      recall,
      f1: rate(2 * precision * recall, precision + recall),
      falsePositiveRate: rate(fp, fp + tn),
      falseNegativeRate: rate(fn, fn + tp),
      accuracy: rate(tp + tn, cases.length),
    },
    actionsOnPositive: actionOnPositive,
    actionsOnNegative: actionOnNegative,
    byRisk,
    strata,
    latency: {
      p50Ms: Number(percentile(latencies, 0.5).toFixed(3)),
      p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
      p99Ms: Number(percentile(latencies, 0.99).toFixed(3)),
      meanMs: Number((latencies.reduce((total, value) => total + value, 0) / latencies.length).toFixed(3)),
    },
    qualityStatus: 'ENGINEERING_EVIDENCE_ONLY',
    qualificationReasons: ['EXTERNAL_PUBLIC_DATASETS', 'ANNOTATION_SINGLE_SOURCE', 'OFFLINE_RULES_ONLY_NO_JUDGE_NO_SEMANTIC'],
  };

  await mkdir(path.dirname(path.resolve(outPrefix + '.json')), { recursive: true });
  await writeFile(outPrefix + '.json', JSON.stringify(report, null, 2) + '\n', 'utf8');
  await writeFile(
    outPrefix + '-rows.jsonl',
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );
  console.log(JSON.stringify({ output: outPrefix + '.json', cases: cases.length, recall: report.binary.recall, fpr: report.binary.falsePositiveRate, f1: report.binary.f1 }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : 'EXTERNAL_EVAL_FAILED');
  process.exitCode = 1;
});
