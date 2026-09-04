import { inArray, sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import {
  applicationPolicyBindings,
  badcaseFeedback,
  guardJobs,
} from '@/storage/database/shared/schema';
import { replaceGauge, scopeMetricBucket } from './metrics';

const ACTIVE_JOB_STATES = ['pending', 'retrying', 'running'] as const;

export async function collectGuardJobMetrics(): Promise<void> {
  const [activeRows, outcomeRows, bindingRows, badcaseRows] = await Promise.all([
    db.select({
      jobType: guardJobs.jobType,
      status: guardJobs.status,
      count: sql<number>`count(*)::integer`,
      oldestAgeSeconds: sql<number>`coalesce(extract(epoch from (now() - min(${guardJobs.createdAt}))), 0)::double precision`,
    }).from(guardJobs).where(inArray(guardJobs.status, [...ACTIVE_JOB_STATES]))
      .groupBy(guardJobs.jobType, guardJobs.status),
    db.select({
      jobType: guardJobs.jobType,
      status: guardJobs.status,
      count: sql<number>`count(*)::integer`,
    }).from(guardJobs).where(sql`${guardJobs.createdAt} >= now() - interval '24 hours'`)
      .groupBy(guardJobs.jobType, guardJobs.status),
    db.select({
      tenantId: applicationPolicyBindings.tenantId,
      applicationId: applicationPolicyBindings.applicationId,
      generation: applicationPolicyBindings.generation,
    }).from(applicationPolicyBindings),
    db.select({
      tenantId: badcaseFeedback.tenantId,
      applicationId: badcaseFeedback.applicationId,
      classification: badcaseFeedback.classification,
      status: badcaseFeedback.status,
      count: sql<number>`count(*)::integer`,
      averageResolutionSeconds: sql<number>`coalesce(avg(extract(epoch from (${badcaseFeedback.resolvedAt} - ${badcaseFeedback.createdAt}))) filter (where ${badcaseFeedback.resolvedAt} is not null), 0)::double precision`,
    }).from(badcaseFeedback).groupBy(
      badcaseFeedback.tenantId,
      badcaseFeedback.applicationId,
      badcaseFeedback.classification,
      badcaseFeedback.status,
    ),
  ]);

  replaceGauge('guardllm_guard_jobs_pending', activeRows.map((row) => ({
    labels: { job_type: row.jobType, status: row.status },
    value: Number(row.count),
  })));
  replaceGauge('guardllm_guard_job_oldest_age_seconds', activeRows.map((row) => ({
    labels: { job_type: row.jobType, status: row.status },
    value: Number(row.oldestAgeSeconds),
  })));
  replaceGauge('guardllm_guard_job_outcomes_24h', outcomeRows.map((row) => ({
    labels: { job_type: row.jobType, status: row.status },
    value: Number(row.count),
  })));
  replaceGauge('guardllm_policy_bundle_generation', bindingRows.map((row) => ({
    labels: {
      tenant_bucket: scopeMetricBucket(row.tenantId),
      application_bucket: scopeMetricBucket(row.applicationId),
    },
    value: row.generation,
  })));
  replaceGauge('guardllm_badcase_feedback', badcaseRows.map((row) => ({
    labels: {
      tenant_bucket: scopeMetricBucket(row.tenantId),
      application_bucket: scopeMetricBucket(row.applicationId),
      classification: row.classification,
      status: row.status,
    },
    value: Number(row.count),
  })));
  replaceGauge('guardllm_badcase_resolution_seconds', badcaseRows
    .filter((row) => Number(row.averageResolutionSeconds) > 0)
    .map((row) => ({
      labels: {
        tenant_bucket: scopeMetricBucket(row.tenantId),
        application_bucket: scopeMetricBucket(row.applicationId),
        classification: row.classification,
      },
      value: Number(row.averageResolutionSeconds),
    })));
}
