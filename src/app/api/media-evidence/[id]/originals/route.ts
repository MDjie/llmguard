import {z} from 'zod';
import {withApiSecurity} from '@/lib/api-security';
import {requireTenantContext} from '@/lib/tenancy';
import {originalSourcesResponseSchema} from '@/contracts/http/original-preview';
import {listOriginalPreviewSources,originalPreviewProblem} from '@/lib/evidence/original-preview';
export const GET=withApiSecurity({permission:'content:raw:read',paramsSchema:z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),responseSchema:originalSourcesResponseSchema,maxBodyBytes:0,auditEvent:'media.original.sources',rateLimitPolicy:{id:'original-sources-list',windowMs:60000,maxRequests:30,scope:'principal'}},async({principal,routeContext})=>{
 const {id}=await(routeContext as {params:Promise<{id:string}>}).params;
 return Response.json(await listOriginalPreviewSources(requireTenantContext(principal),id).catch(originalPreviewProblem),{headers:{'cache-control':'no-store, max-age=0',pragma:'no-cache'}});
});
