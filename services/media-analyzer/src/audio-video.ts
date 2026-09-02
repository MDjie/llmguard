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

function samplingIntervalSeconds(request: MediaRequest, durationMs: number): number {
  const fixed = request.sampling.strategies.find((item) => item.type === 'fixed_interval')
    ?.parameters.intervalMs;
  if (fixed && fixed > 0) return Math.max(0.04, fixed / 1_000);
  const durationSeconds = Math.max(1, durationMs / 1_000);
  return Math.max(0.04, durationSeconds / request.sampling.maxFrames);
}

async function extractFrames(
  request: MediaRequest,
  runner: CommandRunner,
  inputPath: string,
  workspace: string,
  durationMs: number,
): Promise<string[]> {
  const interval = samplingIntervalSeconds(request, durationMs);
  await runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
    '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-i', inputPath, '-vf', `fps=1/${interval}`,
    '-frames:v', String(request.sampling.maxFrames), '-vsync', 'vfr',
    '-y', join(workspace, 'frame-%06d.png'),
  ], {
    cwd: workspace,
    timeoutMs: request.sandbox.ffmpegTimeoutMs,
    maxOutputBytes: 4 * 1_024 * 1_024,
  });
  return (await readdir(workspace))
    .filter((name) => /^frame-\d{6}\.png$/u.test(name))
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
      const [asr, audioRisks] = await Promise.all([
        transcribeAudio({ runner, audioPath, workspace }),
        classifyAudioAnomalies({ runner, audioPath, workspace }),
      ]);
      versions.add(asr.modelVersion);
      versions.add(audioRisks.modelVersion);
      transcript = asr.segments;
      anomalies = audioRisks.anomalies;
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
      const intervalMs = samplingIntervalSeconds(request, metadata.durationMs) * 1_000;
      for (let index = 0; index < files.length; index += 1) {
        const viewId = `frame_${index}`;
        const [ocr, visual] = await Promise.all([
          runOcr({
            runner,
            tesseract: process.env.ANALYZER_TESSERACT_COMMAND ?? 'tesseract',
            ffprobe: process.env.ANALYZER_FFPROBE_COMMAND ?? 'ffprobe',
            imagePath: files[index],
            workspace,
            viewId,
          }),
          classifyImage({
            runner,
            imagePath: files[index],
            workspace,
            viewId,
            frameIndex: index,
          }),
        ]);
        versions.add(visual.modelVersion);
        frames.push({
          frameIndex: index,
          timeMs: Math.min(metadata.durationMs, Math.round(index * intervalMs)),
          ...(ocr.length > 0 ? { ocrText: ocr.map((item) => item.text).join(' ').slice(0, 100_000) } : {}),
          risks: visual.risks,
        });
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
