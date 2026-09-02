import { inArray, sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { guardJobs } from '@/storage/database/shared/schema';
import { replaceGauge } from './metrics';

const ACTIVE_JOB_STATES = ['pending', 'retrying', 'running'] as const;

export async function collectGuardJobMetrics(): Promise<void> {
  const rows = await db.select({
    jobType: guardJobs.jobType,
    status: guardJobs.status,
    count: sql<number>`count(*)::integer`,
    oldestAgeSeconds: sql<number>`coalesce(extract(epoch from (now() - min(${guardJobs.createdAt}))), 0)::double precision`,
  }).from(guardJobs).where(inArray(guardJobs.status, [...ACTIVE_JOB_STATES]))
    .groupBy(guardJobs.jobType, guardJobs.status);
  replaceGauge('guardllm_guard_jobs_pending', rows.map((row) => ({
    labels: { job_type: row.jobType, status: row.status },
    value: Number(row.count),
  })));
  replaceGauge('guardllm_guard_job_oldest_age_seconds', rows.map((row) => ({
    labels: { job_type: row.jobType, status: row.status },
    value: Number(row.oldestAgeSeconds),
  })));
}
