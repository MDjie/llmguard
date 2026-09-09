import {z} from 'zod';
import {withApiSecurity} from '@/lib/api-security';
import {requireTenantContext} from '@/lib/tenancy';
import {originalResourceIdSchema} from '@/contracts/http/original-preview';
import {createContentAccessRequestSchema,contentAccessRequestResponseSchema} from '@/contracts/http/content-access';
import {requestEvidenceAccess} from '@/lib/incidents/content-access';
export const POST=withApiSecurity({permission:'content:raw:read',paramsSchema:z.object({id:originalResourceIdSchema}).strict(),bodySchema:createContentAccessRequestSchema,responseSchema:contentAccessRequestResponseSchema,maxBodyBytes:4096,auditEvent:'media.original.access.request',rateLimitPolicy:{id:'original-access-request',windowMs:60000,maxRequests:20,scope:'principal'}},async({principal,routeContext,body})=>{
 const {id}=await(routeContext as {params:Promise<{id:string}>}).params;
 return Response.json({success:true,data:await requestEvidenceAccess(requireTenantContext(principal),id,body,'MEDIA_ORIGINAL')},{headers:{'cache-control':'no-store, max-age=0',pragma:'no-cache'}});
});
