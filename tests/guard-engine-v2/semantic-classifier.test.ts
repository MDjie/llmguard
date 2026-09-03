import { describe, expect, it } from 'vitest';
import type { GuardDetectorContext, SemanticClassifierSpec } from '../../src/lib/guard-engine-v2';
import {
  parseSemanticClassifierBuildConfig,
  SemanticClassifierDetector,
} from '../../src/lib/guard-engine-v2';

const spec: SemanticClassifierSpec = {
  detectorId: 'qwen-safety-classifier',
  detectorVersion: 'adapter-1',
  modelId: 'qwen3-guard',
  modelVersion: '1.2.3',
  modelSha256: 'sha256:' + 'a'.repeat(64),
  quantization: 'INT8',
  baseUrl: 'https://classifier.example.com',
  path: '/v1/classify',
  providerType: 'custom',
  mode: 'ENFORCE',
  failurePolicy: 'FAIL_CLOSED',
  timeoutMs: 500,
  batchSize: 2,
  maximumRequestBytes: 1_048_576,
  maximumResponseBytes: 1_048_576,
  temperature: 1,
  labels: [
    {
      label: 'violence',
      riskType: 'content.violence',
      severity: 'HIGH',
      threshold: 0.8,
    },
  ],
};

function context(): GuardDetectorContext {
  return {
    request: {
      contractVersion: '1.0',
      context: {
        traceId: 'trace-semantic-00000001',
        requestId: 'request-semantic-01',
        tenantId: 'tenant-1',
        applicationId: 'app-1',
        direction: 'INPUT',
        absoluteDeadlineEpochMs: Date.now() + 2_000,
        policyBundleId: 'bundle-1',
      },
      content: { text: 'violent content' },
    },
    envelopes: [],
    views: [{
      id: 'original',
      text: 'violent content',
      originSpans: Array.from({ length: 15 }, (_, index) => ({
        start: index,
        end: index + 1,
      })),
    }],
    signal: new AbortController().signal,
    evidenceHmac: () => 'b'.repeat(64),
  };
}

describe('semantic classifier detector', () => {
  it('emits calibrated, model-bound observations in enforce mode', async () => {
    const detector = new SemanticClassifierDetector(spec, {
      invoke: async (_configured, items) => ({
        modelId: spec.modelId,
        modelVersion: spec.modelVersion,
        modelSha256: spec.modelSha256,
        items: items.map((item) => ({
          id: item.id,
          labels: [{ label: 'violence', confidence: 0.91 }],
        })),
      }),
    });
    await expect(detector.detect(context())).resolves.toEqual([
      expect.objectContaining({
        detectorId: 'qwen-safety-classifier',
        riskType: 'content.violence',
        status: 'MATCH',
        modelVersion: 'qwen3-guard@1.2.3',
        configurationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it('records shadow matches without allowing them to affect aggregation', async () => {
    const detector = new SemanticClassifierDetector({ ...spec, mode: 'SHADOW' }, {
      invoke: async (_configured, items) => ({
        modelId: spec.modelId,
        modelVersion: spec.modelVersion,
        modelSha256: spec.modelSha256,
        items: items.map((item) => ({
          id: item.id,
          labels: [{ label: 'violence', confidence: 0.99 }],
        })),
      }),
    });
    const [observation] = await detector.detect(context());
    expect(observation).toMatchObject({
      status: 'NO_MATCH',
      reasonCode: 'SEMANTIC_CLASSIFIER_SHADOW_MATCH',
    });
    expect(detector.required).toBe(false);
  });

  it('rejects model identity drift and incomplete batch responses', async () => {
    const mismatch = new SemanticClassifierDetector(spec, {
      invoke: async () => ({
        modelId: spec.modelId,
        modelVersion: 'unexpected',
        modelSha256: spec.modelSha256,
        items: [{ id: 'original', labels: [] }],
      }),
    });
    await expect(mismatch.detect(context()))
      .rejects.toThrow('SEMANTIC_CLASSIFIER_MODEL_IDENTITY_MISMATCH');

    const incomplete = new SemanticClassifierDetector(spec, {
      invoke: async () => ({
        modelId: spec.modelId,
        modelVersion: spec.modelVersion,
        modelSha256: spec.modelSha256,
        items: [],
      }),
    });
    await expect(incomplete.detect(context()))
      .rejects.toThrow('SEMANTIC_CLASSIFIER_RESPONSE_COVERAGE_INVALID');
  });

  it('requires exact model metadata and fail-closed enforcement configuration', () => {
    expect(parseSemanticClassifierBuildConfig({
      SEMANTIC_CLASSIFIER_CONFIG_JSON: JSON.stringify(spec),
    })).toEqual(spec);
    expect(() => parseSemanticClassifierBuildConfig({
      SEMANTIC_CLASSIFIER_CONFIG_JSON: JSON.stringify({
        ...spec,
        failurePolicy: 'DEGRADE',
      }),
    })).toThrow();
    expect(() => parseSemanticClassifierBuildConfig({
      SEMANTIC_CLASSIFIER_CONFIG_JSON: JSON.stringify({
        ...spec,
        modelSha256: 'latest',
      }),
    })).toThrow();
  });
});
