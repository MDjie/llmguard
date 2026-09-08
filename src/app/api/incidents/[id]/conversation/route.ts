import { and, eq, inArray, gt } from 'drizzle-orm';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { incidentParamsSchema } from '@/contracts/http/incidents';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { requireTenantContext,scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { securityIncidents,detectionSessions,detectionRecords,riskFindings,securityAlerts,archivedContentObjects } from '@/storage/database/shared/schema';
import { sessionEvidence } from '@/lib/incidents/session-evidence';

export const GET=withApiSecurity({permission:'security:operate',paramsSchema:incidentParamsSchema,responseSchema:jsonObjectResponseSchema,maxBodyBytes:0,auditEvent:'incident.conversation.read',rateLimitPolicy:{id:'incident-conversation',windowMs:60000,maxRequests:60,scope:'principal'}},async({principal,routeContext})=>{
  const scope=requireTenantContext(principal),{id}=await(routeContext as {params:Promise<{id:string}>}).params;
  const [incident]=await db.select({sessionId:securityIncidents.sessionId}).from(securityIncidents).where(and(scopePredicate(securityIncidents,scope),eq(securityIncidents.id,id))).limit(1);
  if(!incident)throw new ApiProblem({status:404,code:'INCIDENT_NOT_FOUND',title:'事件不存在',detail:'当前应用中不存在该事件'});
  const canRead=principal?.permissions.includes('content:raw:read')??false;
  const [session]=incident.sessionId?await db.select().from(detectionSessions).where(and(scopePredicate(detectionSessions,scope),eq(detectionSessions.id,incident.sessionId))).limit(1):[];
  const findings=session?await db.select({dimension:riskFindings.dimension,score:riskFindings.score,matchedRules:riskFindings.matchedRules,...(canRead?{evidence:riskFindings.evidence}:{})}).from(riskFindings)
    .innerJoin(detectionRecords,and(eq(detectionRecords.id,riskFindings.recordId),scopePredicate(detectionRecords,scope)))
    .where(and(scopePredicate(riskFindings,scope),eq(detectionRecords.sessionId,session.id))).limit(100):[];
  const alerts=await db.select({requestId:securityAlerts.requestId}).from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.incidentId,id))).limit(50);
  const requestIds=[...new Set(alerts.flatMap(alert=>alert.requestId?[alert.requestId]:[]))];
  const archives=requestIds.length?await db.select({id:archivedContentObjects.id,purpose:archivedContentObjects.purpose,sequence:archivedContentObjects.sequence,state:archivedContentObjects.state,sourceHmac:archivedContentObjects.sourceHmac}).from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects,scope),inArray(archivedContentObjects.requestId,requestIds),gt(archivedContentObjects.expiresAt,new Date()))).limit(100):[];
  return Response.json({success:true,data:{conversation:session?sessionEvidence(session,canRead):null,findings,archives,message:session?null:archives.length?'问答已归档，请按原文访问流程查看具体版本':'未找到关联问答；历史摘要不能恢复原文'}},{headers:{'cache-control':'no-store'}});
});
