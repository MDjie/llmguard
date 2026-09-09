import { and,desc,eq,sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { llmProviders,users } from '@/storage/database/shared/schema';
import { requireTenantContext,scopePredicate } from '@/lib/tenancy';
import type { AuthenticatedPrincipal } from '@/lib/api-security/types';
import { normalizePlatformRole } from '@/lib/auth/authorization';
import { providerApprovalRequests } from './schema';
import { auditIam,iamDigest } from './management';
import { denied,listEffectiveApplications } from './grants';

export const providerRequestSchema=z.object({providerId:z.string().min(1).max(36),
  reason:z.string().trim().min(5).max(1000),isDefaultTarget:z.boolean().default(false),isDefaultJudge:z.boolean().default(false)}).strict();
export function providerSnapshot(row:typeof llmProviders.$inferSelect){
  return {id:row.id,name:row.name,displayName:row.displayName,providerType:row.providerType,baseUrl:row.baseUrl,
    defaultModel:row.defaultModel,useCase:row.useCase,secretDigest:iamDigest({ref:row.secretRef,legacy:row.apiKeyEncrypted}),
    config:row.configJson,version:row.governanceVersion};
}
export async function requestProviderApproval(principal:AuthenticatedPrincipal,input:z.infer<typeof providerRequestSchema>){
  if(!principal.permissions.includes('provider:manage'))throw denied('PROVIDER_MANAGE_REQUIRED');
  const scope=requireTenantContext(principal);
  return db.transaction(async tx=>{
    const [provider]=await tx.select().from(llmProviders).where(and(eq(llmProviders.id,input.providerId),scopePredicate(llmProviders,scope))).for('update');
    if(!provider||provider.isEnabled)throw denied('PROVIDER_MUST_BE_DISABLED',409);
    // The requester must be the author, preventing a second operator from laundering a self approval.
    if(provider.proposedBy!==principal.subject)throw denied('PROVIDER_AUTHOR_REQUIRED');
    const payload={...providerSnapshot(provider),isDefaultTarget:input.isDefaultTarget,isDefaultJudge:input.isDefaultJudge};
    const [request]=await tx.insert(providerApprovalRequests).values({...scope,providerId:provider.id,requesterId:principal.subject,
      payload,payloadDigest:iamDigest(payload),expectedVersion:provider.governanceVersion,reason:input.reason,
      expiresAt:new Date(Date.now()+24*3600_000)}).returning();
    await auditIam(tx,scope,'provider.approval.request',provider.id,{requestId:request.id,payloadDigest:request.payloadDigest,reason:input.reason});
    return {success:true,requestId:request.id};
  });
}
export async function listProviderApprovals(principal:AuthenticatedPrincipal){
  const scope=requireTenantContext(principal);
  const rows=await db.select().from(providerApprovalRequests).where(and(scopePredicate(providerApprovalRequests,scope),
    principal.permissions.includes('policy:approve')?undefined:eq(providerApprovalRequests.requesterId,principal.subject)))
    .orderBy(desc(providerApprovalRequests.createdAt)).limit(100);
  return {success:true,items:rows.map(row=>({...row,status:row.status==='pending'&&row.expiresAt<=new Date()?'expired':row.status}))};
}
export async function decideProviderApproval(principal:AuthenticatedPrincipal,id:string,decision:'approve'|'reject'){
  const scope=requireTenantContext(principal);
  if(!principal.permissions.includes('policy:approve'))throw denied('PROVIDER_APPROVE_REQUIRED');
  return db.transaction(async tx=>{
    const [request]=await tx.select().from(providerApprovalRequests).where(and(eq(providerApprovalRequests.id,id),scopePredicate(providerApprovalRequests,scope))).for('update');
    if(!request||request.status!=='pending'||request.expiresAt<=new Date())throw denied('PROVIDER_APPROVAL_NOT_PENDING',409);
    if(request.requesterId===principal.subject)throw denied('IAM_INDEPENDENT_APPROVAL_REQUIRED');
    const [provider]=await tx.select().from(llmProviders).where(and(eq(llmProviders.id,request.providerId),scopePredicate(llmProviders,scope))).for('update');
    const [requester]=await tx.select().from(users).where(eq(users.id,request.requesterId)).for('share');
    if(!requester||requester.status!=='active'||normalizePlatformRole(requester.role)!=='SECURITY_ADMIN'||
      !(await listEffectiveApplications(request.requesterId,scope.tenantId)).some(row=>row.app.id===scope.applicationId))throw denied('IAM_REQUESTER_AUTHORITY_REVOKED');
    if(!provider||provider.isEnabled||provider.governanceVersion!==request.expectedVersion||provider.proposedBy!==request.requesterId)throw denied('PROVIDER_VERSION_CONFLICT',409);
    const intended=z.object({isDefaultTarget:z.boolean(),isDefaultJudge:z.boolean()}).parse(request.payload);
    if(iamDigest(request.payload)!==request.payloadDigest||
      iamDigest({...providerSnapshot(provider),...intended})!==request.payloadDigest)throw denied('PROVIDER_APPROVAL_DIGEST_MISMATCH',409);
    if(decision==='approve')await tx.update(llmProviders).set({isEnabled:true,...intended,
      governanceVersion:sql`${llmProviders.governanceVersion}+1`,updatedAt:new Date()}).where(eq(llmProviders.id,provider.id));
    await tx.update(providerApprovalRequests).set({status:decision==='approve'?'approved':'rejected',reviewerId:principal.subject,decidedAt:new Date()}).where(eq(providerApprovalRequests.id,id));
    await auditIam(tx,scope,'provider.approval.decision',provider.id,{requestId:id,decision,payloadDigest:request.payloadDigest});
    return {success:true};
  });
}
