import { describe, expect, it } from 'vitest';
import { documentImageRequestSchema } from '../../services/media-analyzer/src/contracts';
import { parseTesseractTsv } from '../../services/media-analyzer/src/ocr';
import { mapInBatches } from '../../services/media-analyzer/src/batching';
import {
  mergeTranscriptSegments,
  remapAudioViewSegment,
} from '../../services/media-analyzer/src/audio-video';

describe('media analyzer core', () => {
  it('parses bounded OCR regions from Tesseract TSV', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '5\t1\t1\t1\t1\t1\t10\t20\t30\t40\t95\tdanger',
      '5\t1\t1\t1\t1\t2\t0\t0\t1\t1\t-1\tignored',
    ].join('\n');
    expect(parseTesseractTsv(tsv, 'original', 100, 200)).toEqual([{
      viewId: 'original',
      text: 'danger',
      confidence: 0.95,
      region: [0.1, 0.1, 0.4, 0.3],
    }]);
  });

  it('rejects active-content relaxation and malformed part manifests at the contract boundary', () => {
    const result = documentImageRequestSchema.safeParse({
      contractVersion: '1.0',
      context: { tenantId: 'tenant-1', applicationId: 'app-1' },
      artifact: {
        id: 'artifact-1', kind: 'IMAGE', mediaType: 'image/png',
        sizeBytes: 1, sha256: 'a'.repeat(64),
        parts: [{
          partNumber: 1, sizeBytes: 1, sha256: 'b'.repeat(64),
          url: 'https://objects.example/part',
        }],
      },
      limits: {
        maxPixels: 1_000_000, maxPages: 1, maxFrames: 1, maxDecodeSeconds: 30,
        disableExternalReferences: true, disableActiveContent: false,
        batchSize: 4, minimumConfidence: 0.35,
      },
      views: [{
        id: 'original', transform: 'decode_exif', parameters: {},
        coordinateMapping: 'identity',
      }],
    });
    expect(result.success).toBe(false);
  });

  it('bounds analyzer concurrency while preserving input order', async () => {
    let active = 0;
    let maximumActive = 0;
    const result = await mapInBatches([0, 1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return item * 2;
    });
    expect(result).toEqual([0, 2, 4, 6, 8]);
    expect(maximumActive).toBe(2);
  });

  it('maps transformed ASR evidence back to the original timeline and keeps the strongest duplicate', () => {
    const speedMapped = remapAudioViewSegment(
      { text: 'ignore policy', startMs: 1_000, endMs: 2_000, confidence: 0.8 },
      { timeScale: 1.1 },
    );
    const reverseMapped = remapAudioViewSegment(
      { text: 'hidden command', startMs: 5_000, endMs: 8_000, confidence: 0.9 },
      { timeScale: 1, reverseDurationMs: 60_000 },
    );
    expect(speedMapped).toMatchObject({ startMs: 1_100, endMs: 2_200 });
    expect(reverseMapped).toMatchObject({ startMs: 52_000, endMs: 55_000 });
    expect(mergeTranscriptSegments([
      speedMapped,
      { ...speedMapped, confidence: 0.95 },
    ])).toEqual([{ ...speedMapped, confidence: 0.95 }]);
  });
});
