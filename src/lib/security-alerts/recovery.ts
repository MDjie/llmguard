import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { decisionRecordOutbox } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantContext, type TenantScope } from '@/lib/tenancy';
import { appendAuditEventInTransaction } from '@/lib/audit/repository';
import { sha256 } from '@/lib/gateway-runtime/protocol';
const identifier = z.string().regex(/^[a-f0-9]{64}$/);
export async function listFailedAlertProjections(scope: TenantScope, afterId?: string) {
  if (afterId) identifier.parse(afterId);
  const rows = await db.select({id:decisionRecordOutbox.id,failureCode:decisionRecordOutbox.failureCode,failedAt:decisionRecordOutbox.failedAt,retryCount:decisionRecordOutbox.retryCount,payloadDigest:decisionRecordOutbox.payloadDigest})
    .from(decisionRecordOutbox).where(and(scopePredicate(decisionRecordOutbox,scope),eq(decisionRecordOutbox.state,'FAILED'),afterId?gt(decisionRecordOutbox.id,afterId):undefined)).orderBy(asc(decisionRecordOutbox.id)).limit(101);
  const items=rows.slice(0,100);
  return {items,hasMore:rows.length>100,nextAfterId:rows.length>100?items.at(-1)!.id:null};
}
export async function retryFailedAlertProjection(scope: TenantContext, id:string, reason:string) {
  identifier.parse(id);z.string().trim().min(10).max(500).parse(reason);
  return db.transaction(async tx=>{
    const [row]=await tx.select().from(decisionRecordOutbox).where(and(scopePredicate(decisionRecordOutbox,scope),eq(decisionRecordOutbox.id,id))).for('update');
    if(!row || row.state!=='FAILED')throw new Error('FAILED_PROJECTION_NOT_AVAILABLE');
    await appendAuditEventInTransaction(tx,{...scope,event:'security_alert.projection.retry',outcome:'ALLOWED',status:200,requestId:randomUUID(),traceId:id,method:'INTERNAL',path:'/internal/security-alert-projection/retry',queryString:'reasonSha256='+sha256(reason),latencyMs:0});
    await tx.update(decisionRecordOutbox).set({state:'PENDING',retryCount:sql`${decisionRecordOutbox.retryCount}+1`}).where(and(scopePredicate(decisionRecordOutbox,scope),eq(decisionRecordOutbox.id,id)));
    // Evidence and the last failure remain immutable diagnostics; retry cannot alter a recorded verdict.
    return {id,state:'PENDING',retryCount:row.retryCount+1};
  });
}
