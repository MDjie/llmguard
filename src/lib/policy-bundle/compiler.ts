import type { CachedPolicyConfig } from '@/lib/detection/types';
import { builtInOutputResponseTemplates } from '@/lib/output-control/templates';
import { validateSafeRegexPattern } from '@/lib/detection/safe-regex';
import { buildDefaultDetectorDag } from '@/lib/guard-engine-v2/default-dag';
import type { SemanticClassifierSpec } from '@/lib/guard-engine-v2/types';
import type { GuardResourceAdmissionSpec } from '@/lib/resource-control/admission-config';
import {
  builtInTokenizerManifest,
  PolicyGovernanceValidationError,
  validateGovernedKeywordRulesForCompilation,
  validateGovernedPolicyArtifacts,
  type GovernedPolicyArtifacts,
  type ModelDigestManifest,
} from './governance';
import type { CompiledPolicyBundle } from './types';
import { judgeProfileListSchema, validateJudgeProfileSet, type JudgeProfile } from '@/lib/judge/profile';
import { assertJudgeQuality } from '@/lib/judge/profile-registry';
import { withJudgeDetectorDag } from '@/lib/guard-engine-v2/semantic-routing';
import { riskDefinition } from '@/lib/guard-engine-v2/risk-registry';
import { semanticCoveragePolicySchema, type SemanticCoveragePolicy } from '@/lib/guard-engine-v2/semantic-coverage';
import { assertClassifierQualification } from '@/lib/guard-engine-v2/classifier-qualification';

function requireUniqueIds(values: readonly { readonly id: string }[], field: string): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    throw new PolicyGovernanceValidationError(
      'GOVERNANCE_DUPLICATE',
      `${field} contains duplicate ids`,
    );
  }
}

function sortedGovernance(artifacts: GovernedPolicyArtifacts): GovernedPolicyArtifacts {
  return {
    dictionaryReleases: [...artifacts.dictionaryReleases]
      .sort((left, right) => left.id.localeCompare(right.id)),
    keywordRules: [...artifacts.keywordRules]
      .sort((left, right) =>
        left.riskType.localeCompare(right.riskType) || left.id.localeCompare(right.id)),
    responseTemplates: [...artifacts.responseTemplates]
      .sort((left, right) => left.id.localeCompare(right.id)),
    detectorCalibrations: [...artifacts.detectorCalibrations]
      .sort((left, right) => left.id.localeCompare(right.id)),
    modelDigests: [...artifacts.modelDigests]
      .sort((left, right) => left.modelId.localeCompare(right.modelId) ||
        left.modelVersion.localeCompare(right.modelVersion)),
    tokenizer: artifacts.tokenizer,
    failurePolicies: [...artifacts.failurePolicies]
      .sort((left, right) => left.detectorId.localeCompare(right.detectorId)),
  };
}

function semanticModelDigest(
  semanticClassifier: SemanticClassifierSpec | undefined,
): ModelDigestManifest[] {
  return semanticClassifier ? [{
    modelId: semanticClassifier.modelId,
    modelVersion: semanticClassifier.modelVersion,
    sha256: semanticClassifier.modelSha256,
  }] : [];
}

function mergeModelDigests(
  configured: readonly ModelDigestManifest[],
  semantic: readonly ModelDigestManifest[],
): readonly ModelDigestManifest[] {
  const models = new Map<string, ModelDigestManifest>();
  for (const model of [...configured, ...semantic]) {
    const key = `${model.modelId}:${model.modelVersion}`;
    const existing = models.get(key);
    if (existing && existing.sha256 !== model.sha256) {
      throw new PolicyGovernanceValidationError(
        'MODEL_DIGEST_CONFLICT',
        `Model ${key} has conflicting digests`,
      );
    }
    models.set(key, model);
  }
  return [...models.values()];
}

