import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { PolicyGovernanceOperationError } from '@/lib/policy-governance/errors';
import { policyGovernanceProblem } from '@/lib/policy-governance/problem';
import { importReleaseSetSchema, importDictionaryReleaseSet, listDictionaryReleaseSets } from '@/lib/policy-governance/release-set-service';

export const GET = withApiSecurity({
  permission: 'policy:read', responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0,
  auditEvent: 'policy.dictionary-set.list',
  rateLimitPolicy: {id:'dictionary-set-list',windowMs:60_000,maxRequests:60,scope:'application'},
}, async ({principal})=>Response.json({success:true,data:await listDictionaryReleaseSets(requireTenantContext(principal))}));

export const POST = withApiSecurity({
  permission: 'policy:write', bodySchema: importReleaseSetSchema, responseSchema: jsonObjectResponseSchema,
  maxBodyBytes: 16_777_216, auditEvent: 'policy.dictionary-set.import',
  rateLimitPolicy: {id:'dictionary-set-import',windowMs:60_000,maxRequests:3,scope:'application'},
}, async ({body,principal})=>{
  try {
    const data=await importDictionaryReleaseSet(requireTenantContext(principal),principal!.subject,body.artifact);
    return Response.json({success:true,data},{status:data.idempotent?200:201});
  } catch(error) {
    if(error instanceof PolicyGovernanceOperationError)throw policyGovernanceProblem(error);
    throw error;
  }
});
