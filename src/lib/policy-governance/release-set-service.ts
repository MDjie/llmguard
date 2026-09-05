import { sign } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { dictionaryReleases, dictionaryReleaseSets, dictionaryReleaseTransitions, policyProfiles } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { policySigningKeyId, signingPrivateKey } from '@/lib/policy-bundle/crypto';
import { clearRuntimePolicyBundleCache } from '@/lib/policy-bundle/runtime';
import { insertDictionaryDraft } from './dictionaries';
import { releaseSetArtifactSchema, verifyReleaseSetArtifact } from './release-set';
import { releaseSetSigningPayload, verifyReleaseSetMembers, type ReleaseSetRow } from './release-set-integrity';
import { testDictionaryManifest, validateDictionaryManifest } from './validation';
import { PolicyGovernanceOperationError } from './errors';

type Transaction=Parameters<Parameters<typeof db.transaction>[0]>[0];
type Member=typeof dictionaryReleases.$inferSelect;
export const importReleaseSetSchema=z.object({artifact:releaseSetArtifactSchema}).strict();
export const releaseSetOperationSchema=z.object({
  expectedRevision:z.number().int().min(1),
  reason:z.string().trim().min(1).max(500),
}).strict();
export type ReleaseSetOperation='approve'|'shadow'|'canary'|'activate'|'rollback';

