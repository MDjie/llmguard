import { and, asc, eq, gte, gt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { gatewaySteps, gatewayRequests, guardJobs, detectionSessions, decisionRecordOutbox } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { guardDecisionSchema } from '@/contracts/http/guard-v1';
import { decisionRecordedSchema, alertActionSchema, type DecisionRecorded } from '@/contracts/http/security-alerts';
import { openReceipt } from '@/lib/gateway-runtime/security';
import { sha256 } from '@/lib/gateway-runtime/protocol';
import { fromGuardDecision, fromJobResult, fromJobFailure } from './record';
import { enqueueDecisionRecord } from './service';
export const alertBackfillSchema = z.object({ source: z.enum(['GATEWAY','GUARD_JOB','LEGACY']), from: z.iso.datetime(), watermark: z.iso.datetime(), afterId: z.string().max(128).optional(), limit: z.number().int().min(1).max(100).default(50), apply: z.boolean().default(false) }).strict();
export async function backfillSecurityAlerts(scope: TenantScope, raw: z.infer<typeof alertBackfillSchema>) {
 const input = alertBackfillSchema.parse(raw), from = new Date(input.from), watermark = new Date(input.watermark), now = Date.now();
 if (from >= watermark || watermark.getTime() > now || from.getTime() < watermark.getTime() - 180 * 86400000) throw new Error('BACKFILL_TIME_RANGE_INVALID');
 const records: DecisionRecorded[] = [], skipped: { id: string; reasonCode: string }[] = []; let ids: string[] = [];
 if (input.source === 'GATEWAY') {
  const rows = await db.select({ step: gatewaySteps, sessionId: gatewayRequests.sessionId }).from(gatewaySteps).innerJoin(gatewayRequests,and(scopePredicate(gatewayRequests,scope),eq(gatewayRequests.id,gatewaySteps.requestId))).where(and(scopePredicate(gatewaySteps,scope),gte(gatewaySteps.createdAt,from),lte(gatewaySteps.createdAt,watermark),input.afterId?gt(gatewaySteps.id,input.afterId):undefined)).orderBy(asc(gatewaySteps.id)).limit(input.limit);
  ids = rows.map(row => row.step.id);
  for (const {step,sessionId} of rows) { try {
   if (!step.decisionEnvelope) throw new Error('SOURCE_MISSING');
   const envelope = z.object({ legacy: guardDecisionSchema }).loose().parse(openReceipt(step.decisionEnvelope,step.id));
   records.push({...fromGuardDecision({sourceId:step.id,requestId:step.requestId,sessionId:sessionId??undefined,stage:step.stage,decision:envelope.legacy}),occurredAt:step.createdAt.toISOString()});
  } catch { skipped.push({id:step.id,reasonCode:'HISTORICAL_DECISION_UNAVAILABLE'}); } }
 } else if (input.source === 'GUARD_JOB') {
  const rows = await db.select().from(guardJobs).where(and(scopePredicate(guardJobs,scope),gte(guardJobs.createdAt,from),lte(guardJobs.createdAt,watermark),input.afterId?gt(guardJobs.id,input.afterId):undefined)).orderBy(asc(guardJobs.id)).limit(input.limit); ids=rows.map(row=>row.id);
  for(const job of rows){ if(!['completed','failed'].includes(job.status)){skipped.push({id:job.id,reasonCode:'JOB_NOT_TERMINAL'});continue;}try{const record=job.status==='failed'?fromJobFailure(job):fromJobResult(job,job.result??{});if(record)records.push({...record,occurredAt:(job.completedAt??job.createdAt).toISOString()});}catch{skipped.push({id:job.id,reasonCode:'HISTORICAL_RESULT_UNAVAILABLE'});} }
 } else {
  const rows=await db.select({id:detectionSessions.id,inputAction:detectionSessions.inputAction,outputAction:detectionSessions.outputAction,createdAt:detectionSessions.createdAt}).from(detectionSessions).where(and(scopePredicate(detectionSessions,scope),gte(detectionSessions.createdAt,from),lte(detectionSessions.createdAt,watermark),input.afterId?gt(detectionSessions.id,input.afterId):undefined)).orderBy(asc(detectionSessions.id)).limit(input.limit);ids=rows.map(row=>row.id);
  for(const row of rows)for(const [stage,rawAction] of [['INPUT',row.inputAction],['OUTPUT_COMPLETE',row.outputAction]] as const){const action=alertActionSchema.safeParse(rawAction?.toUpperCase());if(!action.success||action.data==='ALLOW')continue;records.push(decisionRecordedSchema.parse({version:'1.0',source:'LEGACY',sourceId:row.id,sessionId:row.id,traceId:'legacy-'+row.id,decisionId:sha256(JSON.stringify([row.id,stage])),stage,action:action.data,occurredAt:row.createdAt.toISOString(),coverage:{provenance:'CLIENT_REPORTED',executionVerified:false,backfill:true},findings:[{riskId:'legacy.unverified_decision',score:0,reasonCode:'HISTORICAL_CLIENT_REPORTED',category:'UNDETERMINED',evidence:[]}]}));}
 }
 let enqueued=0,existing=0;
 if(input.apply)await db.transaction(async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope.tenantId+':'+scope.applicationId+':alert-backfill'},0))`);
  for(const record of records){if(!record.findings.length)continue;const [prior]=await tx.select({id:decisionRecordOutbox.id}).from(decisionRecordOutbox).where(and(scopePredicate(decisionRecordOutbox,scope),sql`${decisionRecordOutbox.payload}->>'source' = ${record.source}`,sql`${decisionRecordOutbox.payload}->>'sourceId' = ${record.sourceId}`,sql`${decisionRecordOutbox.payload}->>'stage' = ${record.stage}`)).limit(1);if(prior){existing++;continue;}await enqueueDecisionRecord(tx,scope,record);enqueued++;}
 });
 return { source:input.source,watermark:input.watermark,from:input.from,scanned:ids.length,candidates:records.filter(record=>record.findings.length).length,enqueued,existing,skipped,nextAfterId:ids.length===input.limit?ids.at(-1):null,dryRun:!input.apply };
}
