import { describe, expect, it } from 'vitest';
import { evaluateNativeAssessment, nativeBindingDigest, nativeCombination } from '@/lib/multimodal/native-gate';
import type { NativeBinding, NativeAssessment } from '@/contracts/http/native-multimodal';
const binding: NativeBinding={version:'1.0',tenantId:'tenant',applicationId:'app',bundleDigest:'b'.repeat(64),direction:'INPUT',contextDigest:'c'.repeat(64),requiredRiskIds:['prompt_injection'],sources:[
  {sourceId:'text',artifactId:'context',sha256:'c'.repeat(64),contentVersion:'v1',modality:'TEXT'},
  {sourceId:'image',artifactId:'image',sha256:'d'.repeat(64),contentVersion:'v1',modality:'IMAGE'},
]};
const assessment:NativeAssessment={version:'1.0',bindingDigest:nativeBindingDigest(binding),modelId:'joint',modelDigest:'e'.repeat(64),analyzerVersion:'native-1',verdict:'NOT_DETECTED',riskIds:[],analyzedSourceIds:['text','image'],coverageScope:'GLOBAL',processingComplete:true,relations:[],reasonCodes:[]};
const approval={tenantId:'tenant',applicationId:'app',bundleDigest:binding.bundleDigest,direction:'INPUT',modelId:'joint',modelDigest:assessment.modelDigest,analyzerVersion:'native-1',combination:nativeCombination(binding),requiredRiskIds:['prompt_injection'],coverageScope:'GLOBAL',datasetDigest:'f'.repeat(64),approvalRef:'independent-review',validUntil:'2099-01-01T00:00:00.000Z',status:'PASS'};
const registry=JSON.stringify([approval]);
describe('native multimodal qualification and relationship binding',()=>{
 it('requires an independently scoped qualification beyond a clean model verdict',()=>{
  expect(evaluateNativeAssessment(binding,assessment,false,'[]').eligible).toBe(false);
  expect(evaluateNativeAssessment(binding,assessment,false,registry)).toMatchObject({eligible:true,qualified:true,verdict:'NOT_DETECTED',action:'ALLOW'});
 });
 it('does not turn a heuristic action difference into confirmed attack',()=>{
  expect(evaluateNativeAssessment(binding,null,true,registry)).toMatchObject({verdict:'SUSPECTED',eligible:false,action:'REQUIRE_REVIEW',relations:[]});
 });
 it('binds source identity, order, version, context, direction and bundle',()=>{
  for(const change of [{sources:[...binding.sources].reverse()},{sources:binding.sources.map((s,i)=>i?{...s,contentVersion:'v2'}:s)},{contextDigest:'a'.repeat(64)},{direction:'OUTPUT_COMPLETE' as const},{bundleDigest:'a'.repeat(64)},{applicationId:'other'}]) expect(evaluateNativeAssessment({...binding,...change},assessment,false,registry).eligible).toBe(false);
 });
 it('rejects omitted or repeated analyzed sources and hallucinated relations',()=>{
  expect(evaluateNativeAssessment(binding,{...assessment,analyzedSourceIds:['image']},false,registry).eligible).toBe(false);
  expect(evaluateNativeAssessment(binding,{...assessment,analyzedSourceIds:['image','image']},false,registry).eligible).toBe(false);
  const relation={relationId:'rel',sourceEvidenceIds:['text'],targetEvidenceIds:['missing'],relationType:'instruction_target',riskId:'prompt_injection',verdict:'CONFIRMED',explanation:'joint risk'};
  expect(evaluateNativeAssessment(binding,{...assessment,verdict:'CONFIRMED',riskIds:['prompt_injection'],relations:[relation]},false,registry)).toMatchObject({qualified:false,reasonCodes:['NATIVE_RELATION_SOURCE_INVALID']});
 });
 it('keeps confirmed graph evidence and blocks only with valid sources and qualification',()=>{
  const relation={relationId:'rel',sourceEvidenceIds:['text'],targetEvidenceIds:['image'],relationType:'instruction_target',riskId:'prompt_injection',verdict:'CONFIRMED',explanation:'instruction and target reside in different sources'};
  const result=evaluateNativeAssessment(binding,{...assessment,verdict:'CONFIRMED',riskIds:['prompt_injection'],relations:[relation]},false,registry);
  expect(result).toMatchObject({verdict:'CONFIRMED',action:'BLOCK',eligible:false});expect(result.relations).toEqual([relation]);
 });
 it('does not reuse model, direction, combination or expired qualifications',()=>{
  for(const change of [{modelDigest:'1'.repeat(64)},{direction:'OUTPUT_COMPLETE'},{combination:'IMAGE'},{validUntil:'2000-01-01T00:00:00.000Z'},{requiredRiskIds:['other']},{applicationId:'other'}])expect(evaluateNativeAssessment(binding,assessment,false,JSON.stringify([{...approval,...change}])).eligible).toBe(false);
 });
 it('does not promote windows, incomplete processing or unknown verdicts to global completion',()=>{
  for(const change of [{coverageScope:'WINDOW'},{processingComplete:false},{verdict:'UNKNOWN'},{reasonCodes:['ASR_TRACK_SKIPPED']}])expect(evaluateNativeAssessment(binding,{...assessment,...change},false,registry).eligible).toBe(false);
 });
 it('rejects contradictory clean verdicts and evidence-free mixed attack claims',()=>{
  expect(evaluateNativeAssessment(binding,{...assessment,riskIds:['prompt_injection']},false,registry).reasonCodes).toContain('NATIVE_VERDICT_INCONSISTENT');
  expect(evaluateNativeAssessment(binding,{...assessment,verdict:'CONFIRMED',riskIds:['prompt_injection']},false,registry).reasonCodes).toContain('NATIVE_VERDICT_INCONSISTENT');
 });
});
