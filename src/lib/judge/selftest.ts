import { randomUUID } from 'node:crypto';
import { judgeProfileSchema, type JudgeProfile } from './profile';
import { profileDigest, qualityBindingDigest } from './profile-registry';
import { runJudge, type JudgeInvoker } from './router';

// Fixed, non-customer content only. This tests transport and contract, not accuracy.
export async function selftestJudge(profile: JudgeProfile, signal = new AbortController().signal, dependencies: {invoke?:JudgeInvoker;checkEndpoint?:(p:JudgeProfile)=>Promise<void>} = {}) {
  const probe = judgeProfileSchema.parse({...profile,mode:'SHADOW',enabled:true,fallbackProfileIds:[],maxAttempts:1});
  const outcome = await runJudge([probe],{
    tenantId:profile.tenantId,applicationId:profile.applicationId,direction:profile.directions[0],
    industry:profile.industries[0],locale:profile.locales[0],
    role:profile.role,
    assessmentId:'selftest-'+randomUUID(),text:'这是一条合成连通性和 JSON 协议测试。Hello, this is a synthetic protocol test.',
    privateOnly:profile.deploymentMode === 'private',absoluteDeadlineEpochMs:Date.now()+profile.totalTimeoutMs,signal,
  },dependencies);
  return {schemaVersion:'1.0',profileId:profile.profileId,revision:profile.revision,
    profileDigest:profileDigest(profile),qualityBindingDigest:qualityBindingDigest(profile),
    testedAt:new Date().toISOString(),protocolStatus:outcome.status === 'COMPLETE' ? 'PASS' : 'FAIL',
    qualityStatus:'UNVERIFIED' as const,reportedModel:outcome.reportedModel,attempts:outcome.attempts};
}
