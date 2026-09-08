import {MEDIA_FORMATS,MEDIA_FORMAT_VERSION,MEDIA_LIMITS,MAX_ATTACHMENTS,MAX_ATTACHMENT_TOTAL_BYTES} from '@/lib/media/formats/registry';
import {safeFetchJson,ProviderEndpointPolicy} from '@/lib/egress';
const configured=(value:string|undefined)=>(value??'').split(',').map(item=>item.trim()).filter(Boolean);

export async function readMediaCapabilities(signal?: AbortSignal) {
 let analyzer:unknown=null;
 try{const baseUrl=process.env.MULTIMODAL_ANALYZER_BASE_URL,token=process.env.ANALYZER_SHARED_TOKEN;
  if(baseUrl&&token&&!baseUrl.includes('${')&&token.length>=32)analyzer=await safeFetchJson({baseUrl,path:'/v1/capabilities',providerType:'custom',signal:signal,timeoutMs:10000,maxRequestBytes:128,maxResponseBytes:65536,headers:{'X-Analyzer-Token':token},body:{}},{policy:new ProviderEndpointPolicy({allowedHosts:configured(process.env.MULTIMODAL_ANALYZER_ALLOWED_HOSTS),allowedPrivateHosts:configured(process.env.MULTIMODAL_ANALYZER_ALLOWED_PRIVATE_HOSTS)})});
 }catch{signal?.throwIfAborted();}
 return {version:MEDIA_FORMAT_VERSION,formats:MEDIA_FORMATS,limits:MEDIA_LIMITS,maxAttachments:MAX_ATTACHMENTS,maxTotalBytes:MAX_ATTACHMENT_TOTAL_BYTES,analyzer,unavailableReason:analyzer?null:'ANALYZER_UNAVAILABLE',qualification:'POLICY_AND_MODEL_APPROVAL_REQUIRED',conditionalFormats:{pcm:'PCM_METADATA_REQUIRED',ofd:'OFD_ADAPTER_REQUIRED'}};
}
