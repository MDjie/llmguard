import { z } from 'zod';
import { mediaProvenanceSchema,type MediaAnnotation } from '@/contracts/http/media-evidence';
import type { AlertView } from '@/contracts/http/security-alerts';
import { viewIdentity } from './media-views';
/** Only stored analyzer provenance can assert a source coordinate system. Legacy locations remain textual. */
export function authorizedMediaAnnotations(artifactId:string,sha256:string,mimeType:string,raw:unknown,alerts:readonly Pick<AlertView,'evidence'>[]):MediaAnnotation[]{
 const parsed=mediaProvenanceSchema.safeParse(raw);if(!parsed.success||parsed.data.artifactId!==artifactId||parsed.data.sourceDigest!==sha256)return [];
 const {views,mappings}=parsed.data,identities=new Set(views.filter(v=>v.artifactId===artifactId&&v.sourceDigest===sha256).map(viewIdentity));
 const result:MediaAnnotation[]=[];
 for(const evidence of alerts.flatMap(alert=>alert.evidence)){
  if(evidence.locationState!=='VERIFIED')continue;
  for(const location of evidence.locations){
   if(!identities.has(viewIdentity(location)))continue;
   const mapping=mappings.find(item=>item.artifactId===artifactId&&item.viewId===location.viewId);if(!mapping)continue;
   const entry:MediaAnnotation={evidenceId:evidence.evidenceId,label:location.contentPath};
   if(['image/png','image/jpeg','image/webp'].includes(mimeType)&&location.region&&(!location.page||location.page===1)&&mapping.mappingVersion==='inverse-image-view-1'&&mapping.basis==='DISPLAY_ORIENTED_SOURCE_PAGE'){
    if(location.region[2]>location.region[0]&&location.region[3]>location.region[1])entry.region=location.region;
   }
   if((mimeType.startsWith('audio/')||mimeType==='video/mp4')&&location.startMs!==undefined&&location.endMs!==undefined&&mapping.mappingVersion==='audio-time-to-source-1'&&mapping.basis==='SOURCE_TIME_MS'&&z.number().int().positive().safeParse(mapping.sourceDurationMs).success&&location.endMs<=Number(mapping.sourceDurationMs)){
    entry.startMs=location.startMs;entry.endMs=location.endMs;
   }
   if(mimeType==='video/mp4'&&location.frameIndex!==undefined&&mapping.mappingVersion==='video-frame-to-source-1'&&mapping.basis==='SOURCE_TIME_MS'&&mapping.frameIndex===location.frameIndex&&mapping.timeMs===location.startMs&&location.startMs===location.endMs){entry.startMs=location.startMs;entry.endMs=location.endMs;}
   if(entry.region||entry.startMs!==undefined)result.push(entry);
  }
 }
 return [...new Map(result.map(entry=>[JSON.stringify(entry),entry])).values()].slice(0,100);
}
