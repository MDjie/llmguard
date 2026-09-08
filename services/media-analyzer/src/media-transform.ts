import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../../../src/lib/gateway-runtime/protocol';
import { mediaTransformPlanSchema, mediaTransformReceiptSchema, type MediaTransformPlan } from '../../../src/contracts/http/media-transform';
import { mediaMarkRequestSchema } from './contracts';
import { uploadArtifactFile, withLoadedArtifact } from './artifact-loader';
import type { CommandRunner } from './command-runner';

export const mediaTransformRequestSchema=z.object({
  contractVersion:z.literal('1.0'),context:mediaMarkRequestSchema.shape.context,
  artifact:mediaMarkRequestSchema.shape.artifact,
  plan:mediaTransformPlanSchema,
  output:mediaMarkRequestSchema.shape.output.extend({mediaType:z.enum(['image/png','audio/wav','video/mp4']),maxBytes:z.number().int().positive().max(1048576)}),
}).strict().superRefine((r,ctx)=>{
  if(r.artifact.sha256!==r.plan.sourceSha256||r.artifact.kind!==r.plan.kind||r.artifact.sizeBytes>1048576||
    r.output.mediaType!==({IMAGE:'image/png',AUDIO:'audio/wav',VIDEO:'video/mp4'}[r.plan.kind]))ctx.addIssue({code:'custom',message:'Transform source/output mismatch'});
});

