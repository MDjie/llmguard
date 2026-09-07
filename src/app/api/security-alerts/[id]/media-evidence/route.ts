import { z } from 'zod';
import { withApiSecurity,ApiProblem } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { readSecurityAlert } from '@/lib/security-alerts/service';
import { listJobMediaEvidence } from '@/lib/evidence/media-snapshots';
import { mediaEvidenceMetadataSchema } from '@/contracts/http/media-evidence';
export const GET=withApiSecurity({permission:'security:operate',paramsSchema:z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),responseSchema:z.object({items:z.array(mediaEvidenceMetadataSchema).max(1)}).strict(),maxBodyBytes:0,auditEvent:'security.alerts.media-evidence',rateLimitPolicy:{id:'alert-media-evidence',windowMs:60000,maxRequests:120,scope:'principal'}},async({principal,routeContext})=>{
 const scope=requireTenantContext(principal),{id}=await(routeContext as {params:Promise<{id:string}>}).params,alert=await readSecurityAlert(scope,id);
 if(!alert)throw new ApiProblem({status:404,code:'ALERT_NOT_FOUND',title:'Alert unavailable',detail:'The alert is unavailable in this application.'});
 return Response.json({items:alert.jobId?await listJobMediaEvidence(scope,alert.jobId):[]},{headers:{'cache-control':'no-store'}});
});
