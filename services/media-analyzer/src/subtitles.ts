import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner } from './command-runner';
import type { SubtitleSegment } from './contracts';

function timestampMs(value: string): number | undefined {
  const matched = /^(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})$/u.exec(value.trim());
  if (!matched) return undefined;
  const hours = Number(matched[1] ?? 0);
  const minutes = Number(matched[2]);
  const seconds = Number(matched[3]);
  const millis = Number(matched[4]);
  if (![hours, minutes, seconds, millis].every(Number.isFinite) || minutes > 59 || seconds > 59) {
    return undefined;
  }
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + millis;
}

export function parseWebVtt(value: string): SubtitleSegment[] {
  const segments: SubtitleSegment[] = [];
  const blocks = value.replace(/^\uFEFF/u, '').split(/\r?\n\r?\n/u);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u).map((line) => line.trim());
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].split('-->').map((item) => item.trim().split(/\s+/u)[0]);
    const startMs = timestampMs(timing[0] ?? '');
    const endMs = timestampMs(timing[1] ?? '');
    const text = lines.slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]{1,256}>/gu, '')
      .normalize('NFKC')
      .trim()
      .slice(0, 100_000);
    if (startMs === undefined || endMs === undefined || endMs < startMs || !text) continue;
    segments.push({ text, startMs, endMs, confidence: 1, source: 'subtitle' });
    if (segments.length >= 100_000) break;
  }
  return segments;
}

export async function extractSubtitles(input: {
  readonly runner: CommandRunner;
  readonly inputPath: string;
  readonly workspace: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<SubtitleSegment[]> {
  const outputPath = join(input.workspace, 'subtitles.vtt');
  await input.runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
    '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-i', input.inputPath, '-map', '0:s:0', '-f', 'webvtt', '-y', outputPath,
  ], {
    cwd: input.workspace,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: 1 * 1_024 * 1_024,
    signal: input.signal,
  });
  return parseWebVtt(await readFile(outputPath, 'utf8'));
}
