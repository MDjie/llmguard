import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import type { TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { securityAuditEvents } from '@/storage/database/shared/schema';
import {
  AUDIT_GENESIS_HASH,
  auditPartitionKey,
  verifyAuditChainWithKeyResolver,
  type AuditChainEntry,
} from './chain';
import { resolveAuditChainConfiguration } from './repository';

const BATCH_SIZE = 5_000;

function keyRing(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const current = resolveAuditChainConfiguration(environment);
  const keys: Record<string, string> = { [current.keyId]: current.key };
  const serialized = environment.AUDIT_CHAIN_KEYS_JSON;
  if (!serialized) return keys;
  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AUDIT_CHAIN_KEYS_JSON must be a JSON object');
  }
  for (const [keyId, value] of Object.entries(parsed)) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/u.test(keyId) ||
      typeof value !== 'string' ||
      Buffer.byteLength(value, 'utf8') < 32
    ) {
      throw new Error('AUDIT_CHAIN_KEYS_JSON contains an invalid key entry');
    }
    keys[keyId] = value;
  }
  return keys;
}

function chainEntry(row: typeof securityAuditEvents.$inferSelect): AuditChainEntry {
  if (
    !row.partitionKey || row.chainSequence === null || !row.previousHash || !row.eventHash ||
    !row.hashKeyId || row.chainVersion === null
  ) {
    throw new Error('AUDIT_CHAIN_METADATA_MISSING');
  }
  return {
    id: row.id,
    event: row.event,
    outcome: row.outcome,
    status: row.status,
    requestId: row.requestId,
    traceId: row.traceId,
    method: row.method,
    path: row.path,
    latencyMs: row.latencyMs,
    principalId: row.principalId,
    tenantId: row.tenantId,
    applicationId: row.applicationId,
    createdAt: row.createdAt.toISOString(),
    partitionKey: row.partitionKey,
    chainSequence: row.chainSequence,
    previousHash: row.previousHash,
    eventHash: row.eventHash,
    hashKeyId: row.hashKeyId,
    chainVersion: row.chainVersion,
  };
}

export async function verifyScopedAuditChain(
  scope: TenantScope,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ readonly valid: true; readonly checked: number; readonly headHash: string }> {
  const partition = auditPartitionKey(scope.tenantId, scope.applicationId);
  const keys = keyRing(environment);
  let cursor = 0;
  let checked = 0;
  let previousHash = AUDIT_GENESIS_HASH;
  for (;;) {
    const rows = await db.select().from(securityAuditEvents).where(and(
      eq(securityAuditEvents.partitionKey, partition),
      isNotNull(securityAuditEvents.eventHash),
      gt(securityAuditEvents.chainSequence, cursor),
    )).orderBy(asc(securityAuditEvents.chainSequence)).limit(BATCH_SIZE);
    if (rows.length === 0) break;
    const entries = rows.map(chainEntry);
    const verification = verifyAuditChainWithKeyResolver(
      entries,
      (keyId) => keys[keyId],
      previousHash,
      cursor + 1,
    );
    if (!verification.valid) {
      throw new Error(
        'AUDIT_CHAIN_INVALID:' + String(verification.error) + ':' + String(verification.errorSequence),
      );
    }
    checked += verification.checked;
    previousHash = verification.headHash;
    cursor = entries.at(-1)?.chainSequence ?? cursor;
  }
  return { valid: true, checked, headHash: previousHash };
}
