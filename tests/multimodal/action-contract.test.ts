import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Direction } from '@guardllm/contracts';
import { fuseMultimodal } from '../../src/lib/multimodal/fusion';
import { fuseMediaTimeline } from '../../src/lib/media/timeline-fusion';
import type { RuntimePolicyBundle } from '../../src/lib/policy-bundle';

const bundle: RuntimePolicyBundle = {
  id: 'bundle-fusion-contract', generation: 1,
  payload: { schemaVersion: '1.0', policyId: 'fusion-contract', policyVersion: 1,
    dimensions: [{ id: 'dim-test', code: 'synthetic_risk', name: 'Synthetic', weight: 1 }],
    rules: [{ id: 'direction-rule', riskType: 'synthetic_risk', pattern: 'SYNTHETIC_DENY', matchType: 'contains', caseSensitive: true, score: 1, mandatoryDeny: true }],
    exceptions: [], thresholds: [{ dimensionId: 'dim-test', warn: 0.5, block: 0.8, autoMask: false, autoRewrite: false }],
  },
};
function context(direction: Direction = 'INPUT') {
  return { traceId: 'fusion-direction-' + direction, tenantId: 'tenant-1', applicationId: 'app-1', direction, absoluteDeadlineEpochMs: Date.now() + 5000 };
}
const runners = {
  image: (policy: RuntimePolicyBundle, direction: Direction, text: string) => fuseMultimodal({
    bundle: policy, context: context(direction), ocr: text ? [{ text, artifactId: 'image-1', viewId: 'original', region: [0, 0, 1, 1] }] : [], visual: [],
  }),
  media: (policy: RuntimePolicyBundle, direction: Direction, text: string) => fuseMediaTimeline({
    bundle: policy, context: context(direction), segments: text ? [{ source: 'audio', text, startMs: 100, endMs: 200 }] : [], visual: [],
  }),
};

beforeEach(() => { vi.stubEnv('CONTENT_HASH_KEY', 'fusion-action-contract-test-hmac-key-at-least-32-bytes'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe.each(['image', 'media'] as const)('%s action contract', (kind) => {
  it.each(['INPUT', 'OUTPUT_COMPLETE', 'OUTPUT_CHUNK', 'TOOL_RESULT'] as const)('propagates %s to individual and combined detectors', async (direction) => {
    const policy: RuntimePolicyBundle = { ...bundle, payload: { ...bundle.payload, rules: [{ ...bundle.payload.rules[0], direction }] } };
    const result = await runners[kind](policy, direction, 'SYNTHETIC_DENY');
    const decisions = 'textDecisions' in result ? result.textDecisions : result.decisions;
    expect(decisions.combined.action).toBe('BLOCK');
    expect(result.action).toBe('BLOCK');
    const opposite = direction === 'INPUT' ? 'OUTPUT_COMPLETE' : 'INPUT';
    expect((await runners[kind](policy, opposite, 'SYNTHETIC_DENY')).action).toBe('ALLOW');
  });

  it('does not scan empty placeholders or claim complete evidence for absent tracks', async () => {
    const policy: RuntimePolicyBundle = { ...bundle, payload: { ...bundle.payload, rules: [{ ...bundle.payload.rules[0], pattern: 'empty' }] } };
    const result = await runners[kind](policy, 'INPUT', '');
    expect(result.action).toBe('ALLOW'); expect(result.evidence).toEqual([]);
    const decisions = 'textDecisions' in result ? result.textDecisions : result.decisions;
    for (const decision of Object.values(decisions)) {
      expect(decision).toMatchObject({ action: 'ALLOW', observations: [], reasonCodes: ['MODALITY_NOT_APPLICABLE'], evidenceComplete: false });
    }
  });

  it('retains a terminal denial when modality coverage is unverified', async () => {
    const policy: RuntimePolicyBundle = { ...bundle, payload: { ...bundle.payload, semanticDecisionMode: 'coverage-v1' } };
    const result = await runners[kind](policy, 'INPUT', 'SYNTHETIC_DENY');
    expect(result.coverage.complete).toBe(false); expect(result.action).toBe('BLOCK'); expect(result.evidence.length).toBeGreaterThan(0);
  });
});

it('maps repeated image hits to local offsets and deduplicates identical individual/combined evidence', async () => {
  const result = await fuseMultimodal({ bundle, context: context(), userText: 'public context',
    ocr: [{ text: 'SYNTHETIC_DENY x SYNTHETIC_DENY', artifactId: 'image-1', viewId: 'original', region: [0, 0, 1, 1] }], visual: [],
  });
  const hits = result.evidence.filter(item => 'ruleId' in item && item.ruleId === 'direction-rule');
  expect(hits).toHaveLength(2);
  expect(hits.map(item => item.sources)).toEqual([
    [expect.objectContaining({ artifactId: 'image-1', textStart: 0, textEnd: 14 })],
    [expect.objectContaining({ artifactId: 'image-1', textStart: 17, textEnd: 31 })],
  ]);
});

it('retains evidence from every timeline window, including equal-severity windows', async () => {
  const result = await fuseMediaTimeline({ bundle, context: context(), crossModalWindowMs: 1000,
    segments: [{ source: 'audio', text: 'SYNTHETIC_DENY', startMs: 100, endMs: 200 },
      { source: 'subtitle', text: 'SYNTHETIC_DENY', startMs: 10000, endMs: 10200 }], visual: [],
  });
  const hits = result.evidence.filter(item => 'ruleId' in item && item.ruleId === 'direction-rule');
  expect(hits).toHaveLength(2);
  expect(hits).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'audio', startMs: 100, textStart: 0, textEnd: 14 }),
    expect.objectContaining({ source: 'subtitle', startMs: 10000, textStart: 0, textEnd: 14 }),
  ]));
});
