import { z } from 'zod';
import { dictionaryEntrySchema, dictionaryManifestSchema } from '@/contracts/http/policy-governance';
import { detectionCaseSchema } from '@/lib/evaluation/optimization-dataset';
import { prepareDataset } from '@/lib/evaluation/dataset-workbench';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { riskDefinition } from '@/lib/guard-engine-v2/risk-registry';
const id=z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const financialBusinessSchema=z.enum(['BANKING','SECURITIES','INSURANCE','PAYMENTS','AML','WEALTH','CREDIT','INTERNAL_OPERATIONS']);
export const financialLibrarySchema=z.object({version:z.literal('1.1'),libraryId:id,sourceId:id,sourceLicense:z.string().min(1),origin:z.enum(['synthetic','customer','public']),owner:id,
 terms:z.array(z.object({termId:id,businessLine:financialBusinessSchema,term:z.string().min(2).max(100),riskId:id,direction:z.enum(['INPUT','OUTPUT_COMPLETE']),
  riskExample:z.string().min(10).max(4096),normalExample:z.string().min(10).max(4096),normalIntent:z.enum(['EDUCATION','RISK_DISCLOSURE','QUOTE','COMPLIANCE_REVIEW','AUTHORIZED_SERVICE']),
  distinction:z.string().min(10).max(1000),sourceRef:z.string().min(1).max(500),
 }).strict()).min(1).max(500)}).strict();
/** White examples are scoped evidence for review, never a global ALLOW rule or a platform-redline exemption. */
export function buildFinancialCandidates(raw:unknown){
 const library=financialLibrarySchema.parse(raw),sourceHash=sha256(canonicalJson(library));
 if(new Set(library.terms.map(t=>t.termId)).size!==library.terms.length)throw new Error('FINANCIAL_TERM_DUPLICATE');
 const entries=library.terms.map(term=>{
  riskDefinition(term.riskId);
  if(!term.riskExample.includes(term.term)||!term.normalExample.includes(term.term)||term.riskExample===term.normalExample)throw new Error('FINANCIAL_MINIMAL_CONTEXT_PAIR_REQUIRED');
  return dictionaryEntrySchema.parse({canonicalTermId:term.termId,sourceIds:[library.sourceId],canonicalTerm:term.term,variants:[term.term],riskType:term.riskId,matchType:'contains',score:0.65,severity:'MEDIUM',mandatoryDeny:false,locale:'zh-CN',direction:term.direction,industry:'finance',contexts:[],owner:library.owner,
    actionHint:'CONTEXT_REVIEW',evidenceRequirement:'必须结合行为、对象授权和业务语境复核：'+term.distinction,
    positiveExamples:[term.riskExample],negativeExamples:['查询营业网点的办公时间和服务电话。'],
    contextCases:[{caseId:term.termId+'.risk',text:term.riskExample,expectedRiskIds:[term.riskId],acceptableActions:['BLOCK','REQUIRE_REVIEW']},{caseId:term.termId+'.normal',text:term.normalExample,expectedRiskIds:[],acceptableActions:['ALLOW','WARN']}],
  });
 });
 const cases=library.terms.flatMap(term=>(['risk','normal'] as const).map(kind=>detectionCaseSchema.parse({caseId:term.termId+'.'+kind,groupId:term.termId,sourceId:library.sourceId,sourceLicense:library.sourceLicense,sourceHash,sourceGroupId:term.termId,templateFamily:term.termId,
  split:'development',text:kind==='risk'?term.riskExample:term.normalExample,industry:'finance',direction:term.direction,locale:'zh-CN',modality:'text',expectedRiskIds:kind==='risk'?[term.riskId]:[],acceptableActions:kind==='risk'?['BLOCK','REQUIRE_REVIEW']:['ALLOW','WARN'],
  familyTags:['financial',term.businessLine,kind==='risk'?'actionable_candidate':term.normalIntent],annotationStatus:'needs_review',reviewers:[],authorizedExternalUse:false})));
 const workbench=prepareDataset(cases,library.origin,library.owner);
 return {schemaVersion:'1.1',kind:'financial-candidate-package',libraryDigest:sourceHash,publicationState:'DRAFT_ONLY',qualityState:'INDEPENDENT_REVIEW_REQUIRED',source: {id:library.sourceId,license:library.sourceLicense,origin:library.origin},
  manifest:dictionaryManifestSchema.parse({schemaVersion:'1.0',policyId:'financial-review-required',dictionaryId:library.libraryId,version:'1.1-candidate',layer:'INDUSTRY',entries}),
  normalContextPolicy:{globalAllowRules:0,platformRedlineOverrides:0,effect:'REVIEW_EVIDENCE_ONLY'},
  businessCoverage:Object.fromEntries(financialBusinessSchema.options.map(line=>[line,library.terms.filter(t=>t.businessLine===line).length])),
  distinctions:library.terms.map(term=>({termId:term.termId,businessLine:term.businessLine,normalIntent:term.normalIntent,distinction:term.distinction,sourceRef:term.sourceRef})),workbench};
}
