import { describe, expect, it } from 'vitest';
import { loadMultimodalDetectionPolicy } from '../../src/lib/multimodal';

describe('multimodal detection policy', () => {
  it('loads bounded cost, recall and review controls', () => {
    expect(loadMultimodalDetectionPolicy({
      MULTIMODAL_FRAME_BATCH_SIZE: '8',
      MULTIMODAL_FRAME_INTERVAL_MS: '2500',
      MULTIMODAL_MAX_FRAMES: '200',
      MULTIMODAL_MIN_CONFIDENCE: '0.45',
      MULTIMODAL_REVIEW_THRESHOLD: '0.7',
      MULTIMODAL_BLOCK_THRESHOLD: '0.9',
      MULTIMODAL_CROSS_MODAL_WINDOW_MS: '45000',
    })).toEqual({
      frameBatchSize: 8,
      frameIntervalMs: 2_500,
      maxFrames: 200,
      minimumConfidence: 0.45,
      reviewThreshold: 0.7,
      blockThreshold: 0.9,
      crossModalWindowMs: 45_000,
    });
  });

  it('rejects unsafe or internally inconsistent thresholds', () => {
    expect(() => loadMultimodalDetectionPolicy({
      MULTIMODAL_FRAME_BATCH_SIZE: '0',
    })).toThrow('MULTIMODAL_FRAME_BATCH_SIZE');
    expect(() => loadMultimodalDetectionPolicy({
      MULTIMODAL_REVIEW_THRESHOLD: '0.9',
      MULTIMODAL_BLOCK_THRESHOLD: '0.8',
    })).toThrow('must not exceed');
  });
});
