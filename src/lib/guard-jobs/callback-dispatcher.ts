import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { scopePredicate } from '@/lib/tenancy';
import { ProviderEndpointPolicy } from '@/lib/egress';
import { getSecretProvider } from '@/lib/secrets';
import { db } from '@/storage/database/shared/db';
import { guardJobs } from '@/storage/database/shared/schema';
import { signJobCallback } from './callback';

function list(value: string | undefined) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function claimCallback() {
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction.select().from(guardJobs).where(and(
      eq(guardJobs.status, 'completed'),
      inArray(guardJobs.callbackState, ['pending', 'failed']),
      or(isNull(guardJobs.callbackNextAt), lte(guardJobs.callbackNextAt, new Date())),
    )).orderBy(asc(guardJobs.completedAt)).limit(1).for('update', { skipLocked: true });
    if (!candidate || candidate.callbackAttempt >= 5) return null;
    const [claimed] = await transaction.update(guardJobs).set({
      callbackState: 'sending', callbackAttempt: candidate.callbackAttempt + 1,
    }).where(eq(guardJobs.id, candidate.id)).returning();
    return claimed ?? null;
  });
}

export async function dispatchNextJobCallback() {
  const job = await claimCallback();
  if (!job) return null;
  try {
    if (!job.callbackUrl || !job.callbackSecretRef) throw new Error('Callback configuration is incomplete');
    const policy = new ProviderEndpointPolicy({
      allowedHosts: list(process.env.CALLBACK_ALLOWED_HOSTS),
      allowedPrivateHosts: list(process.env.CALLBACK_ALLOWED_PRIVATE_HOSTS),
    });
    const url = await policy.assertAllowed(job.callbackUrl, 'custom');
    const secret = await getSecretProvider({ tenantId: job.tenantId, applicationId: job.applicationId })
      .get(job.callbackSecretRef);
    const signed = signJobCallback({
      eventVersion: '1.0', eventId: job.id, jobId: job.id,
      tenantId: job.tenantId, applicationId: job.applicationId,
      status: job.status, result: job.result,
    }, secret);
    const response = await fetch(url, {
      method: 'POST', headers: { ...signed.headers, 'x-guard-event-id': job.id },
      body: signed.body, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Callback endpoint returned ${response.status}`);
    await db.update(guardJobs).set({
      callbackState: 'delivered', callbackNextAt: null, callbackLastError: null,
    }).where(and(eq(guardJobs.id, job.id), scopePredicate(guardJobs, job)));
    return { jobId: job.id, state: 'delivered' };
  } catch (error) {
    const terminal = job.callbackAttempt >= 5;
    const delaySeconds = Math.min(300, 2 ** job.callbackAttempt * 5);
    await db.update(guardJobs).set({
      callbackState: terminal ? 'terminal_failed' : 'failed',
      callbackNextAt: terminal ? null : new Date(Date.now() + delaySeconds * 1_000),
      callbackLastError: (error instanceof Error ? error.message : 'Unknown callback failure').slice(0, 500),
    }).where(and(eq(guardJobs.id, job.id), scopePredicate(guardJobs, job)));
    return { jobId: job.id, state: terminal ? 'terminal_failed' : 'failed' };
  }
}
