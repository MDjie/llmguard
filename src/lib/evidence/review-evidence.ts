import {z} from 'zod';
import {reviewEvidenceSchema} from '@/contracts/http/media-evidence';
import {evidenceLocationSchema} from '@/contracts/http/multimodal-analysis';
import type {EvidenceView,ReviewEvidence} from '@/contracts/http/media-evidence';
import {viewIdentity,textVersion} from './media-views';
import {segmentHighlightedText} from './location';
export function reviewPolarity(observation:{detectorId:string;reasonCode?:string;status?:string}):'SUPPORT'|'COUNTER'{
 return observation.detectorId==='configurable-judge'&&observation.status!=='MATCH'&&observation.reasonCode?.startsWith('SEMANTIC_REFINER_')&&!observation.reasonCode.endsWith('_UNSAFE')?'COUNTER':'SUPPORT';
}
const mappedSchema=z.object({evidenceRef:z.string().min(1).max(128),riskType:z.string().max(128),detectorId:z.string().max(128),modelVersion:z.string().max(256).optional(),status:z.string().optional(),decisionRole:z.string().max(64).optional(),reasonCode:z.string().max(128).optional(),locationState:z.literal('VERIFIED'),locations:z.array(evidenceLocationSchema).min(1).max(1000)}).loose();
export function reviewFromMappedEvidence(raw:unknown):ReviewEvidence[]{
 if(!Array.isArray(raw))return [];
 return raw.flatMap(item=>{const parsed=mappedSchema.safeParse(item);if(!parsed.success)return [];const value=parsed.data;if(value.status!=='MATCH'&&value.detectorId!=='configurable-judge')return [];
  return [reviewEvidenceSchema.parse({evidenceId:value.evidenceRef,polarity:reviewPolarity(value),riskType:value.riskType,detectorId:value.detectorId,modelVersion:value.modelVersion,decisionRole:value.decisionRole??'UNSPECIFIED',reasonCode:value.reasonCode??'DETECTION_OBSERVATION',locations:value.locations})];
 });
}
export function assertReviewBindings(views:readonly EvidenceView[],reviews:readonly ReviewEvidence[]){
 const identities=new Map(views.map(view=>[viewIdentity(view),view]));
 for(const review of reviews)for(const location of review.locations){
  const view=identities.get(viewIdentity(location));
  if(!view||textVersion(view.text)!==location.contentVersion)throw new Error('MEDIA_EVIDENCE_REVIEW_SOURCE_CHANGED');
  if(location.textStart!==undefined||location.textEnd!==undefined){
   if(location.textLength!==view.text.length||location.textStart===undefined||location.textEnd===undefined)throw new Error('MEDIA_EVIDENCE_REVIEW_RANGE_CHANGED');
   segmentHighlightedText(view.text,[{start:location.textStart,end:location.textEnd,evidenceId:review.evidenceId}]);
  }
 }
}
export function highlightReviewEvidence(views:readonly EvidenceView[],reviews:readonly ReviewEvidence[]){
 assertReviewBindings(views,reviews);let characters=0;
 return reviews.flatMap(review=>review.locations.flatMap(location=>{
  if(location.textStart===undefined||location.textEnd===undefined)return [];
  const view=views.find(value=>viewIdentity(value)===viewIdentity(location))!;
  if(characters+view.text.length>262144)return [];characters+=view.text.length;
  return [{evidenceId:review.evidenceId,polarity:review.polarity,decisionRole:review.decisionRole,reasonCode:review.reasonCode,detectorId:review.detectorId,modelVersion:review.modelVersion??'',label:view.contentPath,
   parts:segmentHighlightedText(view.text,[{start:location.textStart,end:location.textEnd,evidenceId:review.evidenceId}])}];
 })).slice(0,8);
}
