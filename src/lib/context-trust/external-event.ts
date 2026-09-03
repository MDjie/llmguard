import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GuardEvent } from '@guardllm/contracts';
import { guardEventSchema } from '@/contracts/http/guard-v1';
import { canonicalJson } from '@/lib/policy-bundle/canonical';

export type ExternalGuardEventErrorCode =
  | 'GRD_EVENT_EXPIRED'
  | 'GRD_EVENT_INVALID'
  | 'GRD_EVENT_KEY_UNKNOWN'
  | 'GRD_EVENT_REPLAYED'
  | 'GRD_EVENT_SCOPE_MISMATCH'
  | 'GRD_EVENT_SIGNATURE_INVALID';

export class ExternalGuardEventError extends Error {
  constructor(
    readonly code: ExternalGuardEventErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalGuardEventError';
  }
}

export interface GuardEventScope {
  readonly tenantId: string;
  readonly applicationId: string;
}

export interface GuardEventKeyRegistry {
  resolve(
    keyId: string,
    scope: GuardEventScope,
  ): Promise<string | Buffer | undefined> | string | Buffer | undefined;
}

export interface GuardEventReplayClaim extends GuardEventScope {
  readonly eventId: string;
  readonly keyId: string;
  readonly sequenceNumber: number;
  readonly expiresAtEpochMs: number;
}

export interface GuardEventReplayStore {
  claim(value: GuardEventReplayClaim, now: number): Promise<boolean>;
}

function unsignedEvent(event: GuardEvent): unknown {
  const { signature: _signature, ...unsigned } = event;
  void _signature;
  return JSON.parse(JSON.stringify(unsigned)) as unknown;
}

function eventSignature(event: GuardEvent, key: string | Buffer): string {
  if (Buffer.byteLength(key) < 32) {
    throw new ExternalGuardEventError(
      'GRD_EVENT_KEY_UNKNOWN',
      'Guard event signing keys must contain at least 32 bytes',
    );
  }
  return createHmac('sha256', key)
    .update(canonicalJson(unsignedEvent(event)), 'utf8')
    .digest('base64url');
}

export function signExternalGuardEvent(
  event: GuardEvent,
  key: string | Buffer,
): string {
  return eventSignature(event, key);
}

function payloadScope(payload: GuardEvent['payload']): Partial<GuardEventScope> {
  if ('context' in payload) {
    return {
      tenantId: payload.context.tenantId,
      applicationId: payload.context.applicationId,
    };
  }
  const scopedPayload = payload as { tenantId?: unknown; applicationId?: unknown };
  if (scopedPayload.tenantId !== undefined || scopedPayload.applicationId !== undefined) {
    return {
      tenantId: typeof scopedPayload.tenantId === 'string' ? scopedPayload.tenantId : undefined,
      applicationId: typeof scopedPayload.applicationId === 'string'
        ? scopedPayload.applicationId
        : undefined,
    };
  }
  return {};
}

function equalSignature(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'base64url');
  const actualBytes = Buffer.from(actual, 'base64url');
  return expectedBytes.length === actualBytes.length &&
    expectedBytes.length > 0 &&
    timingSafeEqual(expectedBytes, actualBytes);
}

export async function verifyAndClaimExternalGuardEvent(input: {
  readonly event: unknown;
  readonly scope: GuardEventScope;
  readonly keyRegistry: GuardEventKeyRegistry;
  readonly replayStore: GuardEventReplayStore;
  readonly now?: number;
  readonly maximumTtlMs?: number;
  readonly clockSkewMs?: number;
}): Promise<GuardEvent> {
  const parsed = guardEventSchema.safeParse(input.event);
  if (!parsed.success) {
    throw new ExternalGuardEventError('GRD_EVENT_INVALID', 'Guard event schema validation failed');
  }
  const event = parsed.data as GuardEvent;
  const now = input.now ?? Date.now();
  const maximumTtlMs = input.maximumTtlMs ?? 5 * 60_000;
  const clockSkewMs = input.clockSkewMs ?? 30_000;
  if (
    event.sequenceNumber === undefined ||
    event.expiresAtEpochMs === undefined ||
    event.signature === undefined ||
    event.signatureKeyId === undefined
  ) {
    throw new ExternalGuardEventError(
      'GRD_EVENT_INVALID',
      'External guard events require sequence, expiry, key id and signature',
    );
  }
  if (
    event.tenantId !== input.scope.tenantId ||
    event.applicationId !== input.scope.applicationId
  ) {
    throw new ExternalGuardEventError(
      'GRD_EVENT_SCOPE_MISMATCH',
      'Guard event does not match the authenticated tenant scope',
    );
  }
  const nestedScope = payloadScope(event.payload);
  if (
    (nestedScope.tenantId !== undefined && nestedScope.tenantId !== event.tenantId) ||
    (nestedScope.applicationId !== undefined &&
      nestedScope.applicationId !== event.applicationId)
  ) {
    throw new ExternalGuardEventError(
      'GRD_EVENT_SCOPE_MISMATCH',
      'Guard event payload does not match its event scope',
    );
  }
  const occurredAt = Date.parse(event.occurredAt);
  if (
    !Number.isFinite(occurredAt) ||
    event.expiresAtEpochMs <= now ||
    occurredAt > now + clockSkewMs ||
    event.expiresAtEpochMs <= occurredAt ||
    event.expiresAtEpochMs - occurredAt > maximumTtlMs
  ) {
    throw new ExternalGuardEventError(
      'GRD_EVENT_EXPIRED',
      'Guard event is expired, from the future or exceeds the maximum lifetime',
    );
  }
  const key = await input.keyRegistry.resolve(event.signatureKeyId, input.scope);
  if (key === undefined) {
    throw new ExternalGuardEventError('GRD_EVENT_KEY_UNKNOWN', 'Guard event key is not trusted');
  }
  if (!equalSignature(eventSignature(event, key), event.signature)) {
    throw new ExternalGuardEventError(
      'GRD_EVENT_SIGNATURE_INVALID',
      'Guard event signature verification failed',
    );
  }
  const claimed = await input.replayStore.claim({
    ...input.scope,
    eventId: event.eventId,
    keyId: event.signatureKeyId,
    sequenceNumber: event.sequenceNumber,
    expiresAtEpochMs: event.expiresAtEpochMs,
  }, now);
  if (!claimed) {
    throw new ExternalGuardEventError(
      'GRD_EVENT_REPLAYED',
      'Guard event id or sequence number has already been consumed',
    );
  }
  return event;
}

export class InMemoryGuardEventReplayStore implements GuardEventReplayStore {
  private readonly eventExpirations = new Map<string, number>();
  private readonly highestSequences = new Map<string, number>();

  async claim(value: GuardEventReplayClaim, now: number): Promise<boolean> {
    for (const [eventKey, expiry] of this.eventExpirations) {
      if (expiry <= now) this.eventExpirations.delete(eventKey);
    }
    const producerKey = `${value.tenantId}:${value.applicationId}:${value.keyId}`;
    const eventKey = `${producerKey}:${value.eventId}`;
    const highestSequence = this.highestSequences.get(producerKey);
    if (
      this.eventExpirations.has(eventKey) ||
      (highestSequence !== undefined && value.sequenceNumber <= highestSequence)
    ) {
      return false;
    }
    this.eventExpirations.set(eventKey, value.expiresAtEpochMs);
    this.highestSequences.set(producerKey, value.sequenceNumber);
    return true;
  }
}
