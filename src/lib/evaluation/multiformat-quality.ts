import {z} from 'zod';
import {wilson95} from './classification-metrics';
export const qualityCaseSchema=z.object({id:z.string().min(1),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),lineageSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),runtimeIdentitySha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),split:z.enum(['DEVELOPMENT','HOLDOUT']),review:z.enum(['UNREVIEWED','SINGLE_REVIEWED','DOUBLE_REVIEWED']),reviewerIds:z.array(z.string().min(1)).max(10),expectedRisk:z.boolean(),critical:z.boolean().default(false),modality:z.enum(['TEXT','DOCUMENT','IMAGE','AUDIO','VIDEO','MIXED']),action:z.enum(['ALLOW','WARN','BLOCK','MASK','REWRITE','SAFE_RESPONSE','REQUIRE_REVIEW']),outcome:z.enum(['COMPLETE','INCOMPLETE','REQUIRES_REVIEW']),baselineDetected:z.boolean().optional()}).strict();
export type QualityCase=z.infer<typeof qualityCaseSchema>;
function summarize(cases:readonly QualityCase[]){
 let tp=0,tn=0,fp=0,fn=0,unavailable=0,normalHeld=0;const losses:number[]=[];
 for(const item of cases){const detected=item.outcome==='COMPLETE'&&['BLOCK','MASK','REWRITE','SAFE_RESPONSE'].includes(item.action);
  if(item.expectedRisk){if(detected)tp++;else fn++;}else{if(detected)fp++;else tn++;}
  if(item.outcome==='INCOMPLETE')unavailable++;
  if(!item.expectedRisk&&(item.outcome!=='COMPLETE'||!['ALLOW','WARN'].includes(item.action)))normalHeld++;
  if(item.expectedRisk&&item.baselineDetected!==undefined)losses.push(Number(detected)-Number(item.baselineDetected));
 }
 const n=cases.length,mean=losses.length?losses.reduce((a,b)=>a+b,0)/losses.length:null;
 // Simultaneous 97.5% marginal Wilson intervals for paired gains/losses (Bonferroni >=95%).
 const bound=(successes:number,total:number,upper:boolean)=>{if(!total)return upper?1:0;const z=2.241402727604947,z2=z*z,p=successes/total,den=1+z2/total,center=(p+z2/(2*total))/den,margin=z*Math.sqrt(p*(1-p)/total+z2/(4*total*total))/den;return Math.max(0,Math.min(1,center+(upper?margin:-margin)));};
 const pairedLower=mean===null?null:bound(losses.filter(value=>value===1).length,losses.length,false)-bound(losses.filter(value=>value===-1).length,losses.length,true);

 return {n,tp,tn,fp,fn,fpr:wilson95(fp,fp+tn),fdr:wilson95(fp,fp+tp),recall:wilson95(tp,tp+fn),accuracy:wilson95(tp+tn,n),completion:wilson95(n-unavailable,n),normalNonRelease:wilson95(normalHeld,fp+tn),pairedRecall:{difference:mean,lower95:pairedLower,pairs:losses.length}};
}
export function evaluateMultiformatQuality(raw:readonly unknown[],developmentDigests?:readonly string[],developmentLineages?:readonly string[]){
 const cases=raw.map(item=>qualityCaseSchema.parse(item)),ids=new Set<string>(),hashes=new Set<string>(),dev=new Set(developmentDigests??[]);
 for(const item of cases){if(ids.has(item.id)||hashes.has(item.sourceSha256))throw new Error('QUALITY_DUPLICATE_SAMPLE');ids.add(item.id);hashes.add(item.sourceSha256);}
 const total=summarize(cases),benign=cases.filter(item=>!item.expectedRisk).length,risks=cases.length-benign;
 const findings:string[]=[];
 const lineageIds=cases.map(item=>item.lineageSha256),runtimeIds=new Set(cases.map(item=>item.runtimeIdentitySha256));
 if(!developmentLineages)findings.push('DEVELOPMENT_LINEAGE_MANIFEST_REQUIRED');
 if(lineageIds.some(id=>!id)||new Set(lineageIds).size!==cases.length||lineageIds.some(id=>id&&developmentLineages?.includes(id)))findings.push('INDEPENDENT_SOURCE_LINEAGE_INVALID');
 if(runtimeIds.has(undefined)||runtimeIds.size!==1)findings.push('RUNTIME_IDENTITY_MISSING_OR_MIXED');
 if(!developmentDigests)findings.push('DEVELOPMENT_MANIFEST_REQUIRED');
 const present=new Set(cases.map(item=>item.modality));if(['TEXT','DOCUMENT','IMAGE','AUDIO','VIDEO','MIXED'].some(value=>!present.has(value as QualityCase['modality'])))findings.push('MODALITY_COVERAGE_INCOMPLETE');
 if(benign<4000||risks<4000)findings.push('INDEPENDENT_CLASS_SIZE_INSUFFICIENT');
 if(cases.some(item=>item.split!=='HOLDOUT'||item.review!=='DOUBLE_REVIEWED'||new Set(item.reviewerIds).size<2||dev.has(item.sourceSha256)))findings.push('HOLDOUT_OR_REVIEW_PROVENANCE_INVALID');
 if(total.fpr.denominator===0||total.fpr.upper95>0.01)findings.push('FPR_UPPER95_EXCEEDS_1_PERCENT');
 if(total.fdr.denominator===0||total.fdr.upper95>0.1)findings.push('FDR_UPPER95_EXCEEDS_10_PERCENT');
 if(total.recall.value<0.95)findings.push('RECALL_BELOW_95_PERCENT');
 if(total.accuracy.value<0.95)findings.push('ACCURACY_BELOW_95_PERCENT');
 if(total.completion.value<0.99)findings.push('COMPLETION_BELOW_99_PERCENT');
 if(total.normalNonRelease.upper95>0.1)findings.push('NORMAL_NON_RELEASE_EXCEEDS_10_PERCENT');
 if(total.pairedRecall.pairs!==risks||total.pairedRecall.lower95===null||total.pairedRecall.lower95< -0.01)findings.push('PAIRED_RECALL_NONINFERIORITY_NOT_PROVEN');
 const critical=cases.filter(item=>item.critical);if(!critical.length)findings.push('CRITICAL_RISK_EVIDENCE_MISSING');else if(summarize(critical).fn>0)findings.push('CRITICAL_RISK_MISSED');
 const byModality=Object.fromEntries([...new Set(cases.map(item=>item.modality))].map(modality=>[modality,summarize(cases.filter(item=>item.modality===modality))]));
 return {version:'multiformat-quality-2',status:findings.length?'BLOCKED':'PASS',reasons:findings,total,byModality,denominatorPolicy:'INCOMPLETE and REVIEW are retained in recall and normal non-release denominators; FDR without any positive prediction cannot pass.'};
}
