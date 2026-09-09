import {z} from 'zod';
import {withApiSecurity} from '@/lib/api-security';
import {requireTenantContext} from '@/lib/tenancy';
import {originalResourceIdSchema} from '@/contracts/http/original-preview';
import {contentAccessConsumeResponseSchema,consumeContentAccessRequestSchema} from '@/contracts/http/content-access';
import {consumeOriginalPreview,originalPreviewProblem} from '@/lib/evidence/original-preview';
export const POST=withApiSecurity({permission:'content:raw:read',paramsSchema:z.object({id:originalResourceIdSchema}).strict(),bodySchema:consumeContentAccessRequestSchema,responseSchema:contentAccessConsumeResponseSchema,maxBodyBytes:2048,auditEvent:'media.original.access.consume',rateLimitPolicy:{id:'original-access-consume',windowMs:60000,maxRequests:10,scope:'principal'}},async({principal,routeContext,body,request})=>{
 const {id}=await(routeContext as {params:Promise<{id:string}>}).params;
 return Response.json({success:true,data:await consumeOriginalPreview(requireTenantContext(principal),id,body.requestId,request.signal).catch(originalPreviewProblem)},{headers:{'cache-control':'no-store, max-age=0',pragma:'no-cache','x-content-type-options':'nosniff'}});
});
