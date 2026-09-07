import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { decisionRecordedSchema, alertQuerySchema } from '../../src/contracts/http/security-alerts';
import { gatewayConsoleQuerySchema, gatewayRequestDetailSchema, gatewayRequestListSchema } from '../../src/contracts/http/gateway-console';
async function main() {
  const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string, string> = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
  const fixture: { tenantId: string; applicationId: string } = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
  const url = new URL(environment.PGDATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.port !== '55447' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env, environment);
  const client = new pg.Client({ connectionString: url.toString(), ssl: false }); await client.connect();
  await client.query(readFileSync(path.resolve('drizzle/0059_security_alert_projection.sql'), 'utf8'));
  await client.query(readFileSync(path.resolve('drizzle/0061_badcase_independent_review.sql'), 'utf8'));
  await client.query(readFileSync(path.resolve('drizzle/0062_alert_projection_recovery.sql'), 'utf8'));
  const [{ db, closeDatabaseConnection }, s, service, { readGatewayRequests }, { recordIdentity }] = await Promise.all([
    import('../../src/storage/database/shared/db'), import('../../src/storage/database/shared/schema'), import('../../src/lib/security-alerts/service'),
    import('../../src/lib/gateway-runtime/console-service'), import('../../src/lib/security-alerts/record'),
  ]);
  const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId }, runId = randomUUID(), riskId = 'test.' + runId;
  const otherScope = { tenantId: scope.tenantId, applicationId: randomUUID() };
  const results: Array<{ name: string; status: string }> = [];
  const occurredAt = new Date(Date.now() - 1000).toISOString();
  const record = (sourceId: string) => decisionRecordedSchema.parse({ version: '1.0', source: 'LEGACY', sourceId, traceId: runId, sessionId: runId,
    decisionId: sourceId, stage: 'INPUT', action: 'BLOCK', occurredAt, coverage: { verified: false },
    findings: [{ riskId, score: 0.9, reasonCode: 'ENGINEERING_FIXTURE', category: 'UNDETERMINED', evidence: [] }] });
  async function test(name: string, run: () => Promise<void>) { await run(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  const records = Array.from({ length: 5 }, () => record(randomUUID()));
  const output = path.resolve('.artifact-build/v11-all-20260908'); mkdirSync(output, { recursive: true });
  try {
    await db.insert(s.applications).values({ ...otherScope, id: otherScope.applicationId, code: 'v11-' + runId.slice(0, 8), name: 'V1.1 isolated projection fixture' });
    await test('outbox idempotence and conflicting replay roll back their surrounding transaction', async () => {
      await db.transaction(async tx => { await service.enqueueDecisionRecord(tx, scope, records[0]); await service.enqueueDecisionRecord(tx, scope, records[0]); });
      const id = recordIdentity(scope, records[0]);
      assert.equal((await db.select().from(s.decisionRecordOutbox).where(eq(s.decisionRecordOutbox.id, id))).length, 1);
      const before = (await db.select().from(s.applications).where(eq(s.applications.id, otherScope.applicationId)))[0].name;
      await assert.rejects(db.transaction(async tx => {
        await tx.update(s.applications).set({ name: 'must roll back' }).where(eq(s.applications.id, otherScope.applicationId));
        await service.enqueueDecisionRecord(tx, scope, { ...records[0], action: 'WARN' });
      }), /IDENTITY_CONFLICT/);
      assert.equal((await db.select().from(s.applications).where(eq(s.applications.id, otherScope.applicationId)))[0].name, before);
      await db.transaction(async tx => { for (const value of records.slice(1)) await service.enqueueDecisionRecord(tx, scope, value); });
    });
    await test('projection retries after failure without acknowledging or partially writing the batch', async () => {
      await client.query(`CREATE OR REPLACE FUNCTION isolated_v11_projection_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.risk_id = '${riskId}' THEN RAISE EXCEPTION 'injected projection fault'; END IF; RETURN NEW; END $$`);
      await client.query('CREATE TRIGGER isolated_v11_projection_fault BEFORE INSERT ON security_alerts FOR EACH ROW EXECUTE FUNCTION isolated_v11_projection_fault()');
      try { await assert.rejects(service.projectSecurityAlerts()); assert.equal((await db.select().from(s.securityAlerts).where(eq(s.securityAlerts.riskId, riskId))).length, 0); }
      finally { await client.query('DROP TRIGGER isolated_v11_projection_fault ON security_alerts'); await client.query('DROP FUNCTION isolated_v11_projection_fault()'); }
      await Promise.all([service.projectSecurityAlerts(), service.projectSecurityAlerts()]);
      assert.equal((await db.select().from(s.securityAlerts).where(eq(s.securityAlerts.riskId, riskId))).length, 5);
    });
    let alertIds: string[] = [];
    await test('same-time alerts page completely, freeze late insertions and reject cross-application cursors', async () => {
      const query = alertQuerySchema.parse({ riskId, limit: 2 }); const first = await service.listSecurityAlerts(scope, query);
      assert.equal(first.items.length, 2); assert.equal(first.hasMore, true); alertIds = first.items.map(item => item.id);
      await db.transaction(async tx => service.enqueueDecisionRecord(tx, scope, record(randomUUID()))); await service.projectSecurityAlerts();
      let cursor = first.nextCursor;
      while (cursor) { const page = await service.listSecurityAlerts(scope, { ...query, cursor }); alertIds.push(...page.items.map(item => item.id)); cursor = page.nextCursor; }
      assert.equal(alertIds.length, 5); assert.equal(new Set(alertIds).size, 5);
      assert.equal((await service.listSecurityAlerts(scope, query)).hasMore, true);
      await assert.rejects(service.listSecurityAlerts(otherScope, { ...query, cursor: first.nextCursor! }), /MISMATCH/);
      assert.equal(await service.readSecurityAlert(otherScope, first.items[0].id), null);
      await assert.rejects(service.listSecurityAlerts(scope, alertQuerySchema.parse({ from: '2000-01-01T00:00:00Z' })), /TIME_RANGE/);
    });
    await test('concurrent incident association reuses one scoped incident and leaves evidence immutable', async () => {
      const context = { ...scope, principalId: 'v11-engineering-operator' };
      const links = await Promise.all(alertIds.slice(0, 2).map(id => service.createAlertIncident(context, id)));
      assert.equal(links[0].incidentId, links[1].incidentId); assert.equal(links.filter(item => item.created).length, 1);
      assert.equal((await service.createAlertIncident(context, alertIds[0])).created, false);
      await assert.rejects(db.update(s.securityAlerts).set({ action: 'ALLOW' }).where(eq(s.securityAlerts.id, alertIds[0])));
      await assert.rejects(service.createAlertIncident({ ...otherScope, principalId: context.principalId }, alertIds[0]), /NOT_FOUND/);
    });
    await test('database foreign keys reject cross-application alert references', async () => {
      const foreign = record(randomUUID()); await db.transaction(tx => service.enqueueDecisionRecord(tx, otherScope, foreign));
      const row = (await db.select().from(s.securityAlerts).where(eq(s.securityAlerts.id, alertIds[0])))[0];
      await assert.rejects(db.insert(s.securityAlerts).values({ ...row, ...otherScope, id: 'a'.repeat(32) + runId.replaceAll('-', ''), recordId: recordIdentity(otherScope, foreign), incidentId: row.incidentId }));
    });
    await test('request, step and event pages recover every record beyond the old caps with stable millisecond ordering', async () => {
      const [template] = await db.select().from(s.gatewayRequests).where(and(eq(s.gatewayRequests.tenantId, scope.tenantId), eq(s.gatewayRequests.applicationId, scope.applicationId))).limit(1);
      assert.ok(template, 'The existing isolated proxy fixture must contain a request');
      const requestIds = Array.from({ length: 5 }, () => randomUUID()), createdAt = new Date(Date.now() - 1000);
      for (const id of requestIds) await db.insert(s.gatewayRequests).values({ ...template, id, idempotencyKey: id, sessionId: null, consoleAssertionHmac: null, sessionSnapshot: null,
        state: 'COMPLETED', stepCount: 0, lastEventSeq: 0, sessionFinalized: true, createdAt, contentPurgedAt: null, deletionProofId: null });
      const id = requestIds[0], stepCount = 520, eventCount = 4100;
      const stepRows = Array.from({ length: stepCount }, (_, i) => ({ ...scope, id: randomUUID(), requestId: id, stage: 'OUTPUT_CHUNK', streamSeq: i, attemptKind: 'PRIMARY', inputHmac: 'e'.repeat(64), status: 'COMPLETE', createdAt }));
      await db.insert(s.gatewaySteps).values(stepRows);
      for (let start = 0; start < eventCount; start += 200) await db.insert(s.gatewayExecutionEvents).values(Array.from({ length: Math.min(200, eventCount - start) }, (_, index) => ({ ...scope, id: randomUUID(), requestId: id,
        eventSeq: start + index + 1, kind: 'WRITE_ACCEPTED', snapshotId: template.snapshotId, eventHmac: 'e'.repeat(64), createdAt })));
      await db.update(s.gatewayRequests).set({ stepCount, lastEventSeq: eventCount }).where(eq(s.gatewayRequests.id, id));
      const first = gatewayRequestDetailSchema.parse(JSON.parse(JSON.stringify(await readGatewayRequests(scope, gatewayConsoleQuerySchema.parse({ id, limit: 100 })))));
      const stepIds = first.steps.map(step => step.id), eventSequences = first.events.map(event => event.sequence); let cursor = first.pagination?.nextCursor;
      // A later event is excluded by the first page's frozen watermark.
      await db.insert(s.gatewayExecutionEvents).values({ ...scope, id: randomUUID(), requestId: id, eventSeq: eventCount + 1, kind: 'COMPLETED', snapshotId: template.snapshotId, eventHmac: 'e'.repeat(64) });
      await db.update(s.gatewayRequests).set({ lastEventSeq: eventCount + 1 }).where(eq(s.gatewayRequests.id, id));
      while (cursor) {
        const page = gatewayRequestDetailSchema.parse(JSON.parse(JSON.stringify(await readGatewayRequests(scope, gatewayConsoleQuerySchema.parse({ id, cursor, limit: 100 })))));
        stepIds.push(...page.steps.map(step => step.id)); eventSequences.push(...page.events.map(event => event.sequence)); assert.deepEqual(page.pagination?.eventGaps, []); cursor = page.pagination?.nextCursor;
      }
      assert.equal(stepIds.length, stepCount); assert.equal(new Set(stepIds).size, stepCount); assert.equal(eventSequences.length, eventCount); assert.equal(new Set(eventSequences).size, eventCount);
      await assert.rejects(readGatewayRequests(otherScope, gatewayConsoleQuerySchema.parse({ id })), /NOT_FOUND/);
      const baseQuery = { from: new Date(createdAt.getTime() - 1).toISOString(), to: new Date(createdAt.getTime() + 1).toISOString(), limit: 2 };
      let listCursor: string | undefined; const recovered: string[] = [];
      do { const page = gatewayRequestListSchema.parse(JSON.parse(JSON.stringify(await readGatewayRequests(scope, gatewayConsoleQuerySchema.parse({ ...baseQuery, cursor: listCursor }))))); recovered.push(...page.items.map(item => item.id)); listCursor = page.nextCursor ?? undefined; } while (listCursor);
      assert.ok(requestIds.every(requestId => recovered.includes(requestId))); assert.equal(new Set(recovered).size, recovered.length);
    });
    await test('historical backfill is dry-run by default, repeatable, scope-bound and preserves unknown provenance', async () => {
      const {backfillSecurityAlerts}=await import('../../src/lib/security-alerts/backfill');
      const historicalId=randomUUID(),createdAt=new Date(Date.now()-10000);
      await db.insert(s.detectionSessions).values({...scope,id:historicalId,userId:'synthetic-historical',inputAction:'block',createdAt});
      const options={source:'LEGACY' as const,from:new Date(createdAt.getTime()-1).toISOString(),watermark:new Date(createdAt.getTime()+1).toISOString(),limit:100,apply:false};
      const dry=await backfillSecurityAlerts(scope,options);assert.equal(dry.enqueued,0);assert.ok(dry.candidates>=1);
      const first=await backfillSecurityAlerts(scope,{...options,apply:true});assert.ok(first.enqueued>=1);
      const repeated=await backfillSecurityAlerts(scope,{...options,apply:true});assert.equal(repeated.enqueued,0);assert.ok(repeated.existing>=1);
      const foreign=await backfillSecurityAlerts(otherScope,{...options,apply:true});assert.equal(foreign.enqueued,0);
      await service.projectSecurityAlerts(100);
      const historical=await db.select().from(s.securityAlerts).where(eq(s.securityAlerts.sourceId,historicalId));assert.equal(historical.length,1);assert.equal(historical[0].category,'UNDETERMINED');assert.equal(historical[0].occurredAt.getTime(),createdAt.getTime());
    });
    await test('feedback is scoped, concurrent-idempotent and never publishes a policy', async () => {
      const { submitAlertFeedback } = await import('../../src/lib/security-alerts/feedback');
      const [alert] = await db.select().from(s.securityAlerts).where(and(eq(s.securityAlerts.riskId, riskId), eq(s.securityAlerts.applicationId, scope.applicationId))).limit(1);
      assert.ok(alert);
      const input = { expectedAction: 'ALLOW' as const, classification: 'FALSE_POSITIVE' as const, reason: 'Synthetic feedback checks scope and idempotent review queue only.' };
      const feedback = await Promise.all(Array.from({ length: 3 }, () => submitAlertFeedback({ ...scope, principalId: 'isolated-reviewer' }, alert.id, input)));
      assert.equal(new Set(feedback.map(item => item.id)).size, 1); assert.equal(feedback.filter(item => item.created).length, 1);
      assert.ok(feedback.every(item => item.status === 'open' && item.activationStatus === 'NOT_PUBLISHED'));
      await assert.rejects(() => submitAlertFeedback({ ...otherScope, principalId: 'isolated-reviewer' }, alert.id, input));
      const [saved] = await db.select().from(s.badcaseFeedback).where(eq(s.badcaseFeedback.id, feedback[0].id));
      assert.equal(saved.decisionId, alert.decisionId); assert.equal(saved.resolvedAt, null);
      const {reviewAlertFeedback,listAlertFeedback}=await import('../../src/lib/security-alerts/feedback');
      const review={feedbackId:saved.id,decision:'ACCEPT' as const,reason:'Independent synthetic triage; not a gold dataset approval.'};
      await assert.rejects(()=>reviewAlertFeedback({...scope,principalId:'isolated-reviewer'},alert.id,review),/INDEPENDENT/);
      await assert.rejects(()=>reviewAlertFeedback({...otherScope,principalId:'isolated-second-reviewer'},alert.id,review));
      const reviewed=await Promise.all([reviewAlertFeedback({...scope,principalId:'isolated-second-reviewer'},alert.id,review),reviewAlertFeedback({...scope,principalId:'isolated-second-reviewer'},alert.id,review)]);
      assert.ok(reviewed.every(item=>item.status==='triaged'&&item.activationStatus==='NOT_PUBLISHED'));
      await assert.rejects(()=>reviewAlertFeedback({...scope,principalId:'isolated-third-reviewer'},alert.id,{...review,decision:'REJECT'}),/ALREADY_REVIEWED/);
      const repeatedSubmit=await submitAlertFeedback({...scope,principalId:'isolated-reviewer'},alert.id,input);assert.equal(repeatedSubmit.status,'triaged');
      const listed=await listAlertFeedback({...scope,principalId:'isolated-reviewer'},alert.id);assert.equal(listed.find(item=>item.id===saved.id)?.reviewedBy,'isolated-second-reviewer');
    });
    await test('poison records are isolated; scoped audited retries restore missing-reference records without rewriting evidence', async () => {
      const {sha256,canonicalJson}=await import('../../src/lib/gateway-runtime/protocol');
      const {listFailedAlertProjections,retryFailedAlertProjection}=await import('../../src/lib/security-alerts/recovery');
      const schemaId=sha256('schema-'+runId), integrityPayload=record(randomUUID()), integrityId=recordIdentity(scope,integrityPayload);
      await client.query('INSERT INTO decision_record_outbox(id,tenant_id,application_id,payload,payload_digest) VALUES($1,$2,$3,$4,$5)',[schemaId,scope.tenantId,scope.applicationId,{},'f'.repeat(64)]);
      await db.insert(s.decisionRecordOutbox).values({...scope,id:integrityId,payload:integrityPayload,payloadDigest:'f'.repeat(64)});
      const missingRequestId=randomUUID(), dangling={...record(randomUUID()),requestId:missingRequestId}, danglingId=recordIdentity(scope,dangling), good=record(randomUUID());
      await db.transaction(async tx=>{await service.enqueueDecisionRecord(tx,scope,dangling);await service.enqueueDecisionRecord(tx,scope,good);});
      const projected=await service.projectSecurityAlerts();assert.equal(projected.quarantined,3);assert.ok(projected.processed>=1);
      const failed=await listFailedAlertProjections(scope);assert.ok(failed.items.some(item=>item.id===schemaId&&item.failureCode==='DECISION_RECORD_SCHEMA_INVALID'));
      assert.ok(failed.items.some(item=>item.id===integrityId&&item.failureCode==='DECISION_RECORD_INTEGRITY_FAILED'));
      assert.ok(failed.items.some(item=>item.id===danglingId&&item.failureCode==='PROJECTION_DATA_23503'));
      await assert.rejects(()=>retryFailedAlertProjection({...otherScope,principalId:'isolated-recovery-operator'},danglingId,'Synthetic scoped failure recovery.'),/NOT_AVAILABLE/);
      await assert.rejects(db.update(s.decisionRecordOutbox).set({payload:{...integrityPayload,action:'ALLOW'}}).where(eq(s.decisionRecordOutbox.id,integrityId)));
      const [template]=await db.select().from(s.gatewayRequests).where(and(eq(s.gatewayRequests.tenantId,scope.tenantId),eq(s.gatewayRequests.applicationId,scope.applicationId))).limit(1);
      await db.insert(s.gatewayRequests).values({...template,id:missingRequestId,idempotencyKey:missingRequestId,sessionId:null,consoleAssertionHmac:null,sessionSnapshot:null,state:'COMPLETED',stepCount:0,lastEventSeq:0,sessionFinalized:true,contentPurgedAt:null,deletionProofId:null});
      const retry=await retryFailedAlertProjection({...scope,principalId:'isolated-recovery-operator'},danglingId,'Synthetic missing reference has been restored.');assert.equal(retry.retryCount,1);
      await service.projectSecurityAlerts();
      const [saved]=await db.select().from(s.decisionRecordOutbox).where(eq(s.decisionRecordOutbox.id,danglingId));assert.equal(saved.state,'PROJECTED');assert.equal(saved.payloadDigest,sha256(canonicalJson(dangling)));
      const audit=await db.select().from(s.securityAuditEvents).where(and(eq(s.securityAuditEvents.traceId,danglingId),eq(s.securityAuditEvents.event,'security_alert.projection.retry')));assert.equal(audit.length,1);
    });
  } finally {
    await closeDatabaseConnection(); await client.end();
    writeFileSync(path.join(output, 'p2-integration.json'), JSON.stringify({ runId, capturedAt: new Date().toISOString(), results, passed: results.length, isolatedDatabase: true, syntheticDataOnly: true }, null, 2));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Integration failed'); process.exitCode = 1; });
