import {describe,expect,it} from 'vitest';
import {parseOriginalResourceId,originalPreviewSchema,originalResourceIdSchema} from '@/contracts/http/original-preview';
import {authorizedMediaAnnotations} from '@/lib/evidence/media-annotations';
import {makeEvidenceView} from '@/lib/evidence/media-views';
const artifactId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sha='a'.repeat(64);
describe('original approval source/page and coordinate boundaries',()=>{
 it('requires a canonical source and exact bounded page selector',()=>{
  expect(parseOriginalResourceId(sha+':'+artifactId+':2000')).toEqual({snapshotId:sha,artifactId,page:2000});
  for(const suffix of ['01','-1','2001','1.5','1/../../etc','1?x=2'])expect(originalResourceIdSchema.safeParse(sha+':'+artifactId+':'+suffix).success).toBe(false);
 });
 it('does not let raw bytes claim a different source digest',()=>{
  expect(originalPreviewSchema.safeParse({version:'original-preview-1',artifactId,sourceSha256:sha,outputSha256:'b'.repeat(64),representation:'ORIGINAL_BYTES',page:0,totalPages:1,transformVersion:'original-bytes-1',media:{mimeType:'image/png',dataBase64:'AAAA'}}).success).toBe(false);
 });
 it('only overlays a PDF region on its verified source page',()=>{
  const view=makeEvidenceView({artifactId,sourceDigest:sha,text:'page two',source:'ocr',viewId:'page-2-original',contentPath:'/pages/2',page:2,region:[.1,.2,.4,.5]});
  const {text,source,...location}=view;void text;void source;
  const mapping={artifactId,viewId:view.viewId,page:2,basis:'DISPLAY_ORIENTED_SOURCE_PAGE',mappingVersion:'inverse-image-view-1'};
  const provenance={version:'media-source-provenance-1',artifactId,sourceDigest:sha,jobId:artifactId,views:[location],mappings:[mapping]},alerts=[{evidence:[{evidenceId:'pdf-2',locationState:'VERIFIED' as const,locations:[location]}]}];
  expect(authorizedMediaAnnotations(artifactId,sha,'application/pdf',provenance,alerts,2)).toEqual([{evidenceId:'pdf-2',label:'/pages/2',region:[.1,.2,.4,.5]}]);
  for(const page of [1,3,undefined])expect(authorizedMediaAnnotations(artifactId,sha,'application/pdf',provenance,alerts,page)).toEqual([]);
  expect(authorizedMediaAnnotations(artifactId,sha,'application/pdf',{...provenance,mappings:[{...mapping,page:1}]},alerts,2)).toEqual([]);
 });
});
