import type { DetectionRule } from './types';
import type { JudgeModelResult, PolicyJudgeConfig } from '@/lib/judge/types';

export type RiskAction = 'allow' | 'warn' | 'block';
export type GuardAction = RiskAction | 'mask' | 'rewrite';

const riskPriority: Readonly<Record<RiskAction, number>> = {
  allow: 0,
  warn: 1,
  block: 2,
};

export function strictestRiskAction(...actions: readonly RiskAction[]): RiskAction {
  return actions.reduce<RiskAction>(
    (strictest, action) => (riskPriority[action] > riskPriority[strictest] ? action : strictest),
    'allow',
  );
}

export function terminalAction(
  riskAction: RiskAction,
  treatment: 'none' | 'mask' | 'rewrite',
): GuardAction {
  if (riskAction === 'block') return 'block';
  if (treatment === 'rewrite') return 'rewrite';
  if (treatment === 'mask') return 'mask';
  return riskAction;
}

export function isMandatoryDenyRule(rule: Pick<DetectionRule, 'config'>): boolean {
  return rule.config.mandatoryDeny === true || rule.config.hardBlock === true;
}

export function exceptionSkipsRule(
  dimensionIsExcepted: boolean,
  rule: Pick<DetectionRule, 'config'>,
): boolean {
  return dimensionIsExcepted && !isMandatoryDenyRule(rule);
}

export function judgeFailureAction(
  ruleAction: RiskAction,
  ruleScore: number,
  judgeResult: JudgeModelResult | undefined,
  config: PolicyJudgeConfig,
): RiskAction | null {
  if (judgeResult?.used && !judgeResult.error && !judgeResult.parseError) return null;
  if (config.fallbackAction === 'block') return 'block';
  const highRisk = ruleAction === 'block' || ruleScore >= config.judgeThreshold;
  if (config.failClosedForHighRisk && highRisk) return 'block';
  if (config.fallbackAction === 'allow') return strictestRiskAction(ruleAction, 'allow');
  return ruleAction;
}
