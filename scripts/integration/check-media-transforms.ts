import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { materializeMediaTransform } from '../../services/media-analyzer/src/media-transform';
import type { CommandRunner } from '../../services/media-analyzer/src/command-runner';
import type { MediaTransformPlan } from '../../src/contracts/http/media-transform';

async function main(){
 const directory=path.resolve(process.env.MEDIA_TRANSFORM_EVIDENCE_DIR ?? '.artifact-build/v11-remaining-20260908/media-transforms');mkdirSync(directory,{recursive:true});
 const image=execFileSync('docker',['image','inspect','--format','{{.Id}}','guardllm-r0-media-analyzer:latest'],{encoding:'utf8',windowsHide:true}).trim();assert.match(image,/^sha256:[a-f0-9]{64}$/);
 const tool=(program:string,args:readonly string[],workspace=directory)=>execFileSync('docker',['run','--rm','--network','none','--read-only','--cpus','2','--memory','512m','--pids-limit','128',
  '--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--mount','type=bind,source='+directory+',target=/fixtures',
  '--workdir','/fixtures/'+path.relative(directory,workspace).replaceAll('\\','/'),'--entrypoint',program,image,...args.map(arg=>arg.startsWith(directory)?'/fixtures/'+path.relative(directory,arg).replaceAll('\\','/'):arg)],
  {windowsHide:true,maxBuffer:8*1048576,timeout:130000});
 const ffmpeg=(args:string[])=>tool('ffmpeg',['-v','error','-nostdin','-y',...args]);
 ffmpeg(['-f','lavfi','-i','testsrc=size=101x99:rate=1','-frames:v','1',path.join(directory,'image.png')]);
 ffmpeg(['-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=1','-ac','2','-c:a','pcm_s16le',path.join(directory,'audio.wav')]);
 ffmpeg(['-f','lavfi','-i','testsrc=size=64x64:rate=10:duration=1','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',path.join(directory,'video.mp4')]);
 const runner:CommandRunner={async run(program,args,options){assert.ok(['ffmpeg','ffprobe'].includes(program));return {stdout:tool(program,args,options.cwd).toString('utf8'),stderr:'',exitCode:0};}};
 const run=async(name:string,kind:MediaTransformPlan['kind'],operations:MediaTransformPlan['operations'],suffix:string)=>{
  const input=path.join(directory,name),workspace=path.join(directory,suffix);mkdirSync(workspace,{recursive:true});
  const sourceSha256=createHash('sha256').update(readFileSync(input)).digest('hex');
  return materializeMediaTransform({version:'media-transform-1',sourceSha256,decisionDigest:'a'.repeat(64),kind,operations},input,workspace,runner);
 };
 const picture=await run('image.png','IMAGE',[{operation:'MASK_REGION',region:[0.25,0.25,0.75,0.75],evidenceId:'synthetic-region'}],'image');
 const rgb=tool('ffmpeg',['-v','error','-i',picture.outputPath,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
 for(let y=25;y<74;y++)for(let x=26;x<75;x++){const offset=(y*101+x)*3;assert.deepEqual(rgb.subarray(offset,offset+3),Buffer.alloc(3));}
 const audio=await run('audio.wav','AUDIO',[{operation:'MUTE_INTERVAL',interval:{startMs:200,endMs:600},evidenceId:'synthetic-time'}],'audio');
 const samples=tool('ffmpeg',['-v','error','-i',audio.outputPath,'-f','s16le','-acodec','pcm_s16le','pipe:1']);
 for(let sample=3200;sample<9600;sample++)for(let channel=0;channel<2;channel++)assert.equal(samples.readInt16LE((sample*2+channel)*2),0);
 assert.ok(samples.subarray(0,3200*4).some(byte=>byte!==0));
 const crop=await run('audio.wav','AUDIO',[{operation:'KEEP_INTERVAL',interval:{startMs:200,endMs:800},evidenceId:'synthetic-crop'}],'crop');
 assert.equal(crop.receipt.sourceStartMs,200);assert.ok(Math.abs(crop.receipt.derivedDurationMs-600)<2);
 const video=await run('video.mp4','VIDEO',[{operation:'MASK_REGION',region:[0,0,1,1],interval:{startMs:200,endMs:600},evidenceId:'synthetic-video'},
  {operation:'MUTE_INTERVAL',interval:{startMs:200,endMs:600},evidenceId:'synthetic-audio'}],'video');
 const frame=tool('ffmpeg',['-v','error','-ss','0.4','-i',video.outputPath,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
 assert.equal(frame.length,64*64*3);assert.ok(frame.every(byte=>byte<=3));
 const bad=path.join(directory,'bad');mkdirSync(bad,{recursive:true});
 await assert.rejects(materializeMediaTransform({version:'media-transform-1',sourceSha256:'0'.repeat(64),decisionDigest:'a'.repeat(64),kind:'IMAGE',operations:[{operation:'MASK_REGION',region:[0,0,1,1],evidenceId:'bad'}]},path.join(directory,'image.png'),bad,runner),/SOURCE_CHANGED/);
 const receipts=[picture,audio,crop,video].map(item=>item.receipt);
 writeFileSync(path.join(directory,'verification.json'),JSON.stringify({status:'PASS',image,checks:['actual_png_black_region','stereo_sample_silence','audio_crop_time_mapping','video_decoded_black_frame','source_substitution_rejected'],receipts,syntheticOnly:true,semanticQuality:false},null,2));
 console.log('PASS 5 actual codec/identity checks; transformation is not semantic clearance');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'MEDIA_TRANSFORM_CHECK_FAILED');process.exitCode=1;});
