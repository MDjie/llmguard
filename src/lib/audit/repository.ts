import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { ApiAuditRecord } from '@/lib/api-security/types';
import { db } from '@/storage/database/shared/db';
import { securityAuditEvents } from '@/storage/database/shared/schema';
import { auditExportOutbox } from '@/storage/database/shared/schema';
import {
  AUDIT_CHAIN_VERSION,
  AUDIT_GENESIS_HASH,
  auditPartitionKey,
  computeAuditEventHash,
} from './chain';
import { resolveAuditExportTargets, targetAcceptsEvent } from './export-config';
import type { AuditExportPayload } from './exporters';

interface AuditChainConfiguration {
  readonly key: string;
  readonly keyId: string;
}

export function resolveAuditChainConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AuditChainConfiguration {
  const key = environment.AUDIT_CHAIN_KEY ?? '';
  if (Buffer.byteLength(key, 'utf8') < 32) {
    throw new Error('AUDIT_CHAIN_KEY must contain at least 32 bytes');
  }
  const keyId = environment.AUDIT_CHAIN_KEY_ID?.trim() || 'audit-hmac-v1';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw new Error('AUDIT_CHAIN_KEY_ID is invalid');
  }
  return { key, keyId };
}

export async function appendAuditEvent(event: ApiAuditRecord): Promise<void> {
  const configuration = resolveAuditChainConfiguration();
  const exportTargets = resolveAuditExportTargets().filter((target) => targetAcceptsEvent(target, event));
  const partitionKey = auditPartitionKey(event.tenantId, event.applicationId);
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${partitionKey}, 0))`);
    const [previous] = await transaction
      .select({ sequence: securityAuditEvents.chainSequence, hash: securityAuditEvents.eventHash })
      .from(securityAuditEvents)
      .where(and(
        eq(securityAuditEvents.partitionKey, partitionKey),
        isNotNull(securityAuditEvents.eventHash),
      ))
      .orderBy(desc(securityAuditEvents.chainSequence))
      .limit(1);

    const id = randomUUID();
    const createdAt = new Date();
    const chainSequence = (previous?.sequence ?? 0) + 1;
    const previousHash = previous?.hash ?? AUDIT_GENESIS_HASH;
    const hashInput = {
      id,
      event: event.event,
      outcome: event.outcome,
      status: event.status,
      requestId: event.requestId,
      traceId: event.traceId,
      method: event.method,
      path: event.path,
      latencyMs: event.latencyMs,
      principalId: event.principalId ?? null,
      tenantId: event.tenantId ?? null,
      applicationId: event.applicationId ?? null,
      createdAt: createdAt.toISOString(),
      partitionKey,
      chainSequence,
      previousHash,
      hashKeyId: configuration.keyId,
      chainVersion: AUDIT_CHAIN_VERSION,
    };
    const eventHash = computeAuditEventHash(hashInput, configuration.key);
    await transaction.insert(securityAuditEvents).values({
      ...hashInput,
      eventHash,
      createdAt,
    });
    if (exportTargets.length > 0) {
      const payload: AuditExportPayload = {
        schemaVersion: '1.0',
        eventId: id,
        event: event.event,
        outcome: event.outcome,
        status: event.status,
        requestId: event.requestId,
        traceId: event.traceId,
        method: event.method,
        path: event.path,
        latencyMs: event.latencyMs,
        principalId: event.principalId ?? null,
        tenantId: event.tenantId ?? null,
        applicationId: event.applicationId ?? null,
        occurredAt: createdAt.toISOString(),
        chain: {
          partitionKey,
          sequence: chainSequence,
          previousHash,
          eventHash,
          keyId: configuration.keyId,
          version: AUDIT_CHAIN_VERSION,
        },
      };
      await transaction.insert(auditExportOutbox).values(exportTargets.map((target) => ({
        auditEventId: id,
        tenantId: event.tenantId ?? null,
        applicationId: event.applicationId ?? null,
        destinationType: target.type,
        destination: target.destination,
        payload: { ...payload },
      })));
    }
  });
}
