import { z } from 'zod';
import { createHash } from 'node:crypto';
import { dictionaryEntrySchema } from '@/contracts/http/policy-governance';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import { validateSafeRegexPattern } from '@/lib/detection/safe-regex';
import { riskDefinition } from '@/lib/guard-engine-v2/risk-registry';
import { artifactDigest, resolveAnnotation, workbenchRecordSchema } from '@/lib/evaluation/dataset-workbench';
import { compileReleaseSet, releaseSetInputSchema } from './release-set';

const id=z.string().min(1).max(128);
export const conversionSourceSchema=z.object({sourceId:id,path:z.string().min(1),format:z.enum(['master-jsonl','candidate-jsonl','legacy-sql']),
  sha256:z.string().regex(/^[a-f0-9]{64}$/u),license:z.string().min(1),authorizedUse:z.enum(['candidate_only','dictionary_release']),
  riskMapping:z.record(z.string(),z.array(id).min(1).max(100)).default({})}).strict();
export type ConversionSource=z.infer<typeof conversionSourceSchema>;
export const convertedCandidateSchema=z.object({candidateId:id,canonical:z.string(),variants:z.array(z.string()),riskIds:z.array(id),
  matchType:z.enum(['exact','contains','prefix','suffix','regex']),sourceMatchMode:z.string(),locale:z.string(),direction:z.string(),
  sourceRefs:z.array(z.object({sourceId:id,sourceDigest:z.string(),recordId:z.string(),line:z.number().int().positive()}).strict()).min(1),
  upstreamSourceIds:z.array(z.string()),state:z.literal('needs_review'),issues:z.array(z.string()),
}).strict();
export type ConvertedCandidate=z.infer<typeof convertedCandidateSchema>;
interface SourceRecord { readonly value:unknown; readonly recordId:string; readonly line:number; }
function object(value:unknown):Record<string,unknown>|undefined { return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined; }
function stringList(value:unknown):string[]{return Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[];}

