import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import type { ArchiveObjectStore, StoredArchiveObject } from '../../src/lib/conversation-archive/object-store';
class MemoryObjects implements ArchiveObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; reference: StoredArchiveObject }>();
  writes = 0; failAfterWrite = false; failReads = false;
  async putImmutable(key: string, bytes: Uint8Array) {
    this.writes++; let saved = this.objects.get(key);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (!saved) { saved = { bytes: new Uint8Array(bytes), reference: { objectVersion: randomUUID(), ciphertextSha256: digest, sizeBytes: bytes.length } }; this.objects.set(key, saved); }
    if (saved.reference.ciphertextSha256 !== digest) throw new Error('IMMUTABLE_OBJECT_CONFLICT');
    if (this.failAfterWrite) { this.failAfterWrite = false; throw new Error('INJECTED_ACK_LOSS'); }
    return saved.reference;
  }
  async readVersion(key: string, reference: StoredArchiveObject) { if (this.failReads) throw new Error('INJECTED_READ_FAILURE'); const saved = this.objects.get(key); if (!saved || saved.reference.objectVersion !== reference.objectVersion) throw new Error('OBJECT_VERSION_MISSING'); return new Uint8Array(saved.bytes); }
  async deleteVersion(key: string, version: string) { const saved = this.objects.get(key); if (saved && saved.reference.objectVersion !== version) throw new Error('OBJECT_VERSION_MISMATCH'); this.objects.delete(key); }
}
async function main() {
  const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string, string> = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
  const fixture: { tenantId: string; applicationId: string } = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
  const url = new URL(environment.PGDATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.port !== '55447' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env, environment);
  const client = new pg.Client({ connectionString: url.toString(), ssl: false }); await client.connect();
  await client.query(readFileSync(path.resolve('drizzle/0060_conversation_archive.sql'), 'utf8'));
  const [{ db, closeDatabaseConnection }, s, service, { archivePolicySchema, archiveQuerySchema }, retention, access, { consumeArchivedContentAccess }, query, archiveRetention] = await Promise.all([
    import('../../src/storage/database/shared/db'), import('../../src/storage/database/shared/schema'), import('../../src/lib/conversation-archive/service'),
    import('../../src/contracts/http/conversation-archive'), import('../../src/lib/gateway-runtime/content-retention'), import('../../src/lib/incidents/content-access'),
    import('../../src/lib/conversation-archive/access'), import('../../src/lib/conversation-archive/query'), import('../../src/lib/conversation-archive/retention'),
  ]);
  const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId }, store = new MemoryObjects(), results: Array<{ name: string; status: string }> = [];
  const policy = archivePolicySchema.parse({ mode: 'STRICT_OBJECT', retentionDays: 180, version: 'archive-policy-1' });
  const content = { model: 'archive-fixture', messages: [{ role: 'user', content: 'private archive fixture 😀' }] };
  const [template] = await db.select().from(s.gatewayRequests).where(and(eq(s.gatewayRequests.tenantId, scope.tenantId), eq(s.gatewayRequests.applicationId, scope.applicationId))).limit(1); assert.ok(template);
  async function fixtureRequest() {
    const id = randomUUID(); const [request] = await db.insert(s.gatewayRequests).values({ ...template, id, idempotencyKey: id, sessionId: null, consoleAssertionHmac: null,
      state: 'AUTHORIZED', stepCount: 0, lastEventSeq: 0, sessionFinalized: false, createdAt: new Date(), expiresAt: new Date(Date.now() + 60000), contentPurgedAt: null, deletionProofId: null, retentionVersion: 0, contentHoldUntil: null, contentHoldReasonHmac: null,
      authContext: { ...template.authContext, context: { ...template.authContext.context, businessRequestId: id, archiveRequired: true } }, sessionSnapshot: null }).returning();
    const object = await db.transaction(tx => service.initializeConversationArchive(tx, request, policy, content)); assert.ok(object); return { request, object };
  }
  async function test(name: string, run: () => Promise<void>) { await run(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  try {
    const first = await fixtureRequest();
    await test('encrypted durable spool survives lost upload acknowledgement and rejects changed replay', async () => {
      const [pending] = await db.select().from(s.archivedContentObjects).where(eq(s.archivedContentObjects.id, first.object.id));
      assert.equal(pending.state, 'PENDING'); assert.ok(pending.spool); assert.ok(!JSON.stringify(pending).includes('private archive'));
      store.failAfterWrite = true; await assert.rejects(service.publishArchiveContent(scope, first.object.id, store), /ACK_LOSS/);
      const saved = await service.publishArchiveContent(scope, first.object.id, store); assert.equal(saved.state, 'MANIFEST_COMMITTED');
      const [committed] = await db.select().from(s.archivedContentObjects).where(eq(s.archivedContentObjects.id, saved.id)); assert.equal(committed.spool, null);
      assert.deepEqual((await service.readArchivedContent(scope, saved.id, store)).content, content);
      await assert.rejects(service.writeArchiveContent(scope, { requestId: first.request.id, purpose: 'RECEIVED_INPUT', sequence: 0, representation: 'REQUEST_JSON', data: { altered: true } }, store), /CONTENT_CONFLICT/);
    });
    await test('object-written phase survives manifest transaction failure and resumes the exact version', async () => {
      const next = await fixtureRequest(); const before = store.writes;
      await client.query(`CREATE OR REPLACE FUNCTION isolated_v11_archive_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${next.object.id}' AND NEW.state='MANIFEST_COMMITTED' THEN RAISE EXCEPTION 'injected manifest failure'; END IF; RETURN NEW; END $$`);
      await client.query('CREATE TRIGGER isolated_v11_archive_fault BEFORE UPDATE ON archived_content_objects FOR EACH ROW EXECUTE FUNCTION isolated_v11_archive_fault()');
      try { await assert.rejects(service.publishArchiveContent(scope, next.object.id, store)); }
      finally { await client.query('DROP TRIGGER isolated_v11_archive_fault ON archived_content_objects'); await client.query('DROP FUNCTION isolated_v11_archive_fault()'); }
      const [interrupted] = await db.select().from(s.archivedContentObjects).where(eq(s.archivedContentObjects.id, next.object.id)); assert.equal(interrupted.state, 'OBJECT_WRITTEN'); assert.ok(interrupted.spool);
      const recovered = await service.publishArchiveContent(scope, next.object.id, store); assert.equal(recovered.objectVersion, interrupted.objectVersion); assert.equal(store.writes, before + 1);
    });
    await test('archive object scope, identity and lifecycle transitions are enforced by the database', async () => {
      await assert.rejects(service.readArchivedContent({ ...scope, applicationId: randomUUID() }, first.object.id, store), /NOT_FOUND/);
      await assert.rejects(db.update(s.archivedContentObjects).set({ objectKey: 'archives/overwritten' }).where(eq(s.archivedContentObjects.id, first.object.id)));
      await assert.rejects(db.update(s.archivedContentObjects).set({ state: 'PENDING' }).where(eq(s.archivedContentObjects.id, first.object.id)));
      await assert.rejects(db.delete(s.archivedContentObjects).where(eq(s.archivedContentObjects.id, first.object.id)));
    });
    await test('terminal reconciliation requires complete objects and preserves the input-only blocked case', async () => {
      const missing = await fixtureRequest();
      for (const fixture of [first, missing]) {
        await db.insert(s.gatewayExecutionEvents).values({ ...scope, id: randomUUID(), requestId: fixture.request.id, eventSeq: 1, kind: 'TERMINATED', snapshotId: template.snapshotId, eventHmac: 'a'.repeat(64) });
        await db.update(s.gatewayRequests).set({ state: 'TERMINATED', lastEventSeq: 1, sessionFinalized: true }).where(eq(s.gatewayRequests.id, fixture.request.id));
      }
      assert.equal((await service.reconcileConversationArchive(scope, first.request.id))?.archiveCommitted, true);
      assert.equal((await service.reconcileConversationArchive(scope, missing.request.id))?.archiveCommitted, false);
      const [archive] = await db.select().from(s.conversationArchives).where(eq(s.conversationArchives.requestId, first.request.id));
      assert.equal(archive.expiresAt.getTime() - archive.acceptedAt.getTime(), 180 * 86400000);
    });
    await test('legal holds continue to protect the archive after operational ciphertext has been purged', async () => {
      await db.update(s.gatewayRequests).set({ expiresAt: new Date('1970-01-01T00:00:00Z') }).where(eq(s.gatewayRequests.id, first.request.id));
      assert.equal((await retention.purgeGatewayContent(scope, new Date(), 1))?.requests, 1);
      assert.ok((await db.select().from(s.gatewayRequests).where(eq(s.gatewayRequests.id, first.request.id)))[0].contentPurgedAt);
      const until = new Date(Date.now() + 86400000).toISOString();
      const result = await retention.setGatewayContentHold(scope, 'archive-fixture-operator', { requestId: first.request.id, expectedVersion: 1, holdUntil: until, reason: 'isolation fixture retention hold' }); assert.equal(result.version, 2);
      const [archive] = await db.select().from(s.conversationArchives).where(eq(s.conversationArchives.requestId, first.request.id)); assert.equal(archive.holdUntil?.toISOString(), until);
      await assert.rejects(retention.setGatewayContentHold(scope, 'archive-fixture-operator', { requestId: first.request.id, expectedVersion: 0, holdUntil: null, reason: 'stale release' }), /VERSION_CONFLICT/);
    });
    await test('archived raw access requires independent approval, binds requester and digest, and consumes once', async () => {
      const requester = { ...scope, principalId: 'archive-fixture-requester' }, reviewer = { ...scope, principalId: 'archive-fixture-reviewer' };
      const application = await access.requestEvidenceAccess(requester, first.object.id, { purpose: 'INCIDENT_INVESTIGATION', reason: 'investigate the isolated archive fixture' }, 'ARCHIVED_CONTENT');
      await assert.rejects(access.reviewContentAccessRequest(requester, application.id, { action: 'approve', reason: 'self approval forbidden' }), /requester cannot/);
      await access.reviewContentAccessRequest(reviewer, application.id, { action: 'approve', reason: 'approved isolated fixture investigation' });
      await assert.rejects(consumeArchivedContentAccess(reviewer, first.object.id, application.id, store), /GRANT_NOT_AVAILABLE/);
      store.failReads = true; await assert.rejects(consumeArchivedContentAccess(requester, first.object.id, application.id, store), /READ_FAILURE/); store.failReads = false;
      assert.equal((await db.select().from(s.contentAccessRequests).where(eq(s.contentAccessRequests.id, application.id)))[0].usedAt, null);
      const result = await consumeArchivedContentAccess(requester, first.object.id, application.id, store); assert.deepEqual(JSON.parse(result.answerEvidence), content);
      await assert.rejects(consumeArchivedContentAccess(requester, first.object.id, application.id, store), /GRANT_NOT_AVAILABLE/);
    });
    await test('180-day metadata and message cursors reveal no plaintext and cannot cross application scope', async () => {
      const next = await fixtureRequest();
      for (let sequence = 0; sequence < 3; sequence++) await service.writeArchiveContent(scope, { requestId: next.request.id, purpose: 'MODEL_OUTPUT', sequence, representation: 'SSE_EVENT', data: { data: 'private archived event' } }, store);
      const base = archiveQuerySchema.parse({ requestId: next.request.id, limit: 2 });
      const listing = await query.listConversationArchives(scope, base); assert.equal(listing.items.length, 1); assert.ok(!JSON.stringify(listing).includes('private'));
      const messages = await query.listArchivedMessages(scope, next.request.id, base); assert.equal(messages.hasMore, true); assert.ok(messages.nextCursor); assert.ok(!JSON.stringify(messages).includes('private'));
      const second = await query.listArchivedMessages(scope, next.request.id, { ...base, cursor: messages.nextCursor });
      assert.equal(new Set([...messages.items, ...second.items].map(item => item.id)).size, 4);
      await assert.rejects(query.listArchivedMessages({ ...scope, applicationId: randomUUID() }, next.request.id, { ...base, cursor: messages.nextCursor }), /TRACE_CURSOR_INVALID/);
    });
    await test('expiry deletion honors holds, deletes exact versions, and preserves a backup-pending proof', async () => {
      const [archive] = await db.select().from(s.conversationArchives).where(eq(s.conversationArchives.requestId, first.request.id));
      const future = new Date(archive.expiresAt.getTime() + 1000), holdUntil = new Date(future.getTime() + 86400000).toISOString();
      await retention.setGatewayContentHold(scope, 'archive-fixture-operator', { requestId: first.request.id, expectedVersion: 2, holdUntil, reason: 'protect retained fixture during expiry simulation' });
      assert.equal(await archiveRetention.deleteExpiredConversationArchive(scope, first.request.id, store, future), null);
      await retention.setGatewayContentHold(scope, 'archive-fixture-operator', { requestId: first.request.id, expectedVersion: 3, holdUntil: null, reason: 'release isolated archive retention hold' });
      const deleted = await archiveRetention.deleteExpiredConversationArchive(scope, first.request.id, store, future);
      assert.ok(deleted?.deletionProofId); assert.equal(deleted.backupStatus, 'PENDING_EXTERNAL'); assert.equal(store.objects.has(first.object.objectKey), false);
      await assert.rejects(service.readArchivedContent(scope, first.object.id, store), /NOT_COMMITTED/);
      assert.equal((await db.select().from(s.conversationArchives).where(eq(s.conversationArchives.requestId, first.request.id)))[0].state, 'DELETED');
    });
    await test('stored-version failure creates a system alert and recovers only after a successful reread', async () => {
      const fresh = await fixtureRequest(); await service.publishArchiveContent(scope, fresh.object.id, store);
      await db.update(s.gatewayRequests).set({ state: 'TERMINATED', sessionFinalized: true }).where(eq(s.gatewayRequests.id, fresh.request.id));
      assert.equal((await service.reconcileConversationArchive(scope, fresh.request.id))?.state, 'COMMITTED');
      store.failReads = true;
      const failed = await service.verifyArchiveStoredObjects(10, store, fresh.request.id); assert.equal(failed.failed, 1);
      assert.equal((await service.reconcileConversationArchive(scope, fresh.request.id))?.state, 'GAPPED');
      const records = await db.select().from(s.decisionRecordOutbox).where(and(eq(s.decisionRecordOutbox.tenantId, scope.tenantId), eq(s.decisionRecordOutbox.applicationId, scope.applicationId), sql`${s.decisionRecordOutbox.payload}->>'requestId' = ${fresh.request.id}`));
      assert.equal(records.filter(record => record.payload.requestId === fresh.request.id && record.payload.stage === 'ARCHIVE_RECONCILIATION').length, 1);
      store.failReads = false;
      await db.update(s.archivedContentObjects).set({ retryAt: new Date(0) }).where(eq(s.archivedContentObjects.id, fresh.object.id));
      assert.equal((await service.verifyArchiveStoredObjects(10, store, fresh.request.id)).verified, 1);
      assert.equal((await service.reconcileConversationArchive(scope, fresh.request.id))?.state, 'COMMITTED');
    });
  } finally {
    await closeDatabaseConnection(); await client.end();
    writeFileSync(path.resolve('.artifact-build/v11-all-20260908/p3-integration.json'), JSON.stringify({ capturedAt: new Date().toISOString(), results, passed: results.length,
      isolatedDatabase: true, objectStore: 'IN_MEMORY_FAULT_INJECTION', realS3Acceptance: false }, null, 2));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Archive integration failed'); process.exitCode = 1; });
