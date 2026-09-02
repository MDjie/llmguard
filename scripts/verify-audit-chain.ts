import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import {
  AUDIT_GENESIS_HASH,
  verifyAuditChainWithKeyResolver,
  type AuditChainEntry,
} from '../src/lib/audit/chain';
import { resolveAuditChainConfiguration } from '../src/lib/audit/repository';
import { logger } from '../src/lib/observability/logger';
import { db } from '../src/storage/database/shared/db';
import { securityAuditEvents } from '../src/storage/database/shared/schema';

const BATCH_SIZE = 5_000;

function loadKeyRing(): Readonly<Record<string, string>> {
  const current = resolveAuditChainConfiguration();
  const serialized = process.env.AUDIT_CHAIN_KEYS_JSON;
  if (!serialized) return { [current.keyId]: current.key };
  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AUDIT_CHAIN_KEYS_JSON must be a JSON object');
  }
  const keys: Record<string, string> = { [current.keyId]: current.key };
  for (const [keyId, key] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || typeof key !== 'string' || Buffer.byteLength(key, 'utf8') < 32) {
      throw new Error('AUDIT_CHAIN_KEYS_JSON contains an invalid key entry');
    }
    keys[keyId] = key;
  }
  return keys;
}

function toEntry(row: typeof securityAuditEvents.$inferSelect): AuditChainEntry {
  if (
    !row.partitionKey || row.chainSequence === null || !row.previousHash || !row.eventHash ||
    !row.hashKeyId || row.chainVersion === null
  ) {
    throw new Error('A chained audit row is missing integrity metadata');
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

async function verifyPartition(
  partitionKey: string,
  keyRing: Readonly<Record<string, string>>,
): Promise<{ readonly partitionKey: string; readonly valid: true; readonly checked: number; readonly headHash: string }> {
  let cursor = 0;
  let checked = 0;
  let previousHash = AUDIT_GENESIS_HASH;
  for (;;) {
    const rows = await db.select().from(securityAuditEvents).where(and(
      eq(securityAuditEvents.partitionKey, partitionKey),
      isNotNull(securityAuditEvents.eventHash),
      gt(securityAuditEvents.chainSequence, cursor),
    )).orderBy(asc(securityAuditEvents.chainSequence)).limit(BATCH_SIZE);
    if (rows.length === 0) break;
    const entries = rows.map(toEntry);
    const verification = verifyAuditChainWithKeyResolver(
      entries,
      (keyId) => keyRing[keyId],
      previousHash,
      cursor + 1,
    );
    if (!verification.valid) {
      throw new Error(`${partitionKey} failed at sequence ${verification.errorSequence}: ${verification.error}`);
    }
    checked += verification.checked;
    previousHash = verification.headHash;
    cursor = entries.at(-1)?.chainSequence ?? cursor;
  }
  return { partitionKey, valid: true, checked, headHash: previousHash };
}

async function main(): Promise<void> {
  const keyRing = loadKeyRing();
  const partitions = await db
    .selectDistinct({ partitionKey: securityAuditEvents.partitionKey })
    .from(securityAuditEvents)
    .where(isNotNull(securityAuditEvents.eventHash));
  const results = [];
  for (const partition of partitions) {
    if (partition.partitionKey) results.push(await verifyPartition(partition.partitionKey, keyRing));
  }
  process.stdout.write(`${JSON.stringify({ valid: true, verifiedAt: new Date().toISOString(), partitions: results }, null, 2)}\n`);
}

main().catch((error) => {
  logger.error('audit.chain.verification_failed', { error });
  process.exitCode = 1;
});