/** Extract only quoted JSON data. SQL is never executed or interpolated into a query. */
export function extractLegacySql(content:string){
  const records:SourceRecord[]=[]; const truncations:Array<{label:string;declared:number;available:number}>=[];
  let line=1,statement=1;let literals:string[]=[];
  for(let i=0;i<content.length;i++){
    if(content[i]==='\n')line++;
    if(content.startsWith('--',i)){const end=content.indexOf('\n',i);if(end<0)break;i=end-1;continue;}
    if(content.startsWith('/*',i)){const end=content.indexOf('*/',i+2);if(end<0)throw new Error('SQL_COMMENT_UNTERMINATED');line+=(content.slice(i,end+2).match(/\n/gu)??[]).length;i=end+1;continue;}
    if(content[i]===';'){statement++;literals=[];continue;}
    if(content[i]!=="'")continue;
    const startLine=line;let literal='';let closed=false;
    for(i++;i<content.length;i++){
      if(content[i]==='\n')line++;
      if(content[i]==="'"){if(content[i+1]==="'"){literal+="'";i++;continue;}closed=true;break;}
      literal+=content[i];
    }
    if(!closed)throw new Error('SQL_STRING_UNTERMINATED');
    if(!/^\s*::\s*jsonb\b/iu.test(content.slice(i+1,i+40))){literals.push(literal);continue;}
    let value:unknown;try{value=JSON.parse(literal);}catch{throw new Error('SQL_JSON_INVALID');}
    const config=object(value);if(!config||!Array.isArray(config.keywords))continue;
    const label=literals.find(v=>v.startsWith('Sensitive-lexicon'))??'statement-'+statement;
    const counts=Object.entries(config).filter(([key,v])=>/(?:total|count)/iu.test(key)&&typeof v==='number').map(([,v])=>Number(v));
    const descriptionCount=literals.map(v=>/\((\d+)(?:词|条)\)/u.exec(v)).find(v=>v!==null)?.[1];
    const declared=Math.max(config.keywords.length,...counts,...(descriptionCount?[Number(descriptionCount)]:[]));
    if(declared>config.keywords.length)truncations.push({label,declared,available:config.keywords.length});
    config.keywords.forEach((keyword:unknown,n:number)=>records.push({line:startLine,recordId:label+':'+(n+1),value:{canonical:keyword,variants:[],risk_ids:[],source_label:label,match_mode:'phrase'}}));
  }
  return {records,truncations};
}
export function convertLexiconSources(inputs:readonly {source:ConversionSource;content:string}[]){
  if(!inputs.length)throw new Error('CONVERSION_SOURCES_REQUIRED');
  const candidates:ConvertedCandidate[]=[]; const failures:Array<{sourceId:string;line:number;recordId:string;code:string}>=[];
  const truncations:Array<{sourceId:string;label:string;declared:number;available:number}>=[];
  const seen=new Map<string,ConvertedCandidate>();let inputRows=0,metadataRows=0,duplicateRows=0,rejectedRows=0,quarantinedRows=0;
  const sourceIds=new Set<string>();
  for(const {source:rawSource,content} of inputs){
    const source=conversionSourceSchema.parse(rawSource);
    if(createHash('sha256').update(content).digest('hex')!==source.sha256)throw new Error('CONVERSION_SOURCE_HASH_INVALID');
    if(sourceIds.has(source.sourceId))throw new Error('CONVERSION_SOURCE_DUPLICATE');sourceIds.add(source.sourceId);
    let records:SourceRecord[];
    if(source.format==='legacy-sql'){const sql=extractLegacySql(content);records=sql.records;truncations.push(...sql.truncations.map(t=>({...t,sourceId:source.sourceId})));}
    else records=content.split(/\r?\n/u).flatMap((line,i)=>{
      if(!line.trim())return[];
      try{return[{value:JSON.parse(line) as unknown,line:i+1,recordId:'line-'+(i+1)}];}
      catch{return[{value:null,line:i+1,recordId:'line-'+(i+1)}];}
    });
    for(const row of records){
      const value=object(row.value);
      if(value&&['manifest','source','risk','risk_category','category'].includes(String(value._type))){metadataRows++;continue;}
      inputRows++;
      const canonical=typeof value?.canonical==='string'?value.canonical.normalize('NFKC').trim():'';
      if(!value||!canonical||canonical.length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(canonical)){
        rejectedRows++;failures.push({sourceId:source.sourceId,line:row.line,recordId:row.recordId,code:'TERM_INVALID_OR_UNSUPPORTED_RECORD'});continue;
      }
      const risks=stringList(value.risk_ids??value.suggested_risk_ids);
      const mapped=source.riskMapping[String(value.source_label??value.category??value.term_id??'')]??risks;
      const mode=String(value.match_mode??'phrase');
      const matchType:ConvertedCandidate['matchType']=mode==='regex'?'regex':['exact','prefix','suffix'].includes(mode)?mode as 'exact'|'prefix'|'suffix':'contains';
      const variants=[...new Set([canonical,...stringList(value.variants).map(v=>v.normalize('NFKC').trim())])];
      const issues:string[]=[];
      if(!mapped.length)issues.push('RISK_MAPPING_REQUIRED');
      for(const risk of mapped){try{riskDefinition(risk);}catch{issues.push('UNKNOWN_RISK:'+risk);}}
      if(variants.some(v=>!v||v.length>500)||variants.length>100)issues.push('VARIANT_LIMIT');
      if(matchType==='regex'){for(const variant of variants){try{validateSafeRegexPattern(variant,'i');}catch{issues.push('UNSAFE_PATTERN');}}}
      if(!['phrase','token','contextual_token','exact','contains','prefix','suffix','regex'].includes(mode))issues.push('MATCH_MODE_REVIEW_REQUIRED');
      const locale=typeof value.locale==='string'?value.locale:'und';
      const direction=typeof value.direction==='string'?value.direction:'BOTH';
      const key=artifactDigest({canonical:canonical.toLowerCase(),variants:variants.map(v=>v.toLowerCase()).sort(),matchType,riskIds:[...mapped].sort(),locale,direction});
      const sourceRef={sourceId:source.sourceId,sourceDigest:artifactDigest(source),recordId:String(value.term_id??value.candidate_id??row.recordId),line:row.line};
      const previous=seen.get(key);
      if(previous){previous.sourceRefs.push(sourceRef);duplicateRows++;continue;}
      const candidate:ConvertedCandidate={candidateId:'term-'+key.slice(0,24),canonical,variants,riskIds:[...new Set(mapped)],matchType,sourceMatchMode:mode,locale,direction,
        sourceRefs:[sourceRef],upstreamSourceIds:stringList(value.source_ids??(typeof value.source_id==='string'?[value.source_id]:[])),state:'needs_review',issues:[...new Set(issues)]};
      if(issues.length)quarantinedRows++;
      candidates.push(candidate);seen.set(key,candidate);
    }
  }
  const acceptedRows=candidates.length-quarantinedRows;
  if(inputRows!==acceptedRows+quarantinedRows+duplicateRows+rejectedRows)throw new Error('CONVERSION_COUNT_MISMATCH');
  return {schemaVersion:'2.0',kind:'lexicon-conversion',sources:inputs.map(i=>i.source),candidates,failures,truncations,
    counts:{inputRows,metadataRows,acceptedRows,duplicateRows,quarantinedRows,rejectedRows,uniqueTerms:new Set(candidates.map(c=>c.canonical.toLowerCase())).size},
    digest:artifactDigest({sources:inputs.map(i=>conversionSourceSchema.parse(i.source)),candidates}),productionEligible:false,reviewState:'needs_review'};
}
const conversionSchema=z.object({sources:z.array(conversionSourceSchema),candidates:z.array(convertedCandidateSchema),digest:z.string()}).passthrough();
const approvalSchema=z.object({candidateId:id,entry:dictionaryEntrySchema,review:workbenchRecordSchema}).strict();
export function compileReviewedConversion(rawConversion:unknown,rawApprovals:readonly unknown[],registry:unknown,identity:{policyId:string;dictionaryId:string;version:string;layer:z.infer<typeof releaseSetInputSchema>['layer']}){
  const conversion=conversionSchema.parse(rawConversion);
  if(artifactDigest({sources:conversion.sources,candidates:conversion.candidates})!==conversion.digest)throw new Error('CONVERSION_DIGEST_INVALID');
  if(new Set(conversion.sources.map(s=>s.sourceId)).size!==conversion.sources.length)throw new Error('CONVERSION_SOURCE_DUPLICATE');
  for(const candidate of conversion.candidates)for(const ref of candidate.sourceRefs){
    const source=conversion.sources.find(s=>s.sourceId===ref.sourceId);
    if(!source||ref.sourceDigest!==artifactDigest(source))throw new Error('CONVERSION_SOURCE_BINDING_INVALID');
  }
  const approvals=z.array(approvalSchema).min(1).parse(rawApprovals);
  const terms=approvals.map(approval=>{
    const candidate=conversion.candidates.find(c=>c.candidateId===approval.candidateId);
    if(!candidate)throw new Error('APPROVED_CANDIDATE_UNKNOWN');
    const resolution=resolveAnnotation(approval.review,registry);
    const bound={candidateDigest:artifactDigest(candidate),entry:approval.entry};
    if(!resolution.qualityEligible||approval.review.case.text!==canonicalJson(bound)||approval.review.case.sourceHash!==artifactDigest(candidate)||
      !resolution.label?.riskIds.includes(approval.entry.riskType))throw new Error('TERM_INDEPENDENT_APPROVAL_REQUIRED');
    return {termId:approval.candidateId,status:'reviewed' as const,sourceIds:[...new Set(candidate.sourceRefs.map(s=>s.sourceId))],reviewEvidenceRef:resolution.evidenceDigest,entry:approval.entry};
  });
  const used=new Set(terms.flatMap(t=>t.sourceIds));
  const sources=conversion.sources.filter(s=>used.has(s.sourceId)).map(s=>{
    if(s.authorizedUse!=='dictionary_release')throw new Error('SOURCE_RELEASE_LICENSE_REQUIRED');
    return {sourceId:s.sourceId,sha256:s.sha256,license:s.license,authorizedUse:'dictionary_release' as const};
  });
  return compileReleaseSet({schemaVersion:'1.0',...identity,sources,terms});
}
