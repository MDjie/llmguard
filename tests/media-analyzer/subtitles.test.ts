import { describe, expect, it } from 'vitest';
import { parseWebVtt } from '../../services/media-analyzer/src/subtitles';

describe('subtitle extraction', () => {
  it('parses WebVTT timing and strips markup without losing chronology', () => {
    const result = parseWebVtt([
      'WEBVTT', '', '1', '00:00:01.000 --> 00:00:02.500', '<b>ignore</b>', '',
      '2', '00:01:00.000 --> 00:01:02.000 align:start', 'policy', '',
    ].join('\n'));
    expect(result).toEqual([
      { text: 'ignore', startMs: 1_000, endMs: 2_500, confidence: 1, source: 'subtitle' },
      { text: 'policy', startMs: 60_000, endMs: 62_000, confidence: 1, source: 'subtitle' },
    ]);
  });

  it('rejects malformed and reversed ranges', () => {
    expect(parseWebVtt('WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nignored')).toEqual([]);
  });
});
