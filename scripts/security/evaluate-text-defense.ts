import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  createGuardEngine,
  PromptAttackDetector,
  ReasoningAttackDetector,
} from '../../src/lib/guard-engine-v2';

const datasetSchema = z.object({
  schemaVersion: z.literal('1.0'),
  datasetId: z.string().min(1).max(128),
  description: z.string().min(1).max(512),
  cases: z.array(z.object({
    id: z.string().min(1).max(128),
    family: z.enum(['injection', 'confusion', 'multilingual', 'prompt_leak']),
    expectedRisk: z.boolean(),
    text: z.string().min(1).max(16_384),
  }).strict()).min(1).max(1_000),
}).strict();

interface Counts {
  tp: number;
  tn: number;
  fp: number;
  fn: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

export async function evaluateTextDefense(datasetPath: string) {
  const bytes = readFileSync(datasetPath);
  const dataset = datasetSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (new Set(dataset.cases.map((item) => item.id)).size !== dataset.cases.length) {
    throw new Error('TEXT_DEFENSE_DATASET_CASE_IDS_DUPLICATED');
  }
  const guard = createGuardEngine({
    id: 'p2-evaluation-policy',
    bundleId: 'p2-evaluation-bundle',
    warnThreshold: 0.5,
    blockThreshold: 0.8,
    failClosedOnRequiredDetectorFailure: true,
  }, [new PromptAttackDetector(), new ReasoningAttackDetector()], {
    hmacKey: 'p2-evaluation-hmac-key-at-least-32-bytes',
  });
  const cases = [];
  const counts = new Map<string, Counts>();
  for (const [index, item] of dataset.cases.entries()) {
    const decision = await guard.evaluate({
      contractVersion: '1.0',
      context: {
        traceId: `trace-p2-evaluation-${String(index).padStart(8, '0')}`,
        requestId: `request-p2-evaluation-${String(index).padStart(8, '0')}`,
        tenantId: 'evaluation-tenant',
        applicationId: 'evaluation-app',
        direction: 'INPUT',
        absoluteDeadlineEpochMs: Date.now() + 10_000,
        policyBundleId: 'p2-evaluation-bundle',
      },
      content: { text: item.text },
    });
    const actualRisk = decision.action === 'BLOCK' || decision.action === 'SAFE_RESPONSE';
    const familyCounts = counts.get(item.family) ?? { tp: 0, tn: 0, fp: 0, fn: 0 };
    if (item.expectedRisk && actualRisk) familyCounts.tp += 1;
    else if (!item.expectedRisk && !actualRisk) familyCounts.tn += 1;
    else if (!item.expectedRisk && actualRisk) familyCounts.fp += 1;
    else familyCounts.fn += 1;
    counts.set(item.family, familyCounts);
    cases.push({
      id: item.id,
      family: item.family,
      inputSha256: createHash('sha256').update(item.text, 'utf8').digest('hex'),
      expectedRisk: item.expectedRisk,
      actualRisk,
      action: decision.action,
      reasonCodes: [...new Set(decision.observations
        .map((observation) => observation.reasonCode)
        .filter((value): value is string => value !== undefined))].sort(),
    });
  }
  const metrics = Object.fromEntries([...counts.entries()].sort(([left], [right]) =>
    left.localeCompare(right)).map(([family, value]) => [family, {
      ...value,
      precision: ratio(value.tp, value.tp + value.fp),
      recall: ratio(value.tp, value.tp + value.fn),
      falsePositiveRate: ratio(value.fp, value.fp + value.tn),
      falseNegativeRate: ratio(value.fn, value.fn + value.tp),
      accuracy: ratio(value.tp + value.tn, value.tp + value.tn + value.fp + value.fn),
    }]));
  return {
    schemaVersion: '1.0',
    datasetId: dataset.datasetId,
    datasetSha256: createHash('sha256').update(bytes).digest('hex'),
    caseCount: dataset.cases.length,
    metrics,
    cases,
    privacy: {
      rawInputsPersisted: false,
      evidenceMode: 'sha256-and-reason-codes-only',
      onlineLearning: false,
    },
  };
}

async function main(): Promise<void> {
  const datasetPath = resolve(process.argv[2] ?? 'data/security-evaluation/text-defense-v1.json');
  const outputPath = process.argv[3] ? resolve(process.argv[3]) : undefined;
  const report = await evaluateTextDefense(datasetPath);
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (outputPath) writeFileSync(outputPath, serialized, 'utf8');
  else process.stdout.write(serialized);
  const failed = Object.values(report.metrics).some((metric) =>
    metric.recall < 1 || metric.falsePositiveRate > 0);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'UNKNOWN_EVALUATION_ERROR';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  });
}
