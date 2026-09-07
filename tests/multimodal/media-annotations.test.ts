import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {makeEvidenceView} from '../../src/lib/evidence/media-views';
import {authorizedMediaAnnotations} from '../../src/lib/evidence/media-annotations';
const view=makeEvidenceView({artifactId:'source',sourceDigest:'a'.repeat(64),text:'derived',source:'image',contentPath:'/views/rotate_90',viewId:'rotate_90',region:[0,0.5,0.5,1]});
const {text:_text,source:_source,...location}=view;
const provenance={version:'media-source-provenance-1',jobId:randomUUID(),artifactId:'source',sourceDigest:view.sourceDigest,views:[location],mappings:[{artifactId:'source',viewId:'rotate_90',basis:'DISPLAY_ORIENTED_SOURCE_PAGE',mappingVersion:'inverse-image-view-1'}]};
const alert={evidence:[{evidenceId:'e',locationState:'VERIFIED' as const,locations:[location]}]};
describe('authorized original media location replay',()=>{
 it('shows source rectangles only for exact persisted view identity and mapping provenance',()=>{expect(authorizedMediaAnnotations('source',view.sourceDigest,'image/png',provenance,[alert])).toEqual([{evidenceId:'e',label:view.contentPath,region:view.region}]);expect(authorizedMediaAnnotations('source','b'.repeat(64),'image/png',provenance,[alert])).toEqual([]);expect(authorizedMediaAnnotations('source',view.sourceDigest,'image/png',{...provenance,mappings:[]},[alert])).toEqual([]);expect(authorizedMediaAnnotations('source',view.sourceDigest,'image/png',provenance,[{evidence:[{...alert.evidence[0],locations:[{...location,contentVersion:'changed'}]}]}])).toEqual([]);});
 it('does not claim a source frame for GIF or unverified positions',()=>{expect(authorizedMediaAnnotations('source',view.sourceDigest,'image/gif',provenance,[alert])).toEqual([]);expect(authorizedMediaAnnotations('source',view.sourceDigest,'image/png',provenance,[{evidence:[{...alert.evidence[0],locationState:'UNVERIFIED'}]}])).toEqual([]);});
 it('seeks only in a verified source timeline and refuses timestamps beyond its duration',()=>{
  const timed={...location,region:undefined,viewId:'speed_0_9',startMs:900,endMs:1800};const saved={...provenance,views:[timed],mappings:[{artifactId:'source',viewId:'speed_0_9',mappingVersion:'audio-time-to-source-1',basis:'SOURCE_TIME_MS',sourceDurationMs:5000}]};const alerts=[{evidence:[{...alert.evidence[0],locations:[timed]}]}];
  expect(authorizedMediaAnnotations('source',view.sourceDigest,'audio/wav',saved,alerts)).toEqual([{evidenceId:'e',label:location.contentPath,startMs:900,endMs:1800}]);expect(authorizedMediaAnnotations('source',view.sourceDigest,'audio/wav',{...saved,mappings:[{...saved.mappings[0],sourceDurationMs:1000}]},alerts)).toEqual([]);
 });
});
