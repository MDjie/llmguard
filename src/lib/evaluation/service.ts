import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { GuardAction, GuardRequest } from '@guardllm/contracts';
import { canonicalJson, loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import type { TenantScope } from '@/lib/tenancy';
import { scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  evaluationResults,
  evaluationRuns,
  testCases,
} from '@/storage/database/shared/schema';
import { calculateEvaluationMetrics, type EvaluationMetricInput } from './metrics';

export class EvaluationSubmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'EvaluationSubmissionError';
  }
}

export interface EvaluationSubmission {
  readonly run: typeof evaluationRuns.$inferSelect;
  readonly reused: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface EvaluationDatasetCase {
  readonly id: string;
  readonly inputText: string;
  readonly outputText: string | null;
  readonly expectedAction: string | null;
  readonly expectedDimensions: string[] | null;
  readonly expectedScoreMin: string | null;
  readonly expectedScoreMax: string | null;
}

export function hashEvaluationDataset(cases: readonly EvaluationDatasetCase[]): string {
  const snapshot = [...cases]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      id: item.id,
      inputText: item.inputText,
      outputText: item.outputText,
      expectedAction: item.expectedAction,
      expectedDimensions: item.expectedDimensions,
      expectedScoreMin: item.expectedScoreMin,
      expectedScoreMax: item.expectedScoreMax,
    }));
  return sha256(canonicalJson(snapshot));
}

function percentage(value: number): string {
  return (value * 100).toFixed(2);
}

