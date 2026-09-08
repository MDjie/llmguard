import { nativeAssessmentSchema, type NativeBinding } from '@/contracts/http/native-multimodal';
import { safeFetchJson, ProviderEndpointPolicy } from '@/lib/egress';
import { S3Presigner, analyzerObjectStoreConfig } from '@/lib/object-store';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { evaluateNativeAssessment } from './native-gate';
import type { TenantScope } from '@/lib/tenancy';
import type { artifacts, artifactParts } from '@/storage/database/shared/schema';
const configured=(value:string|undefined)=>(value??'').split(',').map(item=>item.trim()).filter(Boolean);
export async function analyzeNativeArtifacts(input: {
  scope: TenantScope; bundlePayload: unknown; requiredRiskIds: readonly string[]; direction: NativeBinding['direction'];
  contextText?: string; contextArtifactId?: string; heuristicSuspected?: boolean;
  artifacts: readonly { artifact: typeof artifacts.$inferSelect; parts: readonly (typeof artifactParts.$inferSelect)[] }[]; signal?: AbortSignal;
}) {
  const contextText=input.contextText??'', contextDigest=sha256(contextText);
  const sources:NativeBinding['sources']=input.artifacts.map(({artifact})=>({sourceId:'artifact:'+artifact.id,artifactId:artifact.id,sha256:artifact.verifiedSha256??'',contentVersion:artifact.verifiedSha256??'',modality:artifact.kind as 'IMAGE'|'DOCUMENT'|'AUDIO'|'VIDEO'}));
  if(contextText)sources.unshift({sourceId:'context:'+(input.contextArtifactId??contextDigest),artifactId:input.contextArtifactId??'context:'+contextDigest,sha256:contextDigest,contentVersion:contextDigest,modality:'TEXT'});
  const binding:NativeBinding={version:'1.0',...input.scope,bundleDigest:sha256(canonicalJson(input.bundlePayload)),direction:input.direction,contextDigest,sources,requiredRiskIds:[...input.requiredRiskIds]};
  if(!input.requiredRiskIds.length)return {binding:null,assessment:null,gate:{verdict:'UNKNOWN' as const,qualified:false,eligible:false,action:'REQUIRE_REVIEW' as const,reasonCodes:['NATIVE_POLICY_UNCONFIGURED'],relations:[],qualification:null}};
  let assessment:unknown=null;
  if(process.env.NATIVE_MULTIMODAL_ANALYSIS_ENABLED==='true') {
    try {
      const baseUrl=process.env.MULTIMODAL_ANALYZER_BASE_URL,token=process.env.ANALYZER_SHARED_TOKEN;
      if(!baseUrl||!token||Buffer.byteLength(token)<32)throw new Error('NATIVE_ANALYZER_UNCONFIGURED');
      const signer=new S3Presigner(analyzerObjectStoreConfig());
      const items=await Promise.all(input.artifacts.map(async({artifact,parts})=>({id:artifact.id,kind:artifact.kind,mediaType:artifact.detectedMediaType,sizeBytes:artifact.verifiedSize,sha256:artifact.verifiedSha256,
        parts:await Promise.all(parts.map(async part=>({partNumber:part.partNumber,sizeBytes:part.sizeBytes,sha256:part.sha256,...await signer.presign('GET',part.objectKey,{expiresSeconds:300})}))) })));
      assessment=nativeAssessmentSchema.parse(await safeFetchJson({baseUrl,path:'/v1/analyze/native-joint',providerType:'custom',signal:input.signal,timeoutMs:120000,maxRequestBytes:1048576,maxResponseBytes:1048576,headers:{'X-Analyzer-Token':token},
        body:{contractVersion:'1.0',binding,contextText,artifacts:items}}, {policy:new ProviderEndpointPolicy({allowedHosts:configured(process.env.MULTIMODAL_ANALYZER_ALLOWED_HOSTS),allowedPrivateHosts:configured(process.env.MULTIMODAL_ANALYZER_ALLOWED_PRIVATE_HOSTS)})}));
    }catch{ input.signal?.throwIfAborted(); }
  }
  const gate=evaluateNativeAssessment(binding,assessment,input.heuristicSuspected);
  // Model-authored explanations may quote protected media; public job results retain typed relations only.
  const parsed=nativeAssessmentSchema.safeParse(assessment);
  const redact=(relations:typeof gate.relations)=>relations.map(relation=>({...relation,explanation:'Native relationship: '+relation.relationType}));
  return {binding,assessment:parsed.success?{...parsed.data,relations:redact(parsed.data.relations)}:null,gate:{...gate,relations:redact(gate.relations)}};
}
