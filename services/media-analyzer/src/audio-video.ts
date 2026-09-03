import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withLoadedArtifact } from './artifact-loader';
import type { CommandRunner } from './command-runner';
import type { MediaRequest } from './contracts';
import {
  classifyAudioAnomalies,
  classifyImage,
  transcribeAudio,
} from './model-adapters';
import { runOcr } from './ocr';
import { mapInBatches } from './batching';
import type { TranscriptSegment } from './contracts';

const probeSchema = z.object({
  format: z.object({
    format_name: z.string().min(1),
    duration: z.string().optional(),
  }).passthrough(),
  streams: z.array(z.object({
    codec_type: z.string(),
    duration: z.string().optional(),
  }).passthrough()).max(100),
}).passthrough();

async function probe(
  runner: CommandRunner,
  inputPath: string,
  workspace: string,
  timeoutMs: number,
) {
  const result = await runner.run(process.env.ANALYZER_FFPROBE_COMMAND ?? 'ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json',
    '-protocol_whitelist', 'file,pipe', inputPath,
  ], { cwd: workspace, timeoutMs, maxOutputBytes: 4 * 1_024 * 1_024 });
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('ANALYZER_FFPROBE_JSON_INVALID'); }
  const parsed = probeSchema.parse(value);
  const seconds = Number(parsed.format.duration ??
    parsed.streams.map((stream) => Number(stream.duration ?? 0)).find((item) => item > 0) ?? 0);
  return {
    format: parsed.format.format_name.slice(0, 100),
    durationMs: Math.max(0, Math.min(
      7 * 24 * 60 * 60 * 1_000,
      Math.round((Number.isFinite(seconds) ? seconds : 0) * 1_000),
    )),
    hasAudio: parsed.streams.some((stream) => stream.codec_type === 'audio'),
    hasVideo: parsed.streams.some((stream) => stream.codec_type === 'video'),
  };
}

async function extractAudio(
  runner: CommandRunner,
  inputPath: string,
  outputPath: string,
  workspace: string,
  timeoutMs: number,
) {
  await runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
    '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-i', inputPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', '-y', outputPath,
  ], { cwd: workspace, timeoutMs, maxOutputBytes: 4 * 1_024 * 1_024 });
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
}): Promise<AudioView[]> {
  const unique = [...new Set(input.request.audioViews)];
  return mapInBatches(unique, input.request.sampling.batchSize, async (viewId) => {
    if (viewId === 'original') {
      return { id: viewId, path: input.originalPath, timeScale: 1 };
    }
    const target = join(input.workspace, `audio-${viewId}.wav`);
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
    });
    return {
      id: viewId,
      path: target,
      timeScale: viewId === 'speed_0_9' ? 0.9 : viewId === 'speed_1_1' ? 1.1 : 1,
      ...(reverseDurationMs === undefined ? {} : { reverseDurationMs }),
    };
  });
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
    const key = `${Math.round(segment.startMs / 250)}:${Math.round(segment.endMs / 250)}:${normalizedText}`;
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
): readonly VideoSamplingJob[] {
  const unique = [...new Map(request.sampling.strategies.map((strategy) =>
    [strategy.type, strategy])).values()];
  let remaining = request.sampling.maxFrames;
  const jobs: VideoSamplingJob[] = [];
  const reserve = (type: VideoSamplingJob['id'], desired: number, filter: string) => {
    if (remaining <= 0 || !unique.some((strategy) => strategy.type === type)) return;
    const maximumFrames = Math.min(remaining, desired);
    jobs.push({ id: type, filter, maximumFrames });
    remaining -= maximumFrames;
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
    const maximumFrames = index === remainingTypes.length - 1
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
    jobs.push({ id: strategy.type, filter, maximumFrames });
    remaining -= maximumFrames;
  }
  return jobs;
}

async function extractFrames(
  request: MediaRequest,
  runner: CommandRunner,
  inputPath: string,
  workspace: string,
  durationMs: number,
): Promise<string[]> {
  const jobs = buildVideoSamplingJobs(request, durationMs);
  for (const job of jobs) {
    await runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', inputPath, '-vf', job.filter,
      '-frames:v', String(job.maximumFrames), '-vsync', 'vfr',
      '-y', join(workspace, `frame-${job.id}-%06d.png`),
    ], {
      cwd: workspace,
      timeoutMs: request.sandbox.ffmpegTimeoutMs,
      maxOutputBytes: 4 * 1_024 * 1_024,
    });
  }
  return (await readdir(workspace))
    .filter((name) => /^frame-[a-z_]+-\d{6}\.png$/u.test(name))
    .sort()
    .slice(0, request.sampling.maxFrames)
    .map((name) => join(workspace, name));
}

