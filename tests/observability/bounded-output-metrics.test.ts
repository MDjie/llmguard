import { beforeEach, describe, expect, it } from 'vitest';
import {
  observeOutputControl,
  renderPrometheusMetrics,
  resetMetricsForTests,
} from '../../src/lib/observability/metrics';

describe('bounded output-control metric labels', () => {
  beforeEach(resetMetricsForTests);

  it('maps arbitrary customer-controlled dimensions to bounded categories', () => {
    observeOutputControl({
      domain: 'output.customer-sensitive-domain',
      action: 'customer-sensitive-action',
      locale: 'customer-sensitive-locale',
      jurisdiction: 'customer-sensitive-jurisdiction',
      industry: 'customer-sensitive-industry',
      recheck: 'completed',
      latencyMs: 12,
      entityTypes: ['customer.sensitive-identifier'],
    });

    const output = renderPrometheusMetrics();
    expect(output).toContain('domain="output.custom"');
    expect(output).toContain('action="OTHER"');
    expect(output).toContain('locale="other"');
    expect(output).toContain('jurisdiction="OTHER"');
    expect(output).toContain('industry="custom"');
    expect(output).toContain('entity_type="custom"');
    expect(output).not.toContain('customer-sensitive');
    expect(output).not.toContain('sensitive-identifier');
  });
});
