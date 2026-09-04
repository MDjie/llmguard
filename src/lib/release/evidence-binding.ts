import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';

export interface ReleaseSubjectBinding {
  readonly sourceCommit: string;
  readonly imageDigests: Readonly<Record<string, string>>;
  readonly modelDigests: Readonly<Record<string, string>>;
  readonly policyBundleDigest: string;
  readonly tokenizerDigest: string;
  readonly datasetDigest: string;
  readonly configurationDigest: string;
  readonly environmentDigest: string;
}

export interface ReleaseEvidenceBinding {
  readonly fingerprint: string;
  readonly subjects: ReleaseSubjectBinding;
  readonly producedAtEpochMs: number;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function validateSubjects(subjects: ReleaseSubjectBinding): void {
  if (!/^[a-f0-9]{40,64}$/u.test(subjects.sourceCommit)) {
    throw new Error('RELEASE_SOURCE_COMMIT_INVALID');
  }
  const singular = [
    subjects.policyBundleDigest, subjects.tokenizerDigest, subjects.datasetDigest,
    subjects.configurationDigest, subjects.environmentDigest,
  ];
  const collections = [subjects.imageDigests, subjects.modelDigests];
  if (singular.some((value) => !DIGEST.test(value)) ||
      collections.some((items) => Object.keys(items).length === 0 ||
        Object.values(items).some((value) => !DIGEST.test(value)))) {
    throw new Error('RELEASE_SUBJECT_DIGEST_INVALID');
  }
}

export function releaseSubjectFingerprint(subjects: ReleaseSubjectBinding): string {
  validateSubjects(subjects);
  return `sha256:${createHash('sha256').update(canonicalJson(subjects)).digest('hex')}`;
}

export function bindReleaseEvidence(
  subjects: ReleaseSubjectBinding,
  producedAtEpochMs = Date.now(),
): ReleaseEvidenceBinding {
  if (!Number.isSafeInteger(producedAtEpochMs) || producedAtEpochMs <= 0) {
    throw new Error('RELEASE_EVIDENCE_TIMESTAMP_INVALID');
  }
  return { fingerprint: releaseSubjectFingerprint(subjects), subjects, producedAtEpochMs };
}

export function releaseEvidenceInvalidationReasons(
  evidence: ReleaseEvidenceBinding,
  current: ReleaseSubjectBinding,
): readonly string[] {
  const reasons: string[] = [];
  if (evidence.fingerprint !== releaseSubjectFingerprint(evidence.subjects)) {
    reasons.push('RELEASE_EVIDENCE_FINGERPRINT_INVALID');
  }
  if (evidence.subjects.sourceCommit !== current.sourceCommit) reasons.push('SOURCE_COMMIT_CHANGED');
  if (canonicalJson(evidence.subjects.imageDigests) !== canonicalJson(current.imageDigests)) reasons.push('IMAGE_DIGEST_CHANGED');
  if (canonicalJson(evidence.subjects.modelDigests) !== canonicalJson(current.modelDigests)) reasons.push('MODEL_DIGEST_CHANGED');
  if (evidence.subjects.policyBundleDigest !== current.policyBundleDigest) reasons.push('POLICY_BUNDLE_CHANGED');
  if (evidence.subjects.tokenizerDigest !== current.tokenizerDigest) reasons.push('TOKENIZER_CHANGED');
  if (evidence.subjects.datasetDigest !== current.datasetDigest) reasons.push('DATASET_CHANGED');
  if (evidence.subjects.configurationDigest !== current.configurationDigest) reasons.push('CONFIGURATION_CHANGED');
  if (evidence.subjects.environmentDigest !== current.environmentDigest) reasons.push('ENVIRONMENT_CHANGED');
  return reasons;
}
