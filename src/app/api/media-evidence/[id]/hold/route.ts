import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { setMediaEvidenceHold } from '@/lib/evidence/media-snapshots';
export const POST=withApiSecurity({permission:'audit:approve',paramsSchema:z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),bodySchema:z.object({until:z.iso.datetime()}).strict(),responseSchema:z.object({success:z.literal(true)}).strict(),maxBodyBytes:1024,auditEvent:'media.evidence.hold.request',rateLimitPolicy:{id:'media-evidence-hold',windowMs:60000,maxRequests:30,scope:'principal'}},async({principal,routeContext,body})=>{const {id}=await(routeContext as {params:Promise<{id:string}>}).params;await setMediaEvidenceHold(requireTenantContext(principal),id,new Date(body.until));return Response.json({success:true});});
