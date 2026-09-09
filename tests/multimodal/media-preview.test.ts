import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {authorizedMediaSchema,verifiedSeekSeconds,activeMediaAnnotations} from '@/lib/evidence/media-preview';
import {AuthorizedMediaPreview,type AuthorizedMedia} from '@/components/incidents/authorized-media';
import {authorizedMediaAnnotations} from '@/lib/evidence/media-annotations';
import {makeEvidenceView} from '@/lib/evidence/media-views';
const annotation={evidenceId:'e1',label:'source track',startMs:900,endMs:1800};
describe('approved media replay boundaries',()=>{
 it('requires both ends inside the actual decoded duration',()=>{
  expect(verifiedSeekSeconds(annotation,2)).toBe(.9);
  for(const duration of [1,0,-1,Infinity,NaN])expect(verifiedSeekSeconds(annotation,duration)).toBeNull();
  for(const value of [{...annotation,startMs:-1},{...annotation,endMs:800},{...annotation,endMs:undefined},{...annotation,startMs:undefined}])expect(verifiedSeekSeconds(value,2)).toBeNull();
 });
 it('accepts the maximum supported embedded media size without unbounded parsing',()=>{
  expect(authorizedMediaSchema.safeParse({mimeType:'audio/wav',dataBase64:Buffer.alloc(1048576).toString('base64')}).success).toBe(true);
  expect(authorizedMediaSchema.safeParse({mimeType:'audio/wav',dataBase64:'AAA'}).success).toBe(false);
 });
 it('supports v2 audio timestamps with a nonzero source-track offset',()=>{
  const view=makeEvidenceView({artifactId:'source',sourceDigest:'a'.repeat(64),text:'voice',source:'audio',contentPath:'/tracks/1',viewId:'track-1-original',startMs:2900,endMs:3800});
  const {text:_text,source:_source,...location}=view;void _text;void _source;
  const mapping={artifactId:'source',viewId:location.viewId,mappingVersion:'audio-time-to-source-2',basis:'SOURCE_TIME_MS',sourceStartMs:2000,sourceDurationMs:5000,sampleRate:16000,sampleCount:80000,timeScale:1,mappingAccuracy:'SOURCE_TIME'};
  const saved={version:'media-source-provenance-1',jobId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',artifactId:'source',sourceDigest:view.sourceDigest,views:[location],mappings:[mapping]};
  const alerts=[{evidence:[{evidenceId:'track-evidence',locationState:'VERIFIED' as const,locations:[location]}]}];
  expect(authorizedMediaAnnotations('source',view.sourceDigest,'audio/wav',saved,alerts)).toEqual([{evidenceId:'track-evidence',label:location.contentPath,startMs:2900,endMs:3800}]);
  for(const change of [{sourceStartMs:3000},{sourceDurationMs:1000},{mappingAccuracy:'NOMINAL_RATE'},{sampleRate:0}])expect(authorizedMediaAnnotations('source',view.sourceDigest,'audio/wav',{...saved,mappings:[{...mapping,...change}]},alerts)).toEqual([]);
 });
 it('does not display active evidence outside its exact interval',()=>{
  expect(activeMediaAnnotations([annotation],1)).toEqual([annotation]);
  for(const time of [-1,0,1.801,NaN,Infinity])expect(activeMediaAnnotations([annotation],time)).toEqual([]);
 });
 it('never renders arbitrary URLs, markup media or malformed ranges as a player',()=>{
  for(const media of [{mimeType:'image/svg+xml',dataBase64:'PHN2Zz4='},{mimeType:'video/mp4',dataBase64:'https://example.invalid/private'},{mimeType:'audio/wav',dataBase64:'AAAA',annotations:[{...annotation,endMs:1}]}]){
   expect(authorizedMediaSchema.safeParse(media).success).toBe(false);
   const html=renderToStaticMarkup(createElement(AuthorizedMediaPreview,{media:media as AuthorizedMedia}));
   expect(html).toContain('role="alert"');expect(html).not.toMatch(/<(audio|video|img)\b/);
  }
 });
 it('only produces video seek points with a verified source duration',()=>{
  const view=makeEvidenceView({artifactId:'source',sourceDigest:'a'.repeat(64),text:'frame text',source:'frame_ocr',contentPath:'/frames/0',viewId:'frame_0',frameIndex:0,startMs:1000,endMs:1000});
  const {text:_text,source:_source,...location}=view;void _text;void _source;
  const mapping={artifactId:'source',viewId:'frame_0',mappingVersion:'video-frame-to-source-1',basis:'SOURCE_TIME_MS',frameIndex:0,timeMs:1000};
  const saved={version:'media-source-provenance-1',jobId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',artifactId:'source',sourceDigest:view.sourceDigest,views:[location],mappings:[mapping]};
  const alerts=[{evidence:[{evidenceId:'frame-evidence',locationState:'VERIFIED' as const,locations:[location]}]}];
  expect(authorizedMediaAnnotations('source',view.sourceDigest,'video/mp4',saved,alerts)).toEqual([]);
  expect(authorizedMediaAnnotations('source',view.sourceDigest,'video/mp4',{...saved,mappings:[{...mapping,sourceDurationMs:900}]},alerts)).toEqual([]);
  expect(authorizedMediaAnnotations('source',view.sourceDigest,'video/mp4',{...saved,mappings:[{...mapping,sourceDurationMs:2000}]},alerts)).toEqual([{evidenceId:'frame-evidence',label:location.contentPath,startMs:1000,endMs:1000}]);
 });
});
