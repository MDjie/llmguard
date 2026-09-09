import { withApiSecurity } from '@/lib/api-security';
import { iamDecisionSchema } from '@/contracts/http/iam';
import { providerRequestSchema,requestProviderApproval,listProviderApprovals,decideProviderApproval } from '@/lib/iam/provider-approval';
export const GET=withApiSecurity({permission:'profile:self:write',maxBodyBytes:0,auditEvent:'provider.approval.list',
  rateLimitPolicy:{id:'provider-approval-list',windowMs:60000,maxRequests:60,scope:'principal'}},
  async({principal})=>Response.json(await listProviderApprovals(principal!)));
export const POST=withApiSecurity({permission:'provider:manage',bodySchema:providerRequestSchema,maxBodyBytes:4096,auditEvent:'provider.approval.request',
  rateLimitPolicy:{id:'provider-approval-request',windowMs:60000,maxRequests:20,scope:'principal'}},
  async({principal,body})=>Response.json(await requestProviderApproval(principal!,body)));
export const PATCH=withApiSecurity({permission:'policy:approve',bodySchema:iamDecisionSchema,maxBodyBytes:4096,auditEvent:'provider.approval.decide',
  rateLimitPolicy:{id:'provider-approval-decide',windowMs:60000,maxRequests:20,scope:'principal'}},
  async({principal,body})=>Response.json(await decideProviderApproval(principal!,body.id,body.decision)));
