import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/lib/policy-bundle';
import { ProviderEndpointPolicy } from '../../src/lib/egress';
import {
  RemoteSecurityScanner,
  nextSecurityScanStatus,
  securityScannerDefinitionDigest,
  validateFindingReview,
  validateSecurityScannerDefinition,
  type SecurityScannerDefinition,
} from '../../src/lib/security-scanning';
import type { SupplyChainArtifactManifest } from '../../src/lib/supply-chain';

const keys = generateKeyPairSync('ed25519');

function definition(options: {
  readonly networkDomains?: readonly string[];
  readonly permissions?: readonly string[];
} = {}): SecurityScannerDefinition {
  const artifactBase = {
    id: 'scanner-web',
    type: 'CODE' as const,
    version: '1.2.3',
    sourceUri: 'https://scanner.example.com/releases/1.2.3',
    sourceDigest: 'sha256:' + 'a'.repeat(64),
    licenseSpdx: 'Apache-2.0',
    noticeDigest: 'sha256:' + 'b'.repeat(64),
    scannerDefinitionDigest: 'sha256:' + '0'.repeat(64),
    signatureKeyId: 'scanner-key',
    permissions: [...(options.permissions ?? ['scan:web'])],
    networkDomains: [...(options.networkDomains ?? ['scanner.example.com'])],
    filePaths: [],
    commands: [],
    credentialRefs: [],
    isolatedDynamicAnalysis: true,
  };
  const base = {
    id: 'web-scanner',
    scanKind: 'WEB' as const,
    adapterVersion: '1.0.0',
    baseUrl: 'https://scanner.example.com',
    path: '/v1/scan',
    providerType: 'custom' as const,
    supportedTargetTypes: ['REGISTERED_WEB_APP' as const],
    maximumDurationMs: 60_000,
    maximumFindings: 100,
    artifact: {
      ...artifactBase,
      approvalIds: ['security', 'legal'],
      signature: 'pending',
    },
  };
  const scannerDefinitionDigest = securityScannerDefinitionDigest(base);
  const unsignedArtifact = { ...artifactBase, scannerDefinitionDigest };
  const signature = sign(
    null,
    Buffer.from(canonicalJson(unsignedArtifact)),
    keys.privateKey,
  ).toString('base64url');
  return {
    ...base,
    artifact: {
      ...unsignedArtifact,
      approvalIds: ['security', 'legal'],
      signature,
    } satisfies SupplyChainArtifactManifest,
  };
}

describe('unified security scanner admission', () => {
  it('requires a signed, pinned scanner definition with matching capabilities', () => {
    const configured = definition();
    expect(() => validateSecurityScannerDefinition(
      configured,
      new Map([['scanner-key', keys.publicKey]]),
    )).not.toThrow();
    expect(() => validateSecurityScannerDefinition(
      { ...configured, maximumFindings: 101 },
      new Map([['scanner-key', keys.publicKey]]),
    )).toThrow('SECURITY_SCANNER_DEFINITION_DIGEST_MISMATCH');
    expect(() => validateSecurityScannerDefinition(
      definition({ networkDomains: ['other.example.com'] }),
      new Map([['scanner-key', keys.publicKey]]),
    )).toThrow('SECURITY_SCANNER_NETWORK_CAPABILITY_MISSING');
    expect(() => validateSecurityScannerDefinition(
      definition({ permissions: ['scan:host'] }),
      new Map([['scanner-key', keys.publicKey]]),
    )).toThrow('SECURITY_SCANNER_PERMISSION_MISSING');
  });

  it('rejects arbitrary targets before calling the remote scanner', async () => {
    let calls = 0;
    const scanner = new RemoteSecurityScanner(definition(), {
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      },
    });
    await expect(scanner.scan('task-1', {
      type: 'REGISTERED_HOST',
      inventoryId: 'host-1',
      version: 'v1',
    })).rejects.toThrow('SECURITY_SCAN_TARGET_TYPE_NOT_SUPPORTED');
    expect(calls).toBe(0);
  });

  it('verifies scanner and target identity in returned evidence', async () => {
    const configured = definition();
    const scanner = new RemoteSecurityScanner(configured, {
      policy: new ProviderEndpointPolicy({
        allowedHosts: ['scanner.example.com'],
        resolver: async () => ['8.8.8.8'],
      }),
      fetchImpl: async () => new Response(JSON.stringify({
        scannerId: configured.id,
        scannerVersion: configured.artifact.version,
        scannerDigest: configured.artifact.sourceDigest,
        target: {
          type: 'REGISTERED_WEB_APP',
          inventoryId: 'web-1',
          version: 'v7',
        },
        startedAt: '2026-09-03T00:00:00.000Z',
        completedAt: '2026-09-03T00:01:00.000Z',
        findings: [{
          fingerprint: createHash('sha256').update('finding').digest('hex'),
          ruleId: 'WEB-001',
          category: 'injection',
          severity: 'HIGH',
          title: 'Unsafe parameter handling',
          evidenceDigest: 'sha256:' + 'd'.repeat(64),
        }],
        rawOutputDigest: 'sha256:' + 'e'.repeat(64),
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await expect(scanner.scan('task-1', {
      type: 'REGISTERED_WEB_APP',
      inventoryId: 'web-1',
      version: 'v7',
    })).resolves.toMatchObject({ findings: [{ ruleId: 'WEB-001' }] });
  });

  it('enforces terminal states and independent arbitration', () => {
    expect(nextSecurityScanStatus('QUEUED', 'RUNNING')).toBe('RUNNING');
    expect(() => nextSecurityScanStatus('SUCCEEDED', 'RUNNING'))
      .toThrow('SECURITY_SCAN_STATE_TRANSITION_INVALID');
    expect(() => validateFindingReview({
      disposition: 'CONFIRMED',
      submitterId: 'alice',
      reviewerId: 'alice',
      previousReviewerIds: [],
      reason: 'reviewed',
    })).toThrow('SECURITY_SCAN_INDEPENDENT_REVIEW_REQUIRED');
    expect(() => validateFindingReview({
      disposition: 'ARBITRATED_CONFIRMED',
      submitterId: 'alice',
      reviewerId: 'carol',
      previousReviewerIds: ['bob'],
      reason: 'arbitrated',
    })).toThrow('SECURITY_SCAN_ARBITRATION_PREREQUISITES_MISSING');
    expect(() => validateFindingReview({
      disposition: 'ARBITRATED_CONFIRMED',
      submitterId: 'alice',
      reviewerId: 'dave',
      previousReviewerIds: ['bob', 'carol'],
      previousDispositions: ['CONFIRMED', 'CONFIRMED'],
      reason: 'arbitrated',
    })).toThrow('SECURITY_SCAN_ARBITRATION_DISPUTE_REQUIRED');
  });
});
