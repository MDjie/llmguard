import {pcmInputArguments, type PcmParameters} from '../../../src/lib/media/formats/pcm';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withLoadedArtifact } from './artifact-loader';
import type { CommandRunner } from './command-runner';
import type {
  AnalysisFailure,
  CodeRegion,
  MediaRequest,
  SubtitleSegment,
  TranscriptSegment,
  VisualLabel,
  VisualRisk,
} from './contracts';
import {
  classifyAudioAnomalies,
  classifyImage,
  transcribeAudioWindowed,
} from './model-adapters';
import { runOcr } from './ocr';
import { mapInBatches } from './batching';
import { readCodes } from './code-reader';
import { AnalyzerDependencyGuard } from './resilience';
import { extractSubtitles } from './subtitles';

const probeSchema = z.object({
  format: z.object({
    format_name: z.string().min(1),
    duration: z.string().optional(),
  }).passthrough(),
  streams: z.array(z.object({
    codec_type: z.string(),
    channels:z.number().int().positive().max(64).optional(),
    duration: z.string().optional(),
  }).passthrough()).max(100),
}).passthrough();

const asrGuard = new AnalyzerDependencyGuard({
  component: 'ASR', timeoutMs: 300_000, maxAttempts: 2,
  maximumConcurrent: 2, circuitFailureThreshold: 3, circuitResetMs: 30_000,
});
const audioClassifierGuard = new AnalyzerDependencyGuard({
  component: 'AUDIO_CLASSIFIER', timeoutMs: 300_000, maxAttempts: 2,
  maximumConcurrent: 2, circuitFailureThreshold: 3, circuitResetMs: 30_000,
});
const subtitleGuard = new AnalyzerDependencyGuard({
  component: 'SUBTITLE', timeoutMs: 120_000, maxAttempts: 2,
  maximumConcurrent: 2, circuitFailureThreshold: 3, circuitResetMs: 30_000,
});
const ocrGuard = new AnalyzerDependencyGuard({
  component: 'OCR', timeoutMs: 60_000, maxAttempts: 2,
  maximumConcurrent: 8, circuitFailureThreshold: 3, circuitResetMs: 30_000,
});
const visualGuard = new AnalyzerDependencyGuard({
  component: 'VISUAL', timeoutMs: 120_000, maxAttempts: 2,
  maximumConcurrent: 4, circuitFailureThreshold: 3, circuitResetMs: 30_000,
});
const codeGuard = new AnalyzerDependencyGuard({
  component: 'CODE_READER', timeoutMs: 30_000, maxAttempts: 2,
  maximumConcurrent: 4, circuitFailureThreshold: 3, circuitResetMs: 30_000,
});

function failure(
  component: AnalysisFailure['component'],
  required: boolean,
  error: unknown,
): AnalysisFailure {
  const candidate = error instanceof Error ? error.message : '';
  const code = /^ANALYZER_[A-Z0-9_:.-]+$/u.test(candidate)
    ? candidate.slice(0, 160)
    : `ANALYZER_${component}_FAILED`;
  return { component, required, code };
}

function uniqueFailures(values: readonly AnalysisFailure[]): AnalysisFailure[] {
  return [...new Map(values.map((item) => [
    `${item.component}:${item.required}:${item.code}`,
    item,
  ])).values()].slice(0, 100);
}