function summary(row:ReleaseSetRow) {
  return {id:row.id,policyId:row.policyId,dictionaryId:row.dictionaryId,version:row.version,state:row.state,
    revision:row.revision,contentHash:row.contentHash,shardCount:row.shardCount,submittedBy:row.submittedBy,
    approvedBy:row.approvedBy,previousSetId:row.previousSetId,createdAt:row.createdAt,policyBindingChanged:false};
}
async function familyLock(tx:Transaction,scope:TenantScope,dictionaryId:string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId+':'+scope.applicationId+':release-set:'+dictionaryId}))`);
}
async function membersForUpdate(tx:Transaction,scope:TenantScope,root:ReleaseSetRow) {
  const members=await tx.select().from(dictionaryReleases).where(and(scopePredicate(dictionaryReleases,scope),
    eq(dictionaryReleases.releaseSetId,root.id))).orderBy(asc(dictionaryReleases.partNumber)).for('update');
  verifyReleaseSetMembers(root,members);
  return members;
}

export async function listDictionaryReleaseSets(scope:TenantScope) {
  const rows=await db.select().from(dictionaryReleaseSets).where(scopePredicate(dictionaryReleaseSets,scope))
    .orderBy(desc(dictionaryReleaseSets.createdAt)).limit(200);
  return {items:rows.map(summary),limit:200};
}

export async function importDictionaryReleaseSet(scope:TenantScope,actorId:string,raw:unknown) {
  let artifact;
  try { artifact=verifyReleaseSetArtifact(raw); }
  catch { throw new PolicyGovernanceOperationError('DICTIONARY_SET_ARTIFACT_INVALID','Release-set verification failed; no shards were imported.',422); }
  // Validation and signature construction happen before any inserts. A reviewed artifact is still a DB draft.
  const canonicalManifest={...artifact};
  const signed={signature:sign(null,Buffer.from(releaseSetSigningPayload({...scope,canonicalManifest})),signingPrivateKey()).toString('base64url'),signingKeyId:policySigningKeyId()};
  return db.transaction(async tx=>{
    await familyLock(tx,scope,artifact.dictionaryId);
    const [policy]=await tx.select({id:policyProfiles.id}).from(policyProfiles).where(and(
      scopePredicate(policyProfiles,scope),eq(policyProfiles.id,artifact.policyId))).limit(1);
    if(!policy)throw new PolicyGovernanceOperationError('DICTIONARY_POLICY_NOT_FOUND','Target policy is outside this application scope.',404);
    const [existing]=await tx.select().from(dictionaryReleaseSets).where(and(scopePredicate(dictionaryReleaseSets,scope),
      eq(dictionaryReleaseSets.dictionaryId,artifact.dictionaryId),eq(dictionaryReleaseSets.version,artifact.version))).for('update');
    if(existing) {
      if(existing.contentHash!==artifact.releaseSetDigest || existing.policyId!==artifact.policyId)
        throw new PolicyGovernanceOperationError('DICTIONARY_SET_VERSION_CONFLICT','This immutable version already contains different content.',409);
      await membersForUpdate(tx,scope,existing);
      return {...summary(existing),idempotent:true};
    }
    const [root]=await tx.insert(dictionaryReleaseSets).values({...scope,policyId:artifact.policyId,
      dictionaryId:artifact.dictionaryId,version:artifact.version,canonicalManifest,contentHash:artifact.releaseSetDigest,
      ...signed,shardCount:artifact.shards.length,submittedBy:actorId}).returning();
    for(const [index,shard] of artifact.shards.entries()) {
      await insertDictionaryDraft(tx,scope,actorId,shard.manifest,{releaseSetId:root.id,partNumber:index+1});
    }
    await membersForUpdate(tx,scope,root);
    return {...summary(root),idempotent:false};
  });
}

async function transition(tx:Transaction,scope:TenantScope,root:ReleaseSetRow,members:Member[],
  state:string,actorId:string,action:string,reason:string,extra:Partial<Pick<ReleaseSetRow,'approvedBy'|'approvedAt'|'previousSetId'>>={}) {
  const [updated]=await tx.update(dictionaryReleaseSets).set({state,revision:root.revision+1,...extra})
    .where(and(scopePredicate(dictionaryReleaseSets,scope),eq(dictionaryReleaseSets.id,root.id))).returning();
  await tx.update(dictionaryReleases).set({state,
    ...(extra.approvedBy ? {approvedBy:extra.approvedBy,approvedAt:extra.approvedAt} : {}),
    ...(state==='active' ? {activatedAt:new Date()} : {}),
    ...(state==='rolled_back' ? {rolledBackAt:new Date()} : {}),
  }).where(and(scopePredicate(dictionaryReleases,scope),eq(dictionaryReleases.releaseSetId,root.id)));
  await tx.insert(dictionaryReleaseTransitions).values(members.map(member=>({...scope,releaseId:member.id,
    fromState:member.state,toState:state,action:'set_'+action,actorId,reason,manifestHash:member.contentHash})));
  return updated;
}

export async function operateDictionaryReleaseSet(scope:TenantScope,actorId:string,id:string,
  operation:ReleaseSetOperation,raw:z.infer<typeof releaseSetOperationSchema>) {
  const input=releaseSetOperationSchema.parse(raw);
  const result=await db.transaction(async tx=>{
    // Acquire the family lock before row locks so concurrent activation/rollback cannot deadlock.
    const [found]=await tx.select().from(dictionaryReleaseSets).where(and(scopePredicate(dictionaryReleaseSets,scope),eq(dictionaryReleaseSets.id,id))).limit(1);
    if(!found)throw new PolicyGovernanceOperationError('DICTIONARY_SET_NOT_FOUND','Release set not found in this application.',404);
    await familyLock(tx,scope,found.dictionaryId);
    const [root]=await tx.select().from(dictionaryReleaseSets).where(and(scopePredicate(dictionaryReleaseSets,scope),eq(dictionaryReleaseSets.id,id))).for('update');
    if(root.revision!==input.expectedRevision)throw new PolicyGovernanceOperationError('DICTIONARY_SET_REVISION_CONFLICT','Refresh the release set before retrying.',409);
    const members=await membersForUpdate(tx,scope,root);
    const artifact=verifyReleaseSetArtifact(root.canonicalManifest);
    if(operation==='approve') {
      if(root.state!=='draft')throw new PolicyGovernanceOperationError('DICTIONARY_SET_STATE_INVALID','Only drafts may be approved.',409);
      if(actorId===root.submittedBy)throw new PolicyGovernanceOperationError('DICTIONARY_SET_INDEPENDENT_REVIEW_REQUIRED','A different authorized reviewer must approve this release set.',409);
      for(const shard of artifact.shards) {
        if(!validateDictionaryManifest(shard.manifest).passed || !testDictionaryManifest(shard.manifest).passed)
          throw new PolicyGovernanceOperationError('DICTIONARY_SET_TEST_FAILED','Every shard must pass validation and lexical tests.',422);
      }
      return summary(await transition(tx,scope,root,members,'reviewed',actorId,operation,input.reason,{approvedBy:actorId,approvedAt:new Date()}));
    }
    if(operation==='shadow' || operation==='canary') {
      if(root.state!=='reviewed')throw new PolicyGovernanceOperationError('DICTIONARY_SET_STATE_INVALID','Publish requires a reviewed release set.',409);
      return summary(await transition(tx,scope,root,members,operation,actorId,operation,input.reason));
    }
    if(operation==='activate') {
      if(!['shadow','canary'].includes(root.state))throw new PolicyGovernanceOperationError('DICTIONARY_SET_STATE_INVALID','Activation requires a shadow/canary release set.',409);
      const [previous]=await tx.select().from(dictionaryReleaseSets).where(and(scopePredicate(dictionaryReleaseSets,scope),
        eq(dictionaryReleaseSets.dictionaryId,root.dictionaryId),eq(dictionaryReleaseSets.state,'active'))).for('update');
      if(previous) {
        if(previous.policyId!==root.policyId)throw new PolicyGovernanceOperationError('DICTIONARY_SET_POLICY_CONFLICT','A dictionary family cannot silently replace another policy.',409);
        const previousMembers=await membersForUpdate(tx,scope,previous);
        await transition(tx,scope,previous,previousMembers,'deprecated',actorId,'supersede',input.reason);
      }
      return summary(await transition(tx,scope,root,members,'active',actorId,operation,input.reason,{previousSetId:previous?.id ?? null}));
    }
    if(root.state!=='active' || !root.previousSetId)throw new PolicyGovernanceOperationError('DICTIONARY_SET_ROLLBACK_UNAVAILABLE','No exact previous active release set is available.',409);
    const [previous]=await tx.select().from(dictionaryReleaseSets).where(and(scopePredicate(dictionaryReleaseSets,scope),
      eq(dictionaryReleaseSets.id,root.previousSetId))).for('update');
    if(!previous || previous.dictionaryId!==root.dictionaryId || previous.policyId!==root.policyId ||
      !['deprecated','rolled_back'].includes(previous.state) || !previous.approvedBy)
      throw new PolicyGovernanceOperationError('DICTIONARY_SET_ROLLBACK_INVALID','The exact previous release set is unavailable or invalid.',422);
    const previousMembers=await membersForUpdate(tx,scope,previous);
    await transition(tx,scope,root,members,'rolled_back',actorId,operation,input.reason);
    return summary(await transition(tx,scope,previous,previousMembers,'active',actorId,'restore',input.reason));
  });
  clearRuntimePolicyBundleCache();
  return result;
}
