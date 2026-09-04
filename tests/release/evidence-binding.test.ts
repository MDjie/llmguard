import { describe, expect, it } from 'vitest';
import {
  bindReleaseEvidence,
  releaseEvidenceInvalidationReasons,
  releaseHealthAction,
  type ReleaseSubjectBinding,
} from '../../src/lib/release';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const subjects: ReleaseSubjectBinding = {
  sourceCommit: 'a'.repeat(40),
  imageDigests: { app: digest('1') },
  modelDigests: { guard: digest('2') },
  policyBundleDigest: digest('3'),
  tokenizerDigest: digest('4'),
  datasetDigest: digest('5'),
  configurationDigest: digest('6'),
  environmentDigest: digest('7'),
};

describe('release evidence binding', () => {
  it('invalidates evidence on every governed subject change', () => {
    const evidence = bindReleaseEvidence(subjects, 1);
    expect(releaseEvidenceInvalidationReasons(evidence, subjects)).toEqual([]);
    expect(releaseEvidenceInvalidationReasons(evidence, {
      ...subjects, tokenizerDigest: digest('8'), configurationDigest: digest('9'),
    })).toEqual(['TOKENIZER_CHANGED', 'CONFIGURATION_CHANGED']);
  });

  it('orders rollback on safety, latency, detector or evidence-delivery failures', () => {
    expect(releaseHealthAction({
      sampleSize: 2_000, minimumSampleSize: 1_000,
      errorBudgetHealthy: true, errorRate: 0.001, maximumErrorRate: 0.01,
      p95LatencyMs: 180, maximumP95LatencyMs: 200,
      p99LatencyMs: 301, maximumP99LatencyMs: 300,
      falsePositiveRate: 0.005, maximumFalsePositiveRate: 0.01,
      falseNegativeRate: 0.01, maximumFalseNegativeRate: 0.01,
      resourceRejectionRate: 0.001, maximumResourceRejectionRate: 0.01,
      requiredDetectorFailures: 1, auditDeliveryTerminalFailures: 1,
    })).toMatchObject({
      action: 'ROLLBACK',
      reasonCodes: [
        'RELEASE_P99_EXCEEDED', 'RELEASE_REQUIRED_DETECTOR_FAILED',
        'RELEASE_AUDIT_DELIVERY_FAILED',
      ],
    });
  });
});
