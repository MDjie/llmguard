import { describe, expect, it } from 'vitest';
import {
  auditExportRetryDelayMs,
  buildToneEnvelope,
  formatRfc5424,
  resolveAuditExportTargets,
  targetAcceptsEvent,
  type AuditExportPayload,
} from '../../src/lib/audit';

const event = {
  event: 'guard.request.denied', outcome: 'DENIED' as const, status: 403,
  requestId: 'request-1', traceId: 'trace-1', method: 'POST', path: '/api/v1/guard/evaluate',
  latencyMs: 15, tenantId: 'tenant-1', applicationId: 'app-1', principalId: 'user-1',
};

const payload: AuditExportPayload = {
  schemaVersion: '1.0', eventId: 'event-1', event: event.event, outcome: event.outcome,
  status: event.status, requestId: event.requestId, traceId: event.traceId,
  method: event.method, path: event.path, latencyMs: event.latencyMs,
  principalId: event.principalId, tenantId: event.tenantId, applicationId: event.applicationId,
  occurredAt: '2026-09-02T00:00:00.000Z',
  chain: {
    partitionKey: 'tenant-1:app-1', sequence: 2, previousHash: 'a'.repeat(64),
    eventHash: 'b'.repeat(64), keyId: 'audit-hmac-v1', version: 1,
  },
};

describe('audit export', () => {
  it('AUD-007 resolves filtered TLS Syslog and Kafka destinations without storing credentials in destination IDs', () => {
    const targets = resolveAuditExportTargets({
      NODE_ENV: 'production',
      AUDIT_EXPORT_OUTCOMES: 'DENIED,ERROR',
      AUDIT_EXPORT_EVENT_PREFIXES: 'guard.,auth.',
      AUDIT_EXPORT_SYSLOG_HOST: 'soc.example.internal',
      AUDIT_EXPORT_SYSLOG_PROTOCOL: 'tls',
      AUDIT_EXPORT_KAFKA_BROKERS: 'kafka-1.example.internal:9093,kafka-2.example.internal:9093',
      AUDIT_EXPORT_KAFKA_TOPIC: 'guardllm.audit.v1',
      AUDIT_EXPORT_KAFKA_SSL: 'true',
      AUDIT_EXPORT_KAFKA_SASL_MECHANISM: 'scram-sha-512',
      AUDIT_EXPORT_KAFKA_SASL_USERNAME: 'guard-producer',
      AUDIT_EXPORT_KAFKA_SASL_PASSWORD: 'not-persisted',
    });

    expect(targets.map((target) => target.destination)).toEqual([
      'syslog:soc.example.internal:6514', 'kafka:guardllm.audit.v1',
    ]);
    expect(targets.every((target) => targetAcceptsEvent(target, event))).toBe(true);
    expect(JSON.stringify(targets.map((target) => target.destination))).not.toContain('not-persisted');
  });

  it('AUD-007 rejects plaintext production transports and incomplete SASL', () => {
    expect(() => resolveAuditExportTargets({
      NODE_ENV: 'production', AUDIT_EXPORT_SYSLOG_HOST: 'soc.internal', AUDIT_EXPORT_SYSLOG_PROTOCOL: 'tcp',
    })).toThrow(/must use TLS/);
    expect(() => resolveAuditExportTargets({
      NODE_ENV: 'production', AUDIT_EXPORT_KAFKA_BROKERS: 'kafka.internal:9093',
      AUDIT_EXPORT_KAFKA_TOPIC: 'audit', AUDIT_EXPORT_KAFKA_SASL_MECHANISM: 'plain',
    })).toThrow(/username and password/);
  });

  it('AUD-007 emits RFC 5424 with trace and tamper-chain evidence', () => {
    const message = formatRfc5424(payload, 'guard-node-1');
    expect(message).toMatch(/^<132>1 2026-09-02T00:00:00.000Z guard-node-1 guardllm/);
    expect(message).toContain('traceId="trace-1"');
    expect(message).toContain(`chainHash="${'b'.repeat(64)}"`);
    expect(message).toContain('"schemaVersion":"1.0"');
  });

  it('AUD-007 applies bounded exponential backoff', () => {
    expect(auditExportRetryDelayMs(1)).toBe(5_000);
    expect(auditExportRetryDelayMs(2)).toBe(10_000);
    expect(auditExportRetryDelayMs(100)).toBe(15 * 60_000);
  });

  it('maps TONE events with integrity evidence, HMAC signatures and no secret in destination', () => {
    const [target] = resolveAuditExportTargets({
      NODE_ENV: 'production',
      AUDIT_EXPORT_TONE_BASE_URL: 'https://tone.example.internal',
      AUDIT_EXPORT_TONE_PATH: '/api/v1/security-events',
      AUDIT_EXPORT_TONE_KEY_ID: 'tone-key-1',
      AUDIT_EXPORT_TONE_HMAC_KEY: 'tone-test-key-that-is-at-least-32-bytes',
    });
    expect(target).toMatchObject({
      type: 'tone',
      destination: 'tone:tone.example.internal/api/v1/security-events',
    });
    if (target.type !== 'tone') throw new Error('expected TONE target');
    const envelope = buildToneEnvelope(target, payload);
    expect(envelope.event).toMatchObject({
      eventId: 'event-1',
      eventType: 'guard.request.denied',
      severity: 'MEDIUM',
      integrity: { eventHash: 'b'.repeat(64) },
    });
    expect(envelope.headers['idempotency-key']).toBe('event-1');
    expect(envelope.headers['x-guard-signature']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(target.destination).not.toContain(target.hmacKey);
  });

  it('rejects insecure or weak TONE export configuration', () => {
    expect(() => resolveAuditExportTargets({
      AUDIT_EXPORT_TONE_BASE_URL: 'http://tone.example.internal',
      AUDIT_EXPORT_TONE_KEY_ID: 'key',
      AUDIT_EXPORT_TONE_HMAC_KEY: 'x'.repeat(32),
    })).toThrow(/HTTPS/);
    expect(() => resolveAuditExportTargets({
      AUDIT_EXPORT_TONE_BASE_URL: 'https://tone.example.internal',
      AUDIT_EXPORT_TONE_KEY_ID: 'key',
      AUDIT_EXPORT_TONE_HMAC_KEY: 'weak',
    })).toThrow(/32 bytes/);
  });
});
