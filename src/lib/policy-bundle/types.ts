import type {
  DetectorDagSpec,
  RuleSpec,
  SemanticClassifierSpec,
} from '@/lib/guard-engine-v2/types';
import type { GuardResourceAdmissionSpec } from '@/lib/resource-control/admission-config';

export interface CompiledPolicyBundle {
  readonly schemaVersion: '1.0';
  readonly policyId: string;
  readonly policyVersion: number;
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
}

export interface SignedPolicyBundle {
  readonly payload: CompiledPolicyBundle;
  readonly canonicalJson: string;
  readonly contentHash: string;
  readonly signature: string;
  readonly signatureAlgorithm: 'Ed25519';
  readonly signingKeyId: string;
}
