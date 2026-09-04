import { beforeEach, describe, expect, it } from 'vitest';
import {
  observeOutputControl,
  renderPrometheusMetrics,
  resetMetricsForTests,
} from '@/lib/observability/metrics';

describe('output control metrics', () => {
  beforeEach(resetMetricsForTests);

  it('separates compliance domains and DLP entity types without subject identifiers', () => {
    observeOutputControl({
      domain: 'output.political',
      action: 'WARN',
      locale: 'zh-CN',
      jurisdiction: 'CN',
      industry: 'insurance',
      recheck: 'not_required',
      latencyMs: 3,
      entityTypes: [],
    });
    observeOutputControl({
      domain: 'output.sexual',
      action: 'BLOCK',
      locale: 'zh-CN',
      jurisdiction: 'CN',
      industry: 'insurance',
      recheck: 'completed',
      latencyMs: 7,
      entityTypes: [],
    });
    observeOutputControl({
      domain: 'output.insurance',
      action: 'REWRITE',
      locale: 'zh-CN',
      jurisdiction: 'CN',
      industry: 'insurance',
      recheck: 'completed',
      latencyMs: 11,
      entityTypes: ['customer.phone', 'health.medical', 'customer.phone'],
    });

    const output = renderPrometheusMetrics();
    expect(output).toContain('guardllm_output_control_decisions_total');
    expect(output).toContain('guardllm_output_control_duration_ms');
    expect(output).toContain('domain="output.political"');
    expect(output).toContain('domain="output.sexual"');
    expect(output).toContain('domain="output.insurance"');
    expect(output).toContain('guardllm_dlp_entities_total{action="REWRITE",entity_type="customer.phone"} 1');
    expect(output).toContain('guardllm_dlp_entities_total{action="REWRITE",entity_type="health.medical"} 1');
    expect(output).not.toContain('tenant-');
    expect(output).not.toContain('request-');
  });
});
