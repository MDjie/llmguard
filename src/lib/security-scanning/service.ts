import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { canonicalJson } from '@/lib/policy-bundle';
import {
  appendOperationalSecurityEvent,
  type OperationalEventDomain,
} from '@/lib/operations';
import type { TenantScope } from '@/lib/tenancy';
import { scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  securityScanAttempts,
  securityScanAssets,
  securityScanFindingReviews,
  securityScanFindings,
  securityScanTasks,
} from '@/storage/database/shared/schema';
import {
  loadSecurityScannerCatalog,
  RemoteSecurityScanner,
  securityScannerDefinitionDigest,
  validateFindingReview,
  validateSecurityScanTarget,
  type FindingReviewDisposition,
  type SecurityScannerDefinition,
  type SecurityScanTarget,
} from './scanner';

export class SecurityScanSubmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SecurityScanSubmissionError';
  }
}

type ScannerCatalog = ReadonlyMap<string, SecurityScannerDefinition>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashSecurityScanRequest(input: {
  readonly scannerId: string;
  readonly scannerDefinitionDigest: string;
  readonly target: SecurityScanTarget;
}): string {
  return sha256(canonicalJson(input));
}

export async function submitSecurityScan(input: {
  readonly scope: TenantScope;
  readonly actorId: string;
  readonly scannerId: string;
  readonly target: SecurityScanTarget;
  readonly idempotencyKey: string;
  readonly maxAttempts?: number;
  readonly catalog?: ScannerCatalog;
}) {
  const catalog = input.catalog ?? loadSecurityScannerCatalog();
  const definition = catalog.get(input.scannerId);
  if (!definition) {
    throw new SecurityScanSubmissionError(
      'SECURITY_SCANNER_NOT_FOUND',
      'The requested scanner is not present in the trusted scanner catalog',
    );
  }
  const [asset] = await db.select().from(securityScanAssets).where(and(
    eq(securityScanAssets.id, input.target.inventoryId),
    eq(securityScanAssets.status, 'ACTIVE'),
    scopePredicate(securityScanAssets, input.scope),
  )).limit(1);
  if (
    !asset ||
    asset.targetType !== input.target.type ||
    asset.version !== input.target.version ||
    (input.target.sha256 !== undefined && asset.sha256 !== input.target.sha256)
  ) {
    throw new SecurityScanSubmissionError(
      'SECURITY_SCAN_ASSET_NOT_FOUND',
      'The target is not an active, version-matched asset in the authenticated scope',
    );
  }
  const resolvedTarget: SecurityScanTarget = {
    type: input.target.type,
    inventoryId: asset.externalInventoryId,
    version: asset.version,
    ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
  };
  validateSecurityScanTarget(definition, resolvedTarget);
  const definitionDigest = securityScannerDefinitionDigest(definition);
  const requestHash = hashSecurityScanRequest({
    scannerId: definition.id,
    scannerDefinitionDigest: definitionDigest,
    target: {
      ...resolvedTarget,
      inventoryId: asset.id,
    },
  });
  return db.transaction(async (transaction) => {
    const [existing] = await transaction.select().from(securityScanTasks).where(and(
      scopePredicate(securityScanTasks, input.scope),
      eq(securityScanTasks.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new SecurityScanSubmissionError(
          'SECURITY_SCAN_IDEMPOTENCY_CONFLICT',
          'The idempotency key was already used for a different scanner or target',
        );
      }
      return { task: existing, reused: true };
    }
    const [created] = await transaction.insert(securityScanTasks).values({
      ...input.scope,
      assetId: asset.id,
      scannerId: definition.id,
      scanKind: definition.scanKind,
      targetType: resolvedTarget.type,
      targetInventoryId: resolvedTarget.inventoryId,
      targetVersion: resolvedTarget.version,
      targetSha256: resolvedTarget.sha256,
      scannerDefinitionDigest: definitionDigest,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      submittedBy: input.actorId,
      maxAttempts: input.maxAttempts ?? 3,
    }).onConflictDoNothing({
      target: [
        securityScanTasks.tenantId,
        securityScanTasks.applicationId,
        securityScanTasks.idempotencyKey,
      ],
    }).returning();
    if (created) return { task: created, reused: false };
    const [raced] = await transaction.select().from(securityScanTasks).where(and(
      scopePredicate(securityScanTasks, input.scope),
      eq(securityScanTasks.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (!raced || raced.requestHash !== requestHash) {
      throw new SecurityScanSubmissionError(
        'SECURITY_SCAN_IDEMPOTENCY_CONFLICT',
        'The idempotency key was concurrently used for a different scanner or target',
      );
    }
    return { task: raced, reused: true };
  });
}

async function recoverStaleSecurityScans(staleAfterMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  await db.update(securityScanTasks).set({ status: 'RETRYING' }).where(and(
    eq(securityScanTasks.status, 'RUNNING'),
    lt(securityScanTasks.heartbeatAt, cutoff),
  ));
}

async function claimNextSecurityScan() {
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction.select().from(securityScanTasks)
      .where(inArray(securityScanTasks.status, ['QUEUED', 'RETRYING']))
      .orderBy(asc(securityScanTasks.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!candidate) return null;
    const now = new Date();
    const [claimed] = await transaction.update(securityScanTasks).set({
      status: 'RUNNING',
      attempt: candidate.attempt + 1,
      startedAt: candidate.startedAt ?? now,
      heartbeatAt: now,
    }).where(and(
      eq(securityScanTasks.id, candidate.id),
      scopePredicate(securityScanTasks, candidate),
    )).returning();
    return claimed ?? null;
  });
}

function targetFromTask(task: typeof securityScanTasks.$inferSelect): SecurityScanTarget {
  const base = {
    inventoryId: task.targetInventoryId,
    version: task.targetVersion,
  };
  if (task.targetType === 'REGISTERED_HOST') return { ...base, type: 'REGISTERED_HOST' };
  if (task.targetType === 'REGISTERED_WEB_APP') return { ...base, type: 'REGISTERED_WEB_APP' };
  if (task.targetType === 'MODEL_ARTIFACT' && task.targetSha256) {
    return { ...base, type: 'MODEL_ARTIFACT', sha256: task.targetSha256 };
  }
  throw new Error('SECURITY_SCAN_STORED_TARGET_INVALID');
}

async function heartbeat(taskId: string, scope: TenantScope): Promise<void> {
  await db.update(securityScanTasks).set({ heartbeatAt: new Date() }).where(and(
    eq(securityScanTasks.id, taskId),
    eq(securityScanTasks.status, 'RUNNING'),
    scopePredicate(securityScanTasks, scope),
  ));
}

async function recordSecurityScanEvent(input: {
  readonly task: typeof securityScanTasks.$inferSelect;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly evidenceDigest: string;
  readonly findingCount?: number;
}): Promise<void> {
  const domain: OperationalEventDomain =
    input.task.scanKind === 'MODEL_SUPPLY_CHAIN' ? 'MODEL_SECURITY' : 'NETWORK_SECURITY';
  const context = {
    taskId: input.task.id,
    scannerId: input.task.scannerId,
    scanKind: input.task.scanKind,
    targetType: input.task.targetType,
    targetInventoryId: input.task.targetInventoryId,
    findingCount: input.findingCount ?? 0,
  };
  await appendOperationalSecurityEvent({
    id: randomUUID(),
    domain,
    eventType: 'SECURITY_SCAN.' + input.outcome,
    severity: input.outcome === 'FAILED' ? 'HIGH' : 'INFO',
    outcome: input.outcome,
    occurredAt: new Date(),
    tenantId: input.task.tenantId,
    applicationId: input.task.applicationId,
    principalId: input.task.submittedBy,
    source: 'security-scan-worker',
    network: domain === 'NETWORK_SECURITY'
      ? { captureMode: 'APPLICATION_PROXY', sessionId: input.task.id }
      : undefined,
    model: domain === 'MODEL_SECURITY'
      ? { modelId: input.task.targetInventoryId, modelVersion: input.task.targetVersion }
      : undefined,
    evidenceDigest: input.evidenceDigest.replace(/^sha256:/, ''),
    attributes: context,
  });
}

async function executeClaimedSecurityScan(
  task: typeof securityScanTasks.$inferSelect,
  catalog: ScannerCatalog,
): Promise<void> {
  const definition = catalog.get(task.scannerId);
  if (
    !definition ||
    securityScannerDefinitionDigest(definition) !== task.scannerDefinitionDigest ||
    definition.scanKind !== task.scanKind
  ) {
    throw new Error('SECURITY_SCAN_PINNED_SCANNER_UNAVAILABLE');
  }
  const target = targetFromTask(task);
  const startedAt = new Date();
  const intervalMs = Math.max(1_000, Math.min(30_000, Math.floor(definition.maximumDurationMs / 4)));
  const timer = setInterval(() => {
    void heartbeat(task.id, task).catch(() => undefined);
  }, intervalMs);
  let result;
  try {
    result = await new RemoteSecurityScanner(definition).scan(task.id, target);
  } finally {
    clearInterval(timer);
  }
  const completedAt = new Date();
  const resultDigest = 'sha256:' + sha256(canonicalJson(result));
  await db.transaction(async (transaction) => {
    await transaction.insert(securityScanAttempts).values({
      tenantId: task.tenantId,
      applicationId: task.applicationId,
      taskId: task.id,
      attempt: task.attempt,
      status: 'SUCCEEDED',
      scannerId: result.scannerId,
      scannerVersion: result.scannerVersion,
      scannerDigest: result.scannerDigest,
      rawOutputDigest: result.rawOutputDigest,
      startedAt,
      completedAt,
    });
    if (result.findings.length > 0) {
      await transaction.insert(securityScanFindings).values(result.findings.map((finding) => ({
        tenantId: task.tenantId,
        applicationId: task.applicationId,
        taskId: task.id,
        fingerprint: finding.fingerprint,
        ruleId: finding.ruleId,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        evidenceDigest: finding.evidenceDigest,
        remediation: finding.remediation,
      }))).onConflictDoNothing({
        target: [
          securityScanFindings.tenantId,
          securityScanFindings.applicationId,
          securityScanFindings.taskId,
          securityScanFindings.fingerprint,
        ],
      });
    }
    await transaction.update(securityScanTasks).set({
      status: 'SUCCEEDED',
      resultDigest,
      heartbeatAt: completedAt,
      completedAt,
    }).where(and(
      eq(securityScanTasks.id, task.id),
      eq(securityScanTasks.status, 'RUNNING'),
      scopePredicate(securityScanTasks, task),
    ));
  });
  await recordSecurityScanEvent({
    task,
    outcome: 'SUCCEEDED',
    evidenceDigest: resultDigest,
    findingCount: result.findings.length,
  });
}

async function recordSecurityScanFailure(
  task: typeof securityScanTasks.$inferSelect,
  error: unknown,
): Promise<'RETRYING' | 'FAILED'> {
  const completedAt = new Date();
  const message = (error instanceof Error ? error.message : 'Unknown scanner failure').slice(0, 500);
  const status = task.attempt >= task.maxAttempts ? 'FAILED' : 'RETRYING';
  const evidenceDigest = 'sha256:' + sha256(canonicalJson({
    taskId: task.id,
    attempt: task.attempt,
    code: 'SECURITY_SCAN_EXECUTION_FAILED',
    message,
  }));
  await db.transaction(async (transaction) => {
    await transaction.insert(securityScanAttempts).values({
      tenantId: task.tenantId,
      applicationId: task.applicationId,
      taskId: task.id,
      attempt: task.attempt,
      status: 'FAILED',
      scannerId: task.scannerId,
      errorCode: 'SECURITY_SCAN_EXECUTION_FAILED',
      errorMessage: message,
      startedAt: task.heartbeatAt ?? completedAt,
      completedAt,
    }).onConflictDoNothing({
      target: [
        securityScanAttempts.tenantId,
        securityScanAttempts.applicationId,
        securityScanAttempts.taskId,
        securityScanAttempts.attempt,
      ],
    });
    await transaction.update(securityScanTasks).set({
      status,
      heartbeatAt: completedAt,
      completedAt: status === 'FAILED' ? completedAt : null,
      failureHistory: [...task.failureHistory, {
        attempt: task.attempt,
        at: completedAt.toISOString(),
        code: 'SECURITY_SCAN_EXECUTION_FAILED',
        message,
      }],
    }).where(and(
      eq(securityScanTasks.id, task.id),
      eq(securityScanTasks.status, 'RUNNING'),
      scopePredicate(securityScanTasks, task),
    ));
  });
  if (status === 'FAILED') {
    await recordSecurityScanEvent({ task, outcome: 'FAILED', evidenceDigest });
  }
  return status;
}

export async function processNextSecurityScan(options: {
  readonly staleAfterMs?: number;
  readonly catalog?: ScannerCatalog;
} = {}): Promise<{ taskId: string; status: 'SUCCEEDED' | 'RETRYING' | 'FAILED' } | null> {
  await recoverStaleSecurityScans(options.staleAfterMs ?? 120_000);
  const task = await claimNextSecurityScan();
  if (!task) return null;
  try {
    await executeClaimedSecurityScan(task, options.catalog ?? loadSecurityScannerCatalog());
    return { taskId: task.id, status: 'SUCCEEDED' };
  } catch (error) {
    return { taskId: task.id, status: await recordSecurityScanFailure(task, error) };
  }
}

export async function reviewSecurityScanFinding(input: {
  readonly scope: TenantScope;
  readonly findingId: string;
  readonly reviewerId: string;
  readonly disposition: FindingReviewDisposition;
  readonly reason: string;
}) {
  return db.transaction(async (transaction) => {
    const [record] = await transaction.select({
      finding: securityScanFindings,
      task: securityScanTasks,
    }).from(securityScanFindings).innerJoin(
      securityScanTasks,
      and(
        eq(securityScanTasks.id, securityScanFindings.taskId),
        scopePredicate(securityScanTasks, input.scope),
      ),
    ).where(and(
      eq(securityScanFindings.id, input.findingId),
      scopePredicate(securityScanFindings, input.scope),
    )).limit(1).for('update');
    if (!record) {
      throw new SecurityScanSubmissionError(
        'SECURITY_SCAN_FINDING_NOT_FOUND',
        'The finding does not exist in the authenticated scope',
      );
    }
    const previous = await transaction.select({
      reviewerId: securityScanFindingReviews.reviewerId,
      disposition: securityScanFindingReviews.disposition,
    }).from(securityScanFindingReviews).where(and(
      eq(securityScanFindingReviews.findingId, input.findingId),
      scopePredicate(securityScanFindingReviews, input.scope),
    )).orderBy(asc(securityScanFindingReviews.createdAt));
    validateFindingReview({
      disposition: input.disposition,
      submitterId: record.task.submittedBy,
      reviewerId: input.reviewerId,
      previousReviewerIds: previous.map((item) => item.reviewerId),
      previousDispositions: previous.flatMap((item) => {
        const disposition = item.disposition;
        return [
          'CONFIRMED',
          'FALSE_POSITIVE',
          'DISPUTED',
          'ARBITRATED_CONFIRMED',
          'ARBITRATED_FALSE_POSITIVE',
        ].includes(disposition)
          ? [disposition as FindingReviewDisposition]
          : [];
      }),
      reason: input.reason,
    });
    const [review] = await transaction.insert(securityScanFindingReviews).values({
      ...input.scope,
      findingId: input.findingId,
      reviewerId: input.reviewerId,
      disposition: input.disposition,
      reason: input.reason,
    }).returning();
    await transaction.update(securityScanFindings).set({
      disposition: input.disposition,
    }).where(and(
      eq(securityScanFindings.id, input.findingId),
      scopePredicate(securityScanFindings, input.scope),
    ));
    return review;
  });
}
