import {describe,it,expect} from 'vitest';
import {probeMedia} from '../../services/media-analyzer/src/audio-video';
import {officePackageInventory} from '../../services/media-analyzer/src/office';
import type {CommandRunner} from '../../services/media-analyzer/src/command-runner';
import {projectMediaCapabilities} from '@/lib/media/capability-projection';
const runner=(streams:unknown[]):CommandRunner=>({run:async()=>({stdout:JSON.stringify({format:{format_name:'matroska',duration:'2',start_time:'0'},streams}),stderr:'',exitCode:0})});
describe('unqualified source profile boundaries',()=>{
 it('keeps one video stream and independently enumerates every audio channel',async()=>{
  const value=await probeMedia(runner([{codec_type:'video'},{codec_type:'audio',channels:2,start_time:'0'},{codec_type:'audio',channels:1,start_time:'0.5'}]),'source','workspace',1000);
  expect(value.audioUnits).toEqual([{track:0,channel:0,sourceStartMs:0},{track:0,channel:1,sourceStartMs:0},{track:1,channel:0,sourceStartMs:500}]);
 });
 it('rejects multiple video streams before silently selecting one',async()=>{
  await expect(probeMedia(runner([{codec_type:'video'},{codec_type:'video'}]),'source','workspace',1000)).rejects.toThrow('VIDEO_MULTI_STREAM_PROFILE_UNAVAILABLE');
 });
 it.each(['doc','xls','ppt','wps','rtf'])('does not claim that %s hidden content has been inventoried',extension=>{
  expect(officePackageInventory(Buffer.from('synthetic non-package bytes'),extension)).toMatchObject({inventoryComplete:false,coverageGaps:['ANALYZER_OFFICE_NON_PACKAGE_CONTENT_UNASSESSED'],nativeCoverageClaimed:false});
 });
 it('projects profile limitations even when all model commands are configured',()=>{
  const formats=projectMediaCapabilities({version:'test',checkedAt:'2026-09-09',decoding:{ffmpeg:true,office:true,pdf:true,ocr:true},codecAvailability:{heif:true},adapters:{asr:true,visual:true,audioClassifier:true}});
  expect(formats.filter(format=>format.pipeline==='video').every(format=>format.missingDependencies.includes('MULTI_VIDEO_STREAM_PROFILE_UNAVAILABLE'))).toBe(true);
  expect(formats.find(format=>format.id==='heif')?.missingDependencies).toContain('HEIF_SEQUENCE_PROFILE_UNAVAILABLE');
  expect(formats.find(format=>format.id==='doc')?.missingDependencies).toContain('NON_PACKAGE_HIDDEN_CONTENT_UNASSESSED');
  expect(formats.every(format=>format.qualified===false)).toBe(true);
 });
});