async function probe(
  runner: CommandRunner,
  inputPath: string,
  workspace: string,
  timeoutMs: number,
  signal?: AbortSignal,
  pcm?: PcmParameters,
) {
  const result = await runner.run(process.env.ANALYZER_FFPROBE_COMMAND ?? 'ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json',
    '-protocol_whitelist', 'file,pipe', ...pcmInputArguments(pcm), inputPath,
  ], {
    cwd: workspace,
    timeoutMs,
    maxOutputBytes: 4 * 1_024 * 1_024,
    signal,
  });
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error('ANALYZER_FFPROBE_JSON_INVALID');
  }
  const parsed = probeSchema.parse(value);
  const durations=[parsed.format.duration,...parsed.streams.map(stream=>stream.duration)]
    .filter((value):value is string=>value!==undefined&&value!=='N/A').map(Number);
  if(!durations.length||durations.some(value=>!Number.isFinite(value)||value<0))throw new Error('ANALYZER_MEDIA_DURATION_UNKNOWN');
  const durationMs=Math.round(Math.max(...durations)*1000);
  if(!Number.isSafeInteger(durationMs)||durationMs<=0||durationMs>7*24*60*60*1000)throw new Error('ANALYZER_MEDIA_DURATION_INVALID');
  return {
    format: parsed.format.format_name.slice(0, 100),
    durationMs,
    audioTrackCount: parsed.streams.filter(stream => stream.codec_type === 'audio').length,
    audioUnits:parsed.streams.filter(stream=>stream.codec_type==='audio').flatMap((stream,track)=>{if(!stream.channels)throw new Error('ANALYZER_AUDIO_CHANNELS_UNKNOWN');return Array.from({length:stream.channels},(_,channel)=>({track,channel}));}),
    subtitleTrackCount: parsed.streams.filter(stream => stream.codec_type === 'subtitle').length,
    hasAudio: parsed.streams.some((stream) => stream.codec_type === 'audio'),
    hasVideo: parsed.streams.some((stream) => stream.codec_type === 'video'),
    hasSubtitles: parsed.streams.some((stream) => stream.codec_type === 'subtitle'),
  };
}

export function assertMediaResourceBudget(input: {
  readonly durationMs: number;
  readonly maxDurationMs: number;
  readonly decodedBytes: number;
  readonly maxDecodedBytes: number;
}): void {
  if (
    !Number.isSafeInteger(input.durationMs) || input.durationMs < 0 ||
    !Number.isSafeInteger(input.decodedBytes) || input.decodedBytes < 0
  ) {
    throw new Error('ANALYZER_MEDIA_BUDGET_INPUT_INVALID');
  }
  if (input.maxDurationMs > 0 && input.durationMs > input.maxDurationMs) {
    throw new Error('ANALYZER_MEDIA_DURATION_LIMIT');
  }
  if (input.decodedBytes > input.maxDecodedBytes) {
    throw new Error('ANALYZER_DECODED_BYTES_LIMIT');
  }
}

async function decodedBytes(paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const path of new Set(paths)) {
    total += (await stat(path)).size;
    if (!Number.isSafeInteger(total)) throw new Error('ANALYZER_DECODED_BYTES_LIMIT');
  }
  return total;
}

export async function extractAudio(
  runner: CommandRunner,
  inputPath: string,
  outputPath: string,
  workspace: string,
  timeoutMs: number,
  signal?: AbortSignal,
  track=0,channel=0,pcm?: PcmParameters,
) {
  await runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
    '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
    ...pcmInputArguments(pcm), '-i', inputPath, '-map', '0:a:'+track, '-vn', '-af',`pan=mono|c0=c${channel}`, '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', '-y', outputPath,
  ], {
    cwd: workspace,
    timeoutMs,
    maxOutputBytes: 4 * 1_024 * 1_024,
    signal,
  });
}

type AudioViewId = MediaRequest['audioViews'][number];

interface AudioView {
  readonly id: AudioViewId;
  readonly path: string;
  readonly timeScale: number;
  readonly reverseDurationMs?: number;
}

function audioFilter(viewId: Exclude<AudioViewId, 'original'>): string {
  if (viewId === 'denoise') return 'afftdn';
  if (viewId === 'normalize') return 'loudnorm=I=-16:TP=-1.5:LRA=11';
  if (viewId === 'speed_0_9') return 'atempo=0.9';
  if (viewId === 'speed_1_1') return 'atempo=1.1';
  return 'areverse';
}

