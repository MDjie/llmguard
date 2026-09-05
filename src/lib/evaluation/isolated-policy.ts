import { randomBytes,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseCompiledPolicyBundlePayload,type RuntimePolicyBundle } from '@/lib/policy-bundle/runtime';
import { preparePolicyBundleEngine } from '@/lib/guard-engine-v2/from-policy-bundle';
import { createGuardEngine } from '@/lib/guard-engine-v2/engine';
import { ConfigurableJudgeDetector } from '@/lib/guard-engine-v2/judge-detector';
import { applyOutputIntervention } from '@/lib/output-control';
import type { GuardDetector,Observation,GuardRequest } from '@/lib/guard-engine-v2/types';
import { isConfirmedObservation } from '@/lib/guard-engine-v2/observation-role';
import { invokeConfiguredJudge,type JudgeInvoker } from '@/lib/judge/router';
import { profileDigest } from '@/lib/judge/profile-registry';
import { reserveJudgeTokens } from '@/lib/judge/token-reservation';
import type { JudgeProfile } from '@/lib/judge/profile';
import { parseJudgeResponse } from '@/lib/judge/response-schema';
import { detectionCaseSchema } from './optimization-dataset';
import { artifactDigest } from './dataset-workbench';
import { evaluationRunSchema,evaluatedCaseSchema } from './optimization-report';
import { isolatedBudgetSchema } from './isolated-judge';