export function compilePolicyBundle(
  config: CachedPolicyConfig,
  policyVersion: number,
  options: {
    readonly semanticClassifier?: SemanticClassifierSpec;
    readonly decisionPolicyVersion?: 1 | 2;
    readonly semanticDecisionMode?: 'coverage-v1';
    readonly semanticCoverage?: SemanticCoveragePolicy;
    readonly judgeProfiles?: readonly JudgeProfile[];
    readonly resourceAdmission?: GuardResourceAdmissionSpec;
    readonly governance?: Partial<GovernedPolicyArtifacts>;
    readonly compileTimeEpochMs?: number;
  } = {},
): CompiledPolicyBundle {
  const compileTimeEpochMs = options.compileTimeEpochMs ?? Date.now();
  if (!Number.isSafeInteger(compileTimeEpochMs) || compileTimeEpochMs < 1) {
    throw new PolicyGovernanceValidationError('COMPILE_TIME_INVALID', 'Compile time is invalid');
  }

  const judgeProfiles = options.judgeProfiles ? judgeProfileListSchema.parse(options.judgeProfiles).map(profile=>({...profile,
    riskDefinitions:Object.fromEntries(profile.riskIds.map(id=>[id,riskDefinition(id,profile.riskDefinitions)])),
  })) : undefined;
  if (judgeProfiles) { validateJudgeProfileSet(judgeProfiles); for (const profile of judgeProfiles.filter(p=>p.enabled)) assertJudgeQuality(profile, compileTimeEpochMs); }
  if(options.semanticDecisionMode==='coverage-v1'){
    if(options.decisionPolicyVersion!==2)throw new Error('COVERAGE_REQUIRES_V2');
    const coverage=semanticCoveragePolicySchema.parse(options.semanticCoverage);
    const baseProfiles=judgeProfiles?.filter(p=>p.enabled&&p.mode==='ENFORCE'&&(p.role??'base')==='base')??[];
    const classifier=options.semanticClassifier;
    if(classifier?.coverage&&classifier.mode==='ENFORCE')assertClassifierQualification(classifier,compileTimeEpochMs);
    const risks=new Set([...baseProfiles.flatMap(p=>p.riskIds),...(classifier?.coverage&&classifier.mode==='ENFORCE'?classifier.labels.map(l=>l.riskType):[])]);
    if(coverage.requiredRiskIds.some(id=>!risks.has(id)))throw new Error('SEMANTIC_BASE_COVERAGE_REQUIRED');
  } else if (options.decisionPolicyVersion === 2 && !judgeProfiles?.some(p=>p.enabled && p.mode === 'ENFORCE'&&(p.role??'base')==='base')) throw new Error('V2_ENFORCED_JUDGE_REQUIRED');
  const baseDag=buildDefaultDetectorDag(options.semanticClassifier);
  const coverageDag=options.semanticDecisionMode==='coverage-v1'?{...baseDag,nodes:baseDag.nodes.map(n=>n.detectorId===options.semanticClassifier?.detectorId?{...n,failurePolicy:'DEGRADE' as const}:n)}:baseDag;
  const detectorDag = withJudgeDetectorDag(coverageDag, judgeProfiles, options.decisionPolicyVersion);
  const governanceInput = options.governance;
  const governance = sortedGovernance(validateGovernedPolicyArtifacts({
    dictionaryReleases: governanceInput?.dictionaryReleases ?? [],
    keywordRules: governanceInput?.keywordRules ?? [],
    responseTemplates: governanceInput?.responseTemplates?.length
      ? governanceInput.responseTemplates
      : builtInOutputResponseTemplates(),
    detectorCalibrations: governanceInput?.detectorCalibrations ?? [],
    modelDigests: mergeModelDigests(
      governanceInput?.modelDigests ?? [],
      semanticModelDigest(options.semanticClassifier),
    ),
    tokenizer: governanceInput?.tokenizer ?? builtInTokenizerManifest(),
    failurePolicies: governanceInput?.failurePolicies?.length
      ? governanceInput.failurePolicies
      : detectorDag.nodes.map((node) => ({
          detectorId: node.detectorId,
          policy: node.failurePolicy,
        })),
  }));
  validateGovernedKeywordRulesForCompilation(governance.keywordRules, compileTimeEpochMs);

  const dimensions = [...config.dimensions]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map(({ id, code, name, weight }) => ({ id, code, name, weight }));
  requireUniqueIds(dimensions, 'dimensions');
  const dimensionById = new Map(dimensions.map((dimension) => [dimension.id, dimension]));
  const dimensionCodes = new Set(dimensions.map((dimension) => dimension.code));
  for (const rule of governance.keywordRules) {
    if (!dimensionCodes.has(rule.riskType)) {
      throw new PolicyGovernanceValidationError(
        'KEYWORD_RULE_DIMENSION_UNKNOWN',
        `Governed keyword rule ${rule.id} references an unknown dimension`,
      );
    }
  }

  const sourceRules = [
    ...[...config.rules.entries()]
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
    }),
    ...governance.keywordRules,
  ];
  requireUniqueIds(sourceRules, 'rules');
  for (const rule of sourceRules) {
    if (rule.matchType === 'regex') {
      validateSafeRegexPattern(rule.pattern, rule.caseSensitive ? '' : 'i');
    }
  }
  const rules = sourceRules.sort((left, right) =>
    left.riskType.localeCompare(right.riskType) || left.id.localeCompare(right.id),
  );

  const sourceExceptions = [...config.whitelists].filter((exception) => exception.enabled);
  requireUniqueIds(sourceExceptions, 'exceptions');
  for (const exception of sourceExceptions) {
    if (
      exception.approvalStatus !== 'approved' ||
      !exception.approvedBy?.trim() ||
      exception.dimensionScope !== 'specific' ||
      exception.dimensionCodes.length === 0 ||
      !exception.targetRuleIds?.length ||
      !exception.directions?.length ||
      exception.validFromEpochMs === undefined ||
      exception.expiresAtEpochMs === undefined
    ) {
      throw new PolicyGovernanceValidationError(
        'WHITELIST_APPROVAL_SCOPE_INVALID',
        'Enabled whitelist lacks approval or a bounded target scope',
      );
    }
    if (
      exception.validFromEpochMs > compileTimeEpochMs ||
      exception.expiresAtEpochMs <= compileTimeEpochMs ||
      exception.expiresAtEpochMs <= exception.validFromEpochMs
    ) {
      throw new PolicyGovernanceValidationError(
        'WHITELIST_EXPIRED',
        'Enabled whitelist is inactive or expired',
      );
    }
    if (exception.matchType === 'regex') {
      validateSafeRegexPattern(exception.pattern, exception.caseSensitive ? '' : 'i');
    }
  }
  const exceptions = sourceExceptions
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((exception) => ({
      id: exception.id,
      pattern: exception.pattern,
      matchType: exception.matchType,
      caseSensitive: exception.caseSensitive,
      dimensionScope: exception.dimensionScope,
      dimensionCodes: [...exception.dimensionCodes].sort(),
      targetRuleIds: [...exception.targetRuleIds!].sort(),
      directions: [...exception.directions!].sort(),
      validFromEpochMs: exception.validFromEpochMs,
      expiresAtEpochMs: exception.expiresAtEpochMs,
      approvalStatus: 'approved' as const,
      approvedBy: exception.approvedBy,
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
    detectorDag,
    ...(options.decisionPolicyVersion ? { decisionPolicyVersion: options.decisionPolicyVersion } : {}),
    ...(options.semanticDecisionMode?{semanticDecisionMode:options.semanticDecisionMode,semanticCoverage:semanticCoveragePolicySchema.parse(options.semanticCoverage)}:{}),
    ...(judgeProfiles ? { judgeProfiles } : {}),
    ...(options.semanticClassifier
      ? { semanticClassifier: options.semanticClassifier }
      : {}),
    ...(options.resourceAdmission
      ? { resourceAdmission: options.resourceAdmission }
      : {}),
    dictionaryReleases: governance.dictionaryReleases,
    responseTemplates: governance.responseTemplates,
    detectorCalibrations: governance.detectorCalibrations,
    modelDigests: governance.modelDigests,
    tokenizer: governance.tokenizer,
    failurePolicies: governance.failurePolicies,
  };
}
