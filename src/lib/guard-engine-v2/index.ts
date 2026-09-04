export { aggregateGuardDecision, stableObservations } from './aggregate';
export { generateAttackVariants } from './adversarial-variants';
export type {
  AttackPrototype,
  AttackVariant,
  AttackVariantKind,
} from './adversarial-variants';
export { createGuardEngine } from './engine';
export { buildGuardCacheKey } from './cache-key';
export type { GuardCacheIdentity } from './cache-key';
export { DEFAULT_DETECTOR_DAG } from './default-dag';
export { executeDetectorDag, resolveAndValidateDetectorDag } from './dag';
export {
  parseSemanticClassifierBuildConfig,
  semanticClassifierSpecSchema,
  SemanticClassifierDetector,
} from './semantic-classifier';
export type { SemanticClassifierInvoker } from './semantic-classifier';
export type { DetectorDagResult } from './dag';
export { createEngineForPolicyBundle } from './from-policy-bundle';
export {
  ContentSafetyIntentDetector,
  InsuranceComplianceDetector,
  PromptAttackDetector,
  ResourceAbuseDetector,
  StructuredDlpDetector,
  validUnifiedSocialCreditCode,
  validVehicleIdentificationNumber,
} from './builtin-detectors';
export {
  classifyContextRole,
  isDefensiveEducationalContext,
} from './intent-context';
export type { ContextClassification, ContextRole } from './intent-context';
export {
  buildNormalizedViews,
  mapViewRange,
  normalizeWithBudget,
  normalizationTransformNames,
  NORMALIZATION_ALGORITHM_VERSION,
  NORMALIZATION_DECODER_REGISTRY,
  NormalizationBudgetExceededError,
} from './normalization';
export type { NormalizationBudget, NormalizationResult } from './normalization';
export { LexicalMatcher } from './lexical-matcher';
export type { LexicalMatch } from './lexical-matcher';
export {
  createProtectedContextFingerprint,
  ProtectedContextLeakDetector,
} from './protected-context';
export type { ProtectedContextSource } from './protected-context';
export { RuleDetector } from './rule-detector';
export { ReasoningAttackDetector } from './reasoning-attack-detector';
export {
  chooseSessionDecision,
  evaluateWithSessionContext,
} from './session-context';
export type {
  GuardDetector,
  GuardDetectorContext,
  GuardEngine,
  GuardEngineDependencies,
  GuardEnginePolicy,
  NormalizationTransform,
  NormalizedView,
  OriginSpan,
  ProtectedContextFingerprint,
  ProtectedContextKind,
  RuleSpec,
  RuleExceptionSpec,
  SemanticClassifierSpec,
} from './types';
export type {
  ContextEnvelope,
  DetectorDagSpec,
  DetectorFailurePolicy,
  DetectorNodeSpec,
  DetectorRunCondition,
  DetectorTier,
  EvidenceRef,
  GuardAction,
  GuardDecision,
  GuardRequest,
  Observation,
  RiskLevel,
} from './types';
