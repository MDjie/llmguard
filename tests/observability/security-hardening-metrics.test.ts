import { beforeEach, describe, expect, it } from 'vitest';
import {
  observeGuardDecision,
  observeHumanReview,
  observePolicyBundleGeneration,
  observeSafetyAlert,
  observeShadowComparison,
  renderPrometheusMetrics,
  resetMetricsForTests,
} from '../../src/lib/observability/metrics';

describe('security hardening observability', () => {
  beforeEach(resetMetricsForTests);

  it('uses bounded dimensions and hashed scope buckets without customer identifiers', () => {
    observeGuardDecision({
      direction: 'OUTPUT_COMPLETE', action: 'SAFE_RESPONSE', latencyMs: 12,
      detectorFailures: 0, riskCategory: 'insurance.misleading_claim',
      tenantId: 'customer-tenant-sensitive-123', applicationId: 'customer-app-sensitive-456',
      locale: 'zh-CN', modality: 'TEXT|IMAGE', policyVersion: '42', degraded: false,
    });
    observePolicyBundleGeneration({
      generation: 7,
      tenantId: 'customer-tenant-sensitive-123',
      applicationId: 'customer-app-sensitive-456',
    });
    const output = renderPrometheusMetrics();
    expect(output).toContain('tenant_bucket="b');
    expect(output).toContain('application_bucket="b');
    expect(output).toContain('risk_category="insurance"');
    expect(output).not.toContain('customer-tenant-sensitive-123');
    expect(output).not.toContain('customer-app-sensitive-456');
  });

  it('exports shadow, review and high-priority safety alert signals', () => {
    observeShadowComparison({ actionChanged: true, activeHit: false, shadowHit: true, latencyDeltaMs: 15 });
    observeHumanReview({ workflow: 'content_access', agreement: 'agree', cycleMs: 2_000 });
    observeSafetyAlert('POLICY_DIGEST_MISMATCH');
    const output = renderPrometheusMetrics();
    expect(output).toContain('guardllm_shadow_comparisons_total');
    expect(output).toContain('guardllm_human_review_total');
    expect(output).toContain('guardllm_safety_alerts_total{alert_type="POLICY_DIGEST_MISMATCH",priority="high"} 1');
  });
});
