import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/lib/policy-bundle';
import {
  diffSupplyChainManifests,
  trustedSupplyChainKeysFromEnvironment,
  validateSupplyChainArtifactManifest,
  type SupplyChainArtifactManifest,
} from '../../src/lib/supply-chain';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function manifest(overrides: Partial<SupplyChainArtifactManifest> = {}): SupplyChainArtifactManifest {
  const unsigned = {
    id: 'claims-skill', type: 'SKILL' as const, version: '1.2.3',
    sourceUri: 'https://registry.example/claims-skill/1.2.3',
    sourceDigest: `sha256:${'1'.repeat(64)}`,
    licenseSpdx: 'Apache-2.0', noticeDigest: `sha256:${'2'.repeat(64)}`,
    scannerDefinitionDigest: `sha256:${'3'.repeat(64)}`,
    signatureKeyId: 'key-1', permissions: ['claims:read'],
    networkDomains: ['claims.example'], filePaths: [], commands: [], credentialRefs: [],
    isolatedDynamicAnalysis: true,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) =>
      !['signature', 'approvalIds'].includes(key))),
  };
  return {
    ...unsigned,
    approvalIds: overrides.approvalIds ?? ['security-1', 'owner-1'],
    signature: overrides.signature ?? sign(
      null, Buffer.from(canonicalJson(unsigned)), privateKey,
    ).toString('base64url'),
  };
}

describe('supply-chain artifact manifest', () => {
  it('requires a valid signature, exact version, dual approval and isolated execution', () => {
    expect(() => validateSupplyChainArtifactManifest(
      manifest(), new Map([['key-1', publicKey]]),
    )).not.toThrow();
    expect(() => validateSupplyChainArtifactManifest(
      manifest({ version: 'latest' }), new Map([['key-1', publicKey]]),
    )).toThrow('SUPPLY_CHAIN_EXACT_VERSION_REQUIRED');
    expect(() => validateSupplyChainArtifactManifest(
      manifest({ approvalIds: ['only-one'] }), new Map([['key-1', publicKey]]),
    )).toThrow('SUPPLY_CHAIN_LEGAL_AND_DUAL_APPROVAL_REQUIRED');
  });

  it('makes permission, network, file, command and credential expansion reviewable', () => {
    const previous = manifest();
    const next = manifest({
      version: '1.3.0', permissions: ['claims:read', 'claims:write'],
      networkDomains: ['claims.example', 'export.example'], filePaths: ['/exports'],
      commands: ['pwsh'], credentialRefs: ['export-token'],
    });
    expect(diffSupplyChainManifests(previous, next)).toMatchObject({
      addedPermissions: ['claims:write'],
      addedNetworkDomains: ['export.example'],
      addedFilePaths: ['/exports'],
      addedCommands: ['pwsh'],
      addedCredentialRefs: ['export-token'],
      requiresSecurityApproval: true,
    });
  });

  it('loads only explicitly configured trusted public keys', () => {
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(trustedSupplyChainKeysFromEnvironment({
      SUPPLY_CHAIN_TRUSTED_PUBLIC_KEYS_JSON: JSON.stringify({ 'key-1': pem }),
    }).has('key-1')).toBe(true);
    expect(() => trustedSupplyChainKeysFromEnvironment({})).toThrow(/is required/);
  });
});
