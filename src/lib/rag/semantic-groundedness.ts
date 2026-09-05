import { createHash } from 'node:crypto';
import { runJudge,type JudgeInvoker } from '@/lib/judge/router';
import { selectJudgeProfile,type JudgeProfile } from '@/lib/judge/profile';
import type { GroundednessAssessment } from './groundedness';
import type { RagCandidate } from './flow';

export async function assessSemanticGroundedness(input:{
  profiles:readonly JudgeProfile[];scope:{tenantId:string;applicationId:string};output?:string;
  /** Only ACL-, signature-, state- and content-hash-verified candidates from guardRagFlow. */
  citations:readonly RagCandidate[];traceId:string;deadline:number;
},dependencies:{invoke?:JudgeInvoker;checkEndpoint?:(p:JudgeProfile)=>Promise<void>}={}):Promise<GroundednessAssessment & {sourceDigests?:readonly string[];modelVersion?:string}>{
  const unknown=(code:string):GroundednessAssessment=>({status:'INSUFFICIENT_CONTEXT',score:0,unsupportedClaims:[],unsupportedNumbers:[],reasonCodes:[code]});
  if(input.output===undefined)return{status:'NOT_EVALUATED',score:0,unsupportedClaims:[],unsupportedNumbers:[],reasonCodes:[]};
  const scenario={...input.scope,direction:'OUTPUT_COMPLETE' as const};
  const profile=selectJudgeProfile(input.profiles,scenario,'grounding');
  if(!profile||profile.mode!=='ENFORCE'||!profile.riskIds.includes('factual_grounding'))return unknown('RAG_QUALIFIED_GROUNDING_MODEL_REQUIRED');
  if(!input.citations.length||input.citations.some(c=>!c.sourceVersion||!c.validUntilEpochMs||c.validUntilEpochMs<=Date.now()))return unknown('RAG_VERSIONED_CURRENT_EVIDENCE_REQUIRED');
  const payload={output:input.output,citations:input.citations.map(c=>({chunkId:c.chunkId,sourceId:c.sourceId,sourceVersion:c.sourceVersion,contentHash:c.contentHash,text:c.text}))};
  const text=JSON.stringify(payload);
  const outcome=await runJudge(input.profiles,{...scenario,role:'grounding',assessmentId:input.traceId.slice(0,105)+'-grounding',text,
    privateOnly:profile.deploymentMode==='private'||input.citations.some(c=>c.classification>0),absoluteDeadlineEpochMs:input.deadline,
    signal:AbortSignal.timeout(Math.max(1,input.deadline-Date.now()))},dependencies);
  if(outcome.status!=='COMPLETE'||!outcome.response)return unknown('RAG_GROUNDING_UNVERIFIED');
  const assessment=outcome.response.assessments.find(a=>a.riskId==='factual_grounding');
  if(!assessment||assessment.verdict==='UNKNOWN')return unknown('RAG_GROUNDING_UNVERIFIED');
  const outputStart='{"output":'.length+1,outputEnd=outputStart+JSON.stringify(input.output).length-2;
  if(input.citations.some(c=>!c.validUntilEpochMs||c.validUntilEpochMs<=Date.now())||
    (assessment.verdict==='UNSAFE'&&assessment.evidence.some(e=>e.start<outputStart||e.end>outputEnd)))return unknown('RAG_GROUNDING_EVIDENCE_INVALID');
  return{status:assessment.verdict==='SAFE'?'PASS':'FAIL',score:assessment.verdict==='SAFE'?1:0,
    unsupportedClaims:[],unsupportedNumbers:[],reasonCodes:[assessment.verdict==='SAFE'?'RAG_SEMANTIC_SUPPORTED':'RAG_SEMANTIC_UNSUPPORTED'],
    sourceDigests:input.citations.map(c=>createHash('sha256').update(c.sourceId+':'+c.sourceVersion+':'+c.contentHash).digest('hex')),
    modelVersion:outcome.reportedModel??profile.modelId};
}