const probeSchema=z.object({
  streams:z.array(z.object({codec_type:z.enum(['video','audio']),codec_name:z.string(),width:z.number().int().optional(),height:z.number().int().optional(),
    sample_rate:z.string().optional(),channels:z.number().int().optional(),nb_read_frames:z.string().optional(),duration:z.string().optional(),
    avg_frame_rate:z.string().optional(),tags:z.record(z.string(),z.string()).optional(),
    side_data_list:z.array(z.object({rotation:z.number().optional()}).loose()).optional(),
  }).loose()).min(1).max(2),
  format:z.object({duration:z.string().optional(),start_time:z.string().optional(),format_name:z.string()}).loose(),
}).loose();
export interface TransformGeometry { width:number;height:number;durationMs:number;audioTracks:number;videoTracks:number;frames:number }
function geometry(raw:unknown,kind:MediaTransformPlan['kind'],counted=true):TransformGeometry{
  const parsed=probeSchema.parse(raw),video=parsed.streams.filter(s=>s.codec_type==='video'),audio=parsed.streams.filter(s=>s.codec_type==='audio');
  const durationMs=kind==='IMAGE'?0:Math.round(Number(parsed.format.duration)*1000),width=video[0]?.width??0,height=video[0]?.height??0;
  const frames=video.length?(counted?Number(video[0].nb_read_frames):1):0;
  const allowedCodecs=kind==='IMAGE'?['png','mjpeg','webp']:kind==='AUDIO'?['pcm_s16le','pcm_s24le','pcm_f32le','mp3']:['h264','aac'];
  if(parsed.streams.some(s=>!allowedCodecs.includes(s.codec_name))||Math.abs(Number(parsed.format.start_time??0))>0.001)throw new Error('ANALYZER_TRANSFORM_FORMAT_UNSUPPORTED');
  if(kind==='VIDEO'){const [numerator,denominator]=(video[0]?.avg_frame_rate??'0/0').split('/').map(Number);const fps=numerator/denominator;if(!Number.isFinite(fps)||fps<=0||fps>30)throw new Error('ANALYZER_TRANSFORM_FRAME_RATE_UNSUPPORTED');}
  if(video.length>1||audio.length>1||(kind==='IMAGE'&&(video.length!==1||audio.length||frames!==1))||
    (kind==='AUDIO'&&(audio.length!==1||video.length))||(kind==='VIDEO'&&video.length!==1)||
    !Number.isFinite(durationMs)||durationMs<0||(kind!=='IMAGE'&&(durationMs<=0||durationMs>60000))||
    width>2048||height>2048||(video.length&&(width<=0||height<=0||width*height>4194304))||
    !Number.isInteger(frames)||frames<0||frames>1800||
    parsed.streams.some(s=>s.tags?.rotate&&Number(s.tags.rotate)!==0||s.side_data_list?.some(d=>d.rotation&&d.rotation!==0))||
    audio.some(s=>!s.channels||s.channels>2||!Number.isFinite(Number(s.sample_rate))||Number(s.sample_rate)>48000))
    throw new Error('ANALYZER_TRANSFORM_UNSUPPORTED_GEOMETRY');
  return {width,height,durationMs,audioTracks:audio.length,videoTracks:video.length,frames};
}
export function transformFilters(raw:MediaTransformPlan,g:TransformGeometry){
  const plan=mediaTransformPlanSchema.parse(raw),video:string[]=[],audio:string[]=[];
  const crop=plan.operations.find(op=>op.operation==='KEEP_INTERVAL');
  const sourceStartMs=crop?.interval.startMs??0,sourceEndMs=crop?.interval.endMs??g.durationMs;
  for(const op of plan.operations){
    if(op.interval&&(op.interval.endMs>g.durationMs||op.interval.startMs>=g.durationMs))throw new Error('ANALYZER_TRANSFORM_TIME_OUT_OF_BOUNDS');
    if(op.operation==='MASK_REGION'){
      if(!g.videoTracks)throw new Error('ANALYZER_TRANSFORM_VIDEO_REQUIRED');
      // Outward rounding and an extra pixel avoid leaving the edge of the detected region exposed.
      const x=Math.max(0,Math.floor(op.region[0]*g.width)-1),y=Math.max(0,Math.floor(op.region[1]*g.height)-1);
      const w=Math.min(g.width,Math.ceil(op.region[2]*g.width)+1)-x,h=Math.min(g.height,Math.ceil(op.region[3]*g.height)+1)-y;
      const enable=op.interval?":enable='between(t,"+Math.max(0,op.interval.startMs-100)/1000+","+Math.min(g.durationMs,op.interval.endMs+100)/1000+")'":'';
      video.push('drawbox=x='+x+':y='+y+':w='+w+':h='+h+':color=black:t=fill:replace=1'+enable);
    }else if(op.operation==='MUTE_INTERVAL'){
      if(!g.audioTracks)throw new Error('ANALYZER_TRANSFORM_AUDIO_REQUIRED');
      // aeval evaluates every sample, including both channels; no frame-boundary under-muting.
      audio.push("aeval=exprs='if(between(t,"+op.interval.startMs/1000+","+op.interval.endMs/1000+"),0,val(ch))':c=same");
    }
  }
  if(crop){
    if(g.videoTracks)video.push('trim=start='+sourceStartMs/1000+':end='+sourceEndMs/1000,'setpts=PTS-STARTPTS');
    if(g.audioTracks)audio.push('atrim=start='+sourceStartMs/1000+':end='+sourceEndMs/1000,'asetpts=PTS-STARTPTS');
  }
  return {video:video.join(','),audio:audio.join(','),sourceStartMs,durationMs:sourceEndMs-sourceStartMs};
}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export async function materializeMediaTransform(raw:MediaTransformPlan,inputPath:string,workspace:string,runner:CommandRunner,signal?:AbortSignal){
  const plan=mediaTransformPlanSchema.parse(raw),source=await stat(inputPath);
  if(!source.isFile()||source.size<1||source.size>1048576)throw new Error('ANALYZER_TRANSFORM_BYTE_LIMIT');
  if(digest(await readFile(inputPath))!==plan.sourceSha256)throw new Error('ANALYZER_TRANSFORM_SOURCE_CHANGED');
  const ffprobe=process.env.ANALYZER_FFPROBE_COMMAND??'ffprobe',ffmpeg=process.env.ANALYZER_FFMPEG_COMMAND??'ffmpeg';
  const options={cwd:workspace,timeoutMs:120000,maxOutputBytes:1048576,signal};
  const probe=async(file:string,counted=true)=>JSON.parse((await runner.run(ffprobe,['-v','error','-max_alloc','67108864','-protocol_whitelist','file,pipe',...(counted?['-count_frames','-read_intervals','%+#1801']:[]),'-show_streams','-show_format','-of','json',file],options)).stdout) as unknown;
  const toolchainVersions=await Promise.all([ffmpeg,ffprobe].map(program=>runner.run(program,['-version'],options)));
  if(toolchainVersions.some(result=>!result.stdout.trim()))throw new Error('ANALYZER_TRANSFORM_TOOLCHAIN_UNKNOWN');
  const toolchainDigest=digest(Buffer.from(canonicalJson(toolchainVersions.map(result=>result.stdout))));
  geometry(await probe(inputPath,false),plan.kind,false);
  const original=geometry(await probe(inputPath),plan.kind),filters=transformFilters(plan,original);
  const extension={IMAGE:'png',AUDIO:'wav',VIDEO:'mp4'}[plan.kind],outputPath=join(workspace,'transformed.'+extension);
  const args=['-v','error','-nostdin','-xerror','-max_alloc','67108864','-protocol_whitelist','file,pipe','-threads','1','-i',inputPath,
    '-map_metadata','-1','-map_chapters','-1','-sn','-dn'];
  if(original.videoTracks)args.push('-map','0:v:0');
  if(original.audioTracks)args.push('-map','0:a:0');
  if(filters.video)args.push('-vf',filters.video);
  if(filters.audio)args.push('-af',filters.audio);
  if(plan.kind==='IMAGE')args.push('-frames:v','1','-c:v','png','-pix_fmt','rgb24');
  if(plan.kind==='AUDIO')args.push('-c:a','pcm_s16le');
  if(plan.kind==='VIDEO'){args.push('-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p');if(original.audioTracks)args.push('-c:a','aac');args.push('-movflags','+faststart');}
  args.push('-threads','1','-fs','1048577','-y',outputPath);
  await runner.run(ffmpeg,args,options);
  const size=await stat(outputPath);if(!size.isFile()||size.size<1||size.size>1048576)throw new Error('ANALYZER_TRANSFORM_OUTPUT_BUDGET');
  const transformed=geometry(await probe(outputPath),plan.kind);
  if(original.width!==transformed.width||original.height!==transformed.height||original.audioTracks!==transformed.audioTracks||
    original.videoTracks!==transformed.videoTracks||Math.abs(transformed.durationMs-filters.durationMs)>100)
    throw new Error('ANALYZER_TRANSFORM_OUTPUT_GEOMETRY_CHANGED');
  await runner.run(ffmpeg,['-v','error','-nostdin','-xerror','-max_alloc','67108864','-protocol_whitelist','file,pipe','-threads','1','-i',outputPath,'-map','0','-f','null','-'],options);
  const derivedSha256=digest(await readFile(outputPath));
  if(digest(await readFile(inputPath))!==plan.sourceSha256)throw new Error('ANALYZER_TRANSFORM_SOURCE_CHANGED');
  const receipt=mediaTransformReceiptSchema.parse({version:'media-transform-1',planDigest:digest(Buffer.from(canonicalJson(plan))),sourceSha256:plan.sourceSha256,derivedSha256,
    mediaType:{IMAGE:'image/png',AUDIO:'audio/wav',VIDEO:'video/mp4'}[plan.kind],sizeBytes:size.size,transformerVersion:'guard-media-transform-1',toolchainDigest,
    sourceDurationMs:original.durationMs,derivedDurationMs:transformed.durationMs,sourceStartMs:filters.sourceStartMs,
    width:transformed.width,height:transformed.height,audioTracks:transformed.audioTracks,videoTracks:transformed.videoTracks,decodeVerified:true,semanticRecheckRequired:true});
  return {outputPath,receipt};
}
export async function transformMedia(raw:unknown,runner:CommandRunner,signal?:AbortSignal){
  const request=mediaTransformRequestSchema.parse(raw);
  return withLoadedArtifact(request.artifact,async(inputPath,workspace)=>{
    const materialized=await materializeMediaTransform(request.plan,inputPath,workspace,runner,signal);
    const uploaded=await uploadArtifactFile(request.output,materialized.outputPath,signal);
    if(uploaded.sha256!==materialized.receipt.derivedSha256||uploaded.sizeBytes!==materialized.receipt.sizeBytes)throw new Error('ANALYZER_TRANSFORM_UPLOAD_MISMATCH');
    return materialized.receipt;
  },signal);
}
