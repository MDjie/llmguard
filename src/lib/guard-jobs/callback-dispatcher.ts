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

// 认领租约时长：投递本身有 15s 超时，租约到期即可被重新认领，
// 覆盖“置为 sending 后、写回结果前进程崩溃”导致的永久卡死
const CALLBACK_LEASE_MS = 60_000;

async function claimCallback() {
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction.select().from(guardJobs).where(and(
      eq(guardJobs.status, 'completed'),
      or(
        and(
          inArray(guardJobs.callbackState, ['pending', 'failed']),
          or(isNull(guardJobs.callbackNextAt), lte(guardJobs.callbackNextAt, new Date())),
        ),
        and(
          eq(guardJobs.callbackState, 'sending'),
          lte(guardJobs.callbackNextAt, new Date()),
        ),
      ),
    )).orderBy(asc(guardJobs.completedAt)).limit(1).for('update', { skipLocked: true });
    if (!candidate) return null;
    if (candidate.callbackAttempt >= 5) {
      // 崩溃可能把尝试次数已耗尽的任务留在 sending/failed：这里补一次终态化
      await transaction.update(guardJobs).set({
        callbackState: 'terminal_failed', callbackNextAt: null,
      }).where(eq(guardJobs.id, candidate.id));
      return null;
    }
    const [claimed] = await transaction.update(guardJobs).set({
      callbackState: 'sending', callbackAttempt: candidate.callbackAttempt + 1,
      callbackNextAt: new Date(Date.now() + CALLBACK_LEASE_MS),
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
