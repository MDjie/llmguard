import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadArtifactFile, withLoadedArtifact } from './artifact-loader';
import type { CommandRunner } from './command-runner';
import type { MediaMarkRequest } from './contracts';

interface MaterializedMark {
  readonly outputPath: string;
  readonly visibleMarkApplied: boolean;
  readonly spokenMarkApplied: boolean;
  readonly metadataEmbedded: boolean;
}

function imageExtension(mediaType: MediaMarkRequest['output']['mediaType']): string {
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/webp') return 'webp';
  throw new Error('ANALYZER_MARK_OUTPUT_MEDIA_TYPE_INVALID');
}

function drawText(labelPath: string, timed: boolean): string {
  const escaped = labelPath.replace(/\\/gu, '/').replace(/:/gu, '\\:').replace(/'/gu, "\\'");
  const base = [
    `drawtext=textfile='${escaped}'`,
    'fontcolor=white',
    'fontsize=max(18\,h/24)',
    'box=1',
    'boxcolor=black@0.70',
    'boxborderw=12',
    'x=w-tw-24',
    'y=h-th-24',
  ].join(':');
  return timed ? `${base}:enable='lt(t\,5)'` : base;
}

function embeddedMark(request: MediaMarkRequest): string {
  return 'guardllm-mark:' + Buffer.from(JSON.stringify({
    metadata: request.mark.metadata,
    signature: request.mark.signature,
    keyId: request.mark.keyId,
  })).toString('base64url');
}

export async function materializeMediaMark(
  request: MediaMarkRequest,
  inputPath: string,
  workspace: string,
  runner: CommandRunner,
): Promise<MaterializedMark> {
  const ffmpeg = process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg';
  const labelPath = join(workspace, 'visible-label.txt');
  await writeFile(labelPath, request.mark.visibleLabel, { encoding: 'utf8', mode: 0o600 });
  const metadata = embeddedMark(request);
  if (request.artifact.kind === 'IMAGE') {
    const outputPath = join(workspace, 'marked.' + imageExtension(request.output.mediaType));
    await runner.run(ffmpeg, [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', inputPath, '-map_metadata', '-1',
      '-vf', drawText(labelPath, false),
      '-metadata', 'comment=' + metadata,
      '-metadata', 'guardllm_content_id=' + request.mark.metadata.contentId,
      '-frames:v', '1', '-y', outputPath,
    ], { cwd: workspace, timeoutMs: request.limits.timeoutMs });
    return {
      outputPath,
      visibleMarkApplied: true,
      spokenMarkApplied: false,
      metadataEmbedded: true,
    };
  }
  if (request.artifact.kind === 'AUDIO') {
    if (request.output.mediaType !== 'audio/mp4') {
      throw new Error('ANALYZER_MARK_OUTPUT_MEDIA_TYPE_INVALID');
    }
    const tts = process.env.ANALYZER_TTS_COMMAND;
    if (!tts) throw new Error('ANALYZER_TTS_COMMAND_REQUIRED');
    const introPath = join(workspace, 'mark-intro.wav');
    await runner.run(tts, [
      '--text-file', labelPath,
      '--output', introPath,
    ], { cwd: workspace, timeoutMs: Math.min(120_000, request.limits.timeoutMs) });
    const outputPath = join(workspace, 'marked.m4a');
    await runner.run(ffmpeg, [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', introPath, '-i', inputPath,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[outa]',
      '-map', '[outa]', '-map_metadata', '-1',
      '-metadata', 'comment=' + metadata,
      '-metadata', 'guardllm_content_id=' + request.mark.metadata.contentId,
      '-c:a', 'aac', '-movflags', '+faststart', '-y', outputPath,
    ], { cwd: workspace, timeoutMs: request.limits.timeoutMs });
    return {
      outputPath,
      visibleMarkApplied: false,
      spokenMarkApplied: true,
      metadataEmbedded: true,
    };
  }
  if (request.output.mediaType !== 'video/mp4') {
    throw new Error('ANALYZER_MARK_OUTPUT_MEDIA_TYPE_INVALID');
  }
  const outputPath = join(workspace, 'marked.mp4');
  await runner.run(ffmpeg, [
    '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-i', inputPath, '-map_metadata', '-1',
    '-vf', drawText(labelPath, true),
    '-metadata', 'comment=' + metadata,
    '-metadata', 'guardllm_content_id=' + request.mark.metadata.contentId,
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-c:a', 'aac', '-movflags', '+faststart', '-y', outputPath,
  ], { cwd: workspace, timeoutMs: request.limits.timeoutMs });
  return {
    outputPath,
    visibleMarkApplied: true,
    spokenMarkApplied: false,
    metadataEmbedded: true,
  };
}

export async function markMedia(
  request: MediaMarkRequest,
  runner: CommandRunner,
) {
  const limit = request.artifact.kind === 'VIDEO'
    ? 3 * 1_024 * 1_024 * 1_024
    : request.artifact.kind === 'AUDIO'
      ? 500 * 1_024 * 1_024
      : 100 * 1_024 * 1_024;
  if (request.artifact.sizeBytes > limit) throw new Error('ANALYZER_ARTIFACT_TOO_LARGE');
  return withLoadedArtifact(request.artifact, async (inputPath, workspace) => {
    const materialized = await materializeMediaMark(request, inputPath, workspace, runner);
    const output = await uploadArtifactFile(request.output, materialized.outputPath);
    return {
      analyzerVersion: 'media-analyzer/1.0',
      contentId: request.mark.metadata.contentId,
      output: {
        ...output,
        mediaType: request.output.mediaType,
      },
      visibleMarkApplied: materialized.visibleMarkApplied,
      spokenMarkApplied: materialized.spokenMarkApplied,
      metadataEmbedded: materialized.metadataEmbedded,
    };
  });
}
