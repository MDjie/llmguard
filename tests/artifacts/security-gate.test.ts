import { describe, expect, it } from 'vitest';
import { evaluateArtifactSecurity, type ArtifactSecurityPolicy } from '../../src/lib/artifacts';

const policy: ArtifactSecurityPolicy = {
  maximumArchiveDepth: 5,
  maximumArchiveEntries: 10_000,
  maximumExpandedBytes: 1_000_000_000,
  maximumCompressionRatio: 100,
  allowEncryptedArchives: false,
  allowMacros: false,
  allowExternalReferences: false,
  allowEmbeddedObjects: false,
};

describe('artifact security admission gate', () => {
  it('accepts only clean, bounded and inactive content with scanner provenance', () => {
    expect(evaluateArtifactSecurity({
      scannerId: 'artifact-scanner', scannerVersion: '1.0.0',
      definitionDigest: 'a'.repeat(64), malware: 'CLEAN',
      archive: { depth: 2, entryCount: 10, compressedBytes: 100, expandedBytes: 500, encryptedEntryCount: 0 },
      activeContent: { macroCount: 0, embeddedObjectCount: 0, externalReferenceCount: 0, hiddenTextLayerCount: 1 },
    }, policy).disposition).toBe('ACCEPT');
  });

  it('fails closed on scanner failure, zip bomb signals, encryption and active content', () => {
    const result = evaluateArtifactSecurity({
      scannerId: 'artifact-scanner', scannerVersion: '1.0.0',
      definitionDigest: 'b'.repeat(64), malware: 'ERROR',
      archive: { depth: 8, entryCount: 20_000, compressedBytes: 10, expandedBytes: 2_000_000_000, encryptedEntryCount: 1 },
      activeContent: { macroCount: 1, embeddedObjectCount: 2, externalReferenceCount: 3, hiddenTextLayerCount: 1 },
    }, policy);
    expect(result.disposition).toBe('QUARANTINE');
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'ARTIFACT_MALWARE_SCAN_FAILED',
      'ARTIFACT_ARCHIVE_DEPTH_EXCEEDED',
      'ARTIFACT_ARCHIVE_COMPRESSION_RATIO_EXCEEDED',
      'ARTIFACT_ENCRYPTED_ARCHIVE_QUARANTINED',
      'ARTIFACT_MACRO_QUARANTINED',
      'ARTIFACT_EXTERNAL_REFERENCE_QUARANTINED',
    ]));
  });
});
