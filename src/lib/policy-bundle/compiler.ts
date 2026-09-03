import type { CachedPolicyConfig } from '@/lib/detection/types';
import type { CompiledPolicyBundle } from './types';
import { buildDefaultDetectorDag } from '@/lib/guard-engine-v2/default-dag';
import type { SemanticClassifierSpec } from '@/lib/guard-engine-v2/types';
import type { GuardResourceAdmissionSpec } from '@/lib/resource-control/admission-config';

export function compilePolicyBundle(
  config: CachedPolicyConfig,
  policyVersion: number,
  options: {
    readonly semanticClassifier?: SemanticClassifierSpec;
    readonly resourceAdmission?: GuardResourceAdmissionSpec;
  } = {},
): CompiledPolicyBundle {
  const dimensions = [...config.dimensions]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map(({ id, code, name, weight }) => ({ id, code, name, weight }));
  const dimensionById = new Map(dimensions.map((dimension) => [dimension.id, dimension]));
  const rules = [...config.rules.entries()]
    .flatMap(([dimensionId, entries]) => {
      const dimension = dimensionById.get(dimensionId);
      if (!dimension) return [];
      return entries
        .filter((rule) => rule.enabled && Boolean(rule.pattern))
        .map((rule) => ({
          id: rule.id,
          riskType: dimension.code,
          pattern: rule.pattern!,
          matchType: rule.matchType,
          caseSensitive: rule.caseSensitive,
          score: Math.min(1, Math.max(0, rule.score / 100)),
          mandatoryDeny:
            rule.config.mandatoryDeny === true ||
            rule.config.hardBlock === true,
        }));
    })
    .sort((left, right) =>
      left.riskType.localeCompare(right.riskType) || left.id.localeCompare(right.id),
    );
  const exceptions = [...config.whitelists]
    .filter((exception) => exception.enabled)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((exception) => ({
      id: exception.id,
      pattern: exception.pattern,
      matchType: exception.matchType,
      caseSensitive: exception.caseSensitive,
      dimensionScope: exception.dimensionScope,
      dimensionCodes: [...exception.dimensionCodes].sort(),
      mandatoryDenyExempt: false as const,
    }));
  const thresholds = [...config.dimensionConfigs]
    .filter((item) => item.enabled)
    .sort((left, right) => left.dimensionId.localeCompare(right.dimensionId))
    .map((item) => ({
      dimensionId: item.dimensionId,
      warn: Math.min(1, Math.max(0, item.warnThreshold / 100)),
      block: Math.min(1, Math.max(0, item.blockThreshold / 100)),
      autoMask: item.autoMask,
      autoRewrite: item.autoRewrite,
    }));
  return {
    schemaVersion: '1.0',
    policyId: config.policyId,
    policyVersion,
    dimensions,
    rules,
    exceptions,
    thresholds,
    detectorDag: buildDefaultDetectorDag(options.semanticClassifier),
    ...(options.semanticClassifier
      ? { semanticClassifier: options.semanticClassifier }
      : {}),
    ...(options.resourceAdmission
      ? { resourceAdmission: options.resourceAdmission }
      : {}),
  };
}
