import { enqueueDecisionRecord } from '@/lib/security-alerts/service';
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { archivedContentObjects, conversationArchives, gatewayRequests, gatewayExecutionEvents } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { archiveObjectReferenceSchema, type ArchivePolicy, type ArchivePurpose } from '@/contracts/http/conversation-archive';
import { canonicalJson, GatewayError } from '@/lib/gateway-runtime/protocol';
import { archiveContentHmac, evidenceHmac, openReceipt, sealReceipt } from '@/lib/gateway-runtime/security';
import { archiveObjectStore, type ArchiveObjectStore } from './object-store';
import { archiveExpiresAt, reconcileArchive } from './integrity';
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ObjectRow = typeof archivedContentObjects.$inferSelect;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const normalizedJson = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)));
const inputSchema = z.object({ requestId: z.string().min(1).max(128), purpose: z.enum(['RECEIVED_INPUT','MODEL_INPUT','MODEL_OUTPUT','RELEASED_OUTPUT']), sequence: z.number().int().nonnegative(),
  representation: z.enum(['REQUEST_JSON','MODEL_RESPONSE_JSON','SSE_EVENT','CONTENT_SEGMENTS','MEDIA_BYTES']), sourceStepId: z.string().max(128).optional(),
  eventSequence: z.number().int().nonnegative().optional(), executionPayloadDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), rangeStart: z.number().int().nonnegative().optional(), rangeEnd: z.number().int().nonnegative().optional(), data: z.unknown(),
}).strict();
export type ArchiveContentInput = z.infer<typeof inputSchema>;
export function archiveObjectIdentity(scope: TenantScope, requestId: string, purpose: ArchivePurpose, sequence: number) {
  return hash(canonicalJson([scope.tenantId, scope.applicationId, requestId, purpose, sequence]));
}
export function archiveReference(row: ObjectRow) {
  return archiveObjectReferenceSchema.parse({ id: row.id, purpose: row.purpose, sequence: row.sequence, representation: row.representation, state: row.state,
    sourceHmac: row.sourceHmac, ciphertextSha256: row.ciphertextSha256, sizeBytes: row.sizeBytes, objectKey: row.objectKey, objectVersion: row.objectVersion, keyIds: row.keyIds,
    sourceStepId: row.sourceStepId, eventSequence: row.eventSequence, rangeStart: row.rangeStart, rangeEnd: row.rangeEnd, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), verificationError: row.errorCode === 'ARCHIVE_STORED_VERSION_UNAVAILABLE' ? row.errorCode : null });
}
export async function initializeConversationArchive(transaction: Transaction, request: typeof gatewayRequests.$inferSelect, policy: ArchivePolicy, receivedRequest: unknown, mediaComplete = true) {
  if (policy.mode === 'DISABLED') return null;
  const scope = { tenantId: request.tenantId, applicationId: request.applicationId };
  await transaction.insert(conversationArchives).values({ ...scope, requestId: request.id, conversationId: request.sessionId ?? request.id, subjectId: request.subjectId, policy,
    acceptedAt: request.createdAt, expiresAt: archiveExpiresAt(request.createdAt), holdUntil: request.contentHoldUntil, mediaComplete }).onConflictDoNothing();
  return enqueueArchiveContent(transaction, scope, { requestId: request.id, purpose: 'RECEIVED_INPUT', sequence: 0, representation: 'REQUEST_JSON', data: receivedRequest });
}
export async function enqueueArchiveContent(transaction: Transaction, scope: TenantScope, raw: ArchiveContentInput) {
  const input = inputSchema.parse(raw);
  const [archive] = await transaction.select().from(conversationArchives).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, input.requestId))).limit(1).for('update');
  if (!archive || ['DELETE_PENDING','DELETED'].includes(archive.state)) throw new GatewayError('ARCHIVE_NOT_AVAILABLE', 409);
  const id = archiveObjectIdentity(scope, input.requestId, input.purpose, input.sequence), text = normalizedJson(input.data);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new GatewayError('ARCHIVE_CONTENT_BUDGET_EXCEEDED', 413);
  const [existing] = await transaction.select().from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.id, id))).limit(1);
  if (existing) {
    const contentHmac = archiveContentHmac(text, existing.keyIds[0]), sourceHmac = input.executionPayloadDigest ? evidenceHmac(input.executionPayloadDigest) : contentHmac;
    if (existing.contentHmac !== contentHmac || existing.sourceHmac !== sourceHmac || existing.representation !== input.representation || existing.sourceStepId !== (input.sourceStepId ?? null)
      || existing.eventSequence !== (input.eventSequence ?? null) || existing.rangeStart !== (input.rangeStart ?? null) || existing.rangeEnd !== (input.rangeEnd ?? null)) throw new GatewayError('ARCHIVE_CONTENT_CONFLICT', 409);
    return archiveReference(existing);
  }
  if (archive.state === 'COMMITTED') throw new GatewayError('ARCHIVE_ALREADY_FINALIZED', 409);
  const spool = sealReceipt(input.data, 'archive:' + id), encoded = canonicalJson(spool);
  const contentHmac = archiveContentHmac(text, spool[0].keyId), sourceHmac = input.executionPayloadDigest ? evidenceHmac(input.executionPayloadDigest) : contentHmac;
  const [usage] = await transaction.select({ bytes: sql<number>`coalesce(sum(${archivedContentObjects.sizeBytes}),0)::bigint` }).from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.requestId, input.requestId)));
  if (Number(usage?.bytes ?? 0) + Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw new GatewayError('ARCHIVE_REQUEST_QUOTA_EXCEEDED', 413);
  const [row] = await transaction.insert(archivedContentObjects).values({ ...scope, id, requestId: input.requestId, purpose: input.purpose, sequence: input.sequence,
    representation: input.representation, sourceHmac, contentHmac, ciphertextSha256: hash(encoded), sizeBytes: Buffer.byteLength(encoded), objectKey: `archives/${scope.tenantId}/${scope.applicationId}/${id}.json`,
    keyIds: [...new Set(spool.map(envelope => envelope.keyId))], spool, sourceStepId: input.sourceStepId, eventSequence: input.eventSequence, rangeStart: input.rangeStart, rangeEnd: input.rangeEnd, expiresAt: archive.expiresAt }).returning();
  if (!row) throw new GatewayError('ARCHIVE_INSERT_FAILED', 503);
  return archiveReference(row);
}
async function findObject(scope: TenantScope, id: string) {
  const [row] = await db.select().from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.id, id))).limit(1);
  if (!row) throw new GatewayError('ARCHIVE_OBJECT_NOT_FOUND', 404); return row;
}
/** Network I/O occurs between durable database phases, never while a row lock is held. */
export async function publishArchiveContent(scope: TenantScope, id: string, store: ArchiveObjectStore = archiveObjectStore(), signal?: AbortSignal) {
  const row = await findObject(scope, id);
  if (['MANIFEST_COMMITTED','INDEXED'].includes(row.state)) return archiveReference(row);
  if (!['PENDING','OBJECT_WRITTEN'].includes(row.state) || !row.spool) throw new GatewayError('ARCHIVE_OBJECT_STATE_INVALID', 409);
  const bytes = Buffer.from(canonicalJson(row.spool));
  if (bytes.length !== row.sizeBytes || hash(bytes.toString('utf8')) !== row.ciphertextSha256) throw new GatewayError('ARCHIVE_SPOOL_INTEGRITY_FAILED', 503);
  try {
    const reference = row.state === 'OBJECT_WRITTEN' && row.objectVersion
      ? { objectVersion: row.objectVersion, ciphertextSha256: row.ciphertextSha256, sizeBytes: row.sizeBytes }
      : await store.putImmutable(row.objectKey, bytes, signal);
    if (row.state === 'OBJECT_WRITTEN') await store.readVersion(row.objectKey, reference, signal);
    if (reference.ciphertextSha256 !== row.ciphertextSha256 || reference.sizeBytes !== row.sizeBytes) throw new GatewayError('ARCHIVE_OBJECT_INTEGRITY_FAILED', 503);
    await db.transaction(async transaction => {
      await transaction.select({ id: conversationArchives.requestId }).from(conversationArchives).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, row.requestId))).for('update');
      const [current] = await transaction.select().from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.id, id))).for('update');
      if (!current || (current.objectVersion && current.objectVersion !== reference.objectVersion)) throw new GatewayError('ARCHIVE_OBJECT_VERSION_CONFLICT', 409);
      if (current.state === 'PENDING') await transaction.update(archivedContentObjects).set({ state: 'OBJECT_WRITTEN', objectVersion: reference.objectVersion, objectWrittenAt: new Date(), errorCode: null }).where(eq(archivedContentObjects.id, id));
    });
    // A restart after the first transaction re-verifies the exact stored version before committing its manifest.
    await db.transaction(async transaction => {
      await transaction.select({ id: conversationArchives.requestId }).from(conversationArchives).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, row.requestId))).for('update');
      const [updated] = await transaction.update(archivedContentObjects).set({ state: 'MANIFEST_COMMITTED', spool: null, committedAt: new Date(), errorCode: null }).where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.id, id), eq(archivedContentObjects.state, 'OBJECT_WRITTEN'), eq(archivedContentObjects.objectVersion, reference.objectVersion))).returning({ id: archivedContentObjects.id });
      if (updated) await transaction.update(conversationArchives).set({ version: sql`${conversationArchives.version} + 1` }).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, row.requestId)));
    });
    return archiveReference(await findObject(scope, id));
  } catch (error) {
    await db.update(archivedContentObjects).set({ attempt: sql`${archivedContentObjects.attempt} + 1`, errorCode: 'ARCHIVE_PERSISTENCE_FAILED', retryAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** Math.min(row.attempt, 8))) })
      .where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.id, id), inArray(archivedContentObjects.state, ['PENDING','OBJECT_WRITTEN'])));
    throw error;
  } finally { bytes.fill(0); }
}
export async function writeArchiveContent(scope: TenantScope, input: ArchiveContentInput, store?: ArchiveObjectStore, signal?: AbortSignal) {
  const reference = await db.transaction(transaction => enqueueArchiveContent(transaction, scope, input));
  return publishArchiveContent(scope, reference.id, store, signal);
}
/** Internal primitive: callers must consume a requester-bound, digest-bound raw-content grant first. */
export async function readArchivedContent(scope: TenantScope, id: string, store: ArchiveObjectStore = archiveObjectStore()) {
  const row = await findObject(scope, id);
  if (!['MANIFEST_COMMITTED','INDEXED'].includes(row.state) || !row.objectVersion) throw new GatewayError('ARCHIVE_OBJECT_NOT_COMMITTED', 409);
  const bytes = await store.readVersion(row.objectKey, { objectVersion: row.objectVersion, ciphertextSha256: row.ciphertextSha256, sizeBytes: row.sizeBytes });
  const envelopes: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const schema = z.array(z.object({ keyId: z.string(), algorithm: z.literal('AES-256-GCM'), iv: z.string(), ciphertext: z.string(), authTag: z.string() }).strict()).max(1024);
  const value = openReceipt(schema.parse(envelopes), 'archive:' + row.id);
  if (archiveContentHmac(normalizedJson(value), row.keyIds[0]) !== row.contentHmac) throw new GatewayError('ARCHIVE_CONTENT_INTEGRITY_FAILED', 503);
  return { reference: archiveReference(row), content: value };
}
export async function reconcileConversationArchive(scope: TenantScope, requestId: string) {
  return db.transaction(async transaction => {
    const [request] = await transaction.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.id, requestId))).for('update');
    const [archive] = await transaction.select().from(conversationArchives).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, requestId))).for('update');
    if (!request || !archive || ['DELETE_PENDING','DELETED'].includes(archive.state)) return null;
    const [events, objects] = await Promise.all([
      transaction.select({ sequence: gatewayExecutionEvents.eventSeq, kind: gatewayExecutionEvents.kind, payloadHmac: gatewayExecutionEvents.payloadHmac, rangeStart: gatewayExecutionEvents.rangeStart, rangeEnd: gatewayExecutionEvents.rangeEnd }).from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, scope), eq(gatewayExecutionEvents.requestId, requestId))).orderBy(asc(gatewayExecutionEvents.eventSeq)),
      transaction.select().from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.requestId, requestId))),
    ]);
    const integrity = reconcileArchive({ requestState: request.state, lastEventSequence: request.lastEventSeq, events, objects: objects.map(archiveReference), modelOutputFinalSequence: archive.modelOutputFinalSequence,
      modelOutputUnavailableReason: archive.modelOutputUnavailableReason, mediaComplete: archive.mediaComplete });
    if (integrity.state === 'GAPPED' && archive.state !== 'GAPPED') await enqueueDecisionRecord(transaction, scope, {
      version: '1.0', source: 'GATEWAY', sourceId: request.id, requestId: request.id, traceId: request.authContext.context.traceId,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}), decisionId: 'archive:' + hash(request.id + ':' + archive.version),
      stage: 'ARCHIVE_RECONCILIATION', action: 'REQUIRE_REVIEW', occurredAt: new Date().toISOString(), coverage: { archiveState: integrity.state, gaps: integrity.gaps },
      findings: integrity.gaps.map(gap => ({ riskId: 'system.archive_incomplete', score: 0, reasonCode: gap.code, category: 'SYSTEM_FAILURE', evidence: [] })),
    });
    await transaction.update(conversationArchives).set({ state: integrity.state, integrity, reconciledAt: new Date(), committedAt: integrity.archiveCommitted ? archive.committedAt ?? new Date() : null, version: archive.version + 1 })
      .where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, requestId)));
    return integrity;
  });
}
export async function recoverArchiveObjects(maximum = 10, store?: ArchiveObjectStore) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new Error('ARCHIVE_RECOVERY_LIMIT_INVALID');
  const rows = await db.select().from(archivedContentObjects).where(and(inArray(archivedContentObjects.state, ['PENDING','OBJECT_WRITTEN']), lte(archivedContentObjects.retryAt, new Date()))).orderBy(asc(archivedContentObjects.retryAt), asc(archivedContentObjects.id)).limit(maximum);
  let recovered = 0, failed = 0;
  for (const row of rows) { const scope = { tenantId: row.tenantId, applicationId: row.applicationId };
    try { await publishArchiveContent(scope, row.id, store); await reconcileConversationArchive(scope, row.requestId); recovered++; } catch { failed++; }
  }
  return { recovered, failed };
}

