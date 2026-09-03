import { describe, expect, it } from 'vitest';
import type { GuardEvent } from '@guardllm/contracts';
import {
  ExternalGuardEventError,
  InMemoryGuardEventReplayStore,
  signExternalGuardEvent,
  verifyAndClaimExternalGuardEvent,
} from '../../src/lib/context-trust';

const key = 'external-guard-event-key-with-at-least-32-bytes';
const scope = { tenantId: 'tenant-1', applicationId: 'app-1' };
const now = Date.parse('2026-09-03T00:00:00.000Z');
const keyRegistry = {
  resolve: (keyId: string) => keyId === 'agent-key-1' ? key : undefined,
};

function signedEvent(overrides: Partial<GuardEvent> = {}): GuardEvent {
  const unsigned: GuardEvent = {
    contractVersion: '1.0',
    eventId: 'event-1',
    eventType: 'ARTIFACT_STATE_CHANGED',
    occurredAt: new Date(now - 1_000).toISOString(),
    traceId: 'trace-0000000000000001',
    ...scope,
    payload: {
      artifactId: 'artifact-1',
      kind: 'TEXT',
      mediaType: 'text/plain',
      sizeBytes: 7,
      sha256: 'a'.repeat(64),
    },
    sequenceNumber: 1,
    expiresAtEpochMs: now + 60_000,
    signatureKeyId: 'agent-key-1',
    ...overrides,
  };
  return { ...unsigned, signature: signExternalGuardEvent(unsigned, key) };
}

async function expectCode(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
    throw new Error('Expected ExternalGuardEventError');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ExternalGuardEventError);
    expect((error as ExternalGuardEventError).code).toBe(code);
  }
}

describe('UWP-01 external GuardEvent boundary', () => {
  it('verifies schema, scope, lifetime and signature before atomically claiming an event', async () => {
    const replayStore = new InMemoryGuardEventReplayStore();
    const event = signedEvent();
    await expect(verifyAndClaimExternalGuardEvent({
      event,
      scope,
      keyRegistry,
      replayStore,
      now,
    })).resolves.toEqual(event);
    await expectCode(
      () => verifyAndClaimExternalGuardEvent({
        event,
        scope,
        keyRegistry,
        replayStore,
        now,
      }),
      'GRD_EVENT_REPLAYED',
    );
  });

  it('permits only one winner when the same event is submitted concurrently', async () => {
    const event = signedEvent();
    const replayStore = new InMemoryGuardEventReplayStore();
    const results = await Promise.allSettled([
      verifyAndClaimExternalGuardEvent({ event, scope, keyRegistry, replayStore, now }),
      verifyAndClaimExternalGuardEvent({ event, scope, keyRegistry, replayStore, now }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects tampering, cross-tenant payloads, expiry and non-monotonic sequences', async () => {
    const tampered = {
      ...signedEvent(),
      payload: {
        artifactId: 'artifact-2',
        kind: 'TEXT',
        mediaType: 'text/plain',
        sizeBytes: 7,
        sha256: 'b'.repeat(64),
      },
    };
    await expectCode(
      () => verifyAndClaimExternalGuardEvent({
        event: tampered,
        scope,
        keyRegistry,
        replayStore: new InMemoryGuardEventReplayStore(),
        now,
      }),
      'GRD_EVENT_SIGNATURE_INVALID',
    );

    const nestedScope = signedEvent({
      eventType: 'GUARD_REQUEST_ACCEPTED',
      payload: {
        contractVersion: '1.0',
        context: {
          traceId: 'trace-0000000000000001',
          requestId: 'request-00000001',
          tenantId: 'tenant-2',
          applicationId: 'app-1',
          direction: 'INPUT',
          absoluteDeadlineEpochMs: now + 10_000,
          policyBundleId: 'bundle-1',
        },
        content: { text: 'payload' },
      },
    });
    await expectCode(
      () => verifyAndClaimExternalGuardEvent({
        event: nestedScope,
        scope,
        keyRegistry,
        replayStore: new InMemoryGuardEventReplayStore(),
        now,
      }),
      'GRD_EVENT_SCOPE_MISMATCH',
    );

    const expired = signedEvent({
      occurredAt: new Date(now - 120_000).toISOString(),
      expiresAtEpochMs: now - 1,
    });
    await expectCode(
      () => verifyAndClaimExternalGuardEvent({
        event: expired,
        scope,
        keyRegistry,
        replayStore: new InMemoryGuardEventReplayStore(),
        now,
      }),
      'GRD_EVENT_EXPIRED',
    );

    const replayStore = new InMemoryGuardEventReplayStore();
    const second = signedEvent({ eventId: 'event-2', sequenceNumber: 2 });
    await verifyAndClaimExternalGuardEvent({ event: second, scope, keyRegistry, replayStore, now });
    const stale = signedEvent({ eventId: 'event-3', sequenceNumber: 1 });
    await expectCode(
      () => verifyAndClaimExternalGuardEvent({
        event: stale,
        scope,
        keyRegistry,
        replayStore,
        now,
      }),
      'GRD_EVENT_REPLAYED',
    );
  });
});
