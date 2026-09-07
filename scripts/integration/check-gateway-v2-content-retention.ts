import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
async function main() {
  const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string, string> = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
  const fixture: { tenantId: string; applicationId: string } = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
  const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId };
  const url = new URL(environment.PGDATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.port !== '55447' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
  environment.DELETION_PROOF_HMAC_KEY ??= randomBytes(32).toString('hex'); environment.DELETION_PROOF_HMAC_KEY_ID = 'isolated-retention-v2';
  writeFileSync(path.join(directory, 'environment.json'), JSON.stringify(environment, null, 2));
  Object.assign(process.env, environment, { GATEWAY_CONTENT_RETENTION_HOURS: '168' });
  const client = new pg.Client({ connectionString: environment.PGDATABASE_URL, ssl: false }); await client.connect();
  try { for (let i = 0; i < 2; i++) { await client.query('BEGIN'); await client.query(readFileSync('drizzle/0055_gateway_content_retention.sql', 'utf8')); await client.query('COMMIT'); } }
  finally { await client.end(); }
  const [{ db, closeDatabaseConnection }, s, retention, { scopePredicate }, lineage] = await Promise.all([
    import('../../src/storage/database/shared/db'), import('../../src/storage/database/shared/schema'), import('../../src/lib/gateway-runtime/content-retention'),
    import('../../src/lib/tenancy'), import('../../src/lib/data-protection/lineage'),
  ]);
  const createdIds: string[] = [];
  const now = new Date(), results: { name: string; status: string }[] = [];
  async function test(name: string, run: () => Promise<void>) { await run(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  const [base] = await db.select().from(s.gatewayRequests).where(and(scopePredicate(s.gatewayRequests, scope), sql`${s.gatewayRequests.sessionSnapshot} IS NOT NULL`)).limit(1);
  const [baseStep] = await db.select().from(s.gatewaySteps).where(and(scopePredicate(s.gatewaySteps, scope), sql`${s.gatewaySteps.decisionEnvelope} IS NOT NULL`)).limit(1);
  assert.ok(base && baseStep, 'Run gateway E2E first');
  async function create(overrides: Partial<typeof s.gatewayRequests.$inferInsert> = {}, stepStatus = 'SUCCEEDED') {
    const id = randomUUID();
    await db.insert(s.gatewayRequests).values({ ...base, id, idempotencyKey: id, consoleAssertionHmac: null, sessionId: null, sessionFinalized: true, state: 'COMPLETED',
      contentHoldUntil: null, contentHoldReasonHmac: null, retentionVersion: 0, contentPurgedAt: null, deletionProofId: null,
      expiresAt: new Date(now.getTime() - 9 * 86400000), ...overrides });
    createdIds.push(id); const stepId = randomUUID(); await db.insert(s.gatewaySteps).values({ ...baseStep, id: stepId, requestId: id, status: stepStatus });
    return { id, stepId };
  }
  try {
    const held = await create(), running = await create({}, 'RUNNING'), pending = await create({ sessionFinalized: false }), recent = await create({ expiresAt: now });
    await test('scope and CAS protect legal holds and stale modifications cannot release them', async () => {
      await assert.rejects(retention.setGatewayContentHold({ tenantId: scope.tenantId, applicationId: randomUUID() }, 'reviewer-a', { requestId: held.id, expectedVersion: 0, holdUntil: null, reason: 'unit scope test' }), /REQUEST_NOT_FOUND/);
      const changed = await retention.setGatewayContentHold(scope, 'reviewer-a', { requestId: held.id, expectedVersion: 0, holdUntil: new Date(now.getTime() + 86400000).toISOString(), reason: 'Isolated retention hold' });
      assert.equal(changed.version, 1);
      await assert.rejects(retention.setGatewayContentHold(scope, 'reviewer-b', { requestId: held.id, expectedVersion: 0, holdUntil: null, reason: 'stale test' }), /VERSION_CONFLICT/);
    });
    const first = await create(); let proofId = '';
    await test('purge clears expired encrypted content and signs its exact deletion manifest', async () => {
      const result = await retention.purgeGatewayContent(scope, now, 1); assert.ok(result); assert.equal(result.requests, 1); proofId = result.deletionProofId;
      const read = await retention.readGatewayContentRetention(scope, first.id); assert.ok(read?.contentPurgedAt && read.proof);
      assert.ok(!JSON.stringify(read.proof).includes('apiKey')); assert.ok(!JSON.stringify(read.proof).includes('credentialId')); assert.equal(read.deletionProofId, proofId); assert.equal(read.proof.phases.backup.state, 'PENDING_EXTERNAL');
      const [row] = await db.select().from(s.gatewayRequests).where(eq(s.gatewayRequests.id, first.id)); assert.equal(row.sessionSnapshot, null);
      const [step] = await db.select().from(s.gatewaySteps).where(eq(s.gatewaySteps.id, first.stepId)); assert.equal(step.decisionEnvelope, null); assert.equal(step.inputHmac, baseStep.inputHmac);
      assert.equal(lineage.verifyDeletionProof({ ...read.proof, version: '1.0', cutoff: read.proof.cutoff.toISOString(), completedAt: read.proof.completedAt.toISOString() }), true);
    });
    await test('hold, unfinished session, running check and unexpired requests remain intact', async () => {
      await (await import('../../src/lib/gateway-runtime/events')).reconcileExpiredGatewayRequests();
      assert.equal(await retention.purgeGatewayContent(scope, now), null);
      for (const item of [held, running, pending, recent]) { const value = await retention.readGatewayContentRetention(scope, item.id); assert.equal(value?.contentPurgedAt, null); const [row] = await db.select().from(s.gatewayRequests).where(eq(s.gatewayRequests.id, item.id)); assert.ok(row.sessionSnapshot); }
      assert.equal(await retention.readGatewayContentRetention({ tenantId: scope.tenantId, applicationId: randomUUID() }, first.id), null);
    });
    await test('purged content cannot be restored and its idempotency tombstone still conflicts', async () => {
      await assert.rejects(db.update(s.gatewayRequests).set({ sessionSnapshot: base.sessionSnapshot }).where(eq(s.gatewayRequests.id, first.id)));
      await assert.rejects(db.update(s.gatewaySteps).set({ decisionEnvelope: baseStep.decisionEnvelope }).where(eq(s.gatewaySteps.id, first.stepId)));
      await assert.rejects(retention.setGatewayContentHold(scope, 'reviewer', { requestId: first.id, expectedVersion: 1, holdUntil: null, reason: 'too late' }), /ALREADY_PURGED/);
      await assert.rejects(create({ idempotencyKey: first.id }));
    });
    const rollback = await create();
    await test('failure to persist the audit anchor rolls back content deletion and proof together', async () => {
      await db.execute(sql`CREATE OR REPLACE FUNCTION isolated_gateway_retention_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='gateway.content.purged' THEN RAISE EXCEPTION 'isolated retention audit fault'; END IF; RETURN NEW; END $$`);
      await db.execute(sql`CREATE TRIGGER isolated_gateway_retention_failure BEFORE INSERT ON security_audit_events FOR EACH ROW EXECUTE FUNCTION isolated_gateway_retention_failure()`);
      try {
        await assert.rejects(retention.purgeGatewayContent(scope, now));
        const [row] = await db.select().from(s.gatewayRequests).where(eq(s.gatewayRequests.id, rollback.id)); assert.equal(row.contentPurgedAt, null); assert.ok(row.sessionSnapshot);
        const [step] = await db.select().from(s.gatewaySteps).where(eq(s.gatewaySteps.id, rollback.stepId)); assert.ok(step.decisionEnvelope);
      } finally { await db.execute(sql`DROP TRIGGER isolated_gateway_retention_failure ON security_audit_events`); await db.execute(sql`DROP FUNCTION isolated_gateway_retention_failure()`); }
    });
    await test('concurrent purges claim once and explicit hold release makes only that request eligible', async () => {
      const results = await Promise.all([retention.purgeGatewayContent(scope, now), retention.purgeGatewayContent(scope, now)]);
      assert.equal(results.filter(Boolean).length, 1); assert.equal(results.find(Boolean)?.requests, 1);
      await retention.setGatewayContentHold(scope, 'reviewer-b', { requestId: held.id, expectedVersion: 1, holdUntil: null, reason: 'End isolated hold' });
      const result = await retention.purgeGatewayContent(scope, now); assert.equal(result?.requests, 1); assert.equal(await retention.purgeGatewayContent(scope, now), null);
    });
  } finally {
    for (const id of createdIds) {
      await db.update(s.gatewaySteps).set({ status: 'FAILED' }).where(and(eq(s.gatewaySteps.requestId, id), eq(s.gatewaySteps.status, 'RUNNING')));
      await db.update(s.gatewayRequests).set({ state: 'TERMINATED', sessionFinalized: true, contentHoldUntil: new Date(now.getTime() + 86400000) }).where(and(eq(s.gatewayRequests.id, id), sql`${s.gatewayRequests.contentPurgedAt} IS NULL`));
    }
    await closeDatabaseConnection(); writeFileSync(path.join(directory, 'content-retention-evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), status: results.length === 6 ? 'PASS' : 'FAIL',
      migrationAppliedTwice: true, scope: 'isolated gateway database content; backup and original artifacts remain separate', results }, null, 2));
  }
}
main().catch(error => { console.error('GATEWAY_RETENTION_TEST_FAILED', error instanceof Error ? error.message : 'UNKNOWN'); process.exitCode = 1; });
