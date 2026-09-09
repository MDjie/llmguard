import type {
  DetectorDagSpec,
  RuleSpec,
  SemanticClassifierSpec,
} from '@/lib/guard-engine-v2/types';
import type { GuardResourceAdmissionSpec } from '@/lib/resource-control/admission-config';
import type {
  DetectorCalibrationManifest,
  DictionaryReleaseManifest,
  FailurePolicyManifest,
  ModelDigestManifest,
  ResponseTemplateManifest,
  TokenizerManifest,
} from './governance';

export interface CompiledPolicyBundle {
  readonly detectionCapabilities?:import('./detection-capabilities').DetectionCapabilities;
  readonly decisionPolicyVersion?: 1 | 2;
  readonly semanticDecisionMode?: 'coverage-v1';
  readonly semanticCoverage?: import('@/lib/guard-engine-v2/semantic-coverage').SemanticCoveragePolicy;
  readonly judgeProfiles?: readonly import('@/lib/judge/profile').JudgeProfile[];
  readonly schemaVersion: '1.0';
  readonly policyId: string;
  readonly policyVersion: number;
  /** Editor revision captured at compilation; absent on historical bundles. */
  readonly sourcePolicyVersion?: number;
  readonly dimensions: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly weight: number;
  }[];
  readonly rules: readonly RuleSpec[];
  readonly exceptions: readonly {
    readonly id: string;
    readonly pattern: string;
    readonly matchType: RuleSpec['matchType'];
    readonly caseSensitive: boolean;
    readonly dimensionScope: 'all' | 'specific';
    readonly dimensionCodes: readonly string[];
    readonly targetRuleIds?: readonly string[];
    readonly directions?: readonly import('@guardllm/contracts').Direction[];
    readonly validFromEpochMs?: number;
    readonly expiresAtEpochMs?: number;
    readonly approvalStatus?: 'approved';
    readonly approvedBy?: string;
    readonly mandatoryDenyExempt: false;
  }[];
  readonly thresholds: readonly {
    readonly dimensionId: string;
    readonly warn: number;
    readonly block: number;
    readonly autoMask: boolean;
    readonly autoRewrite: boolean;
  }[];
  readonly detectorDag?: DetectorDagSpec;
  readonly semanticClassifier?: SemanticClassifierSpec;
  readonly resourceAdmission?: GuardResourceAdmissionSpec;
  readonly dictionaryReleases?: readonly DictionaryReleaseManifest[];
  readonly responseTemplates?: readonly ResponseTemplateManifest[];
  readonly detectorCalibrations?: readonly DetectorCalibrationManifest[];
  readonly modelDigests?: readonly ModelDigestManifest[];
  readonly tokenizer?: TokenizerManifest;
  readonly failurePolicies?: readonly FailurePolicyManifest[];
}

export interface SignedPolicyBundle {
  readonly payload: CompiledPolicyBundle;
  readonly canonicalJson: string;
  readonly contentHash: string;
  readonly signature: string;
  readonly signatureAlgorithm: 'Ed25519';
  readonly signingKeyId: string;
}
