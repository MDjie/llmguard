import { z } from 'zod';
import { MEDIA_FORMATS } from './formats/registry';
export const analyzerSchema = z.object({ version: z.string(), checkedAt: z.string(), decoding: z.record(z.string(), z.boolean()), codecAvailability: z.record(z.string(), z.boolean()), adapters: z.record(z.string(), z.boolean()), decoders: z.array(z.string()).optional() });
const imageCodecs: Record<string, string[]> = { jpeg: ['mjpeg'], png: ['png'], webp: ['webp'], bmp: ['bmp'], gif: ['gif'], avif: ['libdav1d', 'av1'], tiff: ['tiff'] };
export function projectMediaCapabilities(raw: unknown) {
 const parsed = analyzerSchema.safeParse(raw); const analyzer = parsed.success ? parsed.data : null;
 return MEDIA_FORMATS.map(format => {
  const missing: string[] = []; const text = format.pipeline === 'text';
  let decode: 'AVAILABLE' | 'CONDITIONAL' | 'UNAVAILABLE' = text ? 'AVAILABLE' : 'UNAVAILABLE';
  if (!text && !analyzer) missing.push('ANALYZER_UNAVAILABLE');
  else if (analyzer && !text) {
    if (format.pipeline === 'office') { decode = analyzer.decoding.office && analyzer.decoding.pdf ? 'CONDITIONAL' : 'UNAVAILABLE'; if (format.id === 'ofd') { decode = 'UNAVAILABLE'; missing.push('OFD_ADAPTER_REQUIRED'); } }
    else if (format.pipeline === 'pdf') decode = analyzer.decoding.pdf ? 'AVAILABLE' : 'UNAVAILABLE';
    else if (format.id === 'heif') decode = analyzer.codecAvailability.heif ? 'CONDITIONAL' : 'UNAVAILABLE';
    else if (format.pipeline === 'image') {
      const required = imageCodecs[format.id] ?? [];
      decode = required.some(codec => analyzer.decoders?.includes(codec)) ? 'AVAILABLE' : 'UNAVAILABLE';
      if (format.id === 'tiff' && !analyzer.codecAvailability.tiff) decode = 'UNAVAILABLE';
    } else decode = analyzer.decoding.ffmpeg ? 'CONDITIONAL' : 'UNAVAILABLE'; // Container extension never proves every embedded codec.
    if (decode === 'UNAVAILABLE' && !missing.length) missing.push('REQUIRED_DECODER_UNAVAILABLE');
    if (decode === 'CONDITIONAL') missing.push('ACTUAL_PROFILE_AND_ALL_STREAMS_REQUIRE_PROBE');
  }
  const roles = text ? [] : format.pipeline === 'audio' ? ['asr', 'audioClassifier'] : format.pipeline === 'video' ? ['visual', 'asr', 'audioClassifier'] : ['visual'];
  for (const role of roles) if (!analyzer?.adapters[role]) missing.push('MODEL_ROLE_UNCONFIGURED_' + role.toUpperCase());
  if (!text && !analyzer?.decoding.ocr && ['office', 'pdf', 'image', 'video'].includes(format.pipeline)) missing.push('OCR_UNAVAILABLE');
  if (format.id === 'pcm') missing.push('PCM_METADATA_REQUIRED');
  if (format.pipeline === 'video') missing.push('MULTI_VIDEO_STREAM_PROFILE_UNAVAILABLE');
  if (format.id === 'heif') missing.push('HEIF_SEQUENCE_PROFILE_UNAVAILABLE');
  if (['doc','xls','ppt','wps','rtf'].includes(format.id)) missing.push('NON_PACKAGE_HIDDEN_CONTENT_UNASSESSED');
  return { ...format, upload: 'ACCEPTED_FOR_VERIFICATION', decode, detect: text ? 'POLICY_REQUIRED' : decode !== 'UNAVAILABLE' && roles.every(role => analyzer?.adapters[role]) ? 'PROTOCOL_QUALIFICATION_REQUIRED' : 'UNAVAILABLE', qualified: false, qualificationReason: 'EXACT_POLICY_MODEL_PROFILE_QUALIFICATION_REQUIRED', missingDependencies: missing, analyzerVersion: analyzer?.version ?? null, checkedAt: analyzer?.checkedAt ?? null };
 });
}
