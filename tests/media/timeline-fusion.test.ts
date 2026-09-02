import { describe, expect, it } from 'vitest';
import { fuseMediaTimeline } from '../../src/lib/media';
import type { RuntimePolicyBundle } from '../../src/lib/policy-bundle';

const bundle: RuntimePolicyBundle = {
  id: 'bundle-1', generation: 1,
  payload: {
    schemaVersion: '1.0', policyId: 'policy-1', policyVersion: 1,
    dimensions: [{ id: 'dim-1', code: 'injection', name: 'Injection', weight: 1 }],
    rules: [{ id: 'rule-1', riskType: 'injection', pattern: 'ignore policy', matchType: 'contains', caseSensitive: false, score: 1, mandatoryDeny: true }],
    exceptions: [], thresholds: [{ dimensionId: 'dim-1', warn: 0.5, block: 0.8, autoMask: false, autoRewrite: false }],
  },
};

describe('audio/video timeline fusion', () => {
  it('detects an instruction split across audio and a middle video frame', async () => {
    const previous = process.env.CONTENT_HASH_KEY;
    process.env.CONTENT_HASH_KEY = 'media-fusion-content-hmac-key-32-bytes-minimum';
    try {
      const result = await fuseMediaTimeline({
        bundle,
        context: {
          traceId: 'media-trace-1234567890', tenantId: 'tenant-1', applicationId: 'app-1',
          absoluteDeadlineEpochMs: Date.now() + 5_000,
        },
        segments: [
          { source: 'audio', text: 'ignore', startMs: 5_000, endMs: 5_500 },
          { source: 'frame_ocr', text: 'policy', startMs: 30_000, endMs: 30_000, frameIndex: 750 },
        ],
        visual: [],
      });
      expect(result.decisions.audio.action).toBe('ALLOW');
      expect(result.decisions.frames.action).toBe('ALLOW');
      expect(result.action).toBe('BLOCK');
      expect(result.cooperativeAttack).toBe(true);
      expect(result.evidence[0]).toMatchObject({ startMs: 5_000, endMs: 5_500 });
    } finally {
      process.env.CONTENT_HASH_KEY = previous;
    }
  });
});
