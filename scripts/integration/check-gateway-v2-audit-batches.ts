import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
async function main() {
  const directory=path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment:Record<string,string>=JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8'));
  const fixture:{tenantId:string;applicationId:string}=JSON.parse(readFileSync(path.join(directory,'fixture.json'),'utf8'));
  const url=new URL(environment.PGDATABASE_URL);if(url.hostname!=='127.0.0.1'||url.pathname!=='/guardllm_integration_gateway_v2')throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env,environment,{AUDIT_EXPORT_SYSLOG_HOST:'127.0.0.1',AUDIT_EXPORT_SYSLOG_PORT:'16515',AUDIT_EXPORT_SYSLOG_PROTOCOL:'tls',AUDIT_EXPORT_EVENT_PREFIXES:'gateway.execution.',AUDIT_EXPORT_OUTCOMES:''});
  const[{db,closeDatabaseConnection},s,audit,{scopePredicate}]=await Promise.all([import('../../src/storage/database/shared/db'),import('../../src/storage/database/shared/schema'),import('../../src/lib/gateway-runtime/audit-batches'),import('../../src/lib/tenancy')]);
  const scope={tenantId:fixture.tenantId,applicationId:fixture.applicationId};
  const results:{name:string;status:string}[]=[];
  async function test(name:string,run:()=>Promise<void>){await run();results.push({name,status:'PASS'});console.log('PASS '+name);}
  async function backlog(){const[row]=await db.select({count:sql<number>`count(*)::int`}).from(s.gatewayExecutionEvents).where(and(scopePredicate(s.gatewayExecutionEvents,scope),isNull(s.gatewayExecutionEvents.auditBatchId)));return row.count;}
  let firstId='';
  try{
    await test('a bounded batch verifies its signed manifest and exact persisted event records',async()=>{
      assert.ok(await backlog()>30,'Run gateway E2E first to create unanchored evidence');const batch=await audit.anchorGatewayAuditBatch(scope,10);assert.ok(batch);assert.equal(batch.count,10);firstId=batch.id;const verified=await audit.verifyGatewayAuditBatch(scope,batch.id);assert.equal(verified?.evidenceIntegrity,'VERIFIED');assert.equal(verified.eventCount,10);
    });
    await test('concurrent workers never anchor an execution event twice',async()=>{
      const before=await backlog(),batches=await Promise.all([audit.anchorGatewayAuditBatch(scope,10),audit.anchorGatewayAuditBatch(scope,10)]);assert.ok(batches[0]&&batches[1]);assert.notEqual(batches[0].id,batches[1].id);assert.equal(await backlog(),before-20);
      const verified=await Promise.all(batches.map(b=>audit.verifyGatewayAuditBatch(scope,b!.id)));const ids=verified.flatMap(b=>b!.manifest.events.map(e=>e.id));assert.equal(new Set(ids).size,20);
    });
    await test('export outbox failure rolls back anchor, chain record and event membership together',async()=>{
      const before=await backlog();const[count]=await db.select({count:sql<number>`count(*)::int`}).from(s.gatewayAuditBatches);
      await db.execute(sql`CREATE OR REPLACE FUNCTION isolated_gateway_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'event' = 'gateway.execution.batch' THEN RAISE EXCEPTION 'isolated outbox fault'; END IF; RETURN NEW; END $$`);
      await db.execute(sql`CREATE TRIGGER isolated_gateway_outbox_failure BEFORE INSERT ON audit_export_outbox FOR EACH ROW EXECUTE FUNCTION isolated_gateway_outbox_failure()`);
      try {await assert.rejects(audit.anchorGatewayAuditBatch(scope,5));assert.equal(await backlog(),before);const[after]=await db.select({count:sql<number>`count(*)::int`}).from(s.gatewayAuditBatches);assert.equal(after.count,count.count);}
      finally{await db.execute(sql`DROP TRIGGER isolated_gateway_outbox_failure ON audit_export_outbox`);await db.execute(sql`DROP FUNCTION isolated_gateway_outbox_failure()`);}
    });
    await test('database refuses changed or deleted execution evidence and replaced audit membership',async()=>{
      const[event]=await db.select().from(s.gatewayExecutionEvents).where(eq(s.gatewayExecutionEvents.auditBatchId,firstId)).limit(1);
      await assert.rejects(db.update(s.gatewayExecutionEvents).set({reasonCode:'forged'}).where(eq(s.gatewayExecutionEvents.id,event.id)));
      await assert.rejects(db.update(s.gatewayExecutionEvents).set({auditBatchId:null}).where(eq(s.gatewayExecutionEvents.id,event.id)));
      await assert.rejects(db.delete(s.gatewayExecutionEvents).where(eq(s.gatewayExecutionEvents.id,event.id)));
      await assert.rejects(db.update(s.gatewayAuditBatches).set({digest:'f'.repeat(64)}).where(eq(s.gatewayAuditBatches.id,firstId)));
    });
    await test('cross-application batch reads return no evidence',async()=>{assert.equal(await audit.verifyGatewayAuditBatch({...scope,applicationId:'00000000-0000-0000-0000-000000000099'},firstId),null);});
    await test('batch anchor and durable export payload carry the same authenticated digest',async()=>{
      const verified=await audit.verifyGatewayAuditBatch(scope,firstId);assert.ok(verified);const[outbox]=await db.select().from(s.auditExportOutbox).where(eq(s.auditExportOutbox.auditEventId,verified.auditEventId));assert.ok(outbox);assert.equal(outbox.state,'pending');assert.equal(outbox.payload.queryString,'sha256='+verified.digest);assert.equal(outbox.payload.requestId,firstId);assert.ok(!JSON.stringify(outbox.payload).includes('SYNTHETIC_BLOCK_MARKER'));
    });
    await test('backlog drains in bounded batches and a retry creates no duplicate anchor',async()=>{
      for(let i=0;i<100;i++){const batch=await audit.anchorGatewayAuditBatch(scope,500);if(!batch)break;assert.ok(batch.count<=500);await audit.verifyGatewayAuditBatch(scope,batch.id);}
      assert.equal(await backlog(),0);assert.equal(await audit.anchorGatewayAuditBatch(scope,500),null);
    });
  }finally{await closeDatabaseConnection();writeFileSync(path.join(directory,'audit-batch-evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),status:results.length===7?'PASS':'FAIL',isolatedDatabase:true,externalSiemDeliveryTested:false,results},null,2));}
}
main().catch(error=>{console.error('GATEWAY_AUDIT_INTEGRATION_FAILED',error instanceof Error?error.message:'UNKNOWN');process.exitCode=1;});
