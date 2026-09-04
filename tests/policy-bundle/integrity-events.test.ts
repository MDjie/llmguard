import { describe, expect, it } from 'vitest';
import {
  policyIntegritySecurityEvent,
  type PolicyIntegrityFailure,
} from '../../src/lib/policy-bundle';

const profiles: ReadonlyArray<{
  readonly failure: PolicyIntegrityFailure;
  readonly domain: 'AUDIT' | 'RUNTIME';
  readonly eventType: string;
  readonly severity: 'HIGH' | 'CRITICAL';
  readonly action: string;
}> = [
  {
    failure: 'AUDIT_CHAIN_BREAK',
    domain: 'AUDIT',
    eventType: 'AUDIT.CHAIN.INTEGRITY_FAILURE',
    severity: 'CRITICAL',
    action: 'QUARANTINE_AUDIT_PARTITION',
  },
  {
    failure: 'POLICY_DIGEST_MISMATCH',
    domain: 'RUNTIME',
    eventType: 'POLICY.BUNDLE.INTEGRITY_FAILURE',
    severity: 'CRITICAL',
    action: 'FAIL_CLOSED',
  },
  {
    failure: 'TEMPLATE_RECHECK_FAILED',
    domain: 'RUNTIME',
    eventType: 'POLICY.TEMPLATE.RECHECK_FAILURE',
    severity: 'HIGH',
    action: 'FALLBACK_SAFE_RESPONSE',
  },
];

describe('policy integrity operational events', () => {
  it.each(profiles)('maps $failure to a high-priority minimal event', (profile) => {
    const event = policyIntegritySecurityEvent({
      failure: profile.failure,
      scope: {
        tenantId: 'tenant-1',
        applicationId: 'application-1',
      },
      principalId: 'reviewer-2',
      bundleId: 'bundle-1',
      templateId: 'template-1',
      traceId: 'trace-1',
      requestId: 'request-1',
      detailCode: 'INTEGRITY_ASSERTION_FAILED',
      generation: 4,
    }, {
      id: () => 'event-1',
      now: () => new Date('2026-09-04T00:00:00.000Z'),
    });

    expect(event).toMatchObject({
      id: 'event-1',
      domain: profile.domain,
      eventType: profile.eventType,
      severity: profile.severity,
      action: profile.action,
      outcome: 'FAILED',
      source: 'policy-integrity-monitor',
      attributes: {
        failure: profile.failure,
        rawContentStored: false,
      },
    });
    expect(event.evidenceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(event)).not.toContain('rawPayload');
    expect(JSON.stringify(event)).not.toContain('customer content');
  });
});