async function materializeAudioViews(input: {
  readonly request: MediaRequest;
  readonly runner: CommandRunner;
  readonly originalPath: string;
  readonly workspace: string;
  readonly durationMs: number;
  readonly prefix?:string;
  readonly signal?: AbortSignal;
}): Promise<AudioView[]> {
  const unique = [...new Set(input.request.audioViews)];
  return mapInBatches(unique, input.request.sampling.batchSize, async (viewId) => {
    if (viewId === 'original') {
      return { id: viewId, path: input.originalPath, timeScale: 1 };
    }
    const target = join(input.workspace, `${input.prefix??'audio'}-${viewId}.wav`);
    const reverseDurationMs = viewId === 'reverse_probe'
      ? Math.min(input.durationMs, 60_000)
      : undefined;
    await input.runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      ...(reverseDurationMs === undefined
        ? []
        : ['-t', String(Math.max(0.001, reverseDurationMs / 1_000))]),
      '-i', input.originalPath,
      '-af', audioFilter(viewId),
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', target,
    ], {
      cwd: input.workspace,
      timeoutMs: input.request.sandbox.ffmpegTimeoutMs,
      maxOutputBytes: 4 * 1_024 * 1_024,
      signal: input.signal,
    });
    return {
      id: viewId,
      path: target,
      timeScale: viewId === 'speed_0_9' ? 0.9 : viewId === 'speed_1_1' ? 1.1 : 1,
      ...(reverseDurationMs === undefined ? {} : { reverseDurationMs }),
    };
  }, input.signal);
}

export function remapAudioViewSegment(
  segment: TranscriptSegment,
  view: Pick<AudioView, 'timeScale' | 'reverseDurationMs'>,
): TranscriptSegment {
  if (view.reverseDurationMs !== undefined) {
    return {
      ...segment,
      startMs: Math.max(0, view.reverseDurationMs - segment.endMs),
      endMs: Math.max(0, view.reverseDurationMs - segment.startMs),
    };
  }
  return {
    ...segment,
    startMs: Math.max(0, Math.round(segment.startMs * view.timeScale)),
    endMs: Math.max(0, Math.round(segment.endMs * view.timeScale)),
  };
}

export function mergeTranscriptSegments(
  segments: readonly TranscriptSegment[],
): TranscriptSegment[] {
  const selected = new Map<string, TranscriptSegment>();
  for (const segment of segments) {
    const normalizedText = segment.text.normalize('NFKC').trim().toLowerCase();
    if (!normalizedText) continue;
    const key = `${segment.channel??0}:${Math.round(segment.startMs / 250)}:${Math.round(segment.endMs / 250)}:${normalizedText}`;
    const previous = selected.get(key);
    if (!previous || segment.confidence > previous.confidence) selected.set(key, segment);
  }
  return [...selected.values()]
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    .slice(0, 100_000);
}

function samplingIntervalSeconds(request: MediaRequest, durationMs: number): number {
  const fixed = request.sampling.strategies.find((item) => item.type === 'fixed_interval')
    ?.parameters.intervalMs;
  if (fixed && fixed > 0) return Math.max(0.04, fixed / 1_000);
  const durationSeconds = Math.max(1, durationMs / 1_000);
  return Math.max(0.04, durationSeconds / request.sampling.maxFrames);
}

export interface VideoSamplingJob {
  readonly id: MediaRequest['sampling']['strategies'][number]['type'];
  readonly filter: string;
  readonly maximumFrames: number;
}