export async function analyzeAudioVideo(
  request: MediaRequest,
  runner: CommandRunner,
) {
  const maximum = request.artifact.kind === 'AUDIO'
    ? 500 * 1_024 * 1_024
    : 3 * 1_024 * 1_024 * 1_024;
  if (request.artifact.sizeBytes > maximum) throw new Error('ANALYZER_ARTIFACT_TOO_LARGE');
  return withLoadedArtifact(request.artifact, async (inputPath, workspace) => {
    const metadata = await probe(
      runner, inputPath, workspace, request.sandbox.ffprobeTimeoutMs);
    if (request.artifact.kind === 'AUDIO' && !metadata.hasAudio) {
      throw new Error('ANALYZER_AUDIO_TRACK_MISSING');
    }
    if (request.artifact.kind === 'VIDEO' && !metadata.hasVideo) {
      throw new Error('ANALYZER_VIDEO_TRACK_MISSING');
    }
    const versions = new Set<string>();
    let transcript: Awaited<ReturnType<typeof transcribeAudio>>['segments'] = [];
    let anomalies: Awaited<ReturnType<typeof classifyAudioAnomalies>>['anomalies'] = [];
    if (metadata.hasAudio) {
      const audioPath = join(workspace, 'audio.wav');
      await extractAudio(
        runner, inputPath, audioPath, workspace, request.sandbox.ffmpegTimeoutMs);
      const [audioViews, audioRisks] = await Promise.all([
        materializeAudioViews({
          request, runner, originalPath: audioPath, workspace, durationMs: metadata.durationMs,
        }),
        classifyAudioAnomalies({ runner, audioPath, workspace }),
      ]);
      versions.add(audioRisks.modelVersion);
      const asrViews = await mapInBatches(
        audioViews,
        request.sampling.batchSize,
        async (view) => ({
          view,
          result: await transcribeAudio({ runner, audioPath: view.path, workspace }),
        }),
      );
      for (const item of asrViews) versions.add(item.result.modelVersion);
      transcript = mergeTranscriptSegments(asrViews.flatMap(({ view, result }) =>
        result.segments
          .filter((segment) => segment.confidence >= request.sampling.minimumConfidence)
          .map((segment) => remapAudioViewSegment(segment, view))));
      anomalies = audioRisks.anomalies.filter(
        (anomaly) => anomaly.score >= request.sampling.minimumConfidence,
      );
    }
    const frames: Array<{
      frameIndex: number;
      timeMs: number;
      ocrText?: string;
      risks: Awaited<ReturnType<typeof classifyImage>>['risks'];
    }> = [];
    if (request.artifact.kind === 'VIDEO') {
      const files = await extractFrames(
        request, runner, inputPath, workspace, metadata.durationMs);
      const intervalMs = metadata.durationMs / Math.max(1, files.length - 1);
      const analyzedFrames = await mapInBatches(
        files,
        request.sampling.batchSize,
        async (file, index) => {
          const viewId = `frame_${index}`;
          const [ocr, visual] = await Promise.all([
            runOcr({
              runner,
              tesseract: process.env.ANALYZER_TESSERACT_COMMAND ?? 'tesseract',
              ffprobe: process.env.ANALYZER_FFPROBE_COMMAND ?? 'ffprobe',
              imagePath: file,
              workspace,
              viewId,
            }),
            classifyImage({
              runner,
              imagePath: file,
              workspace,
              viewId,
              frameIndex: index,
            }),
          ]);
          return {
            modelVersion: visual.modelVersion,
            frame: {
              frameIndex: index,
              timeMs: Math.min(metadata.durationMs, Math.round(index * intervalMs)),
              ...(ocr.some((item) => item.confidence >= request.sampling.minimumConfidence)
                ? {
                    ocrText: ocr
                      .filter((item) => item.confidence >= request.sampling.minimumConfidence)
                      .map((item) => item.text)
                      .join(' ')
                      .slice(0, 100_000),
                  }
                : {}),
              risks: visual.risks.filter(
                (risk) => risk.score >= request.sampling.minimumConfidence,
              ),
            },
          };
        },
      );
      for (const analyzed of analyzedFrames) {
        versions.add(analyzed.modelVersion);
        frames.push(analyzed.frame);
      }
    }
    return {
      analyzerVersion: `media-analyzer/1.0+${[...versions].sort().join(',')}`,
      format: metadata.format,
      durationMs: metadata.durationMs,
      transcript,
      frames,
      anomalies,
    };
  });
}
