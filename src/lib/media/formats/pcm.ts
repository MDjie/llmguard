import {z} from 'zod';

/** Raw PCM has no signature: every decoding parameter must be supplied explicitly. */
export const pcmSchema = z.object({
  sampleRate: z.number().int().min(8000).max(192000),
  channels: z.number().int().min(1).max(8),
  sampleFormat: z.enum(['s16le', 's16be', 's24le', 's24be', 's32le', 's32be', 'f32le', 'f32be']),
}).strict();
export type PcmParameters = z.infer<typeof pcmSchema>;
export function pcmFromMetadata(fileName: string, metadata: unknown, sizeBytes: number): PcmParameters | undefined {
  if (!fileName.toLowerCase().endsWith('.pcm')) return undefined;
  const raw = metadata && typeof metadata === 'object' && 'pcm' in metadata ? metadata.pcm : undefined;
  const parsed = pcmSchema.safeParse(raw);
  if (!parsed.success) throw new Error('PCM_METADATA_REQUIRED');
  const width = Number(parsed.data.sampleFormat.slice(1, 3)) / 8;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes % (width * parsed.data.channels) !== 0) {
    throw new Error('PCM_FRAME_ALIGNMENT_INVALID');
  }
  return parsed.data;
}
export function pcmInputArguments(pcm?: PcmParameters): string[] {
  return pcm ? ['-f', pcm.sampleFormat, '-ar', String(pcm.sampleRate), '-ac', String(pcm.channels)] : [];
}

/** ffprobe uses channel layout; unlike ffmpeg it does not accept the -ac option. */
export function pcmProbeArguments(pcm?: PcmParameters): string[] {
  return pcm ? ['-f', pcm.sampleFormat, '-ar', String(pcm.sampleRate), '-ch_layout', `${pcm.channels}c`] : [];
}