export function buildVideoSamplingJobs(
  request: MediaRequest,
  durationMs: number,
  maximumFrames = request.sampling.maxFrames,
): readonly VideoSamplingJob[] {
  const unique = [...new Map(request.sampling.strategies.map((strategy) =>
    [strategy.type, strategy])).values()];
  let remaining = Math.max(0, Math.min(request.sampling.maxFrames, maximumFrames));
  const jobs: VideoSamplingJob[] = [];
  const reserve = (type: VideoSamplingJob['id'], desired: number, filter: string) => {
    if (remaining <= 0 || !unique.some((strategy) => strategy.type === type)) return;
    const maximum = Math.min(remaining, desired);
    jobs.push({ id: type, filter, maximumFrames: maximum });
    remaining -= maximum;
  };
  const durationSeconds = Math.max(0, durationMs / 1_000);
  reserve('boundary', 2, `select='lte(t,0.04)+gte(t,${Math.max(0, durationSeconds - 0.04)})'`);
  const midpoint = unique.find((strategy) => strategy.type === 'midpoint');
  if (midpoint) {
    const atSeconds = Number(midpoint.parameters.atMs ?? durationMs / 2) / 1_000;
    reserve('midpoint', 1, `select='between(t,${Math.max(0, atSeconds - 0.04)},${atSeconds + 0.04})'`);
  }
  const remainingTypes = unique.filter((strategy) =>
    !['boundary', 'midpoint'].includes(strategy.type));
  for (let index = 0; index < remainingTypes.length && remaining > 0; index += 1) {
    const strategy = remainingTypes[index];
    const maximum = index === remainingTypes.length - 1
      ? remaining
      : Math.max(1, Math.floor(remaining / (remainingTypes.length - index)));
    let filter: string;
    if (strategy.type === 'fixed_interval') {
      const interval = samplingIntervalSeconds(request, durationMs);
      filter = `fps=1/${interval}`;
    } else if (strategy.type === 'scene_change') {
      const threshold = Math.min(1, Math.max(0, Number(strategy.parameters.threshold ?? 0.25)));
      filter = `select='gt(scene,${threshold})'`;
    } else {
      const scanFps = Math.min(25, Math.max(1, Number(strategy.parameters.scanFps ?? 25)));
      filter = `fps=${scanFps}`;
    }
    jobs.push({ id: strategy.type, filter, maximumFrames: maximum });
    remaining -= maximum;
  }
  return jobs;
}

interface ExtractedFrame {
  readonly path: string;
  readonly timeMs: number;
}

async function extractFrames(input: {
  readonly request: MediaRequest;
  readonly runner: CommandRunner;
  readonly inputPath: string;
  readonly workspace: string;
  readonly durationMs: number;
  readonly maximumFrames: number;
  readonly prefix: 'summary' | 'expanded';
  readonly signal?: AbortSignal;
}): Promise<ExtractedFrame[]> {
  const jobs = buildVideoSamplingJobs(input.request, input.durationMs, input.maximumFrames);
  for (const job of jobs) {
    await input.runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', input.inputPath, '-vf', job.filter,
      '-frames:v', String(job.maximumFrames), '-vsync', 'vfr',
      '-y', join(input.workspace, `frame-${input.prefix}-${job.id}-%06d.png`),
    ], {
      cwd: input.workspace,
      timeoutMs: input.request.sandbox.ffmpegTimeoutMs,
      maxOutputBytes: 4 * 1_024 * 1_024,
      signal: input.signal,
    });
  }
  const names = (await readdir(input.workspace))
    .filter((name) => new RegExp(`^frame-${input.prefix}-[a-z_]+-\\d{6}\\.png$`, 'u').test(name))
    .sort()
    .slice(0, input.maximumFrames);
  const intervalMs = input.durationMs / Math.max(1, names.length - 1);
  return names.map((name, index) => ({
    path: join(input.workspace, name),
    timeMs: Math.min(input.durationMs, Math.round(index * intervalMs)),
  }));
}

interface FrameAnalysis {
  readonly versions: readonly string[];
  readonly failures: readonly AnalysisFailure[];
  readonly frame: {
    readonly frameIndex: number;
    readonly timeMs: number;
    readonly ocrText?: string;
    readonly codes: readonly CodeRegion[];
    readonly labels: readonly VisualLabel[];
    readonly risks: readonly VisualRisk[];
  };
}

