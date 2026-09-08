import {createHash,randomUUID} from 'node:crypto';
import {PostgresGuardQuotaStore,QuotaLimitExceededError} from '@/lib/resource-control/quota-store';
import type {JudgeProfile} from './profile';
const store=new PostgresGuardQuotaStore();
/** Shared by app and every worker. A lease outlives the bounded provider request. */
export async function reserveJudgeCapacity(profile:JudgeProfile):Promise<()=>Promise<void>>{
 const scope={tenantId:profile.tenantId,applicationId:profile.applicationId};
 const identity=createHash('sha256').update(JSON.stringify([new URL(profile.baseUrl).origin,profile.modelId])).digest('hex');
 try{
  const reservation=await store.reserve({scope,policyBundleId:'judge-admission-v1',requestId:'judge-'+randomUUID(),concurrencyLeaseMs:Math.max(65000,profile.totalTimeoutMs+5000),
   claims:[{scopeType:'MODEL',scopeId:identity,metric:'CONCURRENCY',window:'INSTANT',amount:1},{scopeType:'MODEL',scopeId:identity,metric:'REQUESTS',window:'MINUTE',amount:1}],
   limits:[{scopeType:'MODEL',metric:'CONCURRENCY',window:'INSTANT',limit:profile.maxConcurrent},{scopeType:'MODEL',metric:'REQUESTS',window:'MINUTE',limit:profile.maxRequestsPerMinute??60}]});
  return ()=>store.release(scope,reservation.releaseChargeIds);
 }catch(error:unknown){throw new Error(error instanceof QuotaLimitExceededError?'JUDGE_CAPACITY_EXCEEDED':'JUDGE_ADMISSION_UNAVAILABLE');}
}
