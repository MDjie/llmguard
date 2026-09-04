import { createHash, type Hash } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import {
  evaluateArtifactSecurity,
  type ArtifactSecurityEvidence,
  type ArtifactSecurityPolicy,
} from '@/lib/artifacts';
import type { GuardDecision } from '@/lib/guard-engine-v2';
import type { ArtifactEnvelope } from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';

const RAW_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface ArtifactReconstructionResult {
  readonly artifactId: string;
  readonly verifiedSizeBytes: number;
  readonly verifiedSha256: string;
  readonly prefix: Buffer;
  readonly partCount: number;
}

export class BoundedArtifactReconstructor {
  private readonly hash: Hash = createHash('sha256');
  private readonly prefixChunks: Buffer[] = [];
  private prefixBytes = 0;
  private verifiedSizeBytes = 0;
  private nextPartSequence = 0;
  private completed = false;

  constructor(private readonly options: {
    readonly artifactId: string;
    readonly declaredSizeBytes: number;
    readonly declaredSha256: string;
    readonly maximumArtifactBytes: number;
    readonly maximumPrefixBytes?: number;
  }) {
    if (options.artifactId.length === 0 ||
        !Number.isSafeInteger(options.declaredSizeBytes) || options.declaredSizeBytes < 0 ||
        !RAW_SHA256_PATTERN.test(options.declaredSha256) ||
        !Number.isSafeInteger(options.maximumArtifactBytes) || options.maximumArtifactBytes < 1 ||
        options.declaredSizeBytes > options.maximumArtifactBytes ||
        !Number.isSafeInteger(options.maximumPrefixBytes ?? 512) ||
        (options.maximumPrefixBytes ?? 512) < 1) {
      throw new Error('ARTIFACT_RECONSTRUCTION_OPTIONS_INVALID');
    }
  }

  append(partSequence: number, bytes: Uint8Array): void {
    if (this.completed) throw new Error('ARTIFACT_RECONSTRUCTION_COMPLETED');
    if (!Number.isSafeInteger(partSequence) || partSequence !== this.nextPartSequence) {
      throw new Error('ARTIFACT_PART_SEQUENCE_INVALID');
    }
    const part = Buffer.from(bytes);
    if (this.verifiedSizeBytes + part.length > this.options.declaredSizeBytes ||
        this.verifiedSizeBytes + part.length > this.options.maximumArtifactBytes) {
      throw new Error('ARTIFACT_RECONSTRUCTION_SIZE_EXCEEDED');
    }
    this.hash.update(part);
    const prefixLimit = this.options.maximumPrefixBytes ?? 512;
    if (this.prefixBytes < prefixLimit) {
      const prefixPart = part.subarray(0, prefixLimit - this.prefixBytes);
      this.prefixChunks.push(prefixPart);
      this.prefixBytes += prefixPart.length;
    }
    this.verifiedSizeBytes += part.length;
    this.nextPartSequence += 1;
  }

  complete(): ArtifactReconstructionResult {
    if (this.completed) throw new Error('ARTIFACT_RECONSTRUCTION_COMPLETED');
    this.completed = true;
    const verifiedSha256 = this.hash.digest('hex');
    if (this.verifiedSizeBytes !== this.options.declaredSizeBytes ||
        verifiedSha256 !== this.options.declaredSha256) {
      throw new Error('ARTIFACT_RECONSTRUCTION_INTEGRITY_FAILED');
    }
    return {
      artifactId: this.options.artifactId,
      verifiedSizeBytes: this.verifiedSizeBytes,
      verifiedSha256,
      prefix: Buffer.concat(this.prefixChunks),
      partCount: this.nextPartSequence,
    };
  }
}

export type ArtifactIsolationState =
  | 'AWAITING_RECONSTRUCTION'
  | 'QUARANTINED'
  | 'SCANNING'
  | 'CONTENT_INSPECTION'
  | 'READY_FOR_RELEASE'
  | 'RELEASED'
  | 'REJECTED';

export interface ArtifactReleaseReceipt {
  readonly artifactId: string;
  readonly flowId: string;
  readonly frameId: string;
  readonly policyBundleId: string;
  readonly artifactSha256: string;
  readonly scannerEvidenceDigest: string;
  readonly guardDecisionId: string;
  readonly releasedAtEpochMs: number;
  readonly receiptDigest: string;
}

