import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { retrieveRagSchema } from '@/contracts/http/rag';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { ragClearance, RagRetrievalError, retrieveGuardedRagContext } from '@/lib/rag/retrieval';

export const POST=withApiSecurity({
  permission:'guard:use',bodySchema:retrieveRagSchema,responseSchema:jsonObjectResponseSchema,maxBodyBytes:262144,
  auditEvent:'rag.retrieve.guarded',
  rateLimitPolicy:{id:'rag-retrieve',windowMs:60000,maxRequests:120,scope:'application'},
},async({body,principal,request})=>{
  try {
    const data=await retrieveGuardedRagContext({...body,scope:requireTenantContext(principal),signal:request.signal,
      principal:{id:principal!.subject,roles:principal!.roles,clearance:ragClearance(principal!.roles)}});
    return Response.json({success:true,data});
  }catch(error){
    if(error instanceof RagRetrievalError)throw new ApiProblem({status:403,code:error.code,title:'RAG retrieval rejected',detail:error.message});
    throw error;
  }
});
