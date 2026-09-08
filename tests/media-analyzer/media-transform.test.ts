import { describe,expect,it } from 'vitest';
import { mediaTransformPlanSchema } from '@/contracts/http/media-transform';
import { transformFilters } from '../../services/media-analyzer/src/media-transform';
const base={version:'media-transform-1' as const,sourceSha256:'a'.repeat(64),decisionDigest:'b'.repeat(64)};
const geometry={width:101,height:99,durationMs:1000,audioTracks:1,videoTracks:1,frames:10};
describe('media transform plans',()=>{
  it('rejects empty, inverted, out-of-range and inappropriate operations',()=>{
    for(const operations of [
      [],[{operation:'MASK_REGION',region:[0,0,0,1],evidenceId:'e'}],
      [{operation:'MASK_REGION',region:[-1,0,1,1],evidenceId:'e'}],
      [{operation:'MUTE_INTERVAL',interval:{startMs:500,endMs:400},evidenceId:'e'}],
      [{operation:'MASK_REGION',region:[0,0,1,1],interval:{startMs:0,endMs:500},evidenceId:'e'}],
    ])expect(()=>mediaTransformPlanSchema.parse({...base,kind:'IMAGE',operations})).toThrow();
  });
  it('rounds image masks outward in source pixels',()=>{
    const result=transformFilters({...base,kind:'IMAGE',operations:[{operation:'MASK_REGION',region:[0.1,0.1,0.2,0.2],evidenceId:'e'}]},{...geometry,durationMs:0,audioTracks:0,frames:1});
    expect(result.video).toContain('x=9:y=8:w=13:h=13:color=black:t=fill:replace=1');
  });
  it('mutes every channel per sample and applies all source-time edits before cropping',()=>{
    const result=transformFilters({...base,kind:'AUDIO',operations:[{operation:'MUTE_INTERVAL',interval:{startMs:200,endMs:600},evidenceId:'mute'},
      {operation:'KEEP_INTERVAL',interval:{startMs:100,endMs:900},evidenceId:'crop'}]},{...geometry,videoTracks:0});
    expect(result.audio).toContain("aeval=exprs='if(between(t,0.2,0.6),0,val(ch))':c=same,atrim=start=0.1:end=0.9,asetpts=PTS-STARTPTS");
    expect(result).toMatchObject({sourceStartMs:100,durationMs:800});
  });
  it('rejects missing tracks and intervals beyond the actual source',()=>{
    expect(()=>transformFilters({...base,kind:'AUDIO',operations:[{operation:'MUTE_INTERVAL',interval:{startMs:0,endMs:1001},evidenceId:'e'}]},geometry)).toThrow('OUT_OF_BOUNDS');
    expect(()=>transformFilters({...base,kind:'VIDEO',operations:[{operation:'MUTE_INTERVAL',interval:{startMs:0,endMs:1000},evidenceId:'e'}]},{...geometry,audioTracks:0})).toThrow('AUDIO_REQUIRED');
  });
});
