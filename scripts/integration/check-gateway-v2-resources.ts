import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';

async function main() {
  const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string, string> = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
  const fixture: { tenantId: string; applicationId: string } = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
  const url = new URL(environment.PGDATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.port !== '55447' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env, environment, { GATEWAY_BUSINESS_REQUESTS_PER_MINUTE: '100000', GATEWAY_BUSINESS_CONCURRENCY: '128', GATEWAY_RESERVED_CHARS_PER_APPLICATION: '50331648' });
  const [{ db, closeDatabaseConnection }, s, resource, { scopePredicate }, { evidenceHmac }, { canonicalJson }, { DEFAULT_GATEWAY_BUDGETS }] = await Promise.all([
    import('../../src/storage/database/shared/db'), import('../../src/storage/database/shared/schema'), import('../../src/lib/gateway-runtime/resources'), import('../../src/lib/tenancy'),
    import('../../src/lib/gateway-runtime/security'), import('../../src/lib/gateway-runtime/protocol'), import('../../src/lib/gateway-runtime/snapshot-factory'),
  ]);
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId }, results: { name: string; status: string }[] = [], retained: string[] = [];
  const [base] = await db.select().from(s.gatewayRequests).where(and(scopePredicate(s.gatewayRequests, scope), eq(s.gatewayRequests.state, 'COMPLETED'))).limit(1); assert.ok(base);
  const rollback = new Error('ISOLATED_TEST_ROLLBACK');
  async function test(name: string, run: () => Promise<void>) { await run(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  async function transaction(run: (tx: Tx) => Promise<void>) { await assert.rejects(db.transaction(async tx => { await run(tx); throw rollback; }), error => error === rollback); }
  async function claim(tx: Tx, id = randomUUID(), key = id) {
    await tx.insert(s.gatewayRequests).values({ ...base, id, idempotencyKey: key, state: 'AUTHORIZED', preparationState: 'PREPARING', sessionId: null, sessionFinalized: false, lastEventSeq: 0, stepCount: 0,
      consoleAssertionHmac: null, contentPurgedAt: null, deletionProofId: null, sessionSnapshot: null, responseRef: null, contentHoldUntil: null, expiresAt: new Date(Date.now() + 60000), createdAt: new Date() });
    await resource.admitGatewayResources(tx, { ...scope, requestId: id, snapshotId: base.snapshotId, budgets: DEFAULT_GATEWAY_BUDGETS, expiresAt: Date.now() + 60000, references: 28 });
    return id;
  }
  async function row(tx: Tx, id: string) { return (await tx.select().from(s.gatewayRequestResources).where(eq(s.gatewayRequestResources.requestId, id)))[0]; }
  try {
    await test('admission and measurements bind the request; terminal settlement is exactly once', () => transaction(async tx => {
      const id = await claim(tx); await resource.preparedGatewayResources(tx, scope, id, 14, 2);
      await resource.measureGatewayInspection(tx, scope, id, 14); await resource.measureGatewayInspection(tx, scope, id, 8);
      await resource.settleGatewayResources(tx, scope, id, 'TERMINATED'); const first = await row(tx, id);
      assert.equal(first.state, 'SETTLED'); assert.equal(first.inspectedChars, 22); assert.equal(first.inspectionSteps, 2);
      assert.equal(first.admissionHmac, evidenceHmac(canonicalJson(first.admission))); assert.equal(first.settlementHmac, evidenceHmac(canonicalJson(first.settlement)));
      assert.deepEqual((first.settlement?.released as Record<string, unknown>).outputChars, 262144);
      await resource.settleGatewayResources(tx, scope, id, 'TERMINATED'); assert.deepEqual(await row(tx, id), first);
      await assert.rejects(resource.measureGatewayInspection(tx, scope, id, 1), /RESOURCE_RESERVATION_CLOSED/);
    }));
    await test('reference, content and internal step limits fail closed', () => transaction(async tx => {
      const id = await claim(tx);
      await assert.rejects(resource.preparedGatewayResources(tx, scope, id, 131073, 1), /PREPARED_RESOURCE_BUDGET_EXCEEDED/);
      await assert.rejects(resource.preparedGatewayResources(tx, scope, id, 1, 29), /PREPARED_RESOURCE_BUDGET_EXCEEDED/);
      await tx.update(s.gatewayRequestResources).set({ inspectionSteps: 512 }).where(eq(s.gatewayRequestResources.requestId, id));
      await assert.rejects(resource.measureGatewayInspection(tx, scope, id, 1), /INTERNAL_STEP_BUDGET_EXCEEDED/);
    }));
    await test('rate rejection rolls back the business claim and reservation', async () => {
      const id = randomUUID(); process.env.GATEWAY_BUSINESS_REQUESTS_PER_MINUTE = '1';
      await assert.rejects(db.transaction(async tx => {
        const start = new Date(Math.floor(Date.now() / 60000) * 60000);
        await tx.insert(s.gatewayAdmissionWindows).values({ ...scope, windowStart: start, admitted: 1 }).onConflictDoUpdate({ target: [s.gatewayAdmissionWindows.tenantId, s.gatewayAdmissionWindows.applicationId, s.gatewayAdmissionWindows.windowStart], set: { admitted: 1 } });
        await claim(tx, id);
      }), /BUSINESS_REQUEST_RATE_EXCEEDED/);
      assert.equal((await db.select().from(s.gatewayRequests).where(eq(s.gatewayRequests.id, id))).length, 0);
      process.env.GATEWAY_BUSINESS_REQUESTS_PER_MINUTE = '100000';
    });
    await test('capacity rejection is atomic and database unavailability never admits', async () => {
      const id = randomUUID(); process.env.GATEWAY_RESERVED_CHARS_PER_APPLICATION = '1';
      await assert.rejects(db.transaction(tx => claim(tx, id)), /BUSINESS_RESOURCE_CAPACITY_EXCEEDED/);
      assert.equal((await db.select().from(s.gatewayRequestResources).where(eq(s.gatewayRequestResources.requestId, id))).length, 0);
      process.env.GATEWAY_RESERVED_CHARS_PER_APPLICATION = '50331648';
      await assert.rejects(db.transaction(async tx => { await tx.execute(sql`SET LOCAL statement_timeout = '1ms'`); await tx.execute(sql`SELECT pg_sleep(0.1)`); await claim(tx, id); }));
      assert.equal((await db.select().from(s.gatewayRequests).where(eq(s.gatewayRequests.id, id))).length, 0);
    });
    await test('concurrent admissions cannot exceed one application slot', async () => {
      process.env.GATEWAY_BUSINESS_CONCURRENCY = '1';
      const claims = await Promise.allSettled([0, 1, 2].map(async () => { const id = randomUUID(); await db.transaction(tx => claim(tx, id)); retained.push(id); return id; }));
      assert.equal(claims.filter(value => value.status === 'fulfilled').length, 1);
      assert.equal(claims.filter(value => value.status === 'rejected' && String(value.reason).includes('BUSINESS_CONCURRENCY_EXCEEDED')).length, 2);
      await db.transaction(async tx => { await tx.update(s.gatewayRequests).set({ state: 'TERMINATED', sessionFinalized: true }).where(eq(s.gatewayRequests.id, retained[0])); await resource.settleGatewayResources(tx, scope, retained[0], 'TERMINATED'); });
      await transaction(async tx => { await claim(tx); });
      process.env.GATEWAY_BUSINESS_CONCURRENCY = '128';
    });
    await test('ambiguous model outcome is preserved and finalized evidence cannot be changed', () => transaction(async tx => {
      const id = await claim(tx);
      await resource.settleGatewayResources(tx, scope, id, 'UPSTREAM_OUTCOME_UNKNOWN'); const settled = await row(tx, id);
      assert.equal(settled.state, 'UNKNOWN'); assert.equal(settled.settlement?.modelOutcome, 'UNKNOWN');
      await tx.execute(sql`SAVEPOINT immutable_test`);
      await assert.rejects(tx.update(s.gatewayRequestResources).set({ inspectedChars: 1 }).where(eq(s.gatewayRequestResources.requestId, id)));
      await tx.execute(sql`ROLLBACK TO SAVEPOINT immutable_test`);
      assert.equal((await row(tx, id)).inspectedChars, 0);
    }));
    await test('cross-application measurements cannot access another reservation', () => transaction(async tx => {
      const id = await claim(tx);
      await assert.rejects(resource.preparedGatewayResources(tx, { ...scope, applicationId: randomUUID() }, id, 1, 0), /REQUEST_PREPARATION_CLOSED/);
      assert.equal((await row(tx, id)).preparedInputChars, null);
    }));
  } finally {
    for (const id of retained) await db.update(s.gatewayRequests).set({ state: 'TERMINATED', sessionFinalized: true }).where(eq(s.gatewayRequests.id, id));
    await closeDatabaseConnection();
    writeFileSync(path.join(directory, 'resource-admission-evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), status: results.length === 7 ? 'PASS' : 'FAIL', isolatedDatabase: true, productionAcceptance: false, results }, null, 2));
  }
}
main().catch(() => { console.error('GATEWAY_RESOURCE_INTEGRATION_FAILED'); process.exitCode = 1; });
