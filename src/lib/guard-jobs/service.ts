import { z } from 'zod';
import { enqueueMediaEvidenceSnapshot, type PrivateMediaEvidence } from '@/lib/evidence/media-snapshots';
import { resolveArchivePolicy } from '@/lib/conversation-archive/policy';
import { enqueueDecisionRecord } from '@/lib/security-alerts/service';
import { fromJobResult, fromJobFailure } from '@/lib/security-alerts/record';
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { ProviderEndpointPolicy } from '@/lib/egress';
import { canonicalJson, loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { getSecretProvider } from '@/lib/secrets';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { artifacts, guardJobEvents, guardJobs } from '@/storage/database/shared/schema';

export class GuardJobError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'GuardJobError';
  }
}

export function isGuardJobCancellationError(error: unknown): boolean {
  return error instanceof GuardJobError && error.code === 'GRD_JOB_CANCELLED_OR_TERMINAL';
}

export interface GuardJobCancellationMonitor {
  readonly signal: AbortSignal;
  stop(): void;
}


function configured(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function automaticJobType(kind: string): string {
  if (kind === 'AUDIO' || kind === 'VIDEO') return 'audio_video';
  if (kind === 'TEXT') return 'intake';
  if (kind === 'RAG_CHUNK') return 'rag_ingest';
  if (kind === 'TOOL_RESULT') return 'tool_result';
  return 'document_image';
}

async function event(
  scope: TenantScope,
  jobId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(guardJobEvents).values({ ...scope, jobId, eventType, payload });
}

export async function submitGuardJob(input: {
  scope: TenantScope;
  ownerId: string;
  artifactId: string;
  contextArtifactId?: string;
  nativeArtifactIds?: string[];
  sourceArtifactIds?: string[];
  expectedIntakeSources?: Array<{ artifactId: string; sha256: string; kind: string }>;
  taskPurpose?: string;
  direction?: 'INPUT'|'OUTPUT_COMPLETE'|'OUTPUT_CHUNK'|'TOOL_RESULT';
  bundleId: string;
  jobType: string;
  idempotencyKey: string;
  maxAttempts: number;
  callback?: { url: string; secretRef: string };
}) {
  const [artifact] = await db.select().from(artifacts).where(and(
    eq(artifacts.id, input.artifactId),
    eq(artifacts.ownerId, input.ownerId),
    eq(artifacts.state, 'accepted'),
    scopePredicate(artifacts, input.scope),
  )).limit(1);
  if (!artifact || artifact.contentExpiresAt.getTime() <= Date.now()) throw new GuardJobError('GRD_ARTIFACT_NOT_ACCEPTED', 'Artifact is not accepted or not owned by this principal');
  let contextArtifactHash: string | undefined;
  if (input.contextArtifactId) {
    const [contextArtifact] = await db.select().from(artifacts).where(and(
      eq(artifacts.id, input.contextArtifactId),
      eq(artifacts.ownerId, input.ownerId),
      eq(artifacts.kind, 'TEXT'),
      eq(artifacts.state, 'accepted'),
      scopePredicate(artifacts, input.scope),
    )).limit(1);
    if (!contextArtifact) {
      throw new GuardJobError('GRD_CONTEXT_ARTIFACT_INVALID', 'Context artifact must be an accepted owned TEXT artifact');
    }
    contextArtifactHash = contextArtifact.verifiedSha256 ?? undefined;
  }
  await loadVerifiedPolicyBundle(input.scope, input.bundleId);
  if (input.callback) {
    const policy = new ProviderEndpointPolicy({
      allowedHosts: configured(process.env.CALLBACK_ALLOWED_HOSTS),
      allowedPrivateHosts: configured(process.env.CALLBACK_ALLOWED_PRIVATE_HOSTS),
    });
    await policy.assertAllowed(input.callback.url, 'custom');
    await getSecretProvider(input.scope).get(input.callback.secretRef);
  }
  const jobType = input.jobType === 'auto' ? automaticJobType(artifact.kind) : input.jobType;
  if (jobType === 'content_mark' && !['IMAGE', 'AUDIO', 'VIDEO'].includes(artifact.kind)) {
    throw new GuardJobError(
      'GRD_CONTENT_MARK_KIND_UNSUPPORTED',
      'Generated-content media marking only supports image, audio and video artifacts',
    );
  }
  if (jobType !== 'native_joint' && (input.nativeArtifactIds || input.direction)) throw new GuardJobError('GRD_NATIVE_JOB_OPTIONS_INVALID', 'Native options require a native_joint job');
  if (jobType === 'native_joint' && (!input.contextArtifactId || !input.nativeArtifactIds || input.nativeArtifactIds[0] !== input.artifactId)) throw new GuardJobError('GRD_NATIVE_JOB_CONTEXT_REQUIRED', 'Native jobs require an ordered source list beginning with the primary artifact and an owned context artifact');
  let executionBinding: Record<string, unknown> | undefined;
  if (jobType !== 'intake' && (input.sourceArtifactIds || input.taskPurpose || input.expectedIntakeSources)) throw new GuardJobError('GRD_INTAKE_OPTIONS_INVALID', 'Intake options require an intake job');
  if (jobType === 'intake') {
    const ids=input.sourceArtifactIds ?? [input.artifactId];
    if(ids[0]!==input.artifactId)throw new GuardJobError('GRD_INTAKE_SOURCE_INVALID','The first source must be the primary artifact');
    try{executionBinding=(await (await import('./intake-binding')).captureIntakeBinding(input.scope,input.ownerId,ids,input.taskPurpose)).binding;}
    catch{throw new GuardJobError('GRD_INTAKE_SOURCE_INVALID','Sources must be accepted, current and owned');}
  } else if (jobType === 'native_joint') {
    try { executionBinding = (await (await import('./native-binding')).captureNativeJobBinding(input.scope, input.ownerId, input.nativeArtifactIds!, input.contextArtifactId!, input.direction)).binding; }
    catch { throw new GuardJobError('GRD_NATIVE_JOB_SOURCE_INVALID', 'Native sources must be accepted, current, uniquely ordered and owned by this principal'); }
  } else if (jobType === 'rag_ingest') {
    if(artifact.kind!=='RAG_CHUNK')throw new GuardJobError('GRD_RAG_SOURCE_INVALID','RAG ingest requires an accepted RAG_CHUNK artifact');
    executionBinding=(await import('@/lib/rag/ingest-binding')).captureRagIngestBinding(artifact);
  } else if (jobType === 'code_scan') executionBinding = await (await import('@/lib/connectors/code-sentinel-config')).captureCodeScanBinding(input.scope, input.ownerId, input.artifactId);
  if (input.expectedIntakeSources) {
    const binding = (await import('./intake-binding')).intakeBindingSchema.parse(executionBinding);
    if (canonicalJson(binding.artifacts.map(ref => ({artifactId:ref.id,sha256:ref.sha256,kind:ref.kind}))) !== canonicalJson(input.expectedIntakeSources)) throw new GuardJobError('GRD_INTAKE_SOURCE_CHANGED', 'Source does not match the expected manifest');
  }
  const requestHash = createHash('sha256').update(canonicalJson({
    ownerId: input.ownerId,
    maxAttempts: input.maxAttempts,
    ...(executionBinding ? { executionBinding } : {}),
    artifactId: input.artifactId,
    artifactHash: artifact.verifiedSha256,
    ...(input.contextArtifactId ? { contextArtifactId: input.contextArtifactId, contextArtifactHash } : {}),
    bundleId: input.bundleId,
    jobType,
    ...(input.callback ? { callbackUrl: input.callback.url, callbackSecretRef: input.callback.secretRef } : {}),
  })).digest('hex');
  const submission = await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`${input.scope.tenantId}:${input.scope.applicationId}:${input.idempotencyKey}`}))`);
    const [existing] = await transaction.select().from(guardJobs).where(and(
      scopePredicate(guardJobs, input.scope),
      eq(guardJobs.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.ownerId !== input.ownerId || existing.requestHash !== requestHash) {
        throw new GuardJobError('GRD_IDEMPOTENCY_CONFLICT', 'Idempotency key was used for another job');
      }
      return { job: existing, reused: true };
    }
    const sourceIds = [...new Set([input.artifactId, ...(input.contextArtifactId ? [input.contextArtifactId] : []), ...(input.sourceArtifactIds ?? []), ...(input.nativeArtifactIds ?? [])])].sort();
    const currentSources = await transaction.select().from(artifacts).where(and(scopePredicate(artifacts, input.scope), eq(artifacts.ownerId, input.ownerId), inArray(artifacts.id, sourceIds))).orderBy(artifacts.id).for('share');
    if (currentSources.length !== sourceIds.length || currentSources.some(row => row.state !== 'accepted' || row.contentExpiresAt <= new Date())) throw new GuardJobError('GRD_ARTIFACT_NOT_ACCEPTED', 'Source changed before job submission');
    if (jobType === 'intake') {
      const binding = (await import('./intake-binding')).intakeBindingSchema.parse(executionBinding);
      for (const ref of binding.artifacts) {
        const row = currentSources.find(item => item.id === ref.id);
        if (!row || row.verifiedSha256 !== ref.sha256 || row.kind !== ref.kind || row.verifiedSize !== ref.sizeBytes || row.detectedMediaType !== ref.mediaType) throw new GuardJobError('GRD_INTAKE_SOURCE_CHANGED', 'Source changed before job submission');
      }
    }
    const [created] = await transaction.insert(guardJobs).values({
      ...input.scope,
      ownerId: input.ownerId,
      artifactId: input.artifactId,
      contextArtifactId: input.contextArtifactId,
      bundleId: input.bundleId,
      jobType,
      executionBinding,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      maxAttempts: input.maxAttempts,
      callbackUrl: input.callback?.url,
      callbackSecretRef: input.callback?.secretRef,
      callbackState: input.callback ? 'pending' : 'not_requested',
    }).returning();
    return { job: created, reused: false };
  });
  if (!submission.reused) await event(input.scope, submission.job.id, 'job.submitted', { jobType });
  return submission;
}

/**
 * 回收心跳超时的 running 任务：worker 崩溃/OOM 后任务会永久停留在 running。
 * 与 evaluation 服务的 recoverStaleRuns 保持同一模式：
 * 尝试次数已耗尽的直接终态化，其余回到 retrying（受退避门控）。
 */
async function recoverStaleGuardJobs(): Promise<void> {
  const staleAfterMs = Math.max(
    60_000,
    Number(process.env.GUARD_JOB_STALE_MS ?? 10 * 60_000),
  );
  const cutoff = new Date(Date.now() - staleAfterMs);
  const stale = and(
    eq(guardJobs.status, 'running'),
    or(isNull(guardJobs.heartbeatAt), lt(guardJobs.heartbeatAt, cutoff)),
  );
  await db.update(guardJobs).set({
    status: 'failed',
    stage: 'failed',
    completedAt: new Date(),
    heartbeatAt: new Date(),
  }).where(and(stale, sql`${guardJobs.attempt} >= ${guardJobs.maxAttempts}`));
  const reclaimed = await db.update(guardJobs).set({
    status: 'retrying',
    stage: 'retry_wait',
    heartbeatAt: new Date(),
  }).where(stale).returning({
    id: guardJobs.id,
    tenantId: guardJobs.tenantId,
    applicationId: guardJobs.applicationId,
    attempt: guardJobs.attempt,
  });
  for (const job of reclaimed) {
    await event(
      { tenantId: job.tenantId, applicationId: job.applicationId },
      job.id,
      'job.reclaimed_after_stale_heartbeat',
      { attempt: job.attempt, hint: 'Worker crashed or stalled while the job was running' },
    );
  }
}

const STALE_RECOVERY_INTERVAL_MS = 30_000;
let lastStaleRecoveryAt = 0;

export async function claimNextGuardJob(jobTypes?: readonly string[]) {
  // 节流地顺带回收僵尸任务：所有 worker 都经过这里，无需各自接线
  if (Date.now() - lastStaleRecoveryAt > STALE_RECOVERY_INTERVAL_MS) {
    lastStaleRecoveryAt = Date.now();
    await recoverStaleGuardJobs().catch(() => undefined);
  }
  return db.transaction(async (transaction) => {
    // retrying 任务按指数退避（10s 起、封顶 5 分钟）延迟重新认领，
    // 否则失败任务会在下一次轮询（约 2 秒后）立即被重新领走形成重试风暴
    const conditions = [
      or(
        eq(guardJobs.status, 'pending'),
        and(
          eq(guardJobs.status, 'retrying'),
          lte(
            guardJobs.heartbeatAt,
            sql`now() - make_interval(secs => least(300, 5 * power(2, ${guardJobs.attempt})))`,
          ),
        ),
      ),
    ];
    if (jobTypes?.length) conditions.push(inArray(guardJobs.jobType, [...jobTypes]));
    const [candidate] = await transaction.select().from(guardJobs)
      .where(and(...conditions)).orderBy(asc(guardJobs.createdAt))
      .limit(1).for('update', { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await transaction.update(guardJobs).set({
      status: 'running',
      stage: 'initializing',
      attempt: candidate.attempt + 1,
      startedAt: candidate.startedAt ?? new Date(),
      heartbeatAt: new Date(),
    }).where(and(eq(guardJobs.id, candidate.id), scopePredicate(guardJobs, candidate))).returning();
    return claimed ?? null;
  });
}

export function monitorGuardJobCancellation(
  job: typeof guardJobs.$inferSelect,
  options: { readonly pollIntervalMs?: number } = {},
): GuardJobCancellationMonitor {
  const controller = new AbortController();
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  const pollIntervalMs = Math.min(5_000, Math.max(100, options.pollIntervalMs ?? 500));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return;
    try {
      const current = await db.select({ status: guardJobs.status, attempt: guardJobs.attempt }).from(guardJobs).where(and(
        eq(guardJobs.id, job.id),
        scopePredicate(guardJobs, scope),
      )).limit(1).then((rows) => rows[0]);
      if (!current || current.status !== 'running' || current.attempt !== job.attempt) {
        controller.abort(new GuardJobError(
          'GRD_JOB_CANCELLED_OR_TERMINAL',
          'The guard job was cancelled or became terminal',
        ));
        return;
      }
      await db.update(guardJobs).set({heartbeatAt:new Date()}).where(and(eq(guardJobs.id,job.id),eq(guardJobs.status,'running'),eq(guardJobs.attempt,job.attempt),scopePredicate(guardJobs,scope)));
    } catch {
      // A transient status-read failure must not manufacture a cancellation.
    }
    if (!stopped) {
      timer = setTimeout(() => { void poll(); }, pollIntervalMs);
      timer.unref?.();
    }
  };
  timer = setTimeout(() => { void poll(); }, pollIntervalMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export async function updateGuardJobProgress(
  job: typeof guardJobs.$inferSelect,
  stage: string,
  progress: number,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  await db.transaction(async (transaction) => {
    const [updated] = await transaction.update(guardJobs).set({
      stage,
      progress: Math.min(99, Math.max(0, Math.floor(progress))),
      heartbeatAt: new Date(),
    }).where(and(
      eq(guardJobs.id, job.id),
      eq(guardJobs.attempt, job.attempt),
      eq(guardJobs.status, 'running'),
      scopePredicate(guardJobs, scope),
    )).returning({ id: guardJobs.id });
    if (!updated) {
      throw new GuardJobError(
        'GRD_JOB_CANCELLED_OR_TERMINAL',
        'The guard job was cancelled or became terminal',
      );
    }
    await transaction.insert(guardJobEvents).values({ ...scope, jobId: job.id, eventType: 'job.progress', payload: { stage, progress, ...payload } });
  });
}

export type GuardJobTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface GuardJobCompletion {
  readonly result: Record<string, unknown>;
  readonly privateEvidence?: PrivateMediaEvidence;
}
/** Serialize cancellation/reclaims and commit domain side effects with the terminal job record. */
export async function completeGuardJobWithEffects(
  job: typeof guardJobs.$inferSelect,
  effects: (transaction: GuardJobTransaction) => Promise<GuardJobCompletion>,
): Promise<void> {
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  await db.transaction(async (transaction) => {
    const [active] = await transaction.select({id:guardJobs.id}).from(guardJobs).where(and(
      eq(guardJobs.id,job.id), eq(guardJobs.attempt,job.attempt), eq(guardJobs.status,'running'),
      eq(guardJobs.ownerId,job.ownerId), eq(guardJobs.bundleId,job.bundleId), scopePredicate(guardJobs,scope),
    )).for('update');
    if(!active)throw new GuardJobError('GRD_JOB_CANCELLED_OR_TERMINAL','The job attempt is no longer active');
    const completion=await effects(transaction),privateEvidence=completion.privateEvidence;
    let result=z.record(z.string(),z.unknown()).parse(JSON.parse(JSON.stringify(completion.result)));
    if(privateEvidence && resolveArchivePolicy(scope).mode==='STRICT_OBJECT'){
      const snapshot=await enqueueMediaEvidenceSnapshot(transaction,job,privateEvidence);
      result={...result,evidenceArchive:{id:snapshot.id,state:snapshot.state,sourceDigest:snapshot.sourceDigest}};
    }
    const [completed] = await transaction.update(guardJobs).set({
      status: 'completed', stage: 'completed', progress: 100, result,
      heartbeatAt: new Date(), completedAt: new Date(),
    }).where(and(
      eq(guardJobs.id, job.id),
      eq(guardJobs.attempt, job.attempt),
      eq(guardJobs.status, 'running'),
      scopePredicate(guardJobs, scope),
    )).returning({ id: guardJobs.id });
    if (!completed) {
      throw new GuardJobError(
        'GRD_JOB_CANCELLED_OR_TERMINAL',
        'The guard job was cancelled or became terminal',
      );
    }
    await transaction.insert(guardJobEvents).values({ ...scope, jobId: job.id, eventType: 'job.completed', payload: { resultHash: createHash('sha256').update(canonicalJson(result)).digest('hex') } });
    const record = fromJobResult(job, result);
    if (record) await enqueueDecisionRecord(transaction, scope, record);
  });
}
export async function completeGuardJob(
  job: typeof guardJobs.$inferSelect,
  result: Record<string, unknown>,
  privateEvidence?: PrivateMediaEvidence,
): Promise<void> {
  await completeGuardJobWithEffects(job,async()=>({result,privateEvidence}));
}

export async function failGuardJob(job: typeof guardJobs.$inferSelect, error: unknown): Promise<void> {
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  const history = [...(job.failureHistory ?? []), {
    attempt: job.attempt,
    at: new Date().toISOString(),
    code: error instanceof Error && /^[A-Z][A-Z0-9_:.-]{1,159}$/.test(error.message) ? error.message : 'GRD_JOB_EXECUTION_FAILED',
    message: error instanceof Error && /^[A-Z][A-Z0-9_:.-]{1,159}$/.test(error.message) ? error.message : '任务执行失败，请根据请求标识检查服务状态',
  }];
  const terminal = job.attempt >= job.maxAttempts;
  await db.transaction(async (transaction) => {
    const [failed] = await transaction.update(guardJobs).set({
      status: terminal ? 'failed' : 'retrying',
      stage: terminal ? 'failed' : 'retry_wait',
      failureHistory: history,
      heartbeatAt: new Date(),
      completedAt: terminal ? new Date() : null,
    }).where(and(
      eq(guardJobs.id, job.id),
      eq(guardJobs.attempt, job.attempt),
      eq(guardJobs.status, 'running'),
      scopePredicate(guardJobs, scope),
    )).returning({ id: guardJobs.id });
    if (failed) {
      if (terminal) await enqueueDecisionRecord(transaction, scope, fromJobFailure(job));
      await transaction.insert(guardJobEvents).values({ ...scope, jobId: job.id, eventType: terminal ? 'job.failed' : 'job.retrying', payload: history.at(-1) });
    }
  });
}

export async function cancelGuardJob(scope: TenantScope, ownerId: string, jobId: string) {
  const [cancelled] = await db.update(guardJobs).set({
    status: 'cancelled', stage: 'cancelled', cancelledAt: new Date(), heartbeatAt: new Date(),
  }).where(and(
    eq(guardJobs.id, jobId),
    eq(guardJobs.ownerId, ownerId),
    inArray(guardJobs.status, ['pending', 'retrying', 'running']),
    scopePredicate(guardJobs, scope),
  )).returning();
  if (!cancelled) throw new GuardJobError('GRD_JOB_NOT_CANCELLABLE', 'Job was not found or is terminal');
  await event(scope, jobId, 'job.cancelled');
  return cancelled;
}
