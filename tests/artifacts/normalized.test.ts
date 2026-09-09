import { describe, expect, it } from 'vitest';
import { encodeNormalizedDocument, normalizedText, normalizedDocumentSchema } from '@/lib/artifacts/normalized-contract';
import { projectDocument, projectMedia, projectText } from '@/lib/artifacts/normalized-projection';
const parent = { parentArtifactId: '00000000-0000-4000-8000-000000000001', parentSha256: 'a'.repeat(64), sourceKind: 'TEXT' as const };
describe('normalized source integrity and coverage', () => {
  it('keeps all text, deterministic hashes and source offsets beyond the evidence inline limit', () => {
    const text = '字'.repeat(1500000) + '结尾内容';
    const encoded = encodeNormalizedDocument(projectText(parent, text, 'utf-8'));
    expect(encoded.bytes.length).toBeGreaterThan(4 * 1024 * 1024);
    const projected = normalizedText(encoded.document);
    expect(projected.text).toBe(text);
    expect(projected.mappings.at(-1)?.textEnd).toBe(text.length);
    expect(encodeNormalizedDocument(JSON.parse(encoded.bytes.toString())).sha256).toBe(encoded.sha256);
    expect(encoded.document.nativeCoverageClaimed).toBe(false);
  });
  it('does not split UTF16 pairs at segment boundaries', () => {
    const text = 'a'.repeat(262143) + '😀结束';
    expect(normalizedText(encodeNormalizedDocument(projectText(parent, text, 'utf-8')).document).text).toBe(text);
  });
  it('retains unflagged document/OCR text and rejects mismatched parent coverage', () => {
    const document = projectDocument({ ...parent, sourceKind: 'DOCUMENT' }, {
      analyzerVersion: 'parser-v1', documentText: [{ viewId: 'sheet-1', containerPath: '/xl/sheet1.xml', text: '普通内容', sourceRelation: 'OFFICE_PACKAGE_TEXT' }],
      ocr: [{ viewId: 'page-1', text: '图像文本', confidence: 0.5, region: [0,0,1,1], page: 1, sourceRelation: 'OCR_FROM_RENDERED_PAGE' }],
      codes: [], labels: [], documentElements: [], visual: [], anomalies: [], analysisFailures: [], degraded: false, derivatives: [],
      coverage: { artifactSha256: parent.parentSha256, modality: 'DOCUMENT', state: 'COMPLETE', expectedUnits: 1, processedUnits: 1, analyzerVersion: 'parser-v1', reasonCodes: [] },
    });
    expect(normalizedText(encodeNormalizedDocument(document).document).text).toBe('普通内容\n图像文本');
    expect(normalizedDocumentSchema.safeParse({ ...document, parentSha256: 'b'.repeat(64) }).success).toBe(false);
    expect(encodeNormalizedDocument(document).document.complete).toBe(true);
  });
  it('keeps video sampling incomplete, even with successful transcripts', () => {
    const document = projectMedia({ ...parent, sourceKind: 'VIDEO' }, {
      analyzerVersion: 'media-v1', format: 'mp4', durationMs: 1000, transcript: [{ text: '内容', startMs: 10, endMs: 100, confidence: 0.5, channel: 1 }],
      subtitles: [], frames: [], analysisFailures: [], anomalies: [], degraded: false, samplingPhase: 'summary',
      coverage: { artifactSha256: parent.parentSha256, modality: 'VIDEO', state: 'SAMPLED', expectedUnits: 1000, processedUnits: 1000, analyzerVersion: 'media-v1', reasonCodes: [] },
    });
    expect(document.complete).toBe(false);
    expect(normalizedDocumentSchema.safeParse({ ...document, complete: true }).success).toBe(false);
    expect(document.segments[0]).toMatchObject({ channel: 1, startMs: 10, endMs: 100 });
  });
  it('rejects forged completeness and never upgrades text to native media coverage', () => {
    const document = { ...projectText(parent, 'hello', 'utf-8'), sourceKind: 'IMAGE' };
    expect(normalizedDocumentSchema.safeParse(document).success).toBe(false);
    expect(normalizedDocumentSchema.safeParse({ ...projectText(parent, 'hello', 'utf-8'), nativeCoverageClaimed: true }).success).toBe(false);
  });
});
