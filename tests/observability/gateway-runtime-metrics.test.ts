import { expect, it } from 'vitest';
import { GATEWAY_RUNTIME_GAUGES, publishGatewayRuntimeMetrics } from '@/lib/observability/gateway-runtime-metrics';
import { renderPrometheusMetrics } from '@/lib/observability/metrics';
const rows = GATEWAY_RUNTIME_GAUGES.map(metric => ({ metric, value: 0 }));
it('publishes all runtime families including explicit zero with no high-cardinality labels', () => {
  publishGatewayRuntimeMetrics(rows);
  for (const name of GATEWAY_RUNTIME_GAUGES) expect(renderPrometheusMetrics()).toContain('guardllm_gateway_' + name + ' 0');
});
it('does not replace a previous scrape with missing, duplicate, unknown or non-finite data', () => {
  publishGatewayRuntimeMetrics(rows.map(row => ({ ...row, value: 7 })));
  for (const invalid of [rows.slice(1), [...rows, rows[0]], [...rows.slice(1), { metric: 'tenant_private', value: 1 }], rows.map(row => ({ ...row, value: NaN }))]) {
    expect(() => publishGatewayRuntimeMetrics(invalid)).toThrow();
    expect(renderPrometheusMetrics()).toContain('guardllm_gateway_publication_pending 7');
  }
});
