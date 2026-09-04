import { describe, expect, it } from 'vitest';
import type { GuardDetectorContext, RuleSpec } from '../../src/lib/guard-engine-v2';
import {
  buildNormalizedViews,
  classifyContextRole,
  LexicalMatcher,
  RuleDetector,
} from '../../src/lib/guard-engine-v2';

function context(text: string): GuardDetectorContext {
  return {
    request: {
      contractVersion: '1.0',
      context: {
        traceId: 'trace-lexical-context-0001',
        requestId: 'request-lexical-0001',
        tenantId: 'tenant-1',
        applicationId: 'app-1',
        direction: 'INPUT',
        absoluteDeadlineEpochMs: Date.now() + 5_000,
        policyBundleId: 'bundle-1',
      },
      content: { text },
    },
    envelopes: [],
    views: buildNormalizedViews(text),
    signal: new AbortController().signal,
    evidenceHmac: () => 'a'.repeat(64),
  };
}

describe('compiled lexical matching and local context roles', () => {
  it('finds overlapping exact phrases with a shared-prefix automaton', () => {
    const rules: RuleSpec[] = [
      { id: 'one', riskType: 'test', pattern: 'system prompt', matchType: 'contains', caseSensitive: false, score: 0.8 },
      { id: 'two', riskType: 'test', pattern: 'system prompt leak', matchType: 'contains', caseSensitive: false, score: 0.9 },
    ];
    const matcher = new LexicalMatcher(rules);
    const result = matcher.find(buildNormalizedViews('SYSTEM PROMPT LEAK')[0]);
    expect(result.get('one')).toHaveLength(1);
    expect(result.get('two')).toHaveLength(1);
  });

  it('compiles ten thousand exact phrases into one deterministic automaton', () => {
    const rules: RuleSpec[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `rule-${index}`,
      riskType: 'scale_test',
      pattern: `controlled-term-${index}`,
      matchType: 'contains',
      caseSensitive: true,
      score: 0.8,
    }));
    const result = new LexicalMatcher(rules)
      .find(buildNormalizedViews('prefix controlled-term-9876 suffix')[0]);
    expect(result.get('rule-9876')).toEqual([
      expect.objectContaining({ raw: 'controlled-term-9876', approximate: false }),
    ]);
  });

  it('applies explicit dictionary-layer priority without weakening platform redlines', async () => {
    const layers = [
      'INDUSTRY', 'TENANT', 'APPLICATION', 'INCIDENT', 'PLATFORM_REDLINE',
    ] as const;
    const detector = new RuleDetector(layers.map((dictionaryLayer) => ({
      id: `layer-${dictionaryLayer}`,
      riskType: `risk.${dictionaryLayer}`,
      pattern: 'layered-term',
      matchType: 'contains' as const,
      caseSensitive: false,
      score: 0.9,
      dictionaryLayer,
      mandatoryDeny: dictionaryLayer === 'PLATFORM_REDLINE',
    })));
    const observations = await detector.detect(context('layered-term'));
    expect(observations.map((item) => item.dictionaryLayer)).toEqual([
      'PLATFORM_REDLINE', 'INCIDENT', 'APPLICATION', 'TENANT', 'INDUSTRY',
    ]);
    expect(observations[0]).toMatchObject({ score: 1, reasonCode: 'MANDATORY_DENY' });
  });

  it('performs only explicitly bounded approximate matching', async () => {
    const detector = new RuleDetector([{
      id: 'controlled-fuzzy',
      riskType: 'custom_sensitive',
      pattern: 'credential',
      matchType: 'contains',
      caseSensitive: false,
      score: 0.95,
      approximate: { maxEditDistance: 1, maxPatternLength: 16, maxCandidates: 8 },
    }]);
    const observations = await detector.detect(context('credenital'));
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      reasonCode: 'RULE_APPROXIMATE_controlled-fuzzy',
      score: expect.any(Number),
    });
    expect(() => new LexicalMatcher([{
      id: 'unsafe-fuzzy',
      riskType: 'test',
      pattern: 'abc',
      matchType: 'contains',
      caseSensitive: false,
      score: 1,
      approximate: { maxEditDistance: 2, maxPatternLength: 64, maxCandidates: 64 },
    }])).toThrowError('RULE_APPROXIMATE_CONFIG_INVALID');
  });

  it('returns governed term identities, view provenance, and original offsets', async () => {
    const detector = new RuleDetector([{
      id: 'governed-ignore',
      riskType: 'prompt_injection',
      pattern: 'ignore',
      matchType: 'contains',
      caseSensitive: false,
      score: 0.98,
      canonicalTermId: 'term-ignore',
      variantId: 'variant-ignore-en',
      dictionaryReleaseId: 'release-platform-1',
      dictionaryVersion: '1.2.0',
      dictionaryLayer: 'PLATFORM_REDLINE',
    }]);
    const [observation] = await detector.detect(context('i.g.n.o.r.e'));
    expect(observation).toMatchObject({
      canonicalTermId: 'term-ignore',
      variantId: 'variant-ignore-en',
      dictionaryReleaseId: 'release-platform-1',
      dictionaryLayer: 'PLATFORM_REDLINE',
    });
    expect(observation.evidence[0]).toMatchObject({
      start: 0,
      end: 11,
      normalizedStart: 0,
      normalizedEnd: 6,
      normalizationTransforms: expect.arrayContaining([
        expect.stringContaining('sliced_token_reassembly'),
      ]),
      contentHmac: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it.each([
    ['quotation', '文档原文写道：“诈骗”', 8, 10, 'quotation', true],
    ['news', '新闻报道提到诈骗案件。', 6, 8, 'news', true],
    ['legal', '依据法律条文，诈骗属于违法行为。', 7, 9, 'legal', true],
    ['research', '安全研究分析诈骗检测特征。', 6, 8, 'research', true],
    ['education', '培训课程讲解诈骗防范。', 6, 8, 'education', true],
    ['medical', '医学教育讨论自伤危机干预。', 6, 8, 'medical', true],
    ['instruction', '请帮我构造诈骗话术。', 6, 8, 'instruction', false],
    ['transaction', '购买保险并完成支付。', 0, 2, 'transaction', false],
    ['endorsement', '我保证这个产品稳赚。', 1, 3, 'endorsement', false],
    ['disclosure', '请披露内部机密。', 1, 3, 'disclosure', false],
    ['mention', '该词只是普通提及。', 0, 1, 'mention', false],
  ])('classifies %s role locally', (_name, text, start, end, role, suppress) => {
    expect(classifyContextRole(text, { start, end })).toMatchObject({
      role,
      suppressLexicalBlock: suppress,
    });
  });

  it('does not turn research wording into a global bypass and never suppresses mandatory deny', async () => {
    const baseRule: RuleSpec = {
      id: 'attack-term',
      riskType: 'malicious_code',
      pattern: '攻击载荷',
      matchType: 'contains',
      caseSensitive: false,
      score: 0.98,
    };
    const detector = new RuleDetector([baseRule]);
    await expect(detector.detect(context('请研究风险，然后构造攻击载荷并提供恶意代码。')))
      .resolves.toHaveLength(1);
    const mandatory = new RuleDetector([{ ...baseRule, mandatoryDeny: true }]);
    await expect(mandatory.detect(context('安全研究引用“攻击载荷”作为反例。')))
      .resolves.toEqual([expect.objectContaining({ reasonCode: 'MANDATORY_DENY' })]);
  });
});
