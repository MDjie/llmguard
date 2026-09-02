import { createHmac, timingSafeEqual } from 'node:crypto';

export const AUDIT_CHAIN_VERSION = 1;
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export interface AuditChainPayload {
  readonly id: string;
  readonly event: string;
  readonly outcome: string;
  readonly status: number;
  readonly requestId: string;
  readonly traceId: string;
  readonly method: string;
  readonly path: string;
  readonly latencyMs: number;
  readonly principalId: string | null;
  readonly tenantId: string | null;
  readonly applicationId: string | null;
  readonly createdAt: string;
}

export interface AuditChainEntry extends AuditChainPayload {
  readonly partitionKey: string;
  readonly chainSequence: number;
  readonly previousHash: string;
  readonly eventHash: string;
  readonly hashKeyId: string;
  readonly chainVersion: number;
}

export interface AuditChainVerification {
  readonly valid: boolean;
  readonly checked: number;
  readonly headHash: string;
  readonly error?: 'SEQUENCE_GAP' | 'PREVIOUS_HASH_MISMATCH' | 'EVENT_HASH_MISMATCH' | 'VERSION_UNSUPPORTED' | 'KEY_UNAVAILABLE';
  readonly errorSequence?: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Audit payload contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError('Audit payload contains an unsupported value');
}

function requireKey(key: string): string {
  if (Buffer.byteLength(key, 'utf8') < 32) {
    throw new Error('AUDIT_CHAIN_KEY must contain at least 32 bytes');
  }
  return key;
}

function safeHashEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function auditPartitionKey(tenantId?: string, applicationId?: string): string {
  return `${tenantId ?? '_platform'}:${applicationId ?? '_platform'}`;
}

export function computeAuditEventHash(
  entry: Omit<AuditChainEntry, 'eventHash'>,
  key: string,
): string {
  const protectedEntry = {
    chainVersion: entry.chainVersion,
    partitionKey: entry.partitionKey,
    chainSequence: entry.chainSequence,
    previousHash: entry.previousHash,
    hashKeyId: entry.hashKeyId,
    payload: {
      id: entry.id,
      event: entry.event,
      outcome: entry.outcome,
      status: entry.status,
      requestId: entry.requestId,
      traceId: entry.traceId,
      method: entry.method,
      path: entry.path,
      latencyMs: entry.latencyMs,
      principalId: entry.principalId,
      tenantId: entry.tenantId,
      applicationId: entry.applicationId,
      createdAt: entry.createdAt,
    },
  };
  return createHmac('sha256', requireKey(key)).update(canonicalJson(protectedEntry)).digest('hex');
}

export function verifyAuditChain(
  entries: readonly AuditChainEntry[],
  key: string,
  expectedPreviousHash = AUDIT_GENESIS_HASH,
  expectedFirstSequence = 1,
): AuditChainVerification {
  return verifyAuditChainWithKeyResolver(
    entries,
    () => key,
    expectedPreviousHash,
    expectedFirstSequence,
  );
}

export function verifyAuditChainWithKeyResolver(
  entries: readonly AuditChainEntry[],
  resolveKey: (keyId: string) => string | undefined,
  expectedPreviousHash = AUDIT_GENESIS_HASH,
  expectedFirstSequence = 1,
): AuditChainVerification {
  let previousHash = expectedPreviousHash;
  let expectedSequence = expectedFirstSequence;
  for (const entry of entries) {
    if (entry.chainVersion !== AUDIT_CHAIN_VERSION) {
      return { valid: false, checked: expectedSequence - expectedFirstSequence, headHash: previousHash, error: 'VERSION_UNSUPPORTED', errorSequence: entry.chainSequence };
    }
    if (entry.chainSequence !== expectedSequence) {
      return { valid: false, checked: expectedSequence - expectedFirstSequence, headHash: previousHash, error: 'SEQUENCE_GAP', errorSequence: entry.chainSequence };
    }
    if (!safeHashEqual(entry.previousHash, previousHash)) {
      return { valid: false, checked: expectedSequence - expectedFirstSequence, headHash: previousHash, error: 'PREVIOUS_HASH_MISMATCH', errorSequence: entry.chainSequence };
    }
    const key = resolveKey(entry.hashKeyId);
    if (!key) {
      return { valid: false, checked: expectedSequence - expectedFirstSequence, headHash: previousHash, error: 'KEY_UNAVAILABLE', errorSequence: entry.chainSequence };
    }
    const computed = computeAuditEventHash(entry, key);
    if (!safeHashEqual(entry.eventHash, computed)) {
      return { valid: false, checked: expectedSequence - expectedFirstSequence, headHash: previousHash, error: 'EVENT_HASH_MISMATCH', errorSequence: entry.chainSequence };
    }
    previousHash = entry.eventHash;
    expectedSequence += 1;
  }
  return { valid: true, checked: entries.length, headHash: previousHash };
}
