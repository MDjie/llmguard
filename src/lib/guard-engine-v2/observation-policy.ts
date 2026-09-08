import type { Direction, GuardAction, Observation } from '@guardllm/contracts';
import type { GuardEnginePolicy } from './types';
import { isConfirmedObservation } from './observation-role';

/** Shared by aggregation and scheduling: scores alone never imply terminal blocking. */
export function createObservationPolicy(policy: GuardEnginePolicy, direction: Direction) {
  const cache = new Map<string, { readonly warn: number; readonly block: number }>();
  const thresholds = (risk: string) => {
    const cached = cache.get(risk);
    if (cached) return cached;
    const table = policy.riskThresholds ?? {};
    const key = Object.keys(table).filter(value => risk === value || risk.startsWith(value + '.'))
      .sort((a,b) => b.length - a.length)[0];
    const value = key ? table[key] : { warn: policy.warnThreshold, block: policy.blockThreshold };
    cache.set(risk,value);
    return value;
  };
  const override = (item: Observation): GuardAction | undefined => {
    if (!isConfirmedObservation(item)) return undefined;
    const action = policy.actionOverrides?.[item.riskType];
    const cutoff = policy.actionOverrideThresholds?.[item.riskType] ?? thresholds(item.riskType).warn;
    return action && item.score >= cutoff ? action : undefined;
  };
  const output = ['OUTPUT_COMPLETE','OUTPUT_CHUNK','TOOL_RESULT'].includes(direction);
  const thresholdBlock = (item: Observation) => isConfirmedObservation(item) &&
    item.score >= thresholds(item.riskType).block &&
    (!output || override(item) === undefined || override(item) === 'BLOCK');
  const terminal = (item: Observation) => isConfirmedObservation(item) &&
    (item.reasonCode === 'MANDATORY_DENY' || item.decisionRole === 'HARD_DENY' ||
     thresholdBlock(item) || override(item) === 'BLOCK');
  return { thresholds, override, thresholdBlock, terminal };
}
