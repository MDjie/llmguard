import {join,basename} from 'node:path';
import {unlink} from 'node:fs/promises';
import { z } from 'zod';
import type { CommandRunner } from './command-runner';
import type { TranscriptSegment, VisualLabel, VisualRisk } from './contracts';

const visualSchema = z.object({
  modelVersion: z.string().min(1).max(128),
  labels: z.array(z.object({
    label: z.string().min(1).max(128),
    score: z.number().min(0).max(1),
    region: z.tuple([
      z.number().min(0).max(1), z.number().min(0).max(1),
      z.number().min(0).max(1), z.number().min(0).max(1),
    ]).optional(),
  }).strict()).max(1_000).optional(),
  risks: z.array(z.object({
    riskType: z.string().min(1).max(128),
    score: z.number().min(0).max(1),
    reasonCode: z.string().min(1).max(128),
    region: z.tuple([
      z.number().min(0).max(1), z.number().min(0).max(1),
      z.number().min(0).max(1), z.number().min(0).max(1),
    ]).optional(),
  }).strict()).max(100),
}).strict();

const asrSchema = z.object({
  modelVersion: z.string().min(1).max(128),
  segments: z.array(z.object({
    text: z.string().max(100_000),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1),
    speakerId: z.string().min(1).max(128).optional(),
    channel: z.number().int().nonnegative().max(64).optional(),
  }).strict().refine((item) => item.endMs >= item.startMs)).max(100_000),
}).strict();

const audioAnomalySchema = z.object({
  modelVersion: z.string().min(1).max(128),
  anomalies: z.array(z.object({
    type: z.enum([
      'noise', 'ultrasonic', 'speed_change', 'reversed_audio',
      'short_flash', 'hidden_middle', 'track_mismatch',
    ]),
    score: z.number().min(0).max(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  }).strict()).max(1_000),
}).strict();

async function jsonCommand<T>(
  runner: CommandRunner,
  program: string | undefined,
  requiredCode: string,
  args: readonly string[],
  workspace: string,
  timeoutMs: number,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!program?.trim()||program.includes('${')) throw new Error(requiredCode);
  const result = await runner.run(program, args, {
    cwd: workspace,
    timeoutMs,
    maxOutputBytes: 32 * 1_024 * 1_024,
    signal,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('ANALYZER_MODEL_OUTPUT_JSON_INVALID');
  }
  return schema.parse(parsed);
}

export async function classifyImage(input: {
  runner: CommandRunner;
  imagePath: string;
  workspace: string;
  viewId: string;
  frameIndex?: number;
  signal?: AbortSignal;
}): Promise<{ modelVersion: string; risks: VisualRisk[]; labels: VisualLabel[] }> {
  const result = await jsonCommand(
    input.runner,
    process.env.ANALYZER_VISUAL_COMMAND,
    'ANALYZER_VISUAL_COMMAND_REQUIRED',
    ['--input', input.imagePath, '--output-format', 'json'],
    input.workspace,
    120_000,
    visualSchema,
    input.signal,
  );
  return {
    modelVersion: result.modelVersion,
    labels: (result.labels ?? []).map((label) => ({
      ...label,
      viewId: input.viewId,
      ...(input.frameIndex === undefined ? {} : { frameIndex: input.frameIndex }),
    })),
    risks: result.risks.map((risk) => ({
      ...risk,
      viewId: input.viewId,
      ...(input.frameIndex === undefined ? {} : { frameIndex: input.frameIndex }),
    })),
  };
}

export async function transcribeAudio(input: {
  runner: CommandRunner;
  audioPath: string;
  workspace: string;
  signal?: AbortSignal;
}): Promise<{ modelVersion: string; segments: TranscriptSegment[] }> {
  return jsonCommand(
    input.runner,
    process.env.ANALYZER_ASR_COMMAND,
    'ANALYZER_ASR_COMMAND_REQUIRED',
    ['--input', input.audioPath, '--output-format', 'json'],
    input.workspace,
    300_000,
    asrSchema,
    input.signal,
  );
}

export async function classifyAudioAnomalies(input: {
  runner: CommandRunner;
  audioPath: string;
  workspace: string;
  signal?: AbortSignal;
}) {
  return jsonCommand(
    input.runner,
    process.env.ANALYZER_AUDIO_CLASSIFIER_COMMAND,
    'ANALYZER_AUDIO_CLASSIFIER_COMMAND_REQUIRED',
    ['--input', input.audioPath, '--output-format', 'json'],
    input.workspace,
    300_000,
    audioAnomalySchema,
    input.signal,
  );
}

export function planAsrWindows(durationMs:number):Array<{startMs:number;endMs:number}>{
 if(!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>24*60*60*1000)throw new Error('ANALYZER_ASR_DURATION_INVALID');
 const windows:Array<{startMs:number;endMs:number}>=[];
 for(let startMs=0;startMs<durationMs;startMs+=29000){windows.push({startMs,endMs:Math.min(startMs+30000,durationMs)});if(startMs+30000>=durationMs)break;}
 return windows;
}
/** All providers see bounded mono PCM clips; preserve actual timing, never synthesize token confidence. */
export async function transcribeAudioWindowed(input:Parameters<typeof transcribeAudio>[0]&{durationMs:number;onWindowProcessed?:(window:{startMs:number;endMs:number;modelVersion:string})=>void}):Promise<Awaited<ReturnType<typeof transcribeAudio>>>{
 const segments:TranscriptSegment[]=[];let version:string|undefined;
 for(const [index,window] of planAsrWindows(input.durationMs).entries()){
  input.signal?.throwIfAborted();
  const output=join(input.workspace,basename(input.audioPath)+'.asr-'+index+'.wav');
  try {
  await input.runner.run(process.env.ANALYZER_FFMPEG_COMMAND??'ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-ss',String(window.startMs/1000),'-i',input.audioPath,'-t',String((window.endMs-window.startMs)/1000),'-ac','1','-ar','16000','-c:a','pcm_s16le','-y',output],{cwd:input.workspace,timeoutMs:60000,signal:input.signal});
  const result=await transcribeAudio({...input,audioPath:output});
  if(version&&version!==result.modelVersion)throw new Error('ANALYZER_ASR_MODEL_CHANGED');version=result.modelVersion;
  for(const segment of result.segments){
   if(segment.endMs>window.endMs-window.startMs)throw new Error('ANALYZER_ASR_TIMELINE_OUT_OF_BOUNDS');
   segments.push({...segment,startMs:window.startMs+segment.startMs,endMs:window.startMs+segment.endMs});
   if(segments.length>100000)throw new Error('ANALYZER_ASR_SEGMENT_LIMIT');
  }
  input.onWindowProcessed?.({...window,modelVersion:result.modelVersion});
  } finally {
   // Keep at most one bounded provider clip on disk, including failure/cancellation.
   await unlink(output).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
   });
  }
 }
 if(!version)throw new Error('ANALYZER_ASR_EMPTY_EXECUTION');return {modelVersion:version,segments};
}
