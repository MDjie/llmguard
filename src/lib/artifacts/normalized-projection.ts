import type { MultimodalAnalysis } from '@/lib/multimodal/analyzer';
import type { analyzeAudioVideo } from '@/lib/media/analyzer';
import { NORMALIZED_VERSION, type NormalizedDocument, type NormalizedSegment } from './normalized-contract';

type Parent = Pick<NormalizedDocument, 'parentArtifactId' | 'parentSha256' | 'sourceKind'>;
type MediaAnalysis = Awaited<ReturnType<typeof analyzeAudioVideo>>;

function base(parent: Parent, analysis: MultimodalAnalysis | MediaAnalysis, segments: NormalizedSegment[]): NormalizedDocument {
  const reasons = [...new Set([...analysis.analysisFailures.map(failure => failure.code), ...(analysis.coverage?.reasonCodes ?? []),
    ...(!analysis.coverage ? ['NORMALIZED_COVERAGE_MISSING'] : []), ...(analysis.degraded ? ['NORMALIZED_ANALYSIS_DEGRADED'] : [])])];
  return { ...parent, version: NORMALIZED_VERSION, transformVersion: analysis.analyzerVersion + ':' + NORMALIZED_VERSION,
    representation: 'TEXT_PROJECTION', nativeCoverageClaimed: false, instructionCapability: 'FORBIDDEN', segments,
    coverage: analysis.coverage ?? null, complete: !reasons.length && analysis.coverage?.state === 'COMPLETE' && analysis.coverage.processedUnits === analysis.coverage.expectedUnits,
    reasonCodes: reasons, coordinateMappings: analysis.coordinateMappings ?? [] };
}

export function projectDocument(parent: Parent, analysis: MultimodalAnalysis): NormalizedDocument {
  const segments: NormalizedSegment[] = [
    ...(analysis.documentText ?? []).map(item => ({ text: item.text, viewId: item.viewId, containerPath: item.containerPath, source: 'DOCUMENT_TEXT' as const })),
    ...analysis.ocr.map(item => ({ text: item.text, viewId: item.viewId, page: item.page, region: item.region, source: 'OCR' as const })),
    ...analysis.codes.map(item => ({ text: item.text, viewId: item.viewId, page: item.page, region: item.region, frameIndex: item.frameIndex, source: 'CODE' as const })),
  ];
  return base(parent, analysis, segments);
}

export function projectMedia(parent: Parent, analysis: MediaAnalysis): NormalizedDocument {
  const segments: NormalizedSegment[] = [
    ...analysis.transcript.map((item, index) => ({ text: item.text, viewId: item.sourceViewId ?? 'asr-' + index, source: 'ASR' as const, startMs: item.startMs, endMs: item.endMs, channel: item.channel })),
    ...analysis.subtitles.map((item, index) => ({ text: item.text, viewId: item.sourceViewId ?? 'subtitle-' + index, source: 'SUBTITLE' as const, startMs: item.startMs, endMs: item.endMs, channel: item.channel })),
    ...analysis.frames.flatMap(frame => [
      ...(frame.ocrText === undefined ? [] : [{ text: frame.ocrText, viewId: 'frame-' + frame.frameIndex, source: 'FRAME_OCR' as const, frameIndex: frame.frameIndex, startMs: frame.timeMs, endMs: frame.timeMs }]),
      ...frame.codes.map(code => ({ text: code.text, viewId: code.viewId, source: 'CODE' as const, frameIndex: frame.frameIndex, startMs: frame.timeMs, endMs: frame.timeMs, region: code.region })),
    ]),
  ];
  return base(parent, analysis, segments);
}

export function projectText(parent: Parent, text: string, encoding: string): NormalizedDocument {
  const segments: NormalizedSegment[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 262144, text.length);
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
    segments.push({ text: text.slice(start, end), viewId: 'text-' + start, source: 'DECODED_TEXT', containerPath: '/decoded/' + start }); start = end;
  }
  return { ...parent, version: NORMALIZED_VERSION, transformVersion: 'text-decoder-1:' + encoding, representation: 'TEXT_PROJECTION', nativeCoverageClaimed: false,
    instructionCapability: 'FORBIDDEN', segments, coverage: null, complete: true, reasonCodes: [], coordinateMappings: [{ encoding, offsetEncoding: 'UTF16', mappingVersion: 'decoded-text-1' }] };
}
