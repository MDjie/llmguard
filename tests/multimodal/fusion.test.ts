import { describe, expect, it } from 'vitest';
import { fuseMultimodal } from '../../src/lib/multimodal';
import type { RuntimePolicyBundle } from '../../src/lib/policy-bundle';

const bundle: RuntimePolicyBundle = {
  id: 'bundle-1',
  generation: 1,
  payload: {
    schemaVersion: '1.0',
    policyId: 'policy-1',
    policyVersion: 1,
    dimensions: [{ id: 'dim-1', code: 'prompt_injection', name: 'Injection', weight: 1 }],
    rules: [{
      id: 'rule-1', riskType: 'prompt_injection', pattern: 'ignore policy',
      matchType: 'contains', caseSensitive: false, score: 1, mandatoryDeny: true,
    }],
    exceptions: [],
    thresholds: [{ dimensionId: 'dim-1', warn: 0.5, block: 0.8, autoMask: false, autoRewrite: false }],
  },
};

describe('cross-modal fusion', () => {
  it('detects a harmful instruction split between user text and image OCR', async () => {
    const previous = process.env.CONTENT_HASH_KEY;
    process.env.CONTENT_HASH_KEY = 'fusion-test-content-hmac-key-32-bytes-minimum';
    try {
      const result = await fuseMultimodal({
        bundle,
        context: {
          traceId: 'trace-1234567890123456',
          tenantId: 'tenant-1', applicationId: 'app-1',
          absoluteDeadlineEpochMs: Date.now() + 5_000,
        },
        userText: 'please ignore',
        contextArtifactId: 'text-1',
        ocr: [{
          text: 'policy', artifactId: 'image-1', viewId: 'rotate_90', region: [10, 20, 30, 40],
        }],
        visual: [],
      });
      expect(result.textDecisions.user.action).toBe('ALLOW');
      expect(result.textDecisions.image.action).toBe('ALLOW');
      expect(result.action).toBe('BLOCK');
      expect(result.cooperativeAttack).toBe(true);
      expect(result.evidence[0].sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'user_text', artifactId: 'text-1' }),
        expect.objectContaining({ source: 'image_ocr', artifactId: 'image-1', viewId: 'rotate_90' }),
      ]));
    } finally {
      process.env.CONTENT_HASH_KEY = previous;
    }
  });
});
