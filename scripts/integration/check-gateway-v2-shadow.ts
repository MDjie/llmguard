import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';

async function main() {
  const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string, string> = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
  const fixture: { tenantId: string; applicationId: string; apiKey: string } = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
  const url = new URL(environment.PGDATABASE_URL); if (url.hostname !== '127.0.0.1' || url.port !== '55447' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env, environment);
  const [{ db, closeDatabaseConnection }, s, shadow, { scopePredicate }, { evidenceHmac }, { canonicalJson }] = await Promise.all([
    import('../../src/storage/database/shared/db'), import('../../src/storage/database/shared/schema'), import('../../src/lib/gateway-runtime/shadow'), import('../../src/lib/tenancy'),
    import('../../src/lib/gateway-runtime/security'), import('../../src/lib/gateway-runtime/protocol'),
  ]);
  const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId }, results: { name: string; status: string }[] = [];
  const tls = { ca: readFileSync(path.join(directory, 'tls/ca.crt')), cert: readFileSync(path.join(directory, 'tls/client.crt')), key: readFileSync(path.join(directory, 'tls/client.key')) };
  async function test(name: string, run: () => Promise<void>) { await run(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  async function modelCount(): Promise<number> { return new Promise((resolve, reject) => { https.get('https://127.0.0.1:58088/test/calls', { ...tls, signal: AbortSignal.timeout(5000) }, response => { const chunks: Buffer[] = []; response.on('data', (value: Buffer) => chunks.push(value)); response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).length)); response.on('error', reject); }).on('error', reject); }); }
  async function actualRequest() {
    const id = randomUUID(), body = JSON.stringify({ model: 'test', stream: false, messages: [{ role: 'user', content: 'SHADOW_READ_ONLY ' + id }] });
    const status = await new Promise<number>((resolve, reject) => { const request = https.request('https://127.0.0.1:58087/v1/chat/completions', { ...tls, method: 'POST', signal: AbortSignal.timeout(65000),
      headers: { authorization: 'Bearer ' + fixture.apiKey, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-request-id': id, 'idempotency-key': id } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); response.on('error', reject); }); request.on('error', reject); request.end(body); });
    assert.equal(status, 200);
    for (let i = 0; i < 50; i++) { const [row] = await db.select().from(s.gatewayRequests).where(eq(s.gatewayRequests.id, id)); if (row.sessionFinalized) return row; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('ISOLATED_PRIMARY_FINALIZATION_TIMEOUT');
  }
  try {
    const request = await actualRequest();
    const steps = await db.select().from(s.gatewaySteps).where(eq(s.gatewaySteps.requestId, request.id));
    const primaryBefore = canonicalJson(steps.map(step => ({ id: step.id, decision: step.decisionId, action: step.action, envelope: step.decisionEnvelope })));
    const eventsBefore = (await db.select().from(s.gatewayExecutionEvents).where(eq(s.gatewayExecutionEvents.requestId, request.id))).length, callsBefore = await modelCount();
    // This module test deliberately compares the approved bundle against itself; it is not a model-quality experiment.
    await db.update(s.gatewayRequests).set({ shadowSnapshotId: request.snapshotId }).where(eq(s.gatewayRequests.id, request.id));
    await test('bounded source references queue input and complete output once, never streaming slices', async () => {
      await db.transaction(async tx => { for (const step of steps) { await shadow.queueGatewayShadow(tx, scope, request.id, step.id, step.stage, request.snapshotId); await shadow.queueGatewayShadow(tx, scope, request.id, step.id, step.stage, request.snapshotId); await shadow.queueGatewayShadow(tx, scope, request.id, step.id, 'OUTPUT_CHUNK', request.snapshotId); } });
      const rows = await db.select().from(s.gatewayShadowEvaluations).where(eq(s.gatewayShadowEvaluations.requestId, request.id)); assert.equal(rows.length, 2); assert.ok(rows.every(row => row.state === 'PENDING'));
    });
    await test('parallel detector workers claim once and preserve business calls, decisions and events', async () => {
      const processed = await Promise.all([shadow.runGatewayShadow(scope), shadow.runGatewayShadow(scope), shadow.runGatewayShadow(scope), shadow.runGatewayShadow(scope)]);
      assert.equal(processed.filter(Boolean).length, 2);
      const rows = await db.select().from(s.gatewayShadowEvaluations).where(eq(s.gatewayShadowEvaluations.requestId, request.id));
      assert.deepEqual(rows.map(row => ({ state: row.state, reason: row.reasonCode })), rows.map(() => ({ state: 'SUCCEEDED', reason: 'SHADOW_COMPARISON_RECORDED' })));
      for (const row of rows) { assert.equal(row.coverage, 'COMPLETE'); assert.equal(row.evidenceHmac, evidenceHmac(canonicalJson(row.evidence))); assert.ok(row.auditEventId); }
      assert.equal(await modelCount(), callsBefore);
      const after = await db.select().from(s.gatewaySteps).where(eq(s.gatewaySteps.requestId, request.id)); assert.equal(canonicalJson(after.map(step => ({ id: step.id, decision: step.decisionId, action: step.action, envelope: step.decisionEnvelope }))), primaryBefore);
      assert.equal((await db.select().from(s.gatewayExecutionEvents).where(eq(s.gatewayExecutionEvents.requestId, request.id))).length, eventsBefore);
    });
    await test('expired authorization is skipped instead of generating a fresh privilege', async () => {
      const fresh = await actualRequest(), [input] = await db.select().from(s.gatewaySteps).where(and(eq(s.gatewaySteps.requestId, fresh.id), eq(s.gatewaySteps.stage, 'INPUT')));
      await db.update(s.gatewayRequests).set({ shadowSnapshotId: fresh.snapshotId, expiresAt: new Date(Date.now() - 1000) }).where(eq(s.gatewayRequests.id, fresh.id));
      await db.transaction(tx => shadow.queueGatewayShadow(tx, scope, fresh.id, input.id, 'INPUT', fresh.snapshotId));
      assert.equal((await shadow.runGatewayShadow(scope))?.state, 'SKIPPED');
    });
    await test('interrupted detector work is recorded UNKNOWN without rerunning detectors', async () => {
      const fresh = await actualRequest(), [input] = await db.select().from(s.gatewaySteps).where(and(eq(s.gatewaySteps.requestId, fresh.id), eq(s.gatewaySteps.stage, 'INPUT')));
      await db.transaction(tx => shadow.queueGatewayShadow(tx, scope, fresh.id, input.id, 'INPUT', fresh.snapshotId));
      await db.update(s.gatewayShadowEvaluations).set({ state: 'RUNNING', claimedAt: new Date(Date.now() - 31000) }).where(eq(s.gatewayShadowEvaluations.requestId, fresh.id));
      const count = await modelCount(); assert.equal((await shadow.runGatewayShadow(scope))?.state, 'FAILED'); assert.equal(await modelCount(), count);
      const [row] = await db.select().from(s.gatewayShadowEvaluations).where(eq(s.gatewayShadowEvaluations.requestId, fresh.id)); assert.equal(row.reasonCode, 'SHADOW_PREVIOUS_OUTCOME_UNKNOWN');
    });
    await test('opt-in authorization freezes the approved shadow snapshot and actual input evaluation queues it', async () => {
      const [{ NextRequest }, authorization, evaluation, events, policy, { extractSegments, sha256 }] = await Promise.all([
        import('next/server'), import('../../src/lib/gateway-runtime/authorization'), import('../../src/lib/gateway-runtime/evaluation'), import('../../src/lib/gateway-runtime/events'),
        import('../../src/lib/policy-bundle/service'), import('../../src/lib/gateway-runtime/protocol'),
      ]);
      const [binding] = await db.select().from(s.applicationPolicyBindings).where(scopePredicate(s.applicationPolicyBindings, scope));
      assert.equal(binding.shadowBundleId, null, 'Run without another active shadow campaign');
      const [base] = await db.select().from(s.policyBundles).where(eq(s.policyBundles.id, binding.activeBundleId!));
      const [maximum] = await db.select({ version: sql<number>`max(${s.policyBundles.version})::int` }).from(s.policyBundles).where(eq(s.policyBundles.policyId, base.policyId));
      const bundleId = randomUUID(); await db.insert(s.policyBundles).values({ ...base, id: bundleId, version: maximum.version + 1, state: 'approved', lifecycleVersion: 1, createdAt: new Date(), createdBy: 'isolated-shadow-author' });
      let auth: Awaited<ReturnType<typeof authorization.authorizeGateway>> | undefined;
      try {
        await policy.transitionPolicyBundle(scope, bundleId, 'isolated-shadow-operator', 'shadow', { expectedVersion: 1, reason: 'Isolated shadow wiring verification' });
        const [approved] = await db.select().from(s.applicationPolicyBindings).where(scopePredicate(s.applicationPolicyBindings, scope)); assert.ok(approved.shadowSnapshotId);
        process.env.GATEWAY_SHADOW_EVALUATION_ENABLED = 'true';
        const id = randomUUID(), body = { model: 'test', stream: false, messages: [{ role: 'user', content: 'Shadow automatic queue engineering example' }] }, deadline = Date.now() + 59000;
        auth = await authorization.authorizeGateway({ contractVersion: '2.0', businessRequestId: id, traceId: id, idempotencyKey: id, requestDigest: sha256(canonicalJson(body)), requestJson: canonicalJson(body), modelRoute: 'test', deadline }, new NextRequest('https://isolated.internal/authorize', { headers: { 'x-guard-api-key': fixture.apiKey } }));
        const [claimed] = await db.select().from(s.gatewayRequests).where(eq(s.gatewayRequests.id, id)); assert.equal(claimed.shadowSnapshotId, approved.shadowSnapshotId);
        const stepId = randomUUID(); await evaluation.evaluateGateway({ contractVersion: '2.0', businessRequestId: id, traceId: id, stepId, stage: 'INPUT', streamSeq: 0, attemptKind: 'INITIAL', snapshotId: auth.snapshot.id, auth: auth.auth, deadline, segments: extractSegments(body, 'INPUT', 131072) }, new AbortController().signal);
        const [queued] = await db.select().from(s.gatewayShadowEvaluations).where(eq(s.gatewayShadowEvaluations.stepId, stepId)); assert.equal(queued.snapshotId, approved.shadowSnapshotId); assert.equal(queued.state, 'PENDING');
        assert.equal((await shadow.runGatewayShadow(scope))?.state, 'SUCCEEDED');
      } finally {
        delete process.env.GATEWAY_SHADOW_EVALUATION_ENABLED;
        if (auth) await events.recordGatewayEvents({ contractVersion: '2.0', auth: auth.auth, events: [{ eventSeq: 1, kind: 'TERMINATED', snapshotId: auth.snapshot.id, reasonCode: 'ISOLATED_SHADOW_TEST_FINISHED' }] });
        const [bundle] = await db.select().from(s.policyBundles).where(eq(s.policyBundles.id, bundleId));
        if (bundle.state === 'shadow') await policy.transitionPolicyBundle(scope, bundleId, 'isolated-shadow-operator', 'withdraw', { expectedVersion: bundle.lifecycleVersion, reason: 'Isolated shadow wiring verification complete' });
      }
    });
    await test('completed evidence is immutable and another application cannot claim it', async () => {
      await assert.rejects(db.transaction(tx => tx.execute(sql`UPDATE gateway_shadow_evaluations SET action = 'ALLOW' WHERE request_id = ${request.id}`)));
      assert.equal(await shadow.runGatewayShadow({ ...scope, applicationId: randomUUID() }), null);
      assert.equal((await db.select().from(s.gatewayShadowEvaluations).where(scopePredicate(s.gatewayShadowEvaluations, scope))).filter(row => row.state === 'PENDING').length, 0);
    });
  } finally {
    await closeDatabaseConnection(); writeFileSync(path.join(directory, 'shadow-evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), status: results.length === 6 ? 'PASS' : 'FAIL', isolatedDatabase: true, primaryGatewayReal: true, comparison: 'same approved fixture policy; engine lifecycle only', independentQualityAcceptance: false, results }, null, 2));
  }
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : 'GATEWAY_SHADOW_INTEGRATION_FAILED'); process.exitCode = 1; });
