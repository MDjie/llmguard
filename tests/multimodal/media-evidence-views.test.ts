import {describe,it,expect} from 'vitest';
import {makeEvidenceView,uniqueEvidenceViews,highlightMediaViews} from '../../src/lib/evidence/media-views';
import {mapRegion,inverseRotation,tileMapping} from '../../src/lib/evidence/coordinate-mapping';
import {remapAudioViewSegment} from '../../services/media-analyzer/src/audio-video';
const view=makeEvidenceView({artifactId:'original',sourceDigest:'a'.repeat(64),contentPath:'/views/asr',viewId:'asr',source:'audio',text:'正常😀危险',startMs:100,endMs:200});
const evidence={evidenceId:'e',locationState:'VERIFIED' as const,locations:[{...view,text:undefined,source:undefined,textStart:4,textEnd:6,textLength:6}]};
describe('private media evidence versions and mappings',()=>{
 it('highlights only the exact source, version and segment including repeated words at different times',()=>{
  const later={...view,startMs:300,endMs:400};expect(uniqueEvidenceViews([view,view,later])).toHaveLength(2);
  const result=highlightMediaViews([view,later],[{evidence:[evidence]}]);expect(result).toHaveLength(1);expect(result[0].parts.find(p=>p.evidenceIds.length)?.text).toBe('危险');
  expect(highlightMediaViews([view],[{evidence:[{...evidence,locations:[{...evidence.locations[0],sourceDigest:'b'.repeat(64)}]}]}])).toEqual([]);
  expect(()=>highlightMediaViews([{...view,text:'被替换文本'}],[{evidence:[evidence]}])).toThrow('VERSION_CHANGED');
 });
 it('does not use cleared/unverified locations or split an emoji',()=>{
  expect(highlightMediaViews([view],[{evidence:[{...evidence,locationState:'UNVERIFIED'}]}])).toEqual([]);
  expect(()=>highlightMediaViews([view],[{evidence:[{...evidence,locations:[{...evidence.locations[0],textStart:3}]}]}])).toThrow('RANGE_INVALID');
 });
 it('inverts 90/180/270 degree views and preserves odd-size tile edges',()=>{
  expect(mapRegion([0,0,0.25,0.5],inverseRotation(90))).toEqual([0,0.75,0.5,1]);
  expect(mapRegion([0,0,0.25,0.5],inverseRotation(180))).toEqual([0.75,0.5,1,1]);
  expect(mapRegion([0,0,0.25,0.5],inverseRotation(270))).toEqual([0.5,0,1,0.25]);
  const tile=tileMapping(101,99,1,1,2,2);expect(tile).toMatchObject({x:50,y:49,width:51,height:50});expect(mapRegion([0,0,1,1],tile.matrix)).toEqual([50/101,49/99,1,1]);
  expect(()=>mapRegion([0,0,1,1],[0,0,0,0,0,0])).toThrow('SINGULAR');
 });
 it('retains the analyzer mapping for speed and reversed audio',()=>{
  expect(remapAudioViewSegment({text:'词',startMs:1000,endMs:2000,confidence:1},{timeScale:0.9})).toMatchObject({startMs:900,endMs:1800});
  expect(remapAudioViewSegment({text:'词',startMs:1000,endMs:2000,confidence:1},{timeScale:1,reverseDurationMs:5000})).toMatchObject({startMs:3000,endMs:4000});
 });
});