async function analyzeFrames(input: {
  readonly request: MediaRequest;
  readonly runner: CommandRunner;
  readonly files: readonly ExtractedFrame[];
  readonly workspace: string;
  readonly indexOffset: number;
  readonly signal?: AbortSignal;
}): Promise<FrameAnalysis[]> {
  return mapInBatches(
    input.files,
    input.request.sampling.batchSize,
    async (file, localIndex) => {
      const frameIndex = input.indexOffset + localIndex;
      const viewId = `frame_${frameIndex}`;
      const [ocrResult, visualResult, codeResult] = await Promise.allSettled([
        ocrGuard.execute((attemptSignal) => runOcr({
          runner: input.runner,
          tesseract: process.env.ANALYZER_TESSERACT_COMMAND ?? 'tesseract',
          ffprobe: process.env.ANALYZER_FFPROBE_COMMAND ?? 'ffprobe',
          imagePath: file.path,
          workspace: input.workspace,
          viewId,
          sourceRelation: 'OCR_FROM_VIDEO_FRAME',
          signal: attemptSignal,
        }), input.signal),
        visualGuard.execute((attemptSignal) => classifyImage({
          runner: input.runner,
          imagePath: file.path,
          workspace: input.workspace,
          viewId,
          frameIndex,
          signal: attemptSignal,
        }), input.signal),
        codeGuard.execute((attemptSignal) => readCodes({
          runner: input.runner,
          imagePath: file.path,
          workspace: input.workspace,
          viewId,
          signal: attemptSignal,
        }), input.signal),
      ]);
      const failures: AnalysisFailure[] = [];
      const versions: string[] = [];
      const ocr = ocrResult.status === 'fulfilled'
        ? ocrResult.value.filter((item) =>
            item.confidence >= input.request.sampling.minimumConfidence)
        : [];
      if (ocrResult.status === 'rejected') failures.push(failure('OCR', true, ocrResult.reason));
      const visual = visualResult.status === 'fulfilled'
        ? visualResult.value
        : { modelVersion: '', labels: [], risks: [] };
      if (visualResult.status === 'fulfilled') versions.push(visualResult.value.modelVersion);
      else failures.push(failure('VISUAL', true, visualResult.reason));
      const codes = codeResult.status === 'fulfilled'
        ? codeResult.value.map((item) => ({ ...item, frameIndex }))
        : [];
      if (codeResult.status === 'rejected') {
        failures.push(failure('CODE_READER', true, codeResult.reason));
      }
      const ocrText = ocr.map((item) => item.text).join(' ').slice(0, 100_000);
      return {
        versions,
        failures,
        frame: {
          frameIndex,
          timeMs: file.timeMs,
          ...(ocrText ? { ocrText } : {}),
          codes,
          labels: visual.labels.filter((item) =>
            item.score >= input.request.sampling.minimumConfidence),
          risks: visual.risks.filter((item) =>
            item.score >= input.request.sampling.minimumConfidence),
        },
      };
    },
    input.signal,
  );
}

export function shouldExpandAdaptiveSampling(input: {
  readonly frames: readonly FrameAnalysis['frame'][];
  readonly anomalies: readonly { readonly score: number }[];
  readonly failures: readonly AnalysisFailure[];
  readonly threshold: number;
}): boolean {
  if (input.failures.some((item) => item.required)) return true;
  const maximumScore = Math.max(
    0,
    ...input.anomalies.map((item) => item.score),
    ...input.frames.flatMap((frame) => frame.risks.map((item) => item.score)),
  );
  if (maximumScore >= input.threshold) return true;
  const text = input.frames.flatMap((frame) => [
    frame.ocrText ?? '',
    ...frame.codes.map((item) => item.text),
  ]).join(' ').normalize('NFKC');
  return /(?:ignore|bypass|jailbreak|system\s*prompt|previous\s*instructions?|忽略|绕过|越狱|系统提示|此前指令|角色扮演)/iu.test(text);
}

function analyzerVersion(versions: ReadonlySet<string>, degraded: boolean): string {
  const suffix = [...versions].filter(Boolean).sort().join(',') || (degraded ? 'degraded' : 'builtin');
  return `media-analyzer/1.1+${suffix}`.slice(0, 100);
}

