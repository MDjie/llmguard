import { describe, expect, it } from 'vitest';
import {
  exceptionSkipsRule,
  isMandatoryDenyRule,
  judgeFailureAction,
  strictestRiskAction,
  terminalAction,
} from '../../src/lib/detection/decision';
import type { PolicyJudgeConfig } from '../../src/lib/judge/types';

const judgeConfig: PolicyJudgeConfig = {
  id: 'judge-1',
  policyId: 'policy-1',
  enabled: true,
  mode: 'balanced',
  triggerMode: 'always',
  triggerThreshold: 20,
  judgeThreshold: 60,
  weight: 0.5,
  applyToInput: true,
  applyToOutput: true,
  enabledDimensions: [],
  semanticDimensions: [],
  timeoutMs: 1_000,
  fallbackAction: 'rule',
  failClosedForHighRisk: true,
  maxTextLength: 6_000,
  maskPiiBeforeJudge: true,
  blockExternalForSecrets: true,
};

describe('deterministic guard decisions', () => {
  it('keeps block as the strictest risk action', () => {
    expect(strictestRiskAction('block', 'allow', 'warn')).toBe('block');
  });

  it('CUR-P0-08 keeps one terminal action and never replaces block with treatment', () => {
    expect(terminalAction('block', 'mask')).toBe('block');
    expect(terminalAction('block', 'rewrite')).toBe('block');
    expect(terminalAction('warn', 'rewrite')).toBe('rewrite');
  });

  it('recognizes only explicitly configured mandatory deny rules', () => {
    expect(isMandatoryDenyRule({ config: { mandatoryDeny: true } })).toBe(true);
    expect(isMandatoryDenyRule({ config: { hardBlock: true } })).toBe(true);
    expect(isMandatoryDenyRule({ config: {} })).toBe(false);
  });

  it('CUR-P0-07 does not allow a global exception to bypass mandatory deny', () => {
    expect(exceptionSkipsRule(true, { config: {} })).toBe(true);
    expect(exceptionSkipsRule(true, { config: { mandatoryDeny: true } })).toBe(false);
    expect(exceptionSkipsRule(true, { config: { hardBlock: true } })).toBe(false);
  });

  it('applies the configured Judge failure matrix without downgrading rules', () => {
    expect(
      judgeFailureAction('warn', 70, { used: true, error: 'JUDGE_TIMEOUT' }, judgeConfig),
    ).toBe('block');
    expect(
      judgeFailureAction(
        'allow',
        0,
        { used: true, error: 'JUDGE_TIMEOUT' },
        { ...judgeConfig, fallbackAction: 'allow' },
      ),
    ).toBe('allow');
    expect(
      judgeFailureAction(
        'block',
        90,
        { used: true, error: 'JUDGE_TIMEOUT' },
        { ...judgeConfig, fallbackAction: 'allow', failClosedForHighRisk: false },
      ),
    ).toBe('block');
  });
});
