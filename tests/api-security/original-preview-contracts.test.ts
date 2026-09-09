import {describe,expect,it} from 'vitest';
import {contentAccessRequestResponseSchema,contentAccessConsumeResponseSchema} from '@/contracts/http/content-access';
const digest='a'.repeat(64),requestId='30000000-0000-4000-8000-000000000008';
describe('independent original preview approval',()=>{
 it('exposes a distinct original resource type in approval responses',()=>{
  expect(contentAccessRequestResponseSchema.safeParse({success:true,data:{id:requestId,resourceType:'MEDIA_ORIGINAL',resourceId:digest+':'+requestId+':2',sourceDigest:digest,requesterId:'requester',purpose:'INCIDENT_INVESTIGATION',reason:'Original page investigation',status:'pending',reviewedBy:null,reviewedAt:null,decisionReason:null,expiresAt:null,usedAt:null,createdAt:'2026-09-09T00:00:00.000Z'}}).success).toBe(true);
 });
 it('discloses the raster page only in the consumed original envelope',()=>{
  const data={incidentId:digest+':'+requestId+':2',accessRequestId:requestId,sourceDigest:digest,expiresAt:'2026-09-09T00:15:00.000Z',consumedAt:'2026-09-09T00:01:00.000Z',answerEvidence:'Original page 2',originalPreview:{version:'original-preview-1',artifactId:requestId,sourceSha256:digest,representation:'PDF_PAGE',page:2,totalPages:3,transformVersion:'pdf-page-raster-1',outputSha256:digest,media:{mimeType:'image/png',dataBase64:'AAAA'}}};
  expect(contentAccessConsumeResponseSchema.safeParse({success:true,data}).success).toBe(true);
  expect(contentAccessConsumeResponseSchema.safeParse({success:true,data:{...data,originalPreview:{...data.originalPreview,page:4}}}).success).toBe(false);
 });
});
