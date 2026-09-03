export type ArtifactSecurityDisposition = 'ACCEPT' | 'QUARANTINE';

export interface ArtifactSecurityPolicy {
  readonly maximumArchiveDepth: number;
  readonly maximumArchiveEntries: number;
  readonly maximumExpandedBytes: number;
  readonly maximumCompressionRatio: number;
  readonly allowEncryptedArchives: boolean;
  readonly allowMacros: boolean;
  readonly allowExternalReferences: boolean;
  readonly allowEmbeddedObjects: boolean;
}

export interface ArtifactSecurityEvidence {
  readonly scannerId: string;
  readonly scannerVersion: string;
  readonly definitionDigest: string;
  readonly malware: 'CLEAN' | 'DETECTED' | 'ERROR' | 'NOT_RUN';
  readonly archive?: {
    readonly depth: number;
    readonly entryCount: number;
    readonly compressedBytes: number;
    readonly expandedBytes: number;
    readonly encryptedEntryCount: number;
  };
  readonly activeContent?: {
    readonly macroCount: number;
    readonly embeddedObjectCount: number;
    readonly externalReferenceCount: number;
    readonly hiddenTextLayerCount: number;
  };
}

export interface ArtifactSecurityDecision {
  readonly disposition: ArtifactSecurityDisposition;
  readonly reasonCodes: readonly string[];
  readonly evidence: ArtifactSecurityEvidence;
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateArtifactSecurity(
  evidence: ArtifactSecurityEvidence,
  policy: ArtifactSecurityPolicy,
): ArtifactSecurityDecision {
  if (!evidence.scannerId || !evidence.scannerVersion ||
      !/^[a-f0-9]{64}$/u.test(evidence.definitionDigest)) {
    throw new Error('ARTIFACT_SCANNER_IDENTITY_INVALID');
  }
  if (!validCount(policy.maximumArchiveDepth) || !validCount(policy.maximumArchiveEntries) ||
      !Number.isSafeInteger(policy.maximumExpandedBytes) || policy.maximumExpandedBytes <= 0 ||
      !Number.isFinite(policy.maximumCompressionRatio) || policy.maximumCompressionRatio < 1) {
    throw new Error('ARTIFACT_SECURITY_POLICY_INVALID');
  }
  const reasonCodes: string[] = [];
  if (evidence.malware === 'DETECTED') reasonCodes.push('ARTIFACT_MALWARE_DETECTED');
  if (evidence.malware === 'ERROR') reasonCodes.push('ARTIFACT_MALWARE_SCAN_FAILED');
  if (evidence.malware === 'NOT_RUN') reasonCodes.push('ARTIFACT_MALWARE_SCAN_REQUIRED');
  if (evidence.archive) {
    const archive = evidence.archive;
    if (![archive.depth, archive.entryCount, archive.compressedBytes,
      archive.expandedBytes, archive.encryptedEntryCount].every(validCount)) {
      throw new Error('ARTIFACT_ARCHIVE_EVIDENCE_INVALID');
    }
    const ratio = archive.expandedBytes / Math.max(1, archive.compressedBytes);
    if (archive.depth > policy.maximumArchiveDepth) reasonCodes.push('ARTIFACT_ARCHIVE_DEPTH_EXCEEDED');
    if (archive.entryCount > policy.maximumArchiveEntries) reasonCodes.push('ARTIFACT_ARCHIVE_ENTRY_LIMIT_EXCEEDED');
    if (archive.expandedBytes > policy.maximumExpandedBytes) reasonCodes.push('ARTIFACT_ARCHIVE_EXPANDED_SIZE_EXCEEDED');
    if (ratio > policy.maximumCompressionRatio) reasonCodes.push('ARTIFACT_ARCHIVE_COMPRESSION_RATIO_EXCEEDED');
    if (!policy.allowEncryptedArchives && archive.encryptedEntryCount > 0) {
      reasonCodes.push('ARTIFACT_ENCRYPTED_ARCHIVE_QUARANTINED');
    }
  }
  if (evidence.activeContent) {
    const active = evidence.activeContent;
    if (![active.macroCount, active.embeddedObjectCount, active.externalReferenceCount,
      active.hiddenTextLayerCount].every(validCount)) {
      throw new Error('ARTIFACT_ACTIVE_CONTENT_EVIDENCE_INVALID');
    }
    if (!policy.allowMacros && active.macroCount > 0) reasonCodes.push('ARTIFACT_MACRO_QUARANTINED');
    if (!policy.allowEmbeddedObjects && active.embeddedObjectCount > 0) {
      reasonCodes.push('ARTIFACT_EMBEDDED_OBJECT_QUARANTINED');
    }
    if (!policy.allowExternalReferences && active.externalReferenceCount > 0) {
      reasonCodes.push('ARTIFACT_EXTERNAL_REFERENCE_QUARANTINED');
    }
  }
  return {
    disposition: reasonCodes.length === 0 ? 'ACCEPT' : 'QUARANTINE',
    reasonCodes,
    evidence,
  };
}