function digest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validateEnvelope(envelope: ArtifactEnvelope): void {
  if (envelope.contractVersion !== '1.0' || envelope.flowId.length < 8 ||
      envelope.frameId.length < 8 || envelope.artifactId.length === 0 ||
      envelope.mediaType.length === 0 || !Number.isSafeInteger(envelope.sizeBytes) ||
      envelope.sizeBytes < 0 || !RAW_SHA256_PATTERN.test(envelope.sha256) ||
      envelope.contentReference.sha256 !== envelope.sha256 ||
      envelope.policyBundleId.length === 0 ||
      envelope.absoluteDeadlineEpochMs < 1 ||
      envelope.contentReference.expiresAtEpochMs < envelope.absoluteDeadlineEpochMs) {
    throw new Error('ARTIFACT_ENVELOPE_INVALID');
  }
}

export class ArtifactIsolationWorkflow {
  private currentState: ArtifactIsolationState = 'AWAITING_RECONSTRUCTION';
  private reconstruction: ArtifactReconstructionResult | undefined;
  private scannerEvidenceDigest: string | undefined;
  private guardDecisionId: string | undefined;
  private readonly reasonCodes = new Set<string>();
  private readonly now: () => number;

  constructor(
    readonly envelope: ArtifactEnvelope,
    options: { readonly now?: () => number } = {},
  ) {
    validateEnvelope(envelope);
    this.now = options.now ?? Date.now;
  }

  get state(): ArtifactIsolationState {
    return this.currentState;
  }

  recordReconstruction(result: ArtifactReconstructionResult): void {
    if (this.currentState !== 'AWAITING_RECONSTRUCTION' ||
        result.artifactId !== this.envelope.artifactId ||
        result.verifiedSizeBytes !== this.envelope.sizeBytes ||
        result.verifiedSha256 !== this.envelope.sha256) {
      this.reject('ARTIFACT_RECONSTRUCTION_BINDING_INVALID');
    }
    this.reconstruction = result;
    this.currentState = 'QUARANTINED';
  }

  beginScan(): void {
    if (this.currentState !== 'QUARANTINED' || !this.reconstruction) {
      throw new Error('ARTIFACT_SCAN_STATE_INVALID');
    }
    this.currentState = 'SCANNING';
  }

  recordSecurityScan(
    evidence: ArtifactSecurityEvidence,
    policy: ArtifactSecurityPolicy,
  ): void {
    if (this.currentState !== 'SCANNING') throw new Error('ARTIFACT_SCAN_STATE_INVALID');
    const decision = evaluateArtifactSecurity(evidence, policy);
    this.scannerEvidenceDigest = digest(decision);
    if (decision.disposition !== 'ACCEPT') {
      for (const reason of decision.reasonCodes) this.reasonCodes.add(reason);
      this.currentState = 'REJECTED';
      return;
    }
    this.currentState = 'CONTENT_INSPECTION';
  }

  recordGuardDecision(decision: GuardDecision): void {
    if (this.currentState !== 'CONTENT_INSPECTION' ||
        decision.contractVersion !== '1.0' ||
        decision.bundleId !== this.envelope.policyBundleId ||
        decision.traceId !== this.envelope.flowId ||
        decision.evidenceComplete === false || decision.failMode === 'FAIL_OPEN') {
      this.reject('ARTIFACT_GUARD_DECISION_INVALID');
    }
    this.guardDecisionId = decision.decisionId;
    if (decision.action === 'ALLOW' || decision.action === 'WARN') {
      this.currentState = 'READY_FOR_RELEASE';
      return;
    }
    this.reasonCodes.add('ARTIFACT_GUARD_' + decision.action);
    this.currentState = 'REJECTED';
  }

  release(): ArtifactReleaseReceipt {
    if (this.currentState !== 'READY_FOR_RELEASE' || !this.reconstruction ||
        !this.scannerEvidenceDigest || !this.guardDecisionId) {
      throw new Error('ARTIFACT_RELEASE_NOT_AUTHORIZED');
    }
    const releasedAtEpochMs = this.now();
    if (releasedAtEpochMs >= this.envelope.absoluteDeadlineEpochMs) {
      this.reject('ARTIFACT_RELEASE_DEADLINE_EXCEEDED');
    }
    const body = {
      artifactId: this.envelope.artifactId,
      flowId: this.envelope.flowId,
      frameId: this.envelope.frameId,
      policyBundleId: this.envelope.policyBundleId,
      artifactSha256: this.reconstruction.verifiedSha256,
      scannerEvidenceDigest: this.scannerEvidenceDigest,
      guardDecisionId: this.guardDecisionId,
      releasedAtEpochMs,
    };
    this.currentState = 'RELEASED';
    return { ...body, receiptDigest: digest(body) };
  }

  rejectionReasons(): readonly string[] {
    return [...this.reasonCodes].sort();
  }

  private reject(reasonCode: string): never {
    this.reasonCodes.add(reasonCode);
    this.currentState = 'REJECTED';
    throw new Error(reasonCode);
  }
}