export async function analyzeAudioVideo(
  request: MediaRequest,
  runner: CommandRunner,
  signal?: AbortSignal,
) {
  const maximum = request.artifact.kind === 'AUDIO'
    ? 500 * 1_024 * 1_024
    : 3 * 1_024 * 1_024 * 1_024;
  if (request.artifact.sizeBytes > maximum) throw new Error('ANALYZER_ARTIFACT_TOO_LARGE');
  return withLoadedArtifact(request.artifact, async (inputPath, workspace) => {
    const metadata = await probe(
      runner, inputPath, workspace, request.sandbox.ffprobeTimeoutMs, signal, request.artifact.pcm);
    if(metadata.audioUnits.length>16)throw new Error('ANALYZER_AUDIO_TRACK_BUDGET_EXCEEDED');
    assertMediaResourceBudget({
      durationMs: metadata.durationMs,
      maxDurationMs: request.sampling.maxDurationMs,
      decodedBytes: metadata.hasAudio ? metadata.durationMs * 32 * metadata.audioUnits.length * Math.max(1,request.audioViews.length) : 0,
      maxDecodedBytes: request.sandbox.maxDecodedBytes,
    });
    if (request.artifact.kind === 'AUDIO' && !metadata.hasAudio) {
      throw new Error('ANALYZER_AUDIO_TRACK_MISSING');
    }
    if (request.artifact.kind === 'VIDEO' && !metadata.hasVideo) {
      throw new Error('ANALYZER_VIDEO_TRACK_MISSING');
    }
    const versions = new Set<string>();
    const failures: AnalysisFailure[] = [];
    const generatedPaths: string[] = [];
    const coordinateMappings:Record<string,unknown>[]=[];
    let transcript: TranscriptSegment[] = [];
    const subtitles: SubtitleSegment[] = [];
    const anomalies: Awaited<ReturnType<typeof classifyAudioAnomalies>>['anomalies'] = [];
    for (const [unitIndex,unit] of metadata.audioUnits.entries()) {
      const prefix=`track${unit.track}-ch${unit.channel}`;
      const audioPath = join(workspace, prefix+'.wav');
      await extractAudio(
        runner, inputPath, audioPath, workspace, request.sandbox.ffmpegTimeoutMs, signal,unit.track,unit.channel,request.artifact.pcm);
      generatedPaths.push(audioPath);
      const audioViews = await materializeAudioViews({
        request,
        runner,
        originalPath: audioPath,
        prefix,workspace,
        durationMs: metadata.durationMs,
        signal,
      });
      generatedPaths.push(...audioViews.map((item) => item.path));
      assertMediaResourceBudget({
        durationMs: metadata.durationMs,
        maxDurationMs: request.sampling.maxDurationMs,
        decodedBytes: await decodedBytes(generatedPaths),
        maxDecodedBytes: request.sandbox.maxDecodedBytes,
      });
      try {
        const audioRisks = await audioClassifierGuard.execute((attemptSignal) =>
          classifyAudioAnomalies({
            runner,
            audioPath,
            workspace,
            signal: attemptSignal,
          }), signal);
        versions.add(audioRisks.modelVersion);
        anomalies.push(...audioRisks.anomalies.filter(
          (item) => item.score >= request.sampling.minimumConfidence,
        ));
      } catch (error) {
        failures.push(failure('AUDIO_CLASSIFIER', true, error));
      }
      coordinateMappings.push(...audioViews.map(view=>({viewId:prefix+'-'+view.id,track:unit.track,channel:unit.channel,mappingVersion:'audio-time-to-source-1',basis:'SOURCE_TIME_MS',timeScale:view.timeScale,reverseDurationMs:view.reverseDurationMs??null,sourceDurationMs:metadata.durationMs})));
      const asrViews = await mapInBatches(
        audioViews,
        request.sampling.batchSize,
        async (view) => {
          try {
            const result = await asrGuard.execute((attemptSignal) => transcribeAudioWindowed({
              runner,
              audioPath: view.path,
              durationMs:Math.round(view.reverseDurationMs??metadata.durationMs/view.timeScale),
              workspace,
              signal: attemptSignal,
            }), signal);
            return { view, result } as const;
          } catch (error) {
            failures.push(failure('ASR', true, error));
            return undefined;
          }
        },
        signal,
      );
      for (const item of asrViews) {
        if (!item) continue;
        versions.add(item.result.modelVersion);
        if(item.result.segments.some(segment=>segment.confidence<request.sampling.minimumConfidence))failures.push({component:'ASR',required:true,code:'ANALYZER_ASR_LOW_CONFIDENCE_REGIONS'});
      }
      transcript = mergeTranscriptSegments([...transcript,...asrViews.flatMap((item) => item
        ? item.result.segments
            .filter((segment) => segment.confidence >= request.sampling.minimumConfidence)
            .map((segment) => remapAudioViewSegment({
              ...segment,
              source: 'asr',
              sourceViewId:prefix+'-'+item.view.id,channel:unitIndex,
            }, item.view))
        : [])]);
    }
    if(metadata.subtitleTrackCount>16)throw new Error('ANALYZER_SUBTITLE_TRACK_BUDGET_EXCEEDED');
    for(let subtitleTrack=0;subtitleTrack<metadata.subtitleTrackCount;subtitleTrack++){
      try {
        subtitles.push(...await subtitleGuard.execute((attemptSignal) => extractSubtitles({
          runner,
          inputPath,
          trackIndex:subtitleTrack,
          workspace,
          timeoutMs: request.sandbox.ffmpegTimeoutMs,
          signal: attemptSignal,
        }), signal));
        coordinateMappings.push({viewId:'subtitle-track-'+subtitleTrack,track:subtitleTrack,mappingVersion:'subtitle-track-time-1',basis:'SOURCE_TIME_MS'});
      } catch (error) {
        failures.push(failure('SUBTITLE', true, error));
      }
    }
    const frames: FrameAnalysis['frame'][] = [];
    let samplingPhase: 'summary' | 'expanded' = 'summary';
    if (request.artifact.kind === 'VIDEO') {
      const summaryMaximum = request.sampling.adaptive
        ? Math.min(request.sampling.maxFrames, request.sampling.adaptive.summaryFrames)
        : request.sampling.maxFrames;
      const summaryFiles = await extractFrames({
        request,
        runner,
        inputPath,
        workspace,
        durationMs: metadata.durationMs,
        maximumFrames: summaryMaximum,
        prefix: request.sampling.adaptive ? 'summary' : 'expanded',
        signal,
      });
      generatedPaths.push(...summaryFiles.map((item) => item.path));
      if (summaryFiles.length === 0) {
        failures.push({
          component: 'VISUAL', required: true, code: 'ANALYZER_VIDEO_FRAME_EXTRACTION_EMPTY',
        });
      }
      const summaryAnalysis = await analyzeFrames({
        request,
        runner,
        files: summaryFiles,
        workspace,
        indexOffset: 0,
        signal,
      });
      for (const item of summaryAnalysis) {
        item.versions.forEach((version) => versions.add(version));
        failures.push(...item.failures);
        frames.push(item.frame);
      }
      const shouldExpand = request.sampling.adaptive &&
        summaryFiles.length < request.sampling.maxFrames &&
        shouldExpandAdaptiveSampling({
          frames,
          anomalies,
          failures,
          threshold: request.sampling.adaptive.expansionThreshold,
        });
      if (shouldExpand) {
        const expandedFiles = await extractFrames({
          request,
          runner,
          inputPath,
          workspace,
          durationMs: metadata.durationMs,
          maximumFrames: request.sampling.maxFrames - summaryFiles.length,
          prefix: 'expanded',
          signal,
        });
        generatedPaths.push(...expandedFiles.map((item) => item.path));
        const expandedAnalysis = await analyzeFrames({
          request,
          runner,
          files: expandedFiles,
          workspace,
          indexOffset: frames.length,
          signal,
        });
        for (const item of expandedAnalysis) {
          item.versions.forEach((version) => versions.add(version));
          failures.push(...item.failures);
          frames.push(item.frame);
        }
        samplingPhase = 'expanded';
      } else if (!request.sampling.adaptive) {
        samplingPhase = 'expanded';
      }
      assertMediaResourceBudget({
        durationMs: metadata.durationMs,
        maxDurationMs: request.sampling.maxDurationMs,
        decodedBytes: await decodedBytes(generatedPaths),
        maxDecodedBytes: request.sandbox.maxDecodedBytes,
      });
    }
    const analysisFailures = uniqueFailures(failures);
    // These are observed transcript intervals and sampled frame instants, not semantic proof of the whole recording.
    const intervals = transcript.map(segment => ({ startMs: Math.max(0, segment.startMs), endMs: Math.min(metadata.durationMs, segment.endMs) }))
      .filter(interval => interval.startMs < interval.endMs).sort((left, right) => left.startMs - right.startMs);
    const processedIntervals: Array<{ startMs: number; endMs: number }> = [];
    for (const interval of intervals) { const previous = processedIntervals.at(-1); if (previous && interval.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, interval.endMs); else processedIntervals.push({ ...interval }); }
    const sampledAtMs = [...new Set(frames.map(frame => frame.timeMs))].sort((left, right) => left - right);
    const boundaries = [0, ...sampledAtMs, metadata.durationMs];
    const maximumGapMs = boundaries.slice(1).reduce((maximum, time, index) => Math.max(maximum, time - boundaries[index]), 0);
    const audioFailed = analysisFailures.some(item => item.component === 'ASR' || item.component === 'AUDIO_CLASSIFIER');
    const subtitleFailed = analysisFailures.some(item => item.component === 'SUBTITLE');
    return {
      analyzerVersion: analyzerVersion(versions, analysisFailures.length > 0),
      coverage:{artifactSha256:request.artifact.sha256,modality:request.artifact.kind,
        state:analysisFailures.length?'INCOMPLETE' as const:'SAMPLED' as const,
        unit:'MILLISECOND' as const,expectedUnits:Math.max(1,metadata.durationMs),processedUnits:processedIntervals.reduce((total, interval) => total + interval.endMs - interval.startMs, 0),
        processingCoverage: [
          { unit: 'AUDIO_TRACK' as const, expected: metadata.audioTrackCount, processed: !audioFailed ? metadata.audioTrackCount : 0, failed: audioFailed ? metadata.audioTrackCount : 0, skipped: 0 },
          { unit: 'SUBTITLE_TRACK' as const, expected: metadata.subtitleTrackCount, processed: !subtitleFailed ? metadata.subtitleTrackCount : 0, failed: subtitleFailed ? metadata.subtitleTrackCount : 0, skipped: 0 },
        ],
        temporalCoverage: { durationMs: metadata.durationMs, processedIntervals, sampledAtMs, maximumGapMs, enumerationComplete: false },
        analyzerVersion:analyzerVersion(versions,analysisFailures.length>0),
        reasonCodes:[...analysisFailures.map(f=>f.code),'FRAME_OR_TRANSCRIPT_COVERAGE_NOT_FULL_SEMANTIC_PROOF']},
      format: metadata.format,
      durationMs: metadata.durationMs,
      coordinateMappings:[...coordinateMappings,...frames.map(frame=>({viewId:'frame_'+frame.frameIndex,mappingVersion:'video-frame-to-source-1',basis:'SOURCE_TIME_MS',frameIndex:frame.frameIndex,timeMs:frame.timeMs}))],
      transcript,
      subtitles,
      frames: frames.slice(0, request.sampling.maxFrames),
      anomalies,
      analysisFailures,
      degraded: analysisFailures.length > 0,
      samplingPhase,
    };
  }, signal);
}