const variantSchema=z.enum(['B0','B1','S1','H1']);
type Variant=z.infer<typeof variantSchema>;
/** Simulation is confined to this evaluation module. Never returns an engine, signed bundle or GuardDecision. */
export async function evaluateIsolatedPolicy(input:{payload:unknown;cases:readonly unknown[];variant:Variant;budget:unknown;scope:{tenantId:string;applicationId:string}},
  dependencies:{invoke?:JudgeInvoker;checkEndpoint?:(profile:JudgeProfile)=>Promise<void>}={}){
  const original=parseCompiledPolicyBundlePayload(input.payload),variant=variantSchema.parse(input.variant);
  const cases=z.array(detectionCaseSchema).min(1).max(1000).parse(input.cases),budget=isolatedBudgetSchema.parse(input.budget);
  if(cases.length>budget.maximumCases||new Set(cases.map(c=>c.caseId)).size!==cases.length)throw new Error('ISOLATED_POLICY_CASE_LIMIT');
  const sourceProfiles=original.judgeProfiles??[];
  const scope=z.object({tenantId:z.string().min(1).max(128),applicationId:z.string().min(1).max(128)}).strict().parse(input.scope);
  if(sourceProfiles.some(p=>p.tenantId!==scope.tenantId||p.applicationId!==scope.applicationId))throw new Error('ISOLATED_POLICY_SCOPE_MISMATCH');
  if(cases.some(c=>!c.authorizedExternalUse)&&(sourceProfiles.some(p=>p.deploymentMode==='cloud')||original.semanticClassifier?.coverage?.deploymentMode==='cloud'))throw new Error('EVALUATION_EXTERNAL_DATA_NOT_AUTHORIZED');
  // The older classifier has no candidate protocol adapter. Refuse, never silently skip it.
  if(original.semanticClassifier)throw new Error('ISOLATED_POLICY_CLASSIFIER_REQUIRES_SEPARATE_APPROVED_BENCHMARK');
  if(variant!=='B0'&&(!sourceProfiles.some(p=>p.enabled&&(p.role??'base')==='base')||original.semanticDecisionMode!=='coverage-v1'))throw new Error('ISOLATED_POLICY_COVERAGE_PROFILE_REQUIRED');
  const profiles=sourceProfiles.map(p=>({...p,mode:'SHADOW' as const}));
  const payload=variant==='B0'?original:{...original,detectorDag:undefined,
    ...(variant==='B1'?{decisionPolicyVersion:1 as const,semanticDecisionMode:undefined,semanticCoverage:undefined,judgeProfiles:[]}:{judgeProfiles:profiles,
      ...(variant==='S1'?{rules:original.rules.filter(r=>r.mandatoryDeny),judgeProfiles:profiles.filter(p=>(p.role??'base')==='base')}:{})})};
  const runId='isolated-policy-'+randomUUID(),bundle:RuntimePolicyBundle={id:runId,generation:0,payload};
  const recipe=preparePolicyBundleEngine(bundle),hmacKey=randomBytes(32);
  const started=performance.now(),deadline=Date.now()+budget.totalTimeoutMs;
  let next=0,calls=0,reservedTokens=0;
  const rows:z.infer<typeof evaluatedCaseSchema>[]=[];
  const callDiagnostics:Array<{caseId:string;assessmentId:string;profileDigest:string;reportedModel?:string;finishReason?:string|null;status:string;responseDigest:string}>=[];
  const traces:Array<{caseId:string;traceId:string;observations:readonly Observation[];policyPath:readonly string[];modelCalls:number}>=[];
  const worker=async()=>{while(next<cases.length){
    const c=cases[next++],queueMs=performance.now()-started,serviceStart=performance.now();
    const traceId=runId+'-'+artifactDigest(c.caseId).slice(0,12);let caseCalls=0,budgetExhausted=false;
    const invoke:JudgeInvoker=async(p,r,s)=>{
      const reserve=reserveJudgeTokens(p,r.text);
      if(calls>=budget.maximumCalls||reservedTokens+reserve>budget.maximumReservedTokens||Date.now()>=deadline){budgetExhausted=true;throw new Error('ISOLATED_POLICY_BUDGET_EXHAUSTED');}
      calls++;caseCalls++;reservedTokens+=reserve;
      const raw=await(dependencies.invoke??invokeConfiguredJudge)(p,r,s);
      let status='COMPLETE';
      try{parseJudgeResponse(raw.content,r.assessmentId,p.riskIds,r.text);}catch(error){
        status=error instanceof z.ZodError?'JUDGE_SCHEMA_INVALID':error instanceof Error&&/^JUDGE_[A-Z_]+$/u.test(error.message)?error.message:'JUDGE_JSON_INVALID';
      }
      callDiagnostics.push({caseId:c.caseId,assessmentId:r.assessmentId,profileDigest:profileDigest(p),reportedModel:raw.reportedModel,finishReason:raw.finishReason,status,responseDigest:artifactDigest(raw.content)});
      return raw;
    };
    const detectorDependencies={invoke,checkEndpoint:dependencies.checkEndpoint};
    const detectors:GuardDetector[]=recipe.detectors.map(detector=>{
      if(detector.id!=='configurable-judge')return detector;
      if(variant==='B0')return new ConfigurableJudgeDetector(sourceProfiles,detectorDependencies,original.semanticDecisionMode);
      // Force SHADOW on the wire; interpret observations only within this non-promotable simulation.
      const promote=(items:readonly Observation[]):Observation[]=>items.map(o=>{
        if(o.reasonCode?.endsWith('_SHADOW_SAFE'))return{...o,status:'NO_MATCH',decisionRole:'CLEARED'};
        if(o.reasonCode?.endsWith('_SHADOW_UNSAFE'))return{...o,status:'MATCH',decisionRole:'CONFIRMED_RISK'};
        return o;
      });
      return{id:detector.id,version:detector.version,required:detector.required,async detect(ctx){
        const base=profiles.filter(p=>(p.role??'base')==='base'),refiners=variant==='H1'?profiles.filter(p=>p.role==='refiner'):[];
        const sharedDeadline=Math.min(ctx.request.context.absoluteDeadlineEpochMs,Date.now()+Math.max(1,...base.map(p=>p.totalTimeoutMs)));
        const shared={...ctx,request:{...ctx.request,context:{...ctx.request.context,absoluteDeadlineEpochMs:sharedDeadline}}};
        const findings=promote(await new ConfigurableJudgeDetector(base,detectorDependencies,'coverage-v1').detect(shared));
        if(refiners.length)findings.push(...promote(await new ConfigurableJudgeDetector(refiners,detectorDependencies,'coverage-v1').detect({...shared,previousObservations:[...(ctx.previousObservations??[]),...findings]})));
        return findings;
      }};
    });
    const policy=variant==='S1'||variant==='H1'?{...recipe.policy,judgeProfiles:(payload.judgeProfiles??[]).map(p=>({...p,mode:'ENFORCE' as const}))}:recipe.policy;
    const engine=createGuardEngine(policy,detectors,{hmacKey});
    const request:GuardRequest={contractVersion:'1.0',context:{requestId:traceId,traceId,...scope,
      policyBundleId:bundle.id,direction:c.direction,locale:c.locale,industry:c.industry,absoluteDeadlineEpochMs:deadline},content:{text:c.text}};
    try{
      if(c.modality!=='text')throw new Error('ISOLATED_POLICY_MODALITY_UNSUPPORTED');
      const raw=await engine.evaluate(request);
      const decision=await applyOutputIntervention(request,raw,bundle,{evidenceHmacKey:hmacKey,evaluateRecheck:engine.evaluate});
      const complete=!decision.degraded&&decision.evidenceComplete;
      rows.push(evaluatedCaseSchema.parse({caseId:c.caseId,traceId,requestHash:artifactDigest(c),confirmedRiskIds:[...new Set(decision.observations.filter(isConfirmedObservation).map(o=>o.riskType))],
        action:decision.action,effect:'UNKNOWN',complete,evidenceComplete:decision.evidenceComplete,modelCalls:caseCalls,queueMs,
        serviceMs:performance.now()-serviceStart,totalMs:performance.now()-started,outcome:complete?'COMPLETE':'UNKNOWN',
        reasonCodes:[...(decision.reasonCodes??[]),...(decision.degradationReasons??[]),...(budgetExhausted?['ISOLATED_POLICY_BUDGET_EXHAUSTED']:[])]}));
      traces.push({caseId:c.caseId,traceId,observations:decision.observations,policyPath:decision.policyPath,modelCalls:caseCalls});
    }catch{
      rows.push(evaluatedCaseSchema.parse({caseId:c.caseId,traceId,requestHash:artifactDigest(c),confirmedRiskIds:[],action:'REQUIRE_REVIEW',effect:'UNKNOWN',complete:false,evidenceComplete:false,
        modelCalls:caseCalls,queueMs,serviceMs:performance.now()-serviceStart,totalMs:performance.now()-started,outcome:Date.now()>=deadline?'TIMEOUT':'ERROR',reasonCodes:[c.modality!=='text'?'ISOLATED_POLICY_MODALITY_UNSUPPORTED':'ISOLATED_POLICY_EVALUATION_FAILED']}));
    }
  }};
  await Promise.all(Array.from({length:Math.min(cases.length,budget.concurrency)},worker));
  const run=evaluationRunSchema.parse({schemaVersion:'2.0',kind:'detection-evaluation-run',variant,datasetDigest:artifactDigest(cases),bundleDigest:artifactDigest(original),profileDigests:sourceProfiles.map(profileDigest),cases:rows.sort((a,b)=>a.caseId.localeCompare(b.caseId))});
  return{schemaVersion:'2.0',kind:'isolated-policy-simulation',productionEligible:false,qualityStatus:'INSUFFICIENT_EVIDENCE',
    runId,run,simulationPayloadDigest:artifactDigest(JSON.parse(JSON.stringify(payload)) as unknown),traces,callDiagnostics,budget,calls,reservedTokens,wallTimeMs:performance.now()-started,
    effectStatus:'NOT_OBSERVED_REQUIRES_INDEPENDENT_EFFECT_ORACLE',note:'B0 uses supplied baseline; B1 removes semantics; S1 removes nonmandatory dictionary rules and refiners, preserving deterministic security controls; H1 is hybrid.'};
}
