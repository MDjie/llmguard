import {projectMediaCapabilities,analyzerSchema} from './capability-projection';
import {MEDIA_FORMATS,MEDIA_FORMAT_VERSION,MEDIA_LIMITS,MAX_ATTACHMENTS,MAX_ATTACHMENT_TOTAL_BYTES} from '@/lib/media/formats/registry';
import {safeFetchJson,ProviderEndpointPolicy} from '@/lib/egress';
const configured=(value:string|undefined)=>(value??'').split(',').map(item=>item.trim()).filter(Boolean);
async function inspectAnalyzer(prefix:'MULTIMODAL_ANALYZER'|'MEDIA_ANALYZER',signal?:AbortSignal):Promise<unknown>{
 const baseUrl=process.env[prefix+'_BASE_URL'],token=process.env.ANALYZER_SHARED_TOKEN;
 if(!baseUrl||!token||baseUrl.includes('${')||token.length<32)return null;
 try{return analyzerSchema.parse(await safeFetchJson({baseUrl,path:'/v1/capabilities',providerType:'custom',signal,timeoutMs:10000,maxRequestBytes:128,maxResponseBytes:65536,headers:{'X-Analyzer-Token':token},body:{}},{policy:new ProviderEndpointPolicy({allowedHosts:configured(process.env[prefix+'_ALLOWED_HOSTS']),allowedPrivateHosts:configured(process.env[prefix+'_ALLOWED_PRIVATE_HOSTS'])})}));}catch{signal?.throwIfAborted();return null;}
}
export async function readMediaCapabilities(signal?:AbortSignal){
 const [analyzer,audioVideoAnalyzer]=await Promise.all([inspectAnalyzer('MULTIMODAL_ANALYZER',signal),inspectAnalyzer('MEDIA_ANALYZER',signal)]);
 const documents=projectMediaCapabilities(analyzer),media=projectMediaCapabilities(audioVideoAnalyzer);
 const effectiveFormats=documents.map((format,index)=>['audio','video'].includes(format.pipeline)?media[index]:format);
 return {version:MEDIA_FORMAT_VERSION,formats:MEDIA_FORMATS,effectiveFormats,limits:MEDIA_LIMITS,maxAttachments:MAX_ATTACHMENTS,maxTotalBytes:MAX_ATTACHMENT_TOTAL_BYTES,analyzer,audioVideoAnalyzer,analyzers:{documentImage:{available:Boolean(analyzer)},audioVideo:{available:Boolean(audioVideoAnalyzer)}},unavailableReason:!analyzer&&!audioVideoAnalyzer?'ANALYZER_UNAVAILABLE':!analyzer?'DOCUMENT_ANALYZER_UNAVAILABLE':!audioVideoAnalyzer?'MEDIA_ANALYZER_UNAVAILABLE':null,qualification:'POLICY_AND_MODEL_APPROVAL_REQUIRED',conditionalFormats:{pcm:'PCM_METADATA_REQUIRED',ofd:'OFD_ADAPTER_REQUIRED'}};
}
