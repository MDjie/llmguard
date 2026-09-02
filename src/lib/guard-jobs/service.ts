import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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

function configured(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function automaticJobType(kind: string): string {
  if (kind === 'AUDIO' || kind === 'VIDEO') return 'audio_video';
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
  if (!artifact) throw new GuardJobError('GRD_ARTIFACT_NOT_ACCEPTED', 'Artifact is not accepted or not owned by this principal');
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
  const requestHash = createHash('sha256').update(canonicalJson({
    artifactId: input.artifactId,
    artifactHash: artifact.verifiedSha256,
    contextArtifactId: input.contextArtifactId,
    contextArtifactHash,
    bundleId: input.bundleId,
    jobType,
    callbackUrl: input.callback?.url,
  })).digest('hex');
  const submission = await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`${input.scope.tenantId}:${input.scope.applicationId}:${input.idempotencyKey}`}))`);
    const [existing] = await transaction.select().from(guardJobs).where(and(
      scopePredicate(guardJobs, input.scope),
      eq(guardJobs.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new GuardJobError('GRD_IDEMPOTENCY_CONFLICT', 'Idempotency key was used for another job');
      }
      return { job: existing, reused: true };
    }
    const [created] = await transaction.insert(guardJobs).values({
      ...input.scope,
      ownerId: input.ownerId,
      artifactId: input.artifactId,
      contextArtifactId: input.contextArtifactId,
      bundleId: input.bundleId,
      jobType,
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

export async function claimNextGuardJob(jobTypes?: readonly string[]) {
  return db.transaction(async (transaction) => {
    const conditions = [inArray(guardJobs.status, ['pending', 'retrying'])];
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

export async function updateGuardJobProgress(
  job: typeof guardJobs.$inferSelect,
  stage: string,
  progress: number,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  await db.transaction(async (transaction) => {
    await transaction.update(guardJobs).set({
      stage,
      progress: Math.min(99, Math.max(0, Math.floor(progress))),
      heartbeatAt: new Date(),
    }).where(and(eq(guardJobs.id, job.id), scopePredicate(guardJobs, scope)));
    await transaction.insert(guardJobEvents).values({ ...scope, jobId: job.id, eventType: 'job.progress', payload: { stage, progress, ...payload } });
  });
}

export async function completeGuardJob(
  job: typeof guardJobs.$inferSelect,
  result: Record<string, unknown>,
): Promise<void> {
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  await db.transaction(async (transaction) => {
    await transaction.update(guardJobs).set({
      status: 'completed', stage: 'completed', progress: 100, result,
      heartbeatAt: new Date(), completedAt: new Date(),
    }).where(and(eq(guardJobs.id, job.id), scopePredicate(guardJobs, scope)));
    await transaction.insert(guardJobEvents).values({ ...scope, jobId: job.id, eventType: 'job.completed', payload: { resultHash: createHash('sha256').update(canonicalJson(result)).digest('hex') } });
  });
}

export async function failGuardJob(job: typeof guardJobs.$inferSelect, error: unknown): Promise<void> {
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  const history = [...(job.failureHistory ?? []), {
    attempt: job.attempt,
    at: new Date().toISOString(),
    code: 'GRD_JOB_EXECUTION_FAILED',
    message: (error instanceof Error ? error.message : 'Unknown job failure').slice(0, 500),
  }];
  const terminal = job.attempt >= job.maxAttempts;
  await db.transaction(async (transaction) => {
    await transaction.update(guardJobs).set({
      status: terminal ? 'failed' : 'retrying',
      stage: terminal ? 'failed' : 'retry_wait',
      failureHistory: history,
      heartbeatAt: new Date(),
      completedAt: terminal ? new Date() : null,
    }).where(and(eq(guardJobs.id, job.id), scopePredicate(guardJobs, scope)));
    await transaction.insert(guardJobEvents).values({ ...scope, jobId: job.id, eventType: terminal ? 'job.failed' : 'job.retrying', payload: history.at(-1) });
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
