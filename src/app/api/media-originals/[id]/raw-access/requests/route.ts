import {z} from 'zod';
import {withApiSecurity} from '@/lib/api-security';
import {requireTenantContext} from '@/lib/tenancy';
import {originalResourceIdSchema} from '@/contracts/http/original-preview';
import {contentAccessOwnListResponseSchema} from '@/contracts/http/content-access';
import {listRequesterEvidenceAccess} from '@/lib/incidents/content-access';
export const GET=withApiSecurity({permission:'content:raw:read',paramsSchema:z.object({id:originalResourceIdSchema}).strict(),responseSchema:contentAccessOwnListResponseSchema,maxBodyBytes:0,auditEvent:'media.original.access.list',rateLimitPolicy:{id:'original-access-list',windowMs:60000,maxRequests:60,scope:'principal'}},async({principal,routeContext})=>{
 const {id}=await(routeContext as {params:Promise<{id:string}>}).params;
 return Response.json({success:true,data:await listRequesterEvidenceAccess(requireTenantContext(principal),id,'MEDIA_ORIGINAL')},{headers:{'cache-control':'no-store, max-age=0',pragma:'no-cache'}});
});
