import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { policyProfiles, llmProviders } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { judgeProfileListSchema, judgeProfileSchema, validateJudgeProfileSet, type JudgeProfile } from './profile';
import { providerBaseUrl, parseProviderType } from '@/lib/providers/chat';
import { assertJudgeEndpoint, profileDigest } from './profile-registry';
import { riskDefinition } from '@/lib/guard-engine-v2/risk-registry';
import { semanticCoveragePolicySchema,type SemanticCoveragePolicy } from '@/lib/guard-engine-v2/semantic-coverage';
import { readProviderDeployment } from '@/lib/providers/deployment';

const draftSchema = z.object({profilesV2:judgeProfileListSchema.default([]),revision:z.number().int().nonnegative().default(0),decisionPolicyVersion:z.union([z.literal(1),z.literal(2)]).default(1),
  semanticDecisionMode:z.literal('coverage-v1').optional(),semanticCoverage:semanticCoveragePolicySchema.optional()}).strict();
export function parseJudgeDraft(metadata: Record<string,unknown> | null) {
  return draftSchema.parse(metadata?.judgeDraft ?? {});
}
export async function loadJudgeDraft(scope:TenantScope, policyId:string) {
  const [row] = await db.select({metadata:policyProfiles.metadata}).from(policyProfiles).where(and(eq(policyProfiles.id,policyId),scopePredicate(policyProfiles,scope))).limit(1);
  if (!row) throw new Error('JUDGE_POLICY_NOT_FOUND');
  return parseJudgeDraft(row.metadata);
}
export async function saveJudgeDraft(scope:TenantScope, policyId:string, profiles:readonly JudgeProfile[], expectedRevision:number, decisionPolicyVersion:1|2,coverage?:{semanticDecisionMode?:'coverage-v1';semanticCoverage?:SemanticCoveragePolicy}) {
  return db.transaction(async tx => {
    const [row] = await tx.select({metadata:policyProfiles.metadata}).from(policyProfiles).where(and(eq(policyProfiles.id,policyId),scopePredicate(policyProfiles,scope))).limit(1).for('update');
    if (!row) throw new Error('JUDGE_POLICY_NOT_FOUND');
    const current = parseJudgeDraft(row.metadata);
    if (current.revision !== expectedRevision) throw new Error('JUDGE_DRAFT_CONFLICT');
    const ids = [...new Set(profiles.map(p=>p.providerId))];
    const providers = ids.length ? await tx.select().from(llmProviders).where(and(inArray(llmProviders.id,ids),scopePredicate(llmProviders,scope))) : [];
    const bound:JudgeProfile[] = [];
    for (const candidate of profiles) {
      const provider = providers.find(p=>p.id === candidate.providerId);
      if (!provider || !provider.isEnabled || !['judge','both'].includes(provider.useCase ?? '')) throw new Error('JUDGE_PROVIDER_UNAVAILABLE');
      if (candidate.tenantId !== scope.tenantId || candidate.applicationId !== scope.applicationId) throw new Error('JUDGE_SCOPE_MISMATCH');
      const baseUrl = providerBaseUrl(parseProviderType(provider.providerType),provider.baseUrl);
      // Endpoint and credentials are selected through the existing provider screen.
      if (new URL(candidate.baseUrl).href.replace(/\/$/,'') !== new URL(baseUrl).href.replace(/\/$/,'') || candidate.providerType !== provider.providerType) throw new Error('JUDGE_PROVIDER_SNAPSHOT_MISMATCH');
      const previous = current.profilesV2.find(p=>p.profileId === candidate.profileId);
      const riskDefinitions = Object.fromEntries(candidate.riskIds.map(id=>[id,riskDefinition(id,candidate.riskDefinitions)]));
      const deployment = readProviderDeployment(provider.configJson);
      const boundAuthMode = deployment?.authMode ?? candidate.authMode;
      let p = judgeProfileSchema.parse({...candidate,baseUrl,riskDefinitions,
        ...(deployment ? {deploymentMode:deployment.deploymentMode,dataBoundaryPolicyId:deployment.dataBoundaryPolicyId,authMode:deployment.authMode} : {}),
        authHeaderName:deployment?.authHeaderName,
        secretRef:boundAuthMode !== 'none' ? provider.secretRef ?? undefined : undefined,revision:previous?.revision ?? 1});
      if (p.enabled) await assertJudgeEndpoint(p);
      if (previous && profileDigest(previous) !== profileDigest(p)) p = {...p,revision:previous.revision+1};
      bound.push(p);
    }
    validateJudgeProfileSet(bound);
    if (Buffer.byteLength(JSON.stringify(bound),'utf8') > 512*1024) throw new Error('JUDGE_DRAFT_CAPACITY_EXCEEDED');
    const next = draftSchema.parse({profilesV2:bound,revision:current.revision+1,decisionPolicyVersion,...coverage});
    if(next.semanticDecisionMode && (next.decisionPolicyVersion!==2||!next.semanticCoverage))throw new Error('JUDGE_COVERAGE_CONFIGURATION_REQUIRED');
    await tx.update(policyProfiles).set({metadata:{...(row.metadata ?? {}),judgeDraft:next}}).where(and(eq(policyProfiles.id,policyId),scopePredicate(policyProfiles,scope)));
    return next;
  });
}