export async function reconcileArchiveRequests(maximum = 20) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new Error('ARCHIVE_RECONCILIATION_LIMIT_INVALID');
  const rows = await db.select({ tenantId: conversationArchives.tenantId, applicationId: conversationArchives.applicationId, requestId: conversationArchives.requestId }).from(conversationArchives)
    .innerJoin(gatewayRequests, and(eq(gatewayRequests.tenantId, conversationArchives.tenantId), eq(gatewayRequests.applicationId, conversationArchives.applicationId), eq(gatewayRequests.id, conversationArchives.requestId)))
    .where(and(inArray(conversationArchives.state, ['OPEN','GAPPED']), inArray(gatewayRequests.state, ['COMPLETED','TERMINATED','REVIEW_REQUIRED','UPSTREAM_OUTCOME_UNKNOWN'])))
    .orderBy(asc(sql`coalesce(${conversationArchives.reconciledAt},${conversationArchives.acceptedAt})`)).limit(maximum);
  for (const row of rows) await reconcileConversationArchive(row, row.requestId);
  return { reconciled: rows.length };
}

/** Re-read immutable versions daily; failures retry after 15 minutes and prevent completeness/purge claims. */
export async function verifyArchiveStoredObjects(maximum=10, store?:ArchiveObjectStore, requestId?:string) {
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100)throw new Error('ARCHIVE_VERIFICATION_LIMIT_INVALID');
  const rows=await db.select().from(archivedContentObjects).where(and(inArray(archivedContentObjects.state,['MANIFEST_COMMITTED','INDEXED']),
    lte(archivedContentObjects.retryAt,new Date()),requestId?eq(archivedContentObjects.requestId,requestId):undefined)).orderBy(asc(archivedContentObjects.retryAt),asc(archivedContentObjects.id)).limit(maximum);
  let verified=0,failed=0;
  for(const row of rows){
    const scope={tenantId:row.tenantId,applicationId:row.applicationId};let available=false;
    try{if(!row.objectVersion)throw new Error('VERSION_REQUIRED');await(store??archiveObjectStore()).readVersion(row.objectKey,{objectVersion:row.objectVersion,ciphertextSha256:row.ciphertextSha256,sizeBytes:row.sizeBytes});available=true;verified++;}catch{failed++;}
    await db.transaction(async tx=>{
      await tx.select({id:conversationArchives.requestId}).from(conversationArchives).where(and(scopePredicate(conversationArchives,scope),eq(conversationArchives.requestId,row.requestId))).for('update');
      await tx.update(archivedContentObjects).set({errorCode:available?null:'ARCHIVE_STORED_VERSION_UNAVAILABLE',retryAt:new Date(Date.now()+(available?86400000:900000))})
        .where(and(scopePredicate(archivedContentObjects,scope),eq(archivedContentObjects.id,row.id),inArray(archivedContentObjects.state,['MANIFEST_COMMITTED','INDEXED'])));
    });
    await reconcileConversationArchive(scope,row.requestId);
  }
  return{verified,failed};
}
