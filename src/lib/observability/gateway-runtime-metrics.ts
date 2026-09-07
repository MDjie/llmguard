import { sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { replaceGauge } from './metrics';

export const GATEWAY_RUNTIME_GAUGES = [
  'publication_pending', 'publication_oldest_seconds', 'preparation_expired',
  'resource_unsettled_expired', 'shadow_pending', 'shadow_running', 'shadow_oldest_seconds',
  'shadow_failed_24h', 'shadow_skipped_24h', 'shadow_compared_24h', 'shadow_changed_24h',
] as const;
type Gauge = typeof GATEWAY_RUNTIME_GAUGES[number];

/** Labels are deliberately absent: IDs, text and user-selected policy names never become series. */
export function publishGatewayRuntimeMetrics(rows: readonly { metric: string; value: unknown }[]): void {
  const values = new Map<string, number>();
  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isFinite(value) || value < 0 || values.has(row.metric)) throw new Error('INVALID_GATEWAY_METRIC');
    values.set(row.metric, value);
  }
  if (values.size !== GATEWAY_RUNTIME_GAUGES.length || GATEWAY_RUNTIME_GAUGES.some(name => !values.has(name))) throw new Error('INCOMPLETE_GATEWAY_METRICS');
  for (const name of GATEWAY_RUNTIME_GAUGES) replaceGauge('guardllm_gateway_' + name, [{ labels: {}, value: values.get(name)! }]);
}

export async function collectGatewayRuntimeMetrics(): Promise<void> {
  if (process.env.GATEWAY_V2_ENABLED !== 'true') return;
  const rows = await db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '2s'`);
    await tx.execute(sql`set local transaction_read_only = on`);
    return await tx.execute<{ metric: Gauge; value: string }>(sql`
      with pending as (select created_at from gateway_runtime_publications where dispatch_state='PENDING'),
      shadow as (select state,created_at from gateway_shadow_evaluations where state in ('PENDING','RUNNING')),
      recent as (select e.state,e.action,s.action as primary_action from gateway_shadow_evaluations e
        join gateway_steps s on s.id=e.step_id and s.request_id=e.request_id and s.tenant_id=e.tenant_id and s.application_id=e.application_id
        where e.completed_at >= now()-interval '24 hours')
      select 'publication_pending' as metric, count(*)::double precision as value from pending
      union all select 'publication_oldest_seconds',coalesce(greatest(0,extract(epoch from now()-min(created_at))),0) from pending
      union all select 'preparation_expired',count(*) from gateway_requests where preparation_state='PREPARING' and not session_finalized and expires_at < now()
      union all select 'resource_unsettled_expired',count(*) from gateway_request_resources r join gateway_requests q on q.id=r.request_id and q.tenant_id=r.tenant_id and q.application_id=r.application_id where r.state='RESERVED' and q.expires_at<now()
      union all select 'shadow_pending',count(*) from shadow where state='PENDING'
      union all select 'shadow_running',count(*) from shadow where state='RUNNING'
      union all select 'shadow_oldest_seconds',coalesce(greatest(0,extract(epoch from now()-min(created_at))),0) from shadow
      union all select 'shadow_failed_24h',count(*) from recent where state='FAILED'
      union all select 'shadow_skipped_24h',count(*) from recent where state='SKIPPED'
      union all select 'shadow_compared_24h',count(*) from recent where state='SUCCEEDED' and action is not null and primary_action is not null
      union all select 'shadow_changed_24h',count(*) from recent where state='SUCCEEDED' and action is not null and primary_action is not null and action<>primary_action
    `);
  });
  publishGatewayRuntimeMetrics(rows);
}
