import { createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Direction, GuardRequest } from '@guardllm/contracts';
import {
  createGuardEngine,
  buildNormalizedViews,
  RuleDetector,
  type RuleExceptionSpec,
  type RuleSpec,
} from '../../src/lib/guard-engine-v2';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHADOW_PATH = path.join(PROJECT_ROOT, 'data/content-safety/lexicon/releases/content-safety-lexicon.v0.1.0-candidate.shadow.json');
const CASES_PATH = path.join(PROJECT_ROOT, 'data/content-safety/evaluations/lexicon-hard-negatives.v1.jsonl');
const REPORT_PATH = path.join(PROJECT_ROOT, 'data/content-safety/reports/shadow-evaluation.json');
const HMAC_KEY = 'content-safety-shadow-evaluation-key-32-bytes';

interface ShadowBundle {
  readonly lexiconVersion: string;
  readonly contentHash: string;
  readonly enforcementAllowed: false;
  readonly rules: readonly RuleSpec[];
  readonly exceptions: readonly RuleExceptionSpec[];
}

interface EvaluationCase {
  readonly _type: 'evaluation_case';
  readonly case_id: string;
  readonly allow_id: string;
  readonly case_kind: string;
  readonly direction: Direction;
  readonly evaluation_time_epoch_ms: number;
  readonly input: string;
  readonly target_rule_ids: readonly string[];
  readonly expected: {
    readonly minimum_target_observations: number;
    readonly maximum_target_observations: number | null;
    readonly mandatory_deny_may_be_exempted: false;
  };
}

function parseJsonLines<T>(content: string): T[] {
  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function requestForCase(testCase: EvaluationCase, bundleId: string): GuardRequest {
  return {
    contractVersion: '1.0',
    context: {
      traceId: 'lexicon-evaluation-trace',
      requestId: testCase.case_id,
      tenantId: 'offline-evaluation',
      applicationId: 'lexicon-shadow',
      direction: testCase.direction,
      absoluteDeadlineEpochMs: Date.now() + 10_000,
      policyBundleId: bundleId,
    },
    content: { text: testCase.input },
  };
}

async function evaluateCase(bundle: ShadowBundle, testCase: EvaluationCase) {
  const detector = new RuleDetector(
    bundle.rules,
    'lexicon-shadow-' + bundle.lexiconVersion,
    bundle.exceptions,
    () => testCase.evaluation_time_epoch_ms,
  );
  const engine = createGuardEngine(
    {
      id: 'lexicon-shadow-evaluation',
      bundleId: bundle.contentHash,
      warnThreshold: 0.01,
      blockThreshold: 1,
      failClosedOnRequiredDetectorFailure: true,
    },
    [detector],
    { hmacKey: HMAC_KEY },
  );
  const request = requestForCase(testCase, bundle.contentHash);
  try {
    await detector.detect({
      request,
      envelopes: [],
      views: buildNormalizedViews(testCase.input),
      signal: new AbortController().signal,
      evidenceHmac: (content) => createHmac('sha256', HMAC_KEY).update(content).digest('hex'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(testCase.case_id + ': direct detector failure: ' + message);
  }
  const decision = await engine.evaluate(request);
  const targetReasonCodes = new Set(testCase.target_rule_ids.map((id) => 'RULE_' + id));
  const targetObservations = decision.observations.filter((observation) =>
    observation.reasonCode !== undefined && targetReasonCodes.has(observation.reasonCode),
  );
  const detectorFailed = decision.observations.some((observation) =>
    observation.reasonCode === 'DETECTOR_FAILED' ||
    observation.reasonCode === 'DETECTOR_DEADLINE_EXCEEDED',
  );
  const observed = targetObservations.length;
  const aboveMinimum = observed >= testCase.expected.minimum_target_observations;
  const belowMaximum = testCase.expected.maximum_target_observations === null ||
    observed <= testCase.expected.maximum_target_observations;
  const mandatoryBypass = decision.observations.some((observation) =>
    observation.reasonCode === 'MANDATORY_DENY' && targetReasonCodes.has(observation.reasonCode),
  );
  return {
    caseId: testCase.case_id,
    allowId: testCase.allow_id,
    caseKind: testCase.case_kind,
    passed: aboveMinimum && belowMaximum && !mandatoryBypass && !detectorFailed,
    detectorFailed,
    targetObservationCount: observed,
    expectedMinimum: testCase.expected.minimum_target_observations,
    expectedMaximum: testCase.expected.maximum_target_observations,
    observedReasonCodes: decision.observations.map((observation) => observation.reasonCode),
  };
}

async function main(): Promise<void> {
  const [bundleContent, casesContent] = await Promise.all([
    readFile(SHADOW_PATH, 'utf8'),
    readFile(CASES_PATH, 'utf8'),
  ]);
  const bundle = JSON.parse(bundleContent) as ShadowBundle;
  if (bundle.enforcementAllowed !== false) {
    throw new Error('Evaluation refuses bundles that are not explicitly shadow-only');
  }
  const cases = parseJsonLines<EvaluationCase>(casesContent);
  const results: Awaited<ReturnType<typeof evaluateCase>>[] = [];
  for (const testCase of cases) results.push(await evaluateCase(bundle, testCase));
  const failed = results.filter((result) => !result.passed);
  const byKind = Object.fromEntries(
    [...new Set(results.map((result) => result.caseKind))]
      .sort()
      .map((kind) => [kind, {
        total: results.filter((result) => result.caseKind === kind).length,
        passed: results.filter((result) => result.caseKind === kind && result.passed).length,
      }]),
  );
  const report = {
    schema: 'content-safety-shadow-evaluation-report/v1',
    generatedAt: new Date().toISOString(),
    lexiconVersion: bundle.lexiconVersion,
    bundleContentHash: bundle.contentHash,
    passed: failed.length === 0,
    total: results.length,
    passedCount: results.length - failed.length,
    failedCount: failed.length,
    byKind,
    failures: failed,
  };
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (failed.length > 0) {
    console.error('Shadow evaluation failed: ' + failed.length + '/' + results.length);
    process.exitCode = 1;
    return;
  }
  console.log('Shadow evaluation passed: ' + results.length + '/' + results.length);
  console.log('Report: data/content-safety/reports/shadow-evaluation.json');
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Shadow evaluation could not run: ' + message);
  process.exitCode = 1;
});
