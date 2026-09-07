import { createHash } from 'node:crypto';
import { evidenceViewSchema, type EvidenceView } from '@/contracts/http/media-evidence';
import type { AlertView } from '@/contracts/http/security-alerts';
import { segmentHighlightedText } from './location';
export const textVersion=(text:string)=>createHash('sha256').update(text).digest('hex');
export function makeEvidenceView(input:Omit<EvidenceView,'contentVersion'|'mappingVersion'|'offsetEncoding'|'region'>&{region?:readonly[number,number,number,number]}):EvidenceView {
 return evidenceViewSchema.parse({...input,contentVersion:textVersion(input.text),mappingVersion:'guard-evidence-location-1',offsetEncoding:'UTF16'});
}
export function viewIdentity(view:Omit<EvidenceView,'text'|'source'>):string {
 return JSON.stringify([view.artifactId,view.sourceDigest,view.contentVersion,view.contentPath,view.viewId??null,view.page??null,view.region??null,view.startMs??null,view.endMs??null,view.frameIndex??null,view.channel??null,view.speakerId??null]);
}
export function uniqueEvidenceViews(views:readonly EvidenceView[]){return [...new Map(views.map(view=>[viewIdentity(view),view])).values()];}
export function highlightMediaViews(views:readonly EvidenceView[],alerts:readonly Pick<AlertView,'evidence'>[]){
 const locations=alerts.flatMap(alert=>alert.evidence.flatMap(e=>e.locationState==='VERIFIED'?e.locations.map(location=>({location,evidenceId:e.evidenceId})):[]));
 let characters=0;
 return views.flatMap(view=>{
  if(textVersion(view.text)!==view.contentVersion)throw new Error('MEDIA_EVIDENCE_TEXT_VERSION_CHANGED');
  const matches=locations.filter(item=>viewIdentity(item.location)===viewIdentity(view)&&item.location.textLength===view.text.length&&item.location.textStart!==undefined&&item.location.textEnd!==undefined);
  if(!matches.length||characters+view.text.length>262144)return [];
  characters+=view.text.length;
  return [{label:view.contentPath+(view.page?' · 页 '+view.page:'')+(view.startMs!==undefined?' · '+view.startMs+'—'+view.endMs+' ms':''),
   parts:segmentHighlightedText(view.text,matches.slice(0,1000).map(item=>({start:item.location.textStart!,end:item.location.textEnd!,evidenceId:item.evidenceId})))}];
 }).slice(0,8);
}
