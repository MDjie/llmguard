import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GuardAction, GuardDecision } from '@/lib/guard-engine-v2';
import type { ArtifactEnvelope } from '../../packages/contracts-appliance/generated/typescript/appliance-v1';
import {
  ArtifactIsolationWorkflow,
  BoundedArtifactReconstructor,
} from '@/lib/appliance/artifact-isolation';
import type { ArtifactSecurityEvidence, ArtifactSecurityPolicy } from '@/lib/artifacts';

const NOW = 10_000;
const bytes = Buffer.from('PK\u0003\u0004safe document');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const policy: ArtifactSecurityPolicy = {
  maximumArchiveDepth: 5, maximumArchiveEntries: 1_000,
  maximumExpandedBytes: 10_000_000, maximumCompressionRatio: 100,
  allowEncryptedArchives: false, allowMacros: false,
  allowExternalReferences: false, allowEmbeddedObjects: false,
};

function envelope(): ArtifactEnvelope {
  return {
    contractVersion: '1.0', flowId: 'flow-0001', frameId: 'frame-0001',
    artifactId: 'artifact-1', mediaType: 'application/zip', sizeBytes: bytes.length,
    sha256,
    contentReference: {
      uri: 'quarantine://device-1/artifact-1', sha256,
      expiresAtEpochMs: 21_000,
    },
    absoluteDeadlineEpochMs: 20_000, policyBundleId: 'bundle-1',
  };
}

function reconstructed() {
  const subject = new BoundedArtifactReconstructor({
    artifactId: 'artifact-1', declaredSizeBytes: bytes.length, declaredSha256: sha256,
    maximumArtifactBytes: 1_000,
  });
  subject.append(0, bytes.subarray(0, 5));
  subject.append(1, bytes.subarray(5));
  return subject.complete();
}

function scan(malware: ArtifactSecurityEvidence['malware']): ArtifactSecurityEvidence {
  return {
    scannerId: 'av-1', scannerVersion: '1.0.0', definitionDigest: 'a'.repeat(64), malware,
    archive: { depth: 1, entryCount: 2, compressedBytes: bytes.length,
      expandedBytes: bytes.length * 2, encryptedEntryCount: 0 },
  };
}

function guard(action: GuardAction, overrides: Partial<GuardDecision> = {}): GuardDecision {
  return {
    contractVersion: '1.0', decisionId: 'guard-decision-1', traceId: 'flow-0001', action,
    riskLevel: action === 'ALLOW' ? 'NONE' : 'HIGH', observations: [],
    policyPath: ['artifact-policy'], bundleId: 'bundle-1', latencyMs: 1,
    degradationReasons: [], failMode: 'NORMAL', evidenceComplete: true, ...overrides,
  };
}

describe('bounded artifact reconstruction', () => {
  it('verifies ordered parts, size and aggregate digest', () => {
    expect(reconstructed()).toMatchObject({
      artifactId: 'artifact-1', verifiedSizeBytes: bytes.length, verifiedSha256: sha256,
      partCount: 2,
    });
  });

  it('rejects gaps, overflow and aggregate mismatch', () => {
    const gap = new BoundedArtifactReconstructor({ artifactId: 'a', declaredSizeBytes: 1,
      declaredSha256: createHash('sha256').update('x').digest('hex'), maximumArtifactBytes: 2 });
    expect(() => gap.append(1, Buffer.from('x'))).toThrow('ARTIFACT_PART_SEQUENCE_INVALID');
    const mismatch = new BoundedArtifactReconstructor({ artifactId: 'a', declaredSizeBytes: 1,
      declaredSha256: '0'.repeat(64), maximumArtifactBytes: 2 });
    mismatch.append(0, Buffer.from('x'));
    expect(() => mismatch.complete()).toThrow('ARTIFACT_RECONSTRUCTION_INTEGRITY_FAILED');
  });
});

describe('artifact isolation workflow', () => {
  it('cannot release before reconstruction, AV and Guard all allow it', () => {
    const subject = new ArtifactIsolationWorkflow(envelope(), { now: () => NOW });
    expect(() => subject.release()).toThrow('ARTIFACT_RELEASE_NOT_AUTHORIZED');
    subject.recordReconstruction(reconstructed());
    subject.beginScan();
    subject.recordSecurityScan(scan('CLEAN'), policy);
    subject.recordGuardDecision(guard('ALLOW'));
    expect(subject.release()).toMatchObject({
      artifactId: 'artifact-1', guardDecisionId: 'guard-decision-1', releasedAtEpochMs: NOW,
    });
    expect(subject.state).toBe('RELEASED');
  });

  it('retains malware and scanner failures in quarantine without release', () => {
    for (const malware of ['DETECTED', 'ERROR', 'NOT_RUN'] as const) {
      const subject = new ArtifactIsolationWorkflow(envelope(), { now: () => NOW });
      subject.recordReconstruction(reconstructed());
      subject.beginScan();
      subject.recordSecurityScan(scan(malware), policy);
      expect(subject.state).toBe('REJECTED');
      expect(() => subject.release()).toThrow('ARTIFACT_RELEASE_NOT_AUTHORIZED');
    }
  });

  it('rejects a mismatched, incomplete or transforming Guard result', () => {
    const makeReadyForGuard = () => {
      const subject = new ArtifactIsolationWorkflow(envelope(), { now: () => NOW });
      subject.recordReconstruction(reconstructed());
      subject.beginScan();
      subject.recordSecurityScan(scan('CLEAN'), policy);
      return subject;
    };
    expect(() => makeReadyForGuard().recordGuardDecision(
      guard('ALLOW', { bundleId: 'other' }),
    )).toThrow('ARTIFACT_GUARD_DECISION_INVALID');
    expect(() => makeReadyForGuard().recordGuardDecision(
      guard('ALLOW', { evidenceComplete: false }),
    )).toThrow('ARTIFACT_GUARD_DECISION_INVALID');
    const transformed = makeReadyForGuard();
    transformed.recordGuardDecision(guard('MASK', { transformedText: '[MASKED]' }));
    expect(transformed.state).toBe('REJECTED');
    expect(transformed.rejectionReasons()).toContain('ARTIFACT_GUARD_MASK');
  });
});
