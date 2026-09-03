import { beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeMetricPath,
  observeGuardDecision,
  observeAuditDelivery,
  observeDependencyCall,
  observeHttpRequest,
  renderPrometheusMetrics,
  replaceGauge,
  resetMetricsForTests,
} from '@/lib/observability/metrics';

describe('bounded Prometheus metrics', () => {
  beforeEach(resetMetricsForTests);

  it('removes dynamic identifiers from route labels', () => {
    expect(normalizeMetricPath('/api/v1/guard/jobs/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('/api/v1/guard/jobs/:id');
  });

  it('renders request and decision counters with histograms', () => {
    observeHttpRequest({ method: 'GET', path: '/api/health', status: 200, latencyMs: 12 });
    observeGuardDecision({ direction: 'INPUT', action: 'BLOCK', latencyMs: 8, detectorFailures: 1 });
    replaceGauge('guardllm_guard_jobs_pending', [{ labels: { job_type: 'media' }, value: 3 }]);
    const output = renderPrometheusMetrics();
    expect(output).toContain('guardllm_http_requests_total');
    expect(output).toContain('guardllm_guard_decisions_total');
    expect(output).toContain('guardllm_required_detector_failures_total');
    expect(output).toContain('guardllm_guard_jobs_pending{job_type="media"} 3');
    expect(output).not.toContain('tenant');
  });

  it('exports dependency and audit-delivery failure signals without subject identifiers', () => {
    observeDependencyCall({
      dependency: 'presidio', operation: 'analyze', status: 'timeout', latencyMs: 500,
    });
    observeAuditDelivery({ destinationType: 'kafka', state: 'terminal_failed' });
    const output = renderPrometheusMetrics();
    expect(output).toContain('guardllm_dependency_calls_total');
    expect(output).toContain('guardllm_dependency_duration_ms');
    expect(output).toContain('guardllm_audit_delivery_total');
    expect(output).not.toContain('request-');
  });
});
