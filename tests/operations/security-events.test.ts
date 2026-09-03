import { describe, expect, it } from 'vitest';
import {
  operationalAuditEvent,
  operationalEventDigest,
  validateOperationalSecurityEvent,
  type OperationalSecurityEvent,
} from '../../src/lib/operations';

const base: OperationalSecurityEvent = {
  id: 'event-1',
  domain: 'NETWORK_SECURITY',
  eventType: 'NETWORK.IPS.MATCH',
  severity: 'HIGH',
  outcome: 'DENIED',
  occurredAt: new Date('2026-09-03T00:00:00.000Z'),
  source: 'network-pal',
  network: {
    captureMode: 'L2_TRANSPARENT',
    sourceIp: '192.0.2.1',
    sourceMac: '00:11:22:33:44:55',
    sourcePort: 443,
    destinationIp: '198.51.100.2',
    destinationPort: 8443,
    protocol: 'HTTPS',
  },
  evidenceDigest: 'a'.repeat(64),
  attributes: {},
};

describe('four-domain operational security events', () => {
  it('accepts observable network fields in layer-2 capture mode', () => {
    expect(() => validateOperationalSecurityEvent(base)).not.toThrow();
  });

  it('rejects fabricated MAC fields outside layer-2 capture mode', () => {
    expect(() => validateOperationalSecurityEvent({
      ...base,
      network: { ...base.network!, captureMode: 'APPLICATION_PROXY' },
    })).toThrow('OPERATIONAL_EVENT_MAC_NOT_OBSERVED');
  });

  it('requires domain-specific context and bounded evidence digests', () => {
    expect(() => validateOperationalSecurityEvent({
      ...base,
      domain: 'MODEL_SECURITY',
      network: undefined,
    })).toThrow('OPERATIONAL_EVENT_MODEL_CONTEXT_REQUIRED');
    expect(() => validateOperationalSecurityEvent({
      ...base,
      evidenceDigest: 'not-a-digest',
    })).toThrow('OPERATIONAL_EVENT_DIGEST_INVALID');
  });

  it('maps API audits without copying request content', () => {
    const event = operationalAuditEvent({
      event: 'guard.request.denied',
      outcome: 'DENIED',
      status: 403,
      requestId: 'request-1',
      traceId: 'trace-1',
      method: 'POST',
      path: '/api/v1/guard/evaluate',
      latencyMs: 12,
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      principalId: 'principal-1',
    }, {
      id: 'audit-1',
      occurredAt: new Date('2026-09-03T00:00:00.000Z'),
      evidenceDigest: operationalEventDigest({ chainHash: 'b'.repeat(64) }),
    });
    expect(event).toMatchObject({
      domain: 'AUDIT',
      eventType: 'GUARD.REQUEST.DENIED',
      attributes: {
        path: '/api/v1/guard/evaluate',
        latencyMs: 12,
      },
    });
    expect(event).not.toHaveProperty('rawContent');
  });
});
