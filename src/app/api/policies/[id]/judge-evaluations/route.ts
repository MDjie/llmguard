import { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { policyParamsSchema } from '@/contracts/http/policies';
import { ApiProblem,withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { loadJudgeDraft } from '@/lib/judge/draft-service';
import { detectionCaseSchema } from '@/lib/evaluation/optimization-dataset';
import { evaluateIsolatedJudge } from '@/lib/evaluation/isolated-judge';

const bodySchema=z.object({profileId:z.string().min(1).max(128),expectedRevision:z.number().int().positive(),
  cases:z.array(detectionCaseSchema.extend({text:z.string().min(1).max(16000)})).min(1).max(4)}).strict();
export const POST=withApiSecurity({
  permission:'provider:test',paramsSchema:policyParamsSchema,bodySchema,responseSchema:jsonObjectResponseSchema,
  maxBodyBytes:256*1024,auditEvent:'policy.judge.candidate-evaluation',
  rateLimitPolicy:{id:'judge-candidate-evaluation',windowMs:60000,maxRequests:3,scope:'application'},
},async({principal,routeContext,body,request})=>{
  const {id}=await(routeContext as {params:Promise<{id:string}>}).params;
  const scope=requireTenantContext(principal),draft=await loadJudgeDraft(scope,id);
  const selected=draft.profilesV2.find(p=>p.profileId===body.profileId);
  if(!selected||selected.revision!==body.expectedRevision)throw new ApiProblem({status:409,code:'JUDGE_DRAFT_CONFLICT',title:'Judge draft changed',detail:'Reload the saved profile before evaluation.'});
  if((selected.role??'base')!=='base')throw new ApiProblem({status:422,code:'BASE_PROFILE_REQUIRED',title:'Base profile required',detail:'Use the isolated CLI for specialized grounding or refinement tests.'});
  const profiles=[selected,...selected.fallbackProfileIds.map(id=>draft.profilesV2.find(p=>p.profileId===id)!)];
  try{
    const report=await evaluateIsolatedJudge(profiles,body.cases,{maximumCases:4,maximumCalls:8,maximumReservedTokens:200000,totalTimeoutMs:60000,concurrency:1},{signal:request.signal});
    return Response.json({success:true,data:report});
  }catch{
    throw new ApiProblem({status:422,code:'ISOLATED_EVALUATION_REJECTED',title:'Candidate evaluation rejected',detail:'Check case schema, data boundary, model scope and configured budgets. Runtime policy is unchanged.'});
  }
});
