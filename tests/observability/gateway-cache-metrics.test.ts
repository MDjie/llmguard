import { expect, it } from 'vitest';
import { collectGatewayCacheMetrics } from '@/lib/observability/gateway-cache-metrics';
import { renderPrometheusMetrics } from '@/lib/observability/metrics';
it('publishes bounded cache capacity and monotonic totals with only fixed cache labels',()=>{
  collectGatewayCacheMetrics();
  const metrics=renderPrometheusMetrics();
  expect(metrics).toContain('guardllm_policy_cache_estimated_bytes{cache="policy_recipe"}');
  expect(metrics).toContain('guardllm_policy_cache_entries{cache="policy_lkg"}');
  expect(metrics).toContain('# TYPE guardllm_policy_cache_hits_total counter');
  const lines=metrics.split('\n').filter(line=>line.startsWith('guardllm_policy_cache'));
  expect(lines.length).toBe(16);
  expect(lines.every(line=>!line.includes('tenant')&&!line.includes('request')&&!line.includes('subject'))).toBe(true);
});
