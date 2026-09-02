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
      expect(result.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'audio', startMs: 5_000, endMs: 5_500,
        }),
        expect.objectContaining({
          source: 'frame_ocr', startMs: 30_000, frameIndex: 750,
        }),
      ]));
    } finally {
      process.env.CONTENT_HASH_KEY = previous;
    }
  });

  it('sorts out-of-order tracks and does not join instructions outside the configured window', async () => {
    const previous = process.env.CONTENT_HASH_KEY;
    process.env.CONTENT_HASH_KEY = 'media-window-content-hmac-key-32-bytes-minimum';
    try {
      const result = await fuseMediaTimeline({
        bundle,
        context: {
          traceId: 'media-trace-window-1234', tenantId: 'tenant-1', applicationId: 'app-1',
          absoluteDeadlineEpochMs: Date.now() + 5_000,
        },
        segments: [
          { source: 'frame_ocr', text: 'policy', startMs: 60_000, endMs: 60_000, frameIndex: 90 },
          { source: 'audio', text: 'ignore', startMs: 1_000, endMs: 1_500 },
        ],
        visual: [],
        crossModalWindowMs: 10_000,
      });
      expect(result.action).toBe('ALLOW');
      expect(result.cooperativeAttack).toBe(false);
    } finally {
      process.env.CONTENT_HASH_KEY = previous;
    }
  });

  it('fuses associated user text with audio and routes medium visual risk to review', async () => {
    const previous = process.env.CONTENT_HASH_KEY;
    process.env.CONTENT_HASH_KEY = 'media-context-content-hmac-key-32-bytes-minimum';
    try {
      const cooperative = await fuseMediaTimeline({
        bundle,
        context: {
          traceId: 'media-trace-context-123', tenantId: 'tenant-1', applicationId: 'app-1',
          absoluteDeadlineEpochMs: Date.now() + 5_000,
        },
        userText: 'ignore',
        contextArtifactId: 'text-artifact-1',
        segments: [{ source: 'audio', text: 'policy', startMs: 500, endMs: 900 }],
        visual: [],
      });
      expect(cooperative.action).toBe('BLOCK');
      expect(cooperative.cooperativeAttack).toBe(true);
      expect(cooperative.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'user_text', artifactId: 'text-artifact-1' }),
        expect.objectContaining({ source: 'audio', startMs: 500, endMs: 900 }),
      ]));

      const review = await fuseMediaTimeline({
        bundle,
        context: {
          traceId: 'media-trace-review-1234', tenantId: 'tenant-1', applicationId: 'app-1',
          absoluteDeadlineEpochMs: Date.now() + 5_000,
        },
        segments: [],
        visual: [{
          riskType: 'violence', score: 0.7, timeMs: 1_000,
          frameIndex: 1, reasonCode: 'VISUAL_VIOLENCE',
        }],
        reviewThreshold: 0.65,
        blockThreshold: 0.8,
      });
      expect(review.action).toBe('REQUIRE_REVIEW');
      expect(review.evidence[0]).toMatchObject({
        source: 'visual',
        action: 'REQUIRE_REVIEW',
      });
    } finally {
      process.env.CONTENT_HASH_KEY = previous;
    }
  });
});
