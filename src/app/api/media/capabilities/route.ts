import {withApiSecurity} from '@/lib/api-security';
import {jsonObjectResponseSchema} from '@/contracts/http/common';
import {readMediaCapabilities} from '@/lib/media/capabilities';
export const GET=withApiSecurity({permission:'guard:use',responseSchema:jsonObjectResponseSchema,maxBodyBytes:0,auditEvent:'media.capabilities',rateLimitPolicy:{id:'media-capabilities',windowMs:60000,maxRequests:60,scope:'application'}},async({request})=>{
 return Response.json({success:true,data:await readMediaCapabilities(request.signal)});
});
