import {createHash} from 'node:crypto';
import {and,eq,gt,isNull} from 'drizzle-orm';
import {db} from '@/storage/database/shared/db';
import {contentAccessRequests,securityAlerts} from '@/storage/database/shared/schema';
import {scopePredicate,type TenantContext,type TenantScope} from '@/lib/tenancy';
import {readOriginalResource} from '@/lib/content-access/original-resource';
import {readAcceptedArtifactBytes} from '@/lib/artifacts/binary-reader';
import {analyzerObjectStoreConfig,S3Presigner} from '@/lib/object-store';
import {ProviderEndpointPolicy,safeFetchJson} from '@/lib/egress';
import {originalPreviewSchema,originalSourceSchema,ORIGINAL_MEDIA_MAX_BYTES,parseOriginalResourceId,type OriginalPreview} from '@/contracts/http/original-preview';
import {readMediaEvidence} from './media-snapshots';
import {authorizedMediaAnnotations} from './media-annotations';
import {ApiProblem} from '@/lib/api-security';
type Resource=NonNullable<Awaited<ReturnType<typeof readOriginalResource>>>;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const fail=(code:string):never=>{throw new Error(code);};
const list=(value:string|undefined)=>(value??'').split(',').map(item=>item.trim()).filter(Boolean);
async function render(resource:Resource,scope:TenantScope,signal:AbortSignal):Promise<OriginalPreview>{
 if(resource.page===0){
  const bytes=await readAcceptedArtifactBytes(scope,resource.artifact.id,ORIGINAL_MEDIA_MAX_BYTES,['IMAGE','AUDIO','VIDEO'],signal);
  try{if(hash(bytes)!==resource.artifact.verifiedSha256)fail('ORIGINAL_PREVIEW_SOURCE_CHANGED');
   return originalPreviewSchema.parse({version:'original-preview-1',artifactId:resource.artifact.id,sourceSha256:resource.artifact.verifiedSha256,representation:'ORIGINAL_BYTES',page:0,totalPages:1,transformVersion:'original-bytes-1',outputSha256:hash(bytes),media:{mimeType:resource.artifact.detectedMediaType,dataBase64:Buffer.from(bytes).toString('base64')}});
  }finally{bytes.fill(0);}
 }
 const baseUrl=process.env.MEDIA_ANALYZER_BASE_URL,token=process.env.ANALYZER_SHARED_TOKEN;
 if(!baseUrl||!token||Buffer.byteLength(token)<32)fail('ORIGINAL_PREVIEW_RENDERER_UNAVAILABLE');
 const signer=new S3Presigner(analyzerObjectStoreConfig());
 const parts=await Promise.all(resource.parts.map(async part=>({partNumber:part.partNumber,sizeBytes:part.sizeBytes,sha256:part.sha256,...await signer.presign('GET',part.objectKey,{expiresSeconds:120})})));
 const raw=await safeFetchJson({baseUrl:baseUrl!,path:'/v1/preview/pdf-page',providerType:'custom',timeoutMs:90000,signal,maxRequestBytes:512*1024,maxResponseBytes:12*1024*1024,headers:{'X-Analyzer-Token':token!},
  body:{contractVersion:'1.0',context:scope,artifact:{id:resource.artifact.id,kind:'DOCUMENT',mediaType:'application/pdf',sizeBytes:resource.artifact.verifiedSize,sha256:resource.artifact.verifiedSha256,parts},page:resource.page},
 },{policy:new ProviderEndpointPolicy({allowedHosts:list(process.env.MEDIA_ANALYZER_ALLOWED_HOSTS),allowedPrivateHosts:list(process.env.MEDIA_ANALYZER_ALLOWED_PRIVATE_HOSTS)})});
 const preview=originalPreviewSchema.parse(raw);
 if(preview.artifactId!==resource.artifact.id||preview.sourceSha256!==resource.artifact.verifiedSha256||preview.page!==resource.page||preview.representation!=='PDF_PAGE'||!preview.toolchainDigest)fail('ORIGINAL_PREVIEW_RENDERER_BINDING_CHANGED');
 const bytes=Buffer.from(preview.media.dataBase64,'base64');
 try{if(bytes.length>8*1024*1024||bytes.toString('base64')!==preview.media.dataBase64||hash(bytes)!==preview.outputSha256||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('ORIGINAL_PREVIEW_OUTPUT_CHANGED');}finally{bytes.fill(0);}
 return preview;
}
export async function consumeOriginalPreview(scope:TenantContext,id:string,grantId:string,parentSignal?:AbortSignal){
 parseOriginalResourceId(id);
 const predicate=and(scopePredicate(contentAccessRequests,scope),eq(contentAccessRequests.id,grantId),eq(contentAccessRequests.resourceType,'MEDIA_ORIGINAL'),eq(contentAccessRequests.resourceId,id),eq(contentAccessRequests.requesterId,scope.principalId),eq(contentAccessRequests.status,'approved'),isNull(contentAccessRequests.usedAt),gt(contentAccessRequests.expiresAt,new Date()));
 const [grant]=await db.select().from(contentAccessRequests).where(predicate).limit(1);
 if(!grant)fail('ORIGINAL_PREVIEW_GRANT_UNAVAILABLE');
 const resource=await readOriginalResource(db,scope,id);
 if(!resource||resource.sourceDigest!==grant.sourceDigest)fail('ORIGINAL_PREVIEW_SOURCE_CHANGED');
 const current=resource!;
 const signal=parentSignal?AbortSignal.any([parentSignal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000);
 const {content}=await readMediaEvidence(scope,current.snapshotId);
 const views=content.views.filter(view=>view.artifactId===current.artifact.id);
 if(views.some(view=>view.sourceDigest!==current.artifact.verifiedSha256))fail('ORIGINAL_PREVIEW_EVIDENCE_CHANGED');
 const preview=await render(current,{tenantId:scope.tenantId,applicationId:scope.applicationId},signal);
 const alerts=await db.select({evidence:securityAlerts.evidence}).from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.jobId,current.job.id))).limit(1000);
 const provenance={version:'media-source-provenance-1',jobId:current.job.id,artifactId:current.artifact.id,sourceDigest:current.artifact.verifiedSha256,views:views.map(({text,source,...location})=>{void text;void source;return location;}),mappings:content.mappings};
 preview.media.annotations=authorizedMediaAnnotations(current.artifact.id,current.artifact.verifiedSha256!,current.artifact.detectedMediaType!,provenance,alerts,current.page||undefined);
 const validated=originalPreviewSchema.parse(preview);
 signal.throwIfAborted();
 return db.transaction(async tx=>{
  const [access]=await tx.select().from(contentAccessRequests).where(predicate).for('update');
  const now=new Date();
  if(!access||!access.expiresAt||access.expiresAt<=now)fail('ORIGINAL_PREVIEW_GRANT_UNAVAILABLE');
  const renewed=await readOriginalResource(tx,scope,id,now,true);
  if(!renewed||renewed.sourceDigest!==grant.sourceDigest||access.sourceDigest!==grant.sourceDigest)fail('ORIGINAL_PREVIEW_SOURCE_CHANGED');
  signal.throwIfAborted();
  await tx.update(contentAccessRequests).set({usedAt:now}).where(eq(contentAccessRequests.id,grantId));
  return {incidentId:id,accessRequestId:grantId,sourceDigest:grant.sourceDigest,expiresAt:access.expiresAt!.toISOString(),consumedAt:now.toISOString(),
   answerEvidence:JSON.stringify({artifactId:current.artifact.id,sourceSha256:validated.sourceSha256,representation:validated.representation,page:validated.page,totalPages:validated.totalPages,transformVersion:validated.transformVersion,outputSha256:validated.outputSha256,annotations:validated.media.annotations},null,2),originalPreview:validated};
 });
}
export async function listOriginalPreviewSources(scope:TenantScope,snapshotId:string){
 const {content}=await readMediaEvidence(scope,snapshotId);
 const ids=[...new Set(content.views.map(view=>view.artifactId))].slice(0,8),items=[];
 for(const artifactId of ids){
  const pages=[...new Set(content.views.filter(view=>view.artifactId===artifactId&&view.page).map(view=>view.page!))].filter(page=>page<=2000).sort((a,b)=>a-b).slice(0,100);
  const resource=await readOriginalResource(db,scope,snapshotId+':'+artifactId+':0')??await readOriginalResource(db,scope,snapshotId+':'+artifactId+':'+(pages[0]??1));
  if(!resource)continue;
  items.push(originalSourceSchema.parse({artifactId,kind:resource.artifact.kind,mimeType:resource.artifact.detectedMediaType,sizeBytes:resource.artifact.verifiedSize,suggestedPages:resource.page?pages.length?pages:[1]:[]}));
 }
 return {items};
}
export function originalPreviewProblem(error:unknown):never{
 if(error instanceof ApiProblem)throw error;
 const code=error instanceof Error?error.message:'';
 const status=code==='ORIGINAL_PREVIEW_GRANT_UNAVAILABLE'?403:code==='ORIGINAL_PREVIEW_SOURCE_CHANGED'||code==='ORIGINAL_PREVIEW_EVIDENCE_CHANGED'?409:503;
 throw new ApiProblem({status,code:status===503?'ORIGINAL_PREVIEW_UNAVAILABLE':code,title:'原件预览不可用',detail:status===403?'请重新申请并由另一名授权人员批准所选原件或页面。':status===409?'原件或证据状态已变化，请重新核对并申请。':'预览读取或转换失败，未消费授权；请检查源文件、页码和分析器后重试。'});
}
