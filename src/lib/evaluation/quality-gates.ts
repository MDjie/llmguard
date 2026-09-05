import type { GuardAction } from '@guardllm/contracts';
import { z } from 'zod';
import { wilson95 } from './classification-metrics';

export interface MeasuredRate {
  readonly value: number | null;
  readonly lower95: number | null;
  readonly upper95: number | null;
  readonly numerator: number;
  readonly denominator: number;
}
export function rate(numerator: number, denominator: number): MeasuredRate {
  const result = wilson95(numerator, denominator);
  return denominator === 0 ? { ...result, value: null, lower95: null, upper95: null } : result;
}
export interface SafetyMetricCase {
  readonly groupId: string;
  readonly expectedRiskIds: readonly string[];
  readonly confirmedRiskIds: readonly string[];
  readonly actualAction: GuardAction;
  readonly acceptableActions: readonly GuardAction[];
  readonly effectSafe: boolean;
  readonly complete: boolean;
}
function classification(rows: readonly { expected: boolean; actual: boolean }[]) {
  const tp = rows.filter(r => r.expected && r.actual).length;
  const fp = rows.filter(r => !r.expected && r.actual).length;
  const fn = rows.filter(r => r.expected && !r.actual).length;
  const tn = rows.length - tp - fp - fn;
  return { tp, fp, fn, tn, precision: rate(tp, tp + fp), recall: rate(tp, tp + fn),
    fpr: rate(fp, fp + tn), fnr: rate(fn, tp + fn), accuracy: rate(tp + tn, rows.length),
    f1: 2 * tp + fp + fn === 0 ? null : 2 * tp / (2 * tp + fp + fn) };
}
export function calculateSafetyMetrics(items: readonly SafetyMetricCase[], riskIds: readonly string[]) {
  if (new Set(items.map(i => i.groupId)).size !== items.length) throw new Error('DUPLICATE_GROUP');
  if (new Set(riskIds).size !== riskIds.length) throw new Error('DUPLICATE_RISK');
  const perRisk = Object.fromEntries(riskIds.map(id => [id, classification(items.map(i => ({
    expected: i.expectedRiskIds.includes(id), actual: i.complete && i.confirmedRiskIds.includes(id),
  })))]));
  const allF1 = Object.values(perRisk).map(v => v.f1);
  const benign = items.filter(i => i.expectedRiskIds.length === 0);
  const blocks = items.filter(i => i.actualAction === 'BLOCK');
  return {
    metricVersion: 'safety-2.0' as const, independentGroups: items.length,
    risk: classification(items.map(i => ({ expected: i.expectedRiskIds.length > 0, actual: i.complete && i.confirmedRiskIds.length > 0 }))),
    perRisk,
    macroF1: allF1.length && allF1.every((v): v is number => v !== null) ? allF1.reduce((a, b) => a + b, 0) / allF1.length : null,
    actionCorrectness: rate(items.filter(i => i.complete && i.actualAction !== 'REQUIRE_REVIEW' && i.effectSafe && i.acceptableActions.includes(i.actualAction)).length, items.length),
    automaticCoverage: rate(items.filter(i => i.complete && i.actualAction !== 'REQUIRE_REVIEW').length, items.length),
    unknownRate: rate(items.filter(i => !i.complete).length, items.length),
    reviewRate: rate(items.filter(i => i.actualAction === 'REQUIRE_REVIEW').length, items.length),
    unnecessaryHardBlockRate: rate(benign.filter(i => i.actualAction === 'BLOCK' && !i.acceptableActions.includes('BLOCK')).length, benign.length),
    autoBlockPrecision: rate(blocks.filter(i => i.expectedRiskIds.length > 0 && i.acceptableActions.includes('BLOCK')).length, blocks.length),
  };
}
export const qualityRequirementSchema = z.object({
  metric: z.string().min(1), operator: z.enum(['>=', '<=', '==']), value: z.number().finite(),
  bound: z.enum(['point', 'wilson_lower', 'wilson_upper']).default('point'),
  applyTo: z.string().optional(), minPositiveGroups: z.number().int().positive().optional(),
  minPredictedBlockedGroups: z.number().int().positive().optional(),
  sampling: z.string().optional(),
}).strict();
export type QualityRequirement = z.input<typeof qualityRequirementSchema>;
const measuredSchema = z.object({
  value: z.number().finite().nullable(), lower95: z.number().min(0).max(1).nullable(),
  upper95: z.number().min(0).max(1).nullable(), numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
}).strict();
export function checkQualityGates(metrics: Readonly<Record<string, unknown>>, requirements: readonly QualityRequirement[]) {
  const checks = requirements.map(raw => {
    const gate = qualityRequirementSchema.parse(raw);
    const value = metrics[gate.metric];
    const parsed = measuredSchema.safeParse(value);
    let actual: number | null = null;
    let valid = false;
    if (parsed.success) {
      const r = parsed.data;
      valid = r.denominator > 0 && r.numerator <= r.denominator;
      if (valid) {
        // Recompute, never trust a report-supplied confidence interval.
        const measured = rate(r.numerator, r.denominator);
        actual = gate.bound === 'point' ? measured.value : gate.bound === 'wilson_lower' ? measured.lower95 : measured.upper95;
        valid = r.denominator >= (gate.minPositiveGroups ?? gate.minPredictedBlockedGroups ?? 1);
      }
    } else if (typeof value === 'number' && Number.isFinite(value) && gate.bound === 'point' && !gate.minPositiveGroups && !gate.minPredictedBlockedGroups) {
      actual = value; valid = true;
    }
    const status = !valid || actual === null ? 'INSUFFICIENT_EVIDENCE'
      : (gate.operator === '>=' ? actual >= gate.value : gate.operator === '<=' ? actual <= gate.value : actual === gate.value) ? 'PASS' : 'FAIL';
    return { ...gate, actual, status };
  });
  const status = checks.some(c => c.status === 'FAIL') ? 'FAIL'
    : checks.length === 0 || checks.some(c => c.status === 'INSUFFICIENT_EVIDENCE') ? 'INSUFFICIENT_EVIDENCE' : 'PASS';
  return { status, exitCode: status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 2, checks } as const;
}
