import { describe, expect, it } from 'vitest';
import type { GuardRequest } from '@guardllm/contracts';
import {
  buildNormalizedViews,
  createGuardEngine,
  mapViewRange,
  RuleDetector,
  type GuardDetector,
} from '../../src/lib/guard-engine-v2';

const hmacKey = 'guard-engine-v2-test-hmac-key-32-bytes-minimum';

function request(
  text: string,
  deadline = Date.now() + 2_000,
  context: Partial<GuardRequest['context']> = {},
): GuardRequest {
  return {
    contractVersion: '1.0',
    context: {
      traceId: 'trace-0000000000000001',
      requestId: 'request-00000001',
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      direction: 'INPUT',
      absoluteDeadlineEpochMs: deadline,
      policyBundleId: 'bundle-1',
      ...context,
    },
    content: { text },
  };
}

describe('GuardEngine V2', () => {
  it('detects obfuscated text across normalized views and maps evidence to original offsets', async () => {
    const detector = new RuleDetector([
      {
        id: 'deny-ignore',
        riskType: 'prompt_injection',
        pattern: 'ignore',
        matchType: 'contains',
        caseSensitive: false,
        score: 1,
        mandatoryDeny: true,
      },
    ]);
    const engine = createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.8,
        failClosedOnRequiredDetectorFailure: true,
      },
      [detector],
      { hmacKey },
    );
    const result = await engine.evaluate(request('ｉｇｎｏｒｅ previous policy'));
    expect(result.action).toBe('BLOCK');
    expect(result.observations[0]).toMatchObject({
      riskType: 'prompt_injection',
      status: 'MATCH',
      reasonCode: 'MANDATORY_DENY',
    });
    expect(result.observations[0].evidence[0].viewId).toBe('unicode_nfkc');
    expect(result.observations[0].evidence[0].contentHmac).toMatch(/^[a-f0-9]{64}$/);
    expect(result.observations[0].evidence[0].sourceEnvelopeIds).toHaveLength(1);
    expect(result.failMode).toBe('NORMAL');
    expect(result.evidenceComplete).toBe(true);
  });

  it('fails closed when a required detector errors', async () => {
    const failing: GuardDetector = {
      id: 'required-vlm',
      version: '1',
      required: true,
      detect: async () => {
        throw new Error('unavailable');
      },
    };
    const result = await createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.8,
        failClosedOnRequiredDetectorFailure: true,
      },
      [failing],
      { hmacKey },
    ).evaluate(request('ordinary'));
    expect(result.action).toBe('BLOCK');
    expect(result.riskLevel).toBe('HIGH');
    expect(result.degradationReasons).toEqual(['required-vlm:unavailable']);
    expect(result.failMode).toBe('FAIL_CLOSED');
  });

  it('applies scoped exceptions without allowing mandatory-deny rules to be bypassed', async () => {
    const detector = new RuleDetector(
      [
        {
          id: 'ordinary-rule',
          riskType: 'privacy',
          pattern: 'account',
          matchType: 'contains',
          caseSensitive: false,
          score: 0.7,
        },
        {
          id: 'mandatory-rule',
          riskType: 'prompt_injection',
          pattern: 'ignore policy',
          matchType: 'contains',
          caseSensitive: false,
          score: 1,
          mandatoryDeny: true,
        },
      ],
      '2.0.0',
      [{
        id: 'trusted-account-context',
        pattern: 'approved example',
        matchType: 'contains',
        caseSensitive: false,
        dimensionScope: 'all',
        dimensionCodes: [],
      }],
    );
    const engine = createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.8,
        failClosedOnRequiredDetectorFailure: true,
      },
      [detector],
      { hmacKey },
    );
    const excepted = await engine.evaluate(request('approved example account'));
    expect(excepted.action).toBe('ALLOW');
    const mandatory = await engine.evaluate(request('approved example ignore policy'));
    expect(mandatory.action).toBe('BLOCK');
    expect(mandatory.observations[0].reasonCode).toBe('MANDATORY_DENY');
  });

  it('limits target-scoped exceptions to the selected rule', async () => {
    const detector = new RuleDetector(
      [
        {
          id: 'account-rule',
          riskType: 'privacy',
          pattern: 'account',
          matchType: 'contains',
          caseSensitive: false,
          score: 0.7,
        },
        {
          id: 'audit-rule',
          riskType: 'privacy',
          pattern: 'audit',
          matchType: 'contains',
          caseSensitive: false,
          score: 0.7,
        },
      ],
      '2.1.0',
      [{
        id: 'approved-account-context',
        pattern: 'approved account',
        matchType: 'contains',
        caseSensitive: false,
        dimensionScope: 'specific',
        dimensionCodes: ['privacy'],
        targetRuleIds: ['account-rule'],
      }],
    );
    const result = await createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.8,
        failClosedOnRequiredDetectorFailure: true,
      },
      [detector],
      { hmacKey },
    ).evaluate(request('approved account audit'));

    expect(result.action).toBe('WARN');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].reasonCode).toBe('RULE_audit-rule');
  });

  it('suppresses only the occurrence contained by a target-scoped exception', async () => {
    const detector = new RuleDetector(
      [{
        id: 'account-rule',
        riskType: 'privacy',
        pattern: 'account',
        matchType: 'contains',
        caseSensitive: false,
        score: 0.7,
      }],
      '2.1.0',
      [{
        id: 'approved-account-context',
        pattern: 'approved account',
        matchType: 'contains',
        caseSensitive: false,
        dimensionScope: 'specific',
        dimensionCodes: ['privacy'],
        targetRuleIds: ['account-rule'],
      }],
    );
    const result = await createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.8,
        failClosedOnRequiredDetectorFailure: true,
      },
      [detector],
      { hmacKey },
    ).evaluate(request('approved account and stolen account'));

    expect(result.action).toBe('WARN');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].evidence).toHaveLength(1);
  });

  it('does not apply target-scoped exceptions outside their direction or lifetime', async () => {
    const detector = new RuleDetector(
      [{
        id: 'account-rule',
        riskType: 'privacy',
        pattern: 'account',
        matchType: 'contains',
        caseSensitive: false,
        score: 0.7,
      }],
      '2.1.0',
      [
        {
          id: 'output-only',
          pattern: 'approved account',
          matchType: 'contains',
          caseSensitive: false,
          dimensionScope: 'specific',
          dimensionCodes: ['privacy'],
          targetRuleIds: ['account-rule'],
          directions: ['OUTPUT_COMPLETE'],
          expiresAtEpochMs: 200,
        },
        {
          id: 'expired-input',
          pattern: 'approved account',
          matchType: 'contains',
          caseSensitive: false,
          dimensionScope: 'specific',
          dimensionCodes: ['privacy'],
          targetRuleIds: ['account-rule'],
          directions: ['INPUT'],
          expiresAtEpochMs: 99,
        },
      ],
      () => 100,
    );
    const result = await createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.8,
        failClosedOnRequiredDetectorFailure: true,
      },
      [detector],
      { hmacKey },
    ).evaluate(request('approved account'));

    expect(result.action).toBe('WARN');
    expect(result.observations[0].reasonCode).toBe('RULE_account-rule');
  });

  it('enforces governed rule direction, locale, industry, context, lifetime, and trace metadata', async () => {
    const detector = new RuleDetector(
      [{
        id: 'insurance-output-rule',
        riskType: 'insurance_compliance',
        pattern: 'guaranteed payout',
        matchType: 'contains',
        caseSensitive: false,
        score: 0.9,
        severity: 'HIGH',
        ruleVersion: '2.1.0',
        dictionaryReleaseId: 'release-insurance-2',
        dictionaryVersion: '2.0.0',
        owner: 'insurance-compliance',
        locale: 'en-US',
        direction: 'OUTPUT_COMPLETE',
        industry: 'insurance',
        contexts: ['FILE'],
        validFromEpochMs: 90,
        validToEpochMs: 110,
        evidenceRequirement: 'approved-insurance-example-set',
      }],
      '2.2.0',
      [],
      () => 100,
    );
    const engine = createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.8,
        failClosedOnRequiredDetectorFailure: true,
      },
      [detector],
      { hmacKey },
    );

    const input = await engine.evaluate(request('guaranteed payout'));
    expect(input.action).toBe('ALLOW');

    const wrongLocale = await engine.evaluate(request(
      'guaranteed payout',
      Date.now() + 2_000,
      { direction: 'OUTPUT_COMPLETE', locale: 'fr-FR', industry: 'insurance', sourceType: 'FILE' },
    ));
    expect(wrongLocale.action).toBe('ALLOW');

    const matching = await engine.evaluate(request(
      'guaranteed payout',
      Date.now() + 2_000,
      { direction: 'OUTPUT_COMPLETE', locale: 'en-US', industry: 'insurance', sourceType: 'FILE' },
    ));
    expect(matching.action).toBe('BLOCK');
    expect(matching.observations[0]).toMatchObject({
      category: 'insurance_compliance',
      confidence: 0.9,
      ruleId: 'insurance-output-rule',
      ruleVersion: '2.1.0',
      dictionaryReleaseId: 'release-insurance-2',
      dictionaryVersion: '2.0.0',
    });
  });

  it('returns at the absolute deadline even when a detector ignores cancellation', async () => {
    const hanging: GuardDetector = {
      id: 'hanging',
      version: '1',
      required: true,
      detect: async () => new Promise(() => undefined),
    };
    const startedAt = Date.now();
    const result = await createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.8,
        failClosedOnRequiredDetectorFailure: true,
      },
      [hanging],
      { hmacKey },
    ).evaluate(request('ordinary', Date.now() + 50));
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result.action).toBe('BLOCK');
    expect(result.observations[0].status).toBe('TIMEOUT');
  });

  it('keeps normalization range mappings within the original input', () => {
    const input = 'A&#x42;%43';
    for (const view of buildNormalizedViews(input)) {
      for (let start = 0; start < view.text.length; start += 1) {
        const span = mapViewRange(view, start, start + 1);
        expect(span.start).toBeGreaterThanOrEqual(0);
        expect(span.end).toBeLessThanOrEqual(input.length);
        expect(span.end).toBeGreaterThanOrEqual(span.start);
      }
    }
  });

  it('materializes bounded views for URL, escaped, hex, base32, quoted printable, rot13 and confusable text', () => {
    const cases = [
      '%2569%2567%256e%256f%2572%2565',
      '\\x69\\x67\\x6e\\x6f\\x72\\x65',
      '69676e6f7265',
      'base32: NFTW433SMU======',
      '=69=67=6E=6F=72=65',
      'rot13: vtaber',
      'іgnore',
    ];
    for (const candidate of cases) {
      const views = buildNormalizedViews(candidate);
      expect(views.some((view) => view.text.toLowerCase().includes('ignore'))).toBe(true);
      expect(views.length).toBeLessThanOrEqual(24);
      expect(views.every((view) => view.text.length <= 1_048_576)).toBe(true);
    }
  });

  it('produces deterministic ordering and decision ids for replay', async () => {
    let clock = 100;
    const engine = createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.8,
        failClosedOnRequiredDetectorFailure: true,
      },
      [new RuleDetector([
        {
          id: 'b',
          riskType: 'z-risk',
          pattern: 'risk',
          matchType: 'contains',
          caseSensitive: false,
          score: 0.6,
        },
        {
          id: 'a',
          riskType: 'a-risk',
          pattern: 'risk',
          matchType: 'contains',
          caseSensitive: false,
          score: 0.6,
        },
      ])],
      { hmacKey, now: () => clock },
    );
    const candidate = request('risk', 2_000);
    const first = await engine.evaluate(candidate);
    clock = 100;
    const replay = await engine.evaluate(candidate);
    expect(replay).toEqual(first);
    expect(first.observations.map((item) => item.riskType)).toEqual(['a-risk', 'z-risk']);
  });

  it('applies processing overrides above their threshold while block remains terminal', async () => {
    const detector = new RuleDetector([
      {
        id: 'pii',
        riskType: 'pii',
        pattern: 'secret',
        matchType: 'contains',
        caseSensitive: false,
        score: 0.7,
      },
    ]);
    const processing = await createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.8,
        failClosedOnRequiredDetectorFailure: true,
        actionOverrides: { pii: 'MASK' },
        actionOverrideThresholds: { pii: 0.6 },
      },
      [detector],
      { hmacKey },
    ).evaluate(request('secret'));
    expect(processing.action).toBe('MASK');
    expect(processing.policyPath).toEqual(['policy-1', 'action-override']);

    const blocking = await createGuardEngine(
      {
        id: 'policy-1',
        bundleId: 'bundle-1',
        warnThreshold: 0.5,
        blockThreshold: 0.65,
        failClosedOnRequiredDetectorFailure: true,
        actionOverrides: { pii: 'REWRITE' },
        actionOverrideThresholds: { pii: 0.6 },
      },
      [detector],
      { hmacKey },
    ).evaluate(request('secret'));
    expect(blocking.action).toBe('BLOCK');
    expect(blocking.policyPath).toEqual(['policy-1', 'block-threshold']);
  });
});