export async function submitEvaluationRun(input: {
  scope: TenantScope;
  actorId: string;
  bundleId: string;
  testCaseIds: readonly string[];
  idempotencyKey: string;
  maxAttempts?: number;
}): Promise<EvaluationSubmission> {
  const ids = [...new Set(input.testCaseIds)].sort();
  if (ids.length === 0) {
    throw new EvaluationSubmissionError('EVALUATION_CASES_REQUIRED', 'At least one test case is required');
  }
  const bundle = await loadVerifiedPolicyBundle(input.scope, input.bundleId, { allowPreRelease: true });
  const cases = await db.select({
    id: testCases.id,
    inputText: testCases.inputText,
    outputText: testCases.outputText,
    expectedAction: testCases.expectedAction,
    expectedDimensions: testCases.expectedDimensions,
    expectedScoreMin: testCases.expectedScoreMin,
    expectedScoreMax: testCases.expectedScoreMax,
  }).from(testCases).where(and(
    scopePredicate(testCases, input.scope),
    eq(testCases.enabled, true),
    inArray(testCases.id, ids),
  )).orderBy(asc(testCases.id));
  if (cases.length !== ids.length) {
    throw new EvaluationSubmissionError(
      'EVALUATION_CASES_NOT_FOUND',
      'One or more test cases are missing, disabled or outside the application scope',
    );
  }
  const datasetHash = hashEvaluationDataset(cases);
  const requestHash = sha256(canonicalJson({
    bundleId: bundle.id,
    datasetHash,
    testCaseIds: ids,
  }));
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`${input.scope.tenantId}:${input.scope.applicationId}:${input.idempotencyKey}`}))`);
    const [existing] = await transaction.select().from(evaluationRuns).where(and(
      scopePredicate(evaluationRuns, input.scope),
      eq(evaluationRuns.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new EvaluationSubmissionError(
          'EVALUATION_IDEMPOTENCY_CONFLICT',
          'The idempotency key was already used for a different bundle or dataset',
        );
      }
      return { run: existing, reused: true };
    }
    const [created] = await transaction.insert(evaluationRuns).values({
      ...input.scope,
      userId: input.actorId,
      policyId: bundle.payload.policyId,
      bundleId: bundle.id,
      idempotencyKey: input.idempotencyKey,
      datasetHash,
      requestHash,
      testCaseIds: ids,
      status: 'pending',
      totalCases: ids.length,
      maxAttempts: input.maxAttempts ?? 3,
    }).returning();
    return { run: created, reused: false };
  });
}

async function recoverStaleRuns(staleAfterMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  await db.update(evaluationRuns).set({ status: 'retrying' }).where(and(
    eq(evaluationRuns.status, 'running'),
    lt(evaluationRuns.heartbeatAt, cutoff),
  ));
}

async function claimNextRun(): Promise<typeof evaluationRuns.$inferSelect | null> {
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction.select().from(evaluationRuns)
      .where(inArray(evaluationRuns.status, ['pending', 'retrying']))
      .orderBy(asc(evaluationRuns.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!candidate) return null;
    const now = new Date();
    const [claimed] = await transaction.update(evaluationRuns).set({
      status: 'running',
      attempt: candidate.attempt + 1,
      startedAt: candidate.startedAt ?? now,
      heartbeatAt: now,
    }).where(and(
      eq(evaluationRuns.id, candidate.id),
      scopePredicate(evaluationRuns, candidate),
    )).returning();
    return claimed ?? null;
  });
}

function normalizedExpectedAction(value: string | null): string {
  return (value ?? 'allow').toUpperCase();
}

function scoreForDecision(observations: readonly { score: number }[]): number {
  return Math.round(Math.max(0, ...observations.map((item) => item.score)) * 100);
}

async function executeClaimedRun(run: typeof evaluationRuns.$inferSelect): Promise<void> {
  const scope = { tenantId: run.tenantId, applicationId: run.applicationId };
  if (!run.bundleId) throw new Error('Evaluation run has no signed policy bundle');
  const bundle = await loadVerifiedPolicyBundle(scope, run.bundleId, { allowPreRelease: true });
  const engine = createEngineForPolicyBundle(bundle);
  const cases = await db.select().from(testCases).where(and(
    scopePredicate(testCases, scope),
    inArray(testCases.id, run.testCaseIds),
  )).orderBy(asc(testCases.id));
  if (cases.length !== run.testCaseIds.length) {
    throw new Error('Evaluation dataset changed after submission');
  }
  if (hashEvaluationDataset(cases) !== run.datasetHash) {
    throw new Error('Evaluation dataset digest changed after submission');
  }
  const metricInputs: EvaluationMetricInput[] = [];
  let completedCases = 0;
  for (const testCase of cases) {
    const requestId = `eval-${randomUUID()}`;
    const guardRequest: GuardRequest = {
      contractVersion: '1.0',
      context: {
        traceId: `eval-trace-${randomUUID()}`,
        requestId,
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        direction: 'INPUT',
        absoluteDeadlineEpochMs: Date.now() + 30_000,
        policyBundleId: bundle.id,
      },
      content: { text: testCase.inputText },
    };
    const decision = await engine.evaluate(guardRequest);
    const expectedAction = normalizedExpectedAction(testCase.expectedAction);
    const isCorrect = decision.action === expectedAction;
    metricInputs.push({
      expectedAction,
      actualAction: decision.action as GuardAction,
      latencyMs: decision.latencyMs,
    });
    await db.insert(evaluationResults).values({
      ...scope,
      runId: run.id,
      testCaseId: testCase.id,
      expectedAction,
      actualAction: decision.action,
      actualScore: scoreForDecision(decision.observations),
      decisionId: decision.decisionId,
      latencyMs: decision.latencyMs,
      attempt: run.attempt,
      isCorrect,
      findings: [],
      decision: decision as unknown as Record<string, unknown>,
    }).onConflictDoNothing({
      target: [
        evaluationResults.tenantId,
        evaluationResults.applicationId,
        evaluationResults.runId,
        evaluationResults.testCaseId,
        evaluationResults.attempt,
      ],
    });
    completedCases += 1;
    await db.update(evaluationRuns).set({
      completedCases,
      heartbeatAt: new Date(),
    }).where(and(eq(evaluationRuns.id, run.id), scopePredicate(evaluationRuns, scope)));
  }
  const metrics = calculateEvaluationMetrics(metricInputs);
  await db.update(evaluationRuns).set({
    status: 'completed',
    completedCases,
    accuracy: percentage(metrics.accuracy),
    falsePositiveRate: percentage(metrics.falsePositiveRate),
    falseNegativeRate: percentage(metrics.falseNegativeRate),
    recall: percentage(metrics.recall),
    f1Score: percentage(metrics.f1),
    metrics,
    completedAt: new Date(),
    heartbeatAt: new Date(),
  }).where(and(eq(evaluationRuns.id, run.id), scopePredicate(evaluationRuns, scope)));
}

async function recordRunFailure(run: typeof evaluationRuns.$inferSelect, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : 'Unknown evaluation failure').slice(0, 500);
  const history = [...(run.failureHistory ?? []), {
    attempt: run.attempt,
    at: new Date().toISOString(),
    code: 'EVALUATION_EXECUTION_FAILED',
    message,
  }];
  await db.update(evaluationRuns).set({
    status: run.attempt >= run.maxAttempts ? 'failed' : 'retrying',
    failureHistory: history,
    heartbeatAt: new Date(),
    completedAt: run.attempt >= run.maxAttempts ? new Date() : null,
  }).where(and(
    eq(evaluationRuns.id, run.id),
    scopePredicate(evaluationRuns, run),
  ));
}

export async function processNextEvaluationRun(options: {
  staleAfterMs?: number;
} = {}): Promise<{ runId: string; status: 'completed' | 'retrying' | 'failed' } | null> {
  // This platform worker intentionally claims across tenants; every subsequent query uses the claimed scope.
  await recoverStaleRuns(options.staleAfterMs ?? 120_000);
  const run = await claimNextRun();
  if (!run) return null;
  try {
    await executeClaimedRun(run);
    return { runId: run.id, status: 'completed' };
  } catch (error) {
    await recordRunFailure(run, error);
    return {
      runId: run.id,
      status: run.attempt >= run.maxAttempts ? 'failed' : 'retrying',
    };
  }
}
