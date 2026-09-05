import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { governanceIdParamsSchema } from '@/contracts/http/policy-governance';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { PolicyGovernanceOperationError } from '@/lib/policy-governance/errors';
import { policyGovernanceProblem } from '@/lib/policy-governance/problem';
import { releaseSetOperationSchema, operateDictionaryReleaseSet } from '@/lib/policy-governance/release-set-service';

export const POST = withApiSecurity({
  permission: 'policy:approve', paramsSchema: governanceIdParamsSchema,
  bodySchema: releaseSetOperationSchema, responseSchema: jsonObjectResponseSchema, maxBodyBytes: 2_048,
  auditEvent: 'policy.dictionary-set.approve',
  rateLimitPolicy: {id:'dictionary-set-approve',windowMs:60_000,maxRequests:20,scope:'application'},
}, async ({routeContext,body,principal})=>{
  const {id}=await (routeContext as {params:Promise<{id:string}>}).params;
  try {
    return Response.json({success:true,data:await operateDictionaryReleaseSet(requireTenantContext(principal),
      principal!.subject,id,'approve',body)});
  } catch(error) {
    if(error instanceof PolicyGovernanceOperationError)throw policyGovernanceProblem(error);
    throw error;
  }
});
