import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
async function main() {
  const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string, string> = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
  const fixture: { tenantId: string; applicationId: string; apiKey: string } = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
  const url = new URL(environment.PGDATABASE_URL); if (url.hostname !== '127.0.0.1' || url.port !== '55447' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
  const qualificationFile = path.resolve(environment.GATEWAY_STREAM_QUALIFICATIONS_FILE);
  if (path.dirname(qualificationFile) !== directory) throw new Error('ISOLATED_QUALIFICATION_FILE_REQUIRED');
  const originalQualifications = readFileSync(qualificationFile, 'utf8');
  Object.assign(process.env, environment, { GATEWAY_V2_ENABLED: 'true', AUDIT_EXPORT_SYSLOG_HOST: '127.0.0.1', AUDIT_EXPORT_SYSLOG_PORT: '16515', AUDIT_EXPORT_SYSLOG_PROTOCOL: 'tls', AUDIT_EXPORT_EVENT_PREFIXES: 'gateway.runtime.', AUDIT_EXPORT_OUTCOMES: '' });
  const [{ db, closeDatabaseConnection }, s, publication, policy, { scopePredicate }, security, { canonicalJson, sha256 }] = await Promise.all([
    import('../../src/storage/database/shared/db'), import('../../src/storage/database/shared/schema'), import('../../src/lib/gateway-runtime/publication'),
    import('../../src/lib/policy-bundle/service'), import('../../src/lib/tenancy'), import('../../src/lib/gateway-runtime/security'), import('../../src/lib/gateway-runtime/protocol'),
  ]);
  const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId }, results: { name: string; status: string }[] = [];
  async function binding() { return (await db.select().from(s.applicationPolicyBindings).where(scopePredicate(s.applicationPolicyBindings, scope)))[0]; }
  const original = await binding(); assert.ok(original?.activeBundleId);
  const [baseBundle] = await db.select().from(s.policyBundles).where(eq(s.policyBundles.id, original.activeBundleId));
  const policyStates = await db.select({ id: s.policyBundles.id, state: s.policyBundles.state }).from(s.policyBundles).where(scopePredicate(s.policyBundles, scope));
  const clones: string[] = [];
  async function test(name: string, run: () => Promise<void>) { await run(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  async function snapshotCount() { return Number((await db.select({ count: sql<number>`count(*)::int` }).from(s.gatewayRuntimeSnapshots).where(scopePredicate(s.gatewayRuntimeSnapshots, scope)))[0].count); }
  async function cloneBundle() {
    const id = randomUUID(), [latest] = await db.select({ version: sql<number>`max(${s.policyBundles.version})::int` }).from(s.policyBundles).where(eq(s.policyBundles.policyId, baseBundle.policyId));
    await db.insert(s.policyBundles).values({ ...baseBundle, id, version: latest.version + 1, state: 'approved', lifecycleVersion: 1, createdBy: 'publication-fixture-author', createdAt: new Date() }); clones.push(id); return id;
  }
  async function transition(id: string, action: 'shadow' | 'canary' | 'activate' | 'rollback' | 'withdraw') {
    const [row] = await db.select().from(s.policyBundles).where(eq(s.policyBundles.id, id));
    return policy.transitionPolicyBundle(scope, id, 'publication-fixture-operator', action, { expectedVersion: row.lifecycleVersion, reason: 'Isolated publication lifecycle test', ...(action === 'canary' ? { canaryPercent: 5 } : {}) });
  }
  async function actualRequest() {
    const requestId = randomUUID(), body = JSON.stringify({ model: 'test', stream: false, messages: [{ role: 'user', content: 'Published snapshot engineering request' }] });
    return new Promise<{ status: number; snapshotId: string | string[] | undefined; id: string; errorCode: string }>((resolve, reject) => {
      const request = https.request('https://127.0.0.1:58087/v1/chat/completions', { ca: readFileSync(path.join(directory, 'tls/ca.crt')), cert: readFileSync(path.join(directory, 'tls/client.crt')), key: readFileSync(path.join(directory, 'tls/client.key')),
        method: 'POST', signal: AbortSignal.timeout(65000), headers: { authorization: 'Bearer ' + fixture.apiKey, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-request-id': requestId, 'idempotency-key': requestId } }, response => {
        const chunks: Buffer[] = []; let size = 0; response.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 65536) chunks.push(chunk); }); response.on('error', reject); response.on('end', () => { let code = 'UNSPECIFIED'; try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error && typeof parsed.error === 'object' && 'code' in parsed.error && typeof parsed.error.code === 'string' && /^[A-Z0-9_]+$/.test(parsed.error.code)) code = parsed.error.code; } catch {} resolve({ status: response.statusCode ?? 0, snapshotId: response.headers['x-guard-snapshot-id'], id: requestId, errorCode: code }); });
      }); request.on('error', reject); request.end(body);
    });
  }
  try {
    for (let index = 0; index < 1000; index++) if (!await publication.announceGatewayPublication(scope)) break;
    // Drop invalid historical fixture fallbacks only in this isolated test; preserve monotonic generations on restoration.
    const [maximum] = await db.select({ generation: sql<number>`coalesce(max(${s.gatewayRuntimePublications.bindingGeneration}),0)::int` }).from(s.gatewayRuntimePublications).where(scopePredicate(s.gatewayRuntimePublications, scope));
    await db.update(s.applicationPolicyBindings).set({ generation: Math.max(original.generation, maximum.generation) + 1, previousBundleId: null, canaryBundleId: null, shadowBundleId: null, canaryPercent: 0,
      activeSnapshotId: null, previousSnapshotId: null, canarySnapshotId: null, shadowSnapshotId: null }).where(scopePredicate(s.applicationPolicyBindings, scope));
    await test('refresh binds a full signed snapshot and durable publication in one generation', async () => {
      const before = await binding(); const saved = await publication.refreshGatewayPublication(scope, 'publication-fixture-operator', before.generation); assert.equal(saved.state, 'CONTROL_SAVED');
      const current = await binding(), [message] = await publication.listGatewayPublications(scope, 1);
      assert.equal(current.activeSnapshotId, message.manifest.snapshots.active?.snapshotId); assert.equal(message.generation, current.generation); assert.equal(message.dispatchState, 'PENDING'); assert.equal(message.loadingState, 'AWAITING_LOAD');
      security.verifyPayload('gateway-publication-v1', message.manifest, message.keyId, message.signature); assert.ok(!JSON.stringify(message).includes(fixture.apiKey));
    });
    await test('explicit refresh replaces a revoked WINDOW qualification with a signed FULL_BUFFER snapshot', async () => {
      const before = await binding();
      const [old] = await db.select().from(s.gatewayRuntimeSnapshots).where(eq(s.gatewayRuntimeSnapshots.id, before.activeSnapshotId!));
      assert.equal(old.manifest.streamMode, 'WINDOW');
      try {
        writeFileSync(qualificationFile, '[]');
        await publication.refreshGatewayPublication(scope, 'publication-fixture-operator', before.generation);
        const current = await binding();
        assert.equal(current.generation, before.generation + 1); assert.notEqual(current.activeSnapshotId, before.activeSnapshotId);
        const [row] = await db.select().from(s.gatewayRuntimeSnapshots).where(eq(s.gatewayRuntimeSnapshots.id, current.activeSnapshotId!));
        assert.equal(row.manifest.streamMode, 'FULL_BUFFER'); assert.equal(row.manifest.windowQualified, false);
        assert.equal(row.digest, sha256(canonicalJson(row.manifest)));
        security.verifyPayload('gateway-snapshot-v2', row.manifest, row.keyId, row.signature);
      } finally {
        writeFileSync(qualificationFile, originalQualifications);
        await publication.refreshGatewayPublication(scope, 'publication-fixture-operator', (await binding()).generation);
      }
    });
    await test('automatic renewal cannot recapture a revoked WINDOW qualification or advance its generation', async () => {
      const before = await binding(), count = await snapshotCount();
      try {
        writeFileSync(qualificationFile, '[]');
        await assert.rejects(publication.renewGatewayPublication(scope, before.generation), /STREAM_QUALIFICATION_REVOKED/);
        assert.deepEqual(await binding(), before); assert.equal(await snapshotCount(), count);
      } finally { writeFileSync(qualificationFile, originalQualifications); }
    });
    await test('stale and concurrent publications cannot overwrite a newer binding', async () => {
      const before = await binding(); const outcomes = await Promise.allSettled([publication.refreshGatewayPublication(scope, 'publication-fixture-operator', before.generation), publication.refreshGatewayPublication(scope, 'publication-fixture-operator', before.generation)]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1); assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
      await assert.rejects(publication.refreshGatewayPublication(scope, 'publication-fixture-operator', before.generation), /GENERATION_CONFLICT/);
    });
    await test('outbox insertion failure rolls back both the pointer and signed snapshot', async () => {
      const before = await binding(), count = await snapshotCount();
      await db.execute(sql`CREATE OR REPLACE FUNCTION isolated_publication_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.manifest->>'actorId'='publication-fault' THEN RAISE EXCEPTION 'isolated publication failure'; END IF; RETURN NEW; END $$`);
      await db.execute(sql`CREATE TRIGGER isolated_publication_failure BEFORE INSERT ON gateway_runtime_publications FOR EACH ROW EXECUTE FUNCTION isolated_publication_failure()`);
      try { await assert.rejects(publication.refreshGatewayPublication(scope, 'publication-fault', before.generation)); assert.deepEqual(await binding(), before); assert.equal(await snapshotCount(), count); }
      finally { await db.execute(sql`DROP TRIGGER isolated_publication_failure ON gateway_runtime_publications`); await db.execute(sql`DROP FUNCTION isolated_publication_failure()`); }
    });
    await test('announcement failure leaves a retryable message and does not claim node loading', async () => {
      await db.execute(sql`CREATE OR REPLACE FUNCTION isolated_publication_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='gateway.runtime.publication' THEN RAISE EXCEPTION 'isolated publication audit fault'; END IF; RETURN NEW; END $$`);
      await db.execute(sql`CREATE TRIGGER isolated_publication_audit_failure BEFORE INSERT ON security_audit_events FOR EACH ROW EXECUTE FUNCTION isolated_publication_audit_failure()`);
      try { await assert.rejects(publication.announceGatewayPublication(scope)); const [item] = await publication.listGatewayPublications(scope, 1); assert.equal(item.dispatchState, 'PENDING'); assert.equal(item.loadedNodes, 0); }
      finally { await db.execute(sql`DROP TRIGGER isolated_publication_audit_failure ON security_audit_events`); await db.execute(sql`DROP FUNCTION isolated_publication_audit_failure()`); }
      const announced = await Promise.all([publication.announceGatewayPublication(scope), publication.announceGatewayPublication(scope)]); assert.equal(announced.filter(Boolean).length, 2); assert.notEqual(announced[0]?.id, announced[1]?.id);
    });
    await test('real Java authorization uses the published snapshot and its actual node ACK and request are visible', async () => {
      const before = await binding(), reply = await actualRequest(); assert.equal(reply.status, 200, reply.errorCode); assert.equal(reply.snapshotId, before.activeSnapshotId);
      const [message] = await publication.listGatewayPublications(scope, 1); assert.equal(message.loadedNodes, 1); assert.equal(message.loadingState, 'ALL_TARGETS_LOADED'); assert.ok(message.observedRequests >= 1);
    });
    const candidate = await cloneBundle(); let baselineSnapshot: string | null = null;
    await test('shadow, canary and activation atomically publish their exact role pointers', async () => {
      baselineSnapshot = (await binding()).activeSnapshotId;
      await transition(candidate, 'shadow'); let current = await binding(); assert.ok(current.shadowSnapshotId); assert.equal(current.activeSnapshotId, baselineSnapshot);
      await transition(candidate, 'canary'); current = await binding(); assert.ok(current.canarySnapshotId); assert.equal(current.canaryPercent, 5);
      await transition(candidate, 'activate'); current = await binding(); assert.equal(current.activeBundleId, candidate); assert.equal(current.previousSnapshotId, baselineSnapshot); assert.equal(current.canarySnapshotId, null); assert.equal(current.shadowSnapshotId, null);
      const [message] = await publication.listGatewayPublications(scope, 1); assert.equal(message.manifest.snapshots.active?.snapshotId, current.activeSnapshotId);
    });
    await test('rollback and withdrawal cannot restore an old WINDOW snapshot after qualification revocation', async () => {
      const before = await binding(), count = await snapshotCount();
      const states = await db.select().from(s.policyBundles).where(scopePredicate(s.policyBundles, scope));
      try {
        writeFileSync(qualificationFile, '[]');
        for (const action of ['rollback', 'withdraw'] as const) {
          await assert.rejects(transition(candidate, action), /STREAM_QUALIFICATION_REVOKED/);
          assert.deepEqual(await binding(), before); assert.equal(await snapshotCount(), count);
          const after = await db.select().from(s.policyBundles).where(scopePredicate(s.policyBundles, scope));
          assert.deepEqual(after.sort((a, b) => a.id.localeCompare(b.id)), states.sort((a, b) => a.id.localeCompare(b.id)));
        }
      } finally { writeFileSync(qualificationFile, originalQualifications); }
    });
    await test('rollback restores the complete prior snapshot without recompiling old configuration', async () => {
      await transition(candidate, 'rollback'); const current = await binding(); assert.equal(current.activeBundleId, original.activeBundleId); assert.equal(current.activeSnapshotId, baselineSnapshot);
    });
    await test('withdrawal revokes the withdrawn snapshot while preserving the approved active route', async () => {
      const withdrawn = await cloneBundle(); await transition(withdrawn, 'shadow'); const before = await binding(); assert.ok(before.shadowSnapshotId);
      await transition(withdrawn, 'withdraw'); const current = await binding(); assert.equal(current.activeSnapshotId, before.activeSnapshotId); assert.equal(current.shadowSnapshotId, null);
      const [row] = await db.select().from(s.gatewayRuntimeSnapshots).where(eq(s.gatewayRuntimeSnapshots.id, before.shadowSnapshotId)); assert.equal(row.state, 'REVOKED');
    });
    await test('automatic renewal rejects changed model routing and rolls back its generation', async () => {
      const before = await binding(), base = process.env.MODEL_BASE_URL; process.env.MODEL_BASE_URL = 'https://changed.invalid';
      try { await assert.rejects(publication.renewGatewayPublication(scope, before.generation), /CONFIGURATION_CHANGED/); assert.deepEqual(await binding(), before); }
      finally { process.env.MODEL_BASE_URL = base; }
    });
    await test('an expired signed active snapshot renews without changing the selected bundle', async () => {
      const before = await binding(), [row] = await db.select().from(s.gatewayRuntimeSnapshots).where(eq(s.gatewayRuntimeSnapshots.id, before.activeSnapshotId!));
      const [max] = await db.select({ generation: sql<number>`max(${s.gatewayRuntimeSnapshots.generation})::int` }).from(s.gatewayRuntimeSnapshots).where(scopePredicate(s.gatewayRuntimeSnapshots, scope));
      const manifest = { ...row.manifest, generation: max.generation + 1, validUntil: Date.now() - 1000 }, signed = security.signPayload('gateway-snapshot-v2', manifest), id = 'expired-test-' + randomUUID();
      await db.insert(s.gatewayRuntimeSnapshots).values({ ...row, id, generation: manifest.generation, manifest, digest: sha256(canonicalJson(manifest)), ...signed, validUntil: new Date(manifest.validUntil) });
      await db.update(s.applicationPolicyBindings).set({ activeSnapshotId: id }).where(scopePredicate(s.applicationPolicyBindings, scope));
      const reply = await actualRequest(); assert.equal(reply.status, 200, reply.errorCode); assert.notEqual(reply.snapshotId, id);
      const current = await binding(); assert.equal(current.activeBundleId, before.activeBundleId); assert.equal(current.generation, before.generation + 1); assert.equal(reply.snapshotId, current.activeSnapshotId);
    });
    await test('publication manifests are immutable and scoped reads cannot expose another application', async () => {
      const [message] = await publication.listGatewayPublications(scope, 1); await assert.rejects(db.update(s.gatewayRuntimePublications).set({ digest: 'f'.repeat(64) }).where(eq(s.gatewayRuntimePublications.id, message.id)));
      assert.deepEqual(await publication.listGatewayPublications({ tenantId: scope.tenantId, applicationId: randomUUID() }), []);
    });
  } finally {
    writeFileSync(qualificationFile, originalQualifications);
    const current = await binding(); await db.update(s.applicationPolicyBindings).set({ ...original, generation: Math.max(current.generation, original.generation) + 1, updatedAt: new Date() }).where(scopePredicate(s.applicationPolicyBindings, scope));
    for (const row of policyStates) await db.update(s.policyBundles).set({ state: row.state }).where(eq(s.policyBundles.id, row.id));
    for (const id of clones) await db.update(s.policyBundles).set({ state: 'retired' }).where(eq(s.policyBundles.id, id));
    await closeDatabaseConnection(); writeFileSync(path.join(directory, 'publication-evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), status: results.length === 14 ? 'PASS' : 'FAIL',
      isolatedDatabase: true, syntheticModel: true, independentModelQualityTested: false, results }, null, 2));
  }
}
main().catch(error => { const message = error instanceof Error && !error.message.startsWith('Failed query:') ? error.message : 'DATABASE_OPERATION_FAILED'; console.error('GATEWAY_PUBLICATION_TEST_FAILED', message); process.exitCode = 1; });
